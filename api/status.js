import { authenticateApiRequest, sendServiceUnavailable, sendUnauthorized, withTokenUpgrade } from "../lib/api-auth.js";
import {
  authPoolEntrySummaries,
  authPoolFetchLog,
  authPoolInvalidatedNotifications,
  authPoolQuotaLatest,
  dashboardRevision,
  dbConfigured,
  getFeatureFlag,
  poolHealthSnapshots,
} from "../lib/db.js";
import { authPoolStatusPayload } from "../lib/reports.js";
import { isAdminEmail, signDashboardRevisionToken } from "../lib/company-auth.js";

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
  dashboardRevision,
  authPoolInvalidatedNotifications,
  authPoolFetchLog,
  poolHealthSnapshots,
  authPoolStatusPayload,
  getFeatureFlag,
  isAdminEmail,
  signDashboardRevisionToken,
}) {
  try {
    const authContext = await deps.authenticateApiRequest(req);
    if (!authContext) {
      deps.sendUnauthorized(res);
      return;
    }

    if (!deps.dbConfigured()) {
      const dataset = deps.authPoolStatusPayload([], []);
      dataset.dashboard_revision = 0;
      dataset.dashboard_updated_at = null;
      dataset.dashboard_revision_token = deps.signDashboardRevisionToken(authContext.email);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(deps.withTokenUpgrade(dataset, authContext)));
      return;
    }
    let snapshot = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revisionBefore = await deps.dashboardRevision();
      const [entries, reports, invalidatedStates, fetchLog, healthHistory, disabledRefreshToken] = await Promise.all([
        deps.authPoolEntrySummaries(),
        deps.authPoolQuotaLatest(),
        deps.authPoolInvalidatedNotifications(),
        deps.authPoolFetchLog({ limit: 50 }),
        deps.poolHealthSnapshots({ limit: 96 }),
        deps.getFeatureFlag("disabled_refresh_token", false),
      ]);
      const revisionAfter = await deps.dashboardRevision();
      if (revisionBefore.revision === revisionAfter.revision) {
        snapshot = {
          entries,
          reports,
          invalidatedStates,
          fetchLog,
          healthHistory,
          disabledRefreshToken,
          revision: revisionAfter,
        };
        break;
      }
    }
    if (!snapshot) {
      throw new Error("dashboard changed while status was being assembled");
    }
    const { entries, reports, invalidatedStates, fetchLog, healthHistory, disabledRefreshToken, revision } = snapshot;
    const dataset = deps.authPoolStatusPayload(entries, reports, new Date().toISOString(), invalidatedStates);
    dataset.fetch_log = fetchLog;
    dataset.health_history = healthHistory;
    dataset.dashboard_revision = revision.revision;
    dataset.dashboard_updated_at = revision.updated_at;
    dataset.dashboard_revision_token = deps.signDashboardRevisionToken(authContext.email);
    dataset.viewer_email = authContext.email;
    dataset.disabled_refresh_token = disabledRefreshToken;
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
