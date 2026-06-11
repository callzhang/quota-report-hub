import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import {
  bestAuthPoolEntry,
  dbConfigured,
  getInvalidatedUploaderEntry,
  hasUploadedAnyHealthyAuth,
  recordAuthPoolFetch,
} from "../../lib/db.js";
import { readJsonBody } from "../../lib/http.js";
import { invalidatedEntryToRepairAuth } from "../../lib/fetch-best.js";

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

  if (repairAuth) {
    // The owner has a dead auth: hand it back to them for re-login instead of lending
    // a pool auth. Record it as a "repair_returned" fetch so the dashboard shows the
    // auth as returned to its owner — confirming the handback.
    await recordAuthPoolFetch({
      requesterEmail: authContext.email,
      requesterId,
      source,
      servedEntry: invalidatedEntry,
      reason: "repair_returned",
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
        reason: "uploaded_auth_requires_reauth",
        message: "Your uploaded auth has been invalidated. Re-login this auth and upload fresh credentials.",
      }, authContext))
    );
    return;
  }

  const uploaded = await hasUploadedAnyHealthyAuth({ uploaderEmail: authContext.email });
  if (!uploaded) {
    await recordAuthPoolFetch({
      requesterEmail: authContext.email,
      requesterId,
      source,
      servedEntry: null,
      reason: "no_uploaded_auth",
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
        reason: "must_upload_auth_to_pool",
        message: "You must upload at least one healthy Codex or Claude auth to the pool before you can fetch shared auth.",
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
      servedEntry: invalidatedEntry,
      reason: repairAuth ? "repair_auth_returned" : "no_better_auth_available",
      currentAccountId,
      currentQuota,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(withTokenUpgrade({
      ok: true,
      replacement: null,
      repair_auth: repairAuth,
      reason: repairAuth ? "uploaded_auth_requires_reauth" : "no_better_auth_available",
      message: repairAuth
        ? "Your uploaded auth has been invalidated. Re-login this auth and upload fresh credentials."
        : undefined,
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

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify(withTokenUpgrade({
      ok: true,
      requested_by: authContext.email,
      repair_auth: repairAuth,
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
        auth_json: entry.auth_json,
      },
    }, authContext))
  );
}
