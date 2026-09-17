import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import {
  claimAuthPoolRefreshLease,
  authPoolEntry,
  dbConfigured,
  getFeatureFlag,
  releaseAuthPoolRefreshLease,
  setAuthPoolRefreshHandoff,
  upsertAuthPoolEntry,
  upsertAuthPoolQuota,
} from "../../lib/db.js";
import { decryptAuthJson, deriveAuthPoolEntry } from "../../lib/auth-pool.js";
import { claudeUploadSupersedesRefreshVerdict } from "../../lib/auth-status.js";
import { refreshSerializedAuthPoolEntry } from "../../lib/auth-pool-refresh.js";
import { codexClientPayloadAccepted, ingestClientQuota } from "../../lib/quota-ingest.js";
import { isStrippedRefreshToken, stripRefreshToken } from "../../lib/fetch-best.js";
import { probeClaudeAccessToken, refreshTokenFingerprint, refreshTokenFromAuthBlob, verifyAndRefreshAuthBlob } from "../../lib/token-refresh.js";
import { readJsonBody } from "../../lib/http.js";
import { isRefreshHandoffPending, requestedRefreshHandoffState } from "../../lib/refresh-handoff.js";

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

  // Completion is deliberately a separate, auth-blob-free acknowledgement. At this point the
  // guard has stripped disk state and retired the old local app-server, so it cannot upload the
  // real RT again. The uploader identity is the authority boundary: another Hub member cannot
  // unfreeze an account whose old RT may still live on this machine.
  if (body?.complete_codex_refresh_handoff === true) {
    const accountId = body?.account_id ? String(body.account_id) : null;
    if (source !== "codex" || !accountId) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "codex account_id is required to complete a refresh handoff" }));
      return;
    }
    const completed = await setAuthPoolRefreshHandoff({
      source,
      accountId,
      uploaderEmail: authContext.email,
      state: null,
    });
    res.statusCode = completed.updated ? 200 : 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(withTokenUpgrade({
      ok: completed.updated,
      refresh_handoff_state: completed.updated ? null : "pending",
      error: completed.updated ? undefined : "refresh_handoff_not_owned",
    }, authContext)));
    return;
  }

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

  const requestedHandoffState = requestedRefreshHandoffState({
    source,
    deferCodexRefresh: body?.defer_codex_refresh === true,
  });
  const existingEntry = source === "codex" && !requestedHandoffState
    ? await authPoolEntry(source, deriveAuthPoolEntry(source, body.auth_json, body).account_id)
    : null;
  const refreshHandoffPending = requestedHandoffState === "pending" || isRefreshHandoffPending(existingEntry);

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
  // Which refresh token the pool held before this upload, so an accepted claude upload can tell a new
  // credential generation from a re-upload of the one already there (claudeUploadSupersedesRefreshVerdict).
  let previousClaudeRefreshFingerprint = null;
  if (accessProbe?.ok) {
    const previousEntry = await authPoolEntry(source, deriveAuthPoolEntry(source, body.auth_json, body).account_id);
    if (previousEntry) {
      previousClaudeRefreshFingerprint = refreshTokenFingerprint(
        source,
        refreshTokenFromAuthBlob(await decryptAuthJson(previousEntry), source),
      );
    }
  }
  let entry = null;
  const refreshVerification = !refreshHandoffPending && !probeClaude && source === "codex"
    ? await refreshSerializedAuthPoolEntry({
        source,
        accountId: deriveAuthPoolEntry(source, body.auth_json, body).account_id,
        authJson: body.auth_json,
        claimLease: claimAuthPoolRefreshLease,
        releaseLease: releaseAuthPoolRefreshLease,
        refreshAuthBlob: verifyAndRefreshAuthBlob,
        // Keep the lease until the rotated RT has become canonical. Releasing before this write
        // would admit a second request holding the old generation into the provider endpoint.
        persistRefreshedAuth: async (refreshedAuthJson) => {
          entry = await upsertAuthPoolEntry({
            ...body,
            source,
            auth_json: refreshedAuthJson,
            uploader_email: authContext.email,
          });
        },
      })
    : { ok: false, attempted: false, reason: refreshHandoffPending ? "local_refresh_handoff_pending" : probeClaude ? "claude_probed_not_refreshed" : "unsupported_source" };

  if (source === "codex" && !refreshVerification.ok && !refreshHandoffPending) {
    const busyOrSuperseded = ["refresh_in_progress", "refresh_superseded"].includes(refreshVerification.reason);
    res.statusCode = busyOrSuperseded ? 409 : refreshVerification.auth_rejected ? 422 : 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: false,
      error: busyOrSuperseded ? "refresh_generation_changed" : refreshVerification.auth_rejected ? "refresh_token_rejected" : "refresh_verification_failed",
      reason: refreshVerification.error || refreshVerification.reason,
      status: refreshVerification.status ?? null,
    }));
    return;
  }

  const authJson = refreshVerification.ok ? refreshVerification.auth_json : body.auth_json;
  if (!entry) {
    entry = await upsertAuthPoolEntry({
      ...body,
      source,
      auth_json: authJson,
      refresh_handoff_state: requestedHandoffState,
      uploader_email: authContext.email,
    });
  }

  if (refreshHandoffPending) {
    const handoff = await setAuthPoolRefreshHandoff({
      source,
      accountId: entry.account_id,
      uploaderEmail: authContext.email,
      state: "pending",
    });
    if (!handoff.updated) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "refresh_handoff_not_owned" }));
      return;
    }
    entry = { ...entry, refresh_handoff_state: "pending" };
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

  if (refreshVerification.ok) {
    await upsertAuthPoolQuota(
      refreshVerificationQuotaReport({
        source,
        entry,
        quotaPayload: body.quota_payload,
        reporterEmail: authContext.email,
      })
    );
  } else if (claudeUploadSupersedesRefreshVerdict({
    accessProbe,
    deduplicated: Boolean(entry?.deduplicated),
    incomingHasRealRefreshToken: !isStrippedRefreshToken(body.auth_json, source),
    previousRefreshFingerprint: previousClaudeRefreshFingerprint,
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

  // Hand the refreshed access token back to the uploader.
  //
  // Refreshing here rotates the grant, and this provider REVOKES every access token it previously
  // issued for that grant (measured: a live AT went 200 -> 401 "OAuth access token has been
  // revoked" within one guard cycle of an upload). So the moment we refresh, the uploader's own
  // access token is dead. Before this, the response carried metadata only: the client then stripped
  // its refresh token and was left holding a revoked AT plus a placeholder RT — unable to work and
  // unable to recover. Returning the AT-only blob lets it install a working token in the same cycle
  // as the strip. The refresh token is stripped out: the hub stays the sole refresher.
  let refreshedAuthJson = null;
  if (refreshVerification.ok && disabledRefreshToken) {
    try {
      refreshedAuthJson = stripRefreshToken(authJson, source);
    } catch (error) {
      console.error("upload: could not build AT-only blob for uploader:", error?.message || error);
    }
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(withTokenUpgrade({
    ok: true,
    entry,
    disabled_refresh_token: disabledRefreshToken,
    quota_ingested: quotaIngested,
    refresh_validity: refreshHandoffPending ? "handoff_pending" : refreshVerification.ok ? "confirmed" : accessProbe?.ok ? "access_token_live" : "unverified",
    refreshed_auth_json: refreshedAuthJson,
    // "Your credential is untouched and still works, so you may go AT-only without waiting for a
    // replacement." The client's interlock refuses to strip unless it has a working token in hand;
    // when we refresh we owe it one, but when we only probe, the token it already holds IS the
    // working one. Without this the interlock would (correctly, on its old premise) keep the real
    // refresh token forever and AT-only mode would never engage.
    local_auth_untouched: Boolean(refreshHandoffPending || (probeClaude && accessProbe?.ok)),
    refresh_handoff_state: refreshHandoffPending ? "pending" : null,
  }, authContext)));
}
