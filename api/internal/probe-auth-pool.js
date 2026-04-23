import { authPoolEntries, dbConfigured, upsertAuthPoolQuota } from "../../lib/db.js";
import { probeStoredAuthPoolEntry } from "../../lib/auth-pool-probe.js";

function unauthorized(res) {
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function cronAuthorized(req) {
  const expected = process.env.CRON_SECRET || "";
  const header = String(req.headers.authorization || "");
  return Boolean(expected) && header === `Bearer ${expected}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end("Method Not Allowed");
    return;
  }

  if (!cronAuthorized(req)) {
    unauthorized(res);
    return;
  }

  if (!dbConfigured()) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Database is not configured" }));
    return;
  }

  const entries = await authPoolEntries();
  const items = [];
  for (const entry of entries) {
    const report = await probeStoredAuthPoolEntry(entry);
    await upsertAuthPoolQuota(report);
    items.push({
      source: entry.source,
      account_id: entry.account_id,
      status: report.status,
      error: report.error,
    });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: true, count: items.length, items }));
}
