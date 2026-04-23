import { authPoolConfigured, bearerTokenFromHeaders } from "../../lib/company-auth.js";
import { authenticateApiToken, dbConfigured, upsertAuthPoolQuota } from "../../lib/db.js";
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
  if (!body?.source) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "source is required" }));
    return;
  }
  if (!body?.quota_payload || typeof body.quota_payload !== "object") {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "quota_payload is required" }));
    return;
  }

  const source = String(body.source);
  const payload = {
    ...body.quota_payload,
    source,
    reporter_name: body.quota_payload.reporter_name || authContext.email,
    hostname: body.quota_payload.hostname || "client-report",
  };

  if (!payload.account_id) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "quota_payload.account_id is required" }));
    return;
  }

  await upsertAuthPoolQuota(payload);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: true, source, account_id: payload.account_id }));
}
