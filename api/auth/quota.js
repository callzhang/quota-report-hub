import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import { dbConfigured } from "../../lib/db.js";
import { ingestClientQuota } from "../../lib/quota-ingest.js";
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
  const result = await ingestClientQuota({ source, quotaPayload: body.quota_payload, reporterEmail: authContext.email });

  if (result.reason === "missing_account_id") {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "quota_payload.account_id is required" }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(withTokenUpgrade(
    result.ignored
      ? { ok: true, source, ignored: true, reason: "quota_unavailable" }
      : { ok: true, source, account_id: result.account_id },
    authContext,
  )));
}
