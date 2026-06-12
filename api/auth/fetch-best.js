import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import {
  bestAuthPoolEntry,
  dbConfigured,
  getFeatureFlag,
  getInvalidatedUploaderEntry,
  hasUploadedAnyHealthyAuth,
  recordAuthPoolFetch,
} from "../../lib/db.js";
import { readJsonBody } from "../../lib/http.js";
import { invalidatedEntryToRepairAuth, stripRefreshToken } from "../../lib/fetch-best.js";

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
  const source = body?.source ? String(body.source) : "codex";
  const currentAccountId = body?.current_account_id ? String(body.current_account_id) : null;
  const requesterId = body?.requester_id ? String(body.requester_id) : null;
  const currentQuota = {
    five_h_remaining_percent: body?.current_quota?.five_h_remaining_percent,
    one_week_remaining_percent: body?.current_quota?.one_week_remaining_percent,
  };

  const invalidatedEntry = await getInvalidatedUploaderEntry({
    source,
    uploaderEmail: authContext.email,
    accountId: currentAccountId,
  });
  const repairAuth = invalidatedEntryToRepairAuth(invalidatedEntry);

  // The handback only applies when the requester has NO healthy auth of their own: as
  // long as they have at least one valid uploaded auth we serve a replacement and never
  // return a failed auth. With no healthy auth, hand back their own dead one for
  // re-login (recorded as "repair_returned" so the dashboard shows it as returned to its
  // owner), or ask them to upload if they have nothing at all.
  const uploaded = await hasUploadedAnyHealthyAuth({ uploaderEmail: authContext.email });
  if (!uploaded) {
    await recordAuthPoolFetch({
      requesterEmail: authContext.email,
      requesterId,
      source,
      servedEntry: repairAuth ? invalidatedEntry : null,
      reason: repairAuth ? "repair_returned" : "no_uploaded_auth",
      currentAccountId,
      currentQuota,
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify(withTokenUpgrade({
        ok: true,
        requested_by: authContext.email,
        replacement: null,
        repair_auth: repairAuth,
        reason: repairAuth ? "uploaded_auth_requires_reauth" : "must_upload_auth_to_pool",
        message: repairAuth
          ? "Your uploaded auth has been invalidated. Re-login this auth and upload fresh credentials."
          : "You must upload at least one healthy Codex or Claude auth to the pool before you can fetch shared auth.",
      }, authContext))
    );
    return;
  }

  const entry = await bestAuthPoolEntry({
    source,
    requester_email: authContext.email,
    selection_key: [
      authContext.email,
      requesterId,
      currentAccountId,
      req.headers["x-vercel-ip-city"] || req.headers["x-forwarded-for"] || "",
    ].filter(Boolean).join("|"),
    exclude_account_ids: Array.isArray(body?.exclude_account_ids) ? body.exclude_account_ids : [],
    current_account_id: currentAccountId,
    current_quota: currentQuota,
  });

  if (!entry) {
    await recordAuthPoolFetch({
      requesterEmail: authContext.email,
      requesterId,
      source,
      servedEntry: null,
      reason: "no_better_auth_available",
      currentAccountId,
      currentQuota,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(withTokenUpgrade({
      ok: true,
      replacement: null,
      reason: "no_better_auth_available",
    }, authContext)));
    return;
  }

  await recordAuthPoolFetch({
    requesterEmail: authContext.email,
    requesterId,
    source,
    servedEntry: entry,
    reason: "served",
    currentAccountId,
    currentQuota,
  });

  // When disabled_refresh_token is on, strip the refresh token so the borrower can use the access
  // token but cannot rotate the shared refresh token (the hub refreshes centrally).
  const atOnlyMode = await getFeatureFlag("disabled_refresh_token", false);
  const servedAuthJson = atOnlyMode ? stripRefreshToken(entry.auth_json, entry.source) : entry.auth_json;

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify(withTokenUpgrade({
      ok: true,
      requested_by: authContext.email,
      disabled_refresh_token: atOnlyMode,
      replacement: {
        source: entry.source,
        account_id: entry.account_id,
        session_id: entry.session_id || "",
        email: entry.email,
        name: entry.name,
        plan_name: entry.plan_name,
        auth_last_refresh: entry.auth_last_refresh,
        digest: entry.digest,
        uploaded_at: entry.uploaded_at,
        reporter_name: entry.reporter_name,
        hostname: entry.hostname,
        latest_report: entry.report,
        auth_json: servedAuthJson,
      },
    }, authContext))
  );
}
