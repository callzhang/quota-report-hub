import { dbConfigured, insertReport, latestReports } from "../lib/db.js";
import { statusPayload } from "../lib/reports.js";

function unauthorized(res) {
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  const configuredToken = process.env.REPORT_INGEST_TOKEN;
  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  if (!configuredToken || provided !== configuredToken) {
    unauthorized(res);
    return;
  }

  if (!dbConfigured()) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Turso is not configured" }));
    return;
  }

  await insertReport(req.body || {});
  const rows = await latestReports();
  const payload = statusPayload(rows);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      ok: true,
      generated_at: payload.generated_at,
      report_count: payload.report_count,
    })
  );
}
