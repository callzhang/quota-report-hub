import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import { dbConfigured, getFeatureFlag, upsertAuthPoolEntry, upsertAuthPoolQuota } from "../../lib/db.js";
import { ingestClientQuota } from "../../lib/quota-ingest.js";
import { stripRefreshToken } from "../../lib/fetch-best.js";
import { probeClaudeAccessToken, verifyAndRefreshAuthBlob } from "../../lib/token-refresh.js";
import { readJsonBody } from "../../lib/http.js";

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

  const source = String(body.source);

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
  const refreshVerification = !probeClaude && ["claude", "codex"].includes(source)
    ? await verifyAndRefreshAuthBlob(body.auth_json, source)
    : { ok: false, attempted: false, reason: probeClaude ? "claude_probed_not_refreshed" : "unsupported_source" };

  if (refreshVerification.attempted && !refreshVerification.ok) {
    res.statusCode = refreshVerification.auth_rejected ? 422 : 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: false,
      error: refreshVerification.auth_rejected ? "refresh_token_rejected" : "refresh_verification_failed",
      reason: refreshVerification.error || refreshVerification.reason,
      status: refreshVerification.status ?? null,
    }));
    return;
  }

  const authJson = refreshVerification.ok ? refreshVerification.auth_json : body.auth_json;
  const entry = await upsertAuthPoolEntry({
    ...body,
    source,
    auth_json: authJson,
    uploader_email: authContext.email,
  });

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
    await upsertAuthPoolQuota({
      source,
      account_id: entry.account_id,
      email: entry.email,
      name: entry.name,
      plan_name: entry.plan_name,
      auth_last_refresh: entry.auth_last_refresh,
      status: "ok",
      windows: body.quota_payload?.windows || { "5h": null, "1week": null },
      usage_summary: {
        ...(body.quota_payload?.usage_summary || {}),
        token_refresh: { status: "refreshed", source: "upload" },
      },
      report_origin: "client",
      reporter_name: body.quota_payload?.reporter_name || authContext.email,
      hostname: body.quota_payload?.hostname || "upload",
    });
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
    refresh_validity: refreshVerification.ok ? "confirmed" : accessProbe?.ok ? "access_token_live" : "unverified",
    refreshed_auth_json: refreshedAuthJson,
    // "Your credential is untouched and still works, so you may go AT-only without waiting for a
    // replacement." The client's interlock refuses to strip unless it has a working token in hand;
    // when we refresh we owe it one, but when we only probe, the token it already holds IS the
    // working one. Without this the interlock would (correctly, on its old premise) keep the real
    // refresh token forever and AT-only mode would never engage.
    local_auth_untouched: Boolean(probeClaude && accessProbe?.ok),
  }, authContext)));
}
