import { authPoolConfigured } from "../../lib/auth-pool.js";
import { bestAuthPoolEntry, dbConfigured } from "../../lib/db.js";

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

  const configuredToken = process.env.AUTH_POOL_TOKEN;
  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  if (!configuredToken || provided !== configuredToken) {
    unauthorized(res);
    return;
  }

  if (!dbConfigured() || !authPoolConfigured()) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Auth pool is not configured" }));
    return;
  }

  const entry = await bestAuthPoolEntry({
    exclude_account_ids: Array.isArray(req.body?.exclude_account_ids) ? req.body.exclude_account_ids : [],
  });

  if (!entry) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "No usable auth available" }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      ok: true,
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
    })
  );
}
