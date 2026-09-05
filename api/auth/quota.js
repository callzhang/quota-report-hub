import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import { dbConfigured } from "../../lib/db.js";
import { ingestClientQuota, ingestReporterHeartbeat } from "../../lib/quota-ingest.js";
import { readJsonBody } from "../../lib/http.js";
import { activePhases, clientNeedsUpgrade, upgradeNotice, withRepeatIntervals } from "../../lib/premium-ratio.js";

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
  activePhases,
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
  // The version floor is enforced where data is WRITTEN, not only where auth is fetched. A machine
  // that only reports never asks fetch-best for anything, so the fetch gate never reaches it -- and
  // writing is exactly how a stale client puts bad data in front of everyone. The heartbeat above is
  // always kept: it is how we see the machine and its version at all. Only the quota numbers are
  // refused, and only once the reporter_gate phase has begun; before that the response carries the
  // upgrade notice and the report is taken.
  const clientVersion = body.heartbeat?.client_version ? String(body.heartbeat.client_version) : null;
  const outdated = clientNeedsUpgrade(clientVersion);
  const notices = outdated ? withRepeatIntervals([upgradeNotice()]) : [];
  if (hasQuotaPayload && outdated && deps.activePhases().reporter_gate) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(deps.withTokenUpgrade(
      { ok: false, source, heartbeat: heartbeatResult, ignored: true, reason: "reporter_upgrade_required", client_version: clientVersion, notices },
      authContext,
    )));
    return;
  }
  if (!hasQuotaPayload) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(deps.withTokenUpgrade(
      { ok: true, source, heartbeat: heartbeatResult, ignored: true, reason: "heartbeat_only", notices },
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
      ? { notices, ok: true, source, ignored: true, reason: "quota_unavailable", heartbeat: heartbeatResult }
      : { notices, ok: true, source, account_id: result.account_id, heartbeat: heartbeatResult },
    authContext,
  )));
}
