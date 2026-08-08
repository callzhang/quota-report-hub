import {
  authenticateApiRequest,
  sendServiceUnavailable,
  sendUnauthorized,
  withTokenUpgrade,
} from "../lib/api-auth.js";
import { authPoolQuotaEvents } from "../lib/db.js";

const HISTORY_LIMIT = 96;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

function secondResolutionTimestamp(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export default async function handler(req, res) {
  return quotaHistoryHandlerImpl(req, res);
}

function sendBadRequest(res) {
  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({
    ok: false,
    error: "source and account_id are required exactly once",
  }));
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
      sendBadRequest(res);
      return;
    }

    const generatedAt = deps.now();
    const generatedAtIso = generatedAt.toISOString();
    const queryUntil = new Date(Math.floor(generatedAt.getTime() / 1000) * 1000);
    const until = secondResolutionTimestamp(queryUntil);
    const from = secondResolutionTimestamp(new Date(queryUntil.getTime() - HISTORY_WINDOW_MS));
    const events = await deps.authPoolQuotaEvents({
      source,
      accountId,
      since: from,
      until,
      limit: 96,
    });
    const payload = {
      source,
      account_id: accountId,
      from,
      generated_at: generatedAtIso,
      points: events.slice(0, HISTORY_LIMIT).map((event) => ({
        reported_at: event.reported_at,
        status: event.status,
        error: event.error,
        five_h_remaining_percent: event.windows?.["5h"]?.remaining_percent ?? null,
        five_h_reset_at: event.windows?.["5h"]?.reset_at ?? null,
        one_week_remaining_percent: event.windows?.["1week"]?.remaining_percent ?? null,
        one_week_reset_at: event.windows?.["1week"]?.reset_at ?? null,
      })),
    };

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(deps.withTokenUpgrade(payload, authContext)));
  } catch (error) {
    console.error(error);
    deps.sendServiceUnavailable(res, error);
  }
}
