import { authPoolConfigured, bearerTokenFromHeaders } from "../../lib/company-auth.js";
import {
  authenticateApiToken,
  bestAuthPoolEntry,
  dbConfigured,
  getInvalidatedUploaderEntry,
  hasUploadedAuth,
  recordAuthPoolFetch,
} from "../../lib/db.js";
import { readJsonBody } from "../../lib/http.js";

function unauthorized(res) {
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  const authContext = await authenticateApiToken(bearerTokenFromHeaders(req.headers));
  if (!authContext) {
    unauthorized(res);
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
  const currentQuota = {
    five_h_remaining_percent: body?.current_quota?.five_h_remaining_percent,
    one_week_remaining_percent: body?.current_quota?.one_week_remaining_percent,
  };

  const invalidatedEntry = await getInvalidatedUploaderEntry({
    source,
    uploaderEmail: authContext.email,
  });

  if (invalidatedEntry) {
    await recordAuthPoolFetch({
      requesterEmail: authContext.email,
      source,
      servedEntry: invalidatedEntry,
      reason: "returned_for_reauth",
      currentAccountId,
      currentQuota,
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: true,
        requested_by: authContext.email,
        replacement: {
          source: invalidatedEntry.source,
          account_id: invalidatedEntry.account_id,
          session_id: invalidatedEntry.session_id || "",
          email: invalidatedEntry.email,
          name: invalidatedEntry.name,
          plan_name: invalidatedEntry.plan_name,
          auth_last_refresh: invalidatedEntry.auth_last_refresh,
          digest: invalidatedEntry.digest,
          uploaded_at: invalidatedEntry.uploaded_at,
          reporter_name: invalidatedEntry.reporter_name,
          hostname: invalidatedEntry.hostname,
          latest_report: null,
          auth_json: invalidatedEntry.auth_json,
        },
        reason: "auth_invalidated_return_to_uploader",
        message: "Your uploaded auth for this account has been invalidated. Please re-login to this account and upload fresh credentials.",
      })
    );
    return;
  }

  const uploaded = await hasUploadedAuth({ source, uploaderEmail: authContext.email });
  if (!uploaded) {
    await recordAuthPoolFetch({
      requesterEmail: authContext.email,
      source,
      servedEntry: null,
      reason: "no_uploaded_auth",
      currentAccountId,
      currentQuota,
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: true,
        requested_by: authContext.email,
        replacement: null,
        reason: "must_upload_auth_to_pool",
        message: "You must upload at least one healthy auth to the pool before you can fetch. Bring your own auth to exchange.",
      })
    );
    return;
  }

  const entry = await bestAuthPoolEntry({
    source,
    exclude_account_ids: Array.isArray(body?.exclude_account_ids) ? body.exclude_account_ids : [],
    current_account_id: currentAccountId,
    current_quota: currentQuota,
  });

  if (!entry) {
    await recordAuthPoolFetch({
      requesterEmail: authContext.email,
      source,
      servedEntry: null,
      reason: "no_better_auth_available",
      currentAccountId,
      currentQuota,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, replacement: null, reason: "no_better_auth_available" }));
    return;
  }

  await recordAuthPoolFetch({
    requesterEmail: authContext.email,
    source,
    servedEntry: entry,
    reason: "served",
    currentAccountId,
    currentQuota,
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      ok: true,
      requested_by: authContext.email,
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
    })
  );
}
