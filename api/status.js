import { bearerTokenFromHeaders } from "../lib/company-auth.js";
import { authPoolEntries, authenticateApiToken, dbConfigured, latestReports } from "../lib/db.js";
import { authPoolStatusPayload } from "../lib/reports.js";

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
    res.end(JSON.stringify(authPoolStatusPayload([], [])));
    return;
  }
  const [entries, reports] = await Promise.all([authPoolEntries(), latestReports()]);
  const dataset = authPoolStatusPayload(entries, reports);
  dataset.viewer_email = authContext.email;
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(dataset));
}
