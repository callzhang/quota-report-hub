import { compactTokenUsage, dbConfigured } from "../../lib/db.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  return tokenUsageRetentionHandlerImpl(req, res);
}

export async function tokenUsageRetentionHandlerImpl(req, res, deps = {
  compactTokenUsage,
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
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  if (!deps.dbConfigured()) {
    json(res, 500, { error: "Token usage retention is not configured" });
    return;
  }

  try {
    const before = new Date(deps.now().getTime() - RETENTION_MS).toISOString();
    const result = await deps.compactTokenUsage({
      before,
      receiptBefore: before,
      maxDays: 7,
    });
    json(res, 200, { ok: true, ...result });
  } catch {
    json(res, 503, {
      ok: false,
      error: "token_usage_retention_unavailable",
      message: "Token usage retention is temporarily unavailable.",
    });
  }
}
