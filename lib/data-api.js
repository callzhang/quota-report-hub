import {
  authenticateApiRequest,
  sendServiceUnavailable,
  sendUnauthorized,
  withTokenUpgrade,
} from "./api-auth.js";
import {
  authPoolQuotaEvents,
  compactTokenUsage,
  dbConfigured,
  ingestTokenUsageBatch,
  pruneAuthPoolQuotaEvents,
  queryTokenUsage,
} from "./db.js";
import { readJsonBody } from "./http.js";
import {
  normalizeTokenUsageBatch,
  parseTokenUsageQuery,
  TokenUsageValidationError,
} from "./token-usage.js";

const HISTORY_LIMIT = 96;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// Quota events only ever back a 24h history popover; verdicts live in quota_latest. Thirty days keeps
// enough to reconstruct a bad week without letting the table grow without bound.
const QUOTA_EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function exactParameter(searchParams, name) {
  const values = searchParams.getAll(name);
  if (values.length !== 1) return null;
  const value = values[0];
  if (!value || value !== value.trim() || value.length > 512) return null;
  return value;
}

export async function quotaHistoryHandlerImpl(req, res, deps = {
  authenticateApiRequest,
  sendServiceUnavailable,
  sendUnauthorized,
  withTokenUpgrade,
  authPoolQuotaEvents,
  now: () => new Date(),
}) {
  try {
    const authContext = await deps.authenticateApiRequest(req);
    if (!authContext) {
      deps.sendUnauthorized(res);
      return;
    }
    const searchParams = new URL(req.url, "http://placeholder").searchParams;
    const source = exactParameter(searchParams, "source");
    const accountId = exactParameter(searchParams, "account_id");
    if (!source || !accountId) {
      sendJson(res, 400, { ok: false, error: "source and account_id are required exactly once" });
      return;
    }
    const generatedAt = deps.now();
    const until = generatedAt.toISOString();
    const from = new Date(generatedAt.getTime() - HISTORY_WINDOW_MS).toISOString();
    const events = await deps.authPoolQuotaEvents({ source, accountId, since: from, until, limit: 96 });
    sendJson(res, 200, deps.withTokenUpgrade({
      source,
      account_id: accountId,
      from,
      generated_at: generatedAt.toISOString(),
      points: events.slice(0, HISTORY_LIMIT).map((event) => ({
        reported_at: event.reported_at,
        status: event.status,
        error: event.error,
        five_h_remaining_percent: event.windows?.["5h"]?.remaining_percent ?? null,
        five_h_reset_at: event.windows?.["5h"]?.reset_at ?? null,
        one_week_remaining_percent: event.windows?.["1week"]?.remaining_percent ?? null,
        one_week_reset_at: event.windows?.["1week"]?.reset_at ?? null,
      })),
    }, authContext));
  } catch (error) {
    console.error(error);
    deps.sendServiceUnavailable(res, error);
  }
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
      clientVersion: normalized.client_version,
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
      sendJson(res, error.statusCode || 400, { ok: false, error: "invalid_token_usage", message: error.message });
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
      sendJson(res, error.statusCode || 400, { ok: false, error: "invalid_token_usage_query", message: error.message });
      return;
    }
    if (error?.code === "query_too_broad") {
      sendJson(res, 422, { ok: false, error: "query_too_broad", message: "Narrow the time range or add filters." });
      return;
    }
    deps.sendServiceUnavailable(res, error);
  }
}

export async function tokenUsageRetentionHandlerImpl(req, res, deps = {
  compactTokenUsage,
  pruneAuthPoolQuotaEvents,
  dbConfigured,
  cronSecret: () => process.env.CRON_SECRET,
  now: () => new Date(),
}) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return;
  }
  const secret = deps.cronSecret();
  if (!secret || req.headers?.authorization !== `Bearer ${secret}`) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  if (!deps.dbConfigured()) {
    sendJson(res, 500, { error: "Token usage retention is not configured" });
    return;
  }
  try {
    const before = new Date(deps.now().getTime() - RETENTION_MS).toISOString();
    const result = await deps.compactTokenUsage({ before, receiptBefore: before, maxDays: 7 });
    // One retention cron for every rolling table: Hobby allows two crons and both are spoken for.
    const quotaEvents = await deps.pruneAuthPoolQuotaEvents({
      before: new Date(deps.now().getTime() - QUOTA_EVENTS_RETENTION_MS).toISOString(),
    });
    sendJson(res, 200, { ok: true, ...result, quota_events: quotaEvents });
  } catch {
    sendJson(res, 503, {
      ok: false,
      error: "token_usage_retention_unavailable",
      message: "Token usage retention is temporarily unavailable.",
    });
  }
}
