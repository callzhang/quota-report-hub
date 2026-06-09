import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../lib/api-auth.js";
import {
  authPoolEntrySummaries,
  authPoolFetchLog,
  authPoolInvalidatedNotifications,
  authPoolQuotaLatest,
  dbConfigured,
} from "../lib/db.js";
import { authPoolStatusPayload } from "../lib/reports.js";

export default async function handler(req, res) {
  const authContext = await authenticateApiRequest(req);
  if (!authContext) {
    sendUnauthorized(res);
    return;
  }

  if (!dbConfigured()) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(withTokenUpgrade(authPoolStatusPayload([], []), authContext)));
    return;
  }
  const [entries, reports, invalidatedStates, fetchLog] = await Promise.all([
    authPoolEntrySummaries(),
    authPoolQuotaLatest(),
    authPoolInvalidatedNotifications(),
    authPoolFetchLog({ limit: 50 }),
  ]);
  const dataset = authPoolStatusPayload(entries, reports, new Date().toISOString(), invalidatedStates);
  dataset.fetch_log = fetchLog;
  dataset.viewer_email = authContext.email;
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(withTokenUpgrade(dataset, authContext)));
}
