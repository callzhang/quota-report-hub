import { bearerTokenFromHeaders } from "../lib/company-auth.js";
import { authenticateApiToken, dbConfigured, latestReports } from "../lib/db.js";
import { statusPayload } from "../lib/reports.js";

function unauthorized(res) {
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export default async function handler(req, res) {
  const authContext = await authenticateApiToken(bearerTokenFromHeaders(req.headers));
  if (!authContext) {
    unauthorized(res);
    return;
  }

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
