import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import { dbConfigured } from "../../lib/db.js";
import { ingestClientQuota, ingestReporterHeartbeat } from "../../lib/quota-ingest.js";
import { readJsonBody } from "../../lib/http.js";

export default async function handler(req, res) {
  return quotaHandlerImpl(req, res);
}

export async function quotaHandlerImpl(req, res, deps = {
  authenticateApiRequest,
  sendUnauthorized,
  withTokenUpgrade,
  dbConfigured,
  authPoolConfigured,
  readJsonBody,
  ingestClientQuota,
  ingestReporterHeartbeat,
}) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  const authContext = await deps.authenticateApiRequest(req);
  if (!authContext) {
    deps.sendUnauthorized(res);
    return;
  }

  if (!deps.dbConfigured() || !deps.authPoolConfigured()) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Auth pool is not configured" }));
    return;
  }

  const body = await deps.readJsonBody(req);
  if (!body?.source) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "source is required" }));
    return;
  }
  const hasQuotaPayload = Boolean(body?.quota_payload) && typeof body.quota_payload === "object";
  const hasHeartbeat = Boolean(body?.heartbeat) && typeof body.heartbeat === "object";
  // A heartbeat-only POST is the whole point of the heartbeat: it is what a client sends when the
  // probe failed and there is no quota payload worth reporting. Requiring quota_payload here would
  // keep exactly the runs we most want to see invisible.
  if (!hasQuotaPayload && !hasHeartbeat) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "quota_payload or heartbeat is required" }));
    return;
  }

  const source = String(body.source);
  const heartbeatResult = hasHeartbeat
    ? await deps.ingestReporterHeartbeat({ source, heartbeat: body.heartbeat, reporterEmail: authContext.email })
    : null;
  if (!hasQuotaPayload) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(deps.withTokenUpgrade(
      { ok: true, source, heartbeat: heartbeatResult, ignored: true, reason: "heartbeat_only" },
      authContext,
    )));
    return;
  }
  const result = await deps.ingestClientQuota({ source, quotaPayload: body.quota_payload, reporterEmail: authContext.email });

  if (result.reason === "missing_account_id") {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "quota_payload.account_id is required" }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(deps.withTokenUpgrade(
    result.ignored
      ? { ok: true, source, ignored: true, reason: "quota_unavailable", heartbeat: heartbeatResult }
      : { ok: true, source, account_id: result.account_id, heartbeat: heartbeatResult },
    authContext,
  )));
}
