import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import {
  authPoolEntry,
  dbConfigured,
  getFeatureFlag,
  uploadExcludedAccountIds,
  upsertAuthPoolEntry,
  upsertAuthPoolQuota,
} from "../../lib/db.js";
import { decryptAuthJson, deriveAuthPoolEntry } from "../../lib/auth-pool.js";
import { bundledProbeWitnessesAccessToken, uploadSupersedesRefreshVerdict } from "../../lib/auth-status.js";
import { codexClientPayloadAccepted, ingestClientQuota } from "../../lib/quota-ingest.js";
import { accessTokenFingerprint, isStrippedRefreshToken } from "../../lib/fetch-best.js";
import { probeClaudeAccessToken, refreshTokenFingerprint, refreshTokenFromAuthBlob } from "../../lib/token-refresh.js";
import { readJsonBody } from "../../lib/http.js";

// This write restates the SAME client observation that was just ingested (plus the refresh
// bookkeeping). Omitting exhausted_until here would clear the just-stored deadline under the
// per-report-evidence rule (sanitize always emits the key) — measured: ingest stored the
// deadline, this upsert nulled it in the same request, and an exhausted account that uploaded
// its auth went straight back into rotation.
// The bundled payload was already offered to ingestClientQuota, which turns away a codex report
// whose weekly window is incomplete. This second write has to apply the SAME test or it is a way
// back in for the numbers that gate just refused -- it copied `quotaPayload.windows` through
// untouched. Measured 2026-09-10: BD@chuhuang, on client 2.1.0 and three days past the reporter
// gate, landed two rows this way whose windows ingest had rejected. Empty windows cost nothing
// here (the merge keeps whatever is stored), and the refresh bookkeeping this report exists for is
// written either way. Claude has no ingest gate, so nothing to mirror.
function acceptedBundledWindows({ source, quotaPayload, accountId }) {
  const empty = { "5h": null, "1week": null };
  if (!quotaPayload?.windows) {
    return empty;
  }
  if (source !== "codex") {
    return quotaPayload.windows;
  }
  // account_id comes from the stored entry: it is the authoritative one for this upload, and the
  // gate would otherwise refuse a payload merely for omitting it.
  return codexClientPayloadAccepted({ ...quotaPayload, account_id: accountId })
    ? quotaPayload.windows
    : empty;
}

