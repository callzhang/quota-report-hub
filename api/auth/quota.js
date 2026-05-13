import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import { dbConfigured, upsertAuthPoolQuota } from "../../lib/db.js";
import { readJsonBody } from "../../lib/http.js";

function isHardInvalidation(payload) {
  return (
    payload?.status === "error" &&
    (
      payload?.error === "auth invalidated (token_invalidated)" ||
      payload?.error === "auth failed (401 unauthorized)"
    )
  );
}

function hasCompleteWindow(window) {
  return Boolean(
    window &&
    window.remaining_percent !== null &&
    window.remaining_percent !== undefined &&
    window.reset_at
  );
}

function codexClientPayloadAccepted(payload) {
  if (!payload?.account_id) {
    return false;
  }
  if (isHardInvalidation(payload)) {
    return true;
  }
  return (
    payload?.status === "ok" &&
    hasCompleteWindow(payload?.windows?.["5h"]) &&
    hasCompleteWindow(payload?.windows?.["1week"])
  );
}

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
  const payload = {
    ...body.quota_payload,
    source,
    report_origin: "client",
    reporter_name: body.quota_payload.reporter_name || authContext.email,
    hostname: body.quota_payload.hostname || "client-report",
  };

  if (!payload.account_id) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "quota_payload.account_id is required" }));
    return;
  }

  if (source === "codex" && !codexClientPayloadAccepted(payload)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(withTokenUpgrade({ ok: true, source, ignored: true, reason: "quota_unavailable" }, authContext)));
    return;
  }

  await upsertAuthPoolQuota(payload);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(withTokenUpgrade({ ok: true, source, account_id: payload.account_id }, authContext)));
}
