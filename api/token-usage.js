import {
  authenticateApiRequest,
  sendServiceUnavailable,
  sendUnauthorized,
  withTokenUpgrade,
} from "../lib/api-auth.js";
import { ingestTokenUsageBatch } from "../lib/db.js";
import { readJsonBody } from "../lib/http.js";
import {
  normalizeTokenUsageBatch,
  TokenUsageValidationError,
} from "../lib/token-usage.js";

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  return tokenUsageHandlerImpl(req, res);
}

export async function tokenUsageHandlerImpl(req, res, deps = {
  authenticateApiRequest,
  ingestTokenUsageBatch,
  normalizeTokenUsageBatch,
  readJsonBody,
  sendServiceUnavailable,
  sendUnauthorized,
  withTokenUpgrade,
  now: () => new Date(),
}) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  try {
    const authContext = await deps.authenticateApiRequest(req);
    if (!authContext) {
      deps.sendUnauthorized(res);
      return;
    }

    const body = await deps.readJsonBody(req);
    const receivedAt = deps.now();
    const normalized = deps.normalizeTokenUsageBatch(body, { now: receivedAt });
    const result = await deps.ingestTokenUsageBatch({
      hubUserEmail: authContext.email,
      installationId: normalized.installation_id,
      batchId: normalized.batch_id,
      rows: normalized.rows,
      receivedAt: receivedAt.toISOString(),
    });
    sendJson(res, 200, deps.withTokenUpgrade({
      ok: true,
      hub_user_email: authContext.email,
      batch_id: normalized.batch_id,
      applied: result.applied,
      received_at: result.received_at,
    }, authContext));
  } catch (error) {
    if (error instanceof TokenUsageValidationError) {
      sendJson(res, error.statusCode || 400, {
        ok: false,
        error: "invalid_token_usage",
        message: error.message,
      });
      return;
    }
    if (error?.code === "token_usage_batch_conflict") {
      sendJson(res, 409, {
        ok: false,
        error: "token_usage_batch_conflict",
        message: "This batch ID was already used for another payload.",
      });
      return;
    }
    deps.sendServiceUnavailable(res, error);
  }
}
