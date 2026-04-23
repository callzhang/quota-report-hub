import { authPoolConfigured, bearerTokenFromHeaders } from "../../lib/company-auth.js";
import { authenticateApiToken, bestAuthPoolEntry, dbConfigured } from "../../lib/db.js";
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
  const entry = await bestAuthPoolEntry({
    source: body?.source ? String(body.source) : "codex",
    exclude_account_ids: Array.isArray(body?.exclude_account_ids) ? body.exclude_account_ids : [],
    current_account_id: body?.current_account_id ? String(body.current_account_id) : null,
    current_quota: {
      five_h_remaining_percent: body?.current_quota?.five_h_remaining_percent,
      one_week_remaining_percent: body?.current_quota?.one_week_remaining_percent,
    },
  });

  if (!entry) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, replacement: null, reason: "no_better_auth_available" }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      ok: true,
      requested_by: authContext.email,
      replacement: {
        source: entry.source,
        account_id: entry.account_id,
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
