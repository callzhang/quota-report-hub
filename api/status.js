import { authenticateApiRequest, sendServiceUnavailable, sendUnauthorized, withTokenUpgrade } from "../lib/api-auth.js";
import {
  authPoolEntrySummaries,
  authPoolFetchLog,
  authPoolInvalidatedNotifications,
  authPoolQuotaLatest,
  dbConfigured,
  getFeatureFlag,
  poolHealthSnapshots,
} from "../lib/db.js";
import { authPoolStatusPayload } from "../lib/reports.js";
import { isAdminEmail } from "../lib/company-auth.js";

export default async function handler(req, res) {
  return statusHandlerImpl(req, res);
}

export async function statusHandlerImpl(req, res, deps = {
  authenticateApiRequest,
  sendServiceUnavailable,
  sendUnauthorized,
  withTokenUpgrade,
  dbConfigured,
  authPoolEntrySummaries,
  authPoolQuotaLatest,
  authPoolInvalidatedNotifications,
  authPoolFetchLog,
  poolHealthSnapshots,
  authPoolStatusPayload,
  getFeatureFlag,
  isAdminEmail,
}) {
  try {
    const authContext = await deps.authenticateApiRequest(req);
    if (!authContext) {
      deps.sendUnauthorized(res);
      return;
    }

    if (!deps.dbConfigured()) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(deps.withTokenUpgrade(deps.authPoolStatusPayload([], []), authContext)));
      return;
    }
    const [entries, reports, invalidatedStates, fetchLog, healthHistory] = await Promise.all([
      deps.authPoolEntrySummaries(),
      deps.authPoolQuotaLatest(),
      deps.authPoolInvalidatedNotifications(),
      deps.authPoolFetchLog({ limit: 50 }),
      deps.poolHealthSnapshots({ limit: 96 }),
    ]);
    const dataset = deps.authPoolStatusPayload(entries, reports, new Date().toISOString(), invalidatedStates);
    dataset.fetch_log = fetchLog;
    dataset.health_history = healthHistory;
    dataset.viewer_email = authContext.email;
    dataset.disabled_refresh_token = await deps.getFeatureFlag("disabled_refresh_token", false);
    dataset.is_admin = deps.isAdminEmail(authContext.email);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(deps.withTokenUpgrade(dataset, authContext)));
    return;
  } catch (error) {
    console.error(error);
    deps.sendServiceUnavailable(res, error);
  }
}
