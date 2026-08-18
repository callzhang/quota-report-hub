import {
  authenticateApiRequest,
  sendServiceUnavailable,
  sendUnauthorized,
  withTokenUpgrade,
} from "../lib/api-auth.js";
import { queryTokenUsage } from "../lib/db.js";
import {
  parseTokenUsageQuery,
  TokenUsageValidationError,
} from "../lib/token-usage.js";

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  return tokenUsageQueryHandlerImpl(req, res);
}

export async function tokenUsageQueryHandlerImpl(req, res, deps = {
  authenticateApiRequest,
  parseTokenUsageQuery,
  queryTokenUsage,
  sendServiceUnavailable,
  sendUnauthorized,
  withTokenUpgrade,
  now: () => new Date(),
}) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end("Method Not Allowed");
    return;
  }

  try {
    const authContext = await deps.authenticateApiRequest(req);
    if (!authContext) {
      deps.sendUnauthorized(res);
      return;
    }
    const generatedAt = deps.now();
    const parsed = deps.parseTokenUsageQuery(req.url, { now: generatedAt });
    const result = await deps.queryTokenUsage(parsed);
    sendJson(res, 200, deps.withTokenUpgrade({
      generated_at: generatedAt.toISOString(),
      query: parsed.publicQuery,
      totals: result.totals,
      trend: result.trend,
      breakdown: result.breakdown,
      reporters: result.reporters,
    }, authContext));
  } catch (error) {
    if (error instanceof TokenUsageValidationError) {
      sendJson(res, error.statusCode || 400, {
        ok: false,
        error: "invalid_token_usage_query",
        message: error.message,
      });
      return;
    }
    if (error?.code === "query_too_broad") {
      sendJson(res, 422, {
        ok: false,
        error: "query_too_broad",
        message: "Narrow the time range or add filters.",
      });
      return;
    }
    deps.sendServiceUnavailable(res, error);
  }
}
