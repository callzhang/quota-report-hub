import { dbConfigured, latestReports } from "../lib/db.js";
import { statusPayload } from "../lib/reports.js";

export default async function handler(_req, res) {
  if (!dbConfigured()) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(statusPayload([])));
    return;
  }
  const rows = await latestReports();
  const dataset = statusPayload(rows);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(dataset));
}