export function refreshVerificationQuotaReport({ source, entry, quotaPayload, reporterEmail, tokenRefresh = { status: "refreshed", source: "upload" } }) {
  return {
    source,
    account_id: entry.account_id,
    email: entry.email,
    name: entry.name,
    plan_name: entry.plan_name,
    auth_last_refresh: entry.auth_last_refresh,
    status: "ok",
    windows: acceptedBundledWindows({ source, quotaPayload, accountId: entry.account_id }),
    exhausted_until: quotaPayload?.exhausted_until ?? null,
    usage_summary: {
      ...(quotaPayload?.usage_summary || {}),
      token_refresh: tokenRefresh,
    },
    report_origin: "client",
    reporter_name: quotaPayload?.reporter_name || reporterEmail,
    hostname: quotaPayload?.hostname || "upload",
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  const authContext = await authenticateApiRequest(req);
  if (!authContext) {
    sendUnauthorized(res);
    return;
  }

  if (!dbConfigured() || !authPoolConfigured()) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Auth pool is not configured" }));
    return;
  }

  const body = await readJsonBody(req);

  const source = body?.source ? String(body.source) : null;

  if (!body?.auth_json) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "auth_json is required" }));
    return;
  }
  if (!body?.source) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "source is required" }));
    return;
  }

  // An owner who excluded this account does not want its credential here at all. Current clients
  // never send it; this refuses an older client that has not yet learned the list, before anything
  // is decrypted, probed, refreshed or stored.
  if ((await uploadExcludedAccountIds(source)).has(deriveAuthPoolEntry(source, body.auth_json, body).account_id)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "upload_excluded" }));
    return;
  }

  // A Codex upload is stored, never refreshed: the hub spends a pooled Codex RT only after its AT
  // has expired (lib/refresh-timing.js). Rotating here would orphan the RT other holders still present.
  const codexUpload = source === "codex";

  // Claude uploads are verified by PROBING the access token, not by spending the refresh token.
  //
  // Verifying by refresh cost more than it proved. The refresh revokes the access tokens already
  // issued for the grant, so every upload killed the uploader's own credential; the desktop app then
  // re-minted from its session key and the guard uploaded that, which is another unverified refresh
  // token, which triggered another refresh — a loop that ran ten times a day and revoked the pooled
  // token borrowers were holding on each pass.
  //
  // A live access token is already evidence the refresh token beside it is unspent: nothing can have
  // refreshed this grant since, or the access token would be dead. Codex keeps the refresh-verify —
  // its client cannot re-mint, so there is no loop to break, and its hourly id_token renewal needs
  // the rotation anyway.
  const probeClaude = source === "claude";
  const accessProbe = probeClaude ? await probeClaudeAccessToken(body.auth_json) : null;
  if (accessProbe?.rejected) {
    res.statusCode = 422;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "access_token_rejected", status: accessProbe.status }));
    return;
  }
  // A token that cannot do inference must not enter the pool: every borrower it is served to fails,
  // while every quota and liveness check it passes says the account is healthy.
  if (accessProbe?.lacks_inference) {
    res.statusCode = 422;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "access_token_lacks_inference", status: accessProbe.status }));
    return;
  }
  // Whether this upload's access token has been seen working without the hub spending its refresh
  // token: claude by the probe above, a deferred codex upload by the probe the guard bundled with it.
  const accessTokenLive = probeClaude
    ? Boolean(accessProbe?.ok)
    : codexUpload && bundledProbeWitnessesAccessToken({
      quotaPayload: body.quota_payload,
      uploadedAccessTokenFingerprint: accessTokenFingerprint(body.auth_json, source),
    });
  // Which refresh token the pool held before this upload, so an unrefreshed upload can tell a new
  // credential generation from a re-upload of the one already there (uploadSupersedesRefreshVerdict).
  let previousRefreshFingerprint = null;
  if (accessTokenLive) {
    const previousEntry = await authPoolEntry(source, deriveAuthPoolEntry(source, body.auth_json, body).account_id);
    if (previousEntry) {
      previousRefreshFingerprint = refreshTokenFingerprint(
        source,
        refreshTokenFromAuthBlob(await decryptAuthJson(previousEntry), source),
      );
    }
  }
  let entry = null;
  const refreshVerification = {
    ok: false,
    attempted: false,
    reason: codexUpload ? "codex_upload_not_refreshed" : probeClaude ? "claude_probed_not_refreshed" : "unsupported_source",
  };

  if (!entry) {
    entry = await upsertAuthPoolEntry({
      ...body,
      source,
      auth_json: body.auth_json,
      uploader_email: authContext.email,
    });
  }

  // If the client bundled its freshly-probed quota with the upload, ingest it in the same request
  // so the dashboard reflects fresh quota immediately — closing the window where a just-uploaded
  // entry shows stale quota until a separate quota report arrives or the worker probes it (which
  // the lazy-probe path may skip for a recently-uploaded entry). Best-effort: a bad or unavailable
  // quota payload never fails the auth upload.
  let quotaIngested = false;
  if (body.quota_payload && typeof body.quota_payload === "object") {
    try {
      const q = await ingestClientQuota({ source, quotaPayload: body.quota_payload, reporterEmail: authContext.email });
      quotaIngested = Boolean(q.ok && !q.ignored);
    } catch (error) {
      console.error("upload: bundled quota ingest failed:", error?.message || error);
    }
  }

  if (uploadSupersedesRefreshVerdict({
    accessTokenLive,
    deduplicated: Boolean(entry?.deduplicated),
    incomingHasRealRefreshToken: !isStrippedRefreshToken(body.auth_json, source),
    previousRefreshFingerprint,
    incomingRefreshFingerprint: refreshTokenFingerprint(source, refreshTokenFromAuthBlob(body.auth_json, source)),
  })) {
    // Not "refreshed": nobody refreshed it, so refresh_validity stays unverified. The upload source is
    // what lifts the previous generation's verdict (clearsCentralRefreshRejection).
    await upsertAuthPoolQuota(
      refreshVerificationQuotaReport({
        source,
        entry,
        quotaPayload: body.quota_payload,
        reporterEmail: authContext.email,
        tokenRefresh: { status: "new_generation", source: "upload" },
      })
    );
  }

  // Surface the flag so a client that just uploaded its real RT knows to go AT-only locally
  // (Phase 4): strip its own refresh token once the hub holds it.
  const disabledRefreshToken = await getFeatureFlag("disabled_refresh_token", false);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(withTokenUpgrade({
    ok: true,
    entry,
    disabled_refresh_token: disabledRefreshToken,
    quota_ingested: quotaIngested,
    refresh_validity: accessProbe?.ok ? "access_token_live" : "unverified",
    // "Your credential is untouched and still works, so you may go AT-only without waiting for a
    // replacement." The client's interlock refuses to strip unless it has a working token in hand;
    // when we refresh we owe it one, but when we only probe, the token it already holds IS the
    // working one. Without this the interlock would (correctly, on its old premise) keep the real
    // refresh token forever and AT-only mode would never engage.
    local_auth_untouched: Boolean(codexUpload || (probeClaude && accessProbe?.ok)),
  }, authContext)));
}
