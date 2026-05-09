import { bearerTokenFromHeaders } from "../lib/company-auth.js";
import {
  authPoolEntries,
  authPoolFetchLog,
  authPoolInvalidatedNotifications,
  authPoolQuotaLatest,
  authenticateApiToken,
  dbConfigured,
} from "../lib/db.js";
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
  const [entries, reports, invalidatedStates, fetchLog] = await Promise.all([
    authPoolEntries(),
    authPoolQuotaLatest(),
    authPoolInvalidatedNotifications(),
    authPoolFetchLog({ limit: 50 }),
  ]);
  const dataset = authPoolStatusPayload(entries, reports, new Date().toISOString(), invalidatedStates);
  dataset.fetch_log = fetchLog;
  dataset.viewer_email = authContext.email;
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(dataset));
}
