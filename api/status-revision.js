import { sendServiceUnavailable, sendUnauthorized } from "../lib/api-auth.js";
import { bearerTokenFromHeaders, verifyDashboardRevisionToken } from "../lib/company-auth.js";
import { dashboardRevision } from "../lib/db.js";

export default async function handler(req, res) {
  return statusRevisionHandlerImpl(req, res);
}

export function authenticateDashboardRevisionRequest(req) {
  return verifyDashboardRevisionToken(bearerTokenFromHeaders(req.headers));
}

export async function statusRevisionHandlerImpl(req, res, deps = {
  authenticateDashboardRevisionRequest,
  sendServiceUnavailable,
  sendUnauthorized,
  dashboardRevision,
}) {
  try {
    const authContext = deps.authenticateDashboardRevisionRequest(req);
    if (!authContext) {
      deps.sendUnauthorized(res);
      return;
    }

    const revision = await deps.dashboardRevision();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      revision: revision.revision,
      updated_at: revision.updated_at,
    }));
  } catch (error) {
    console.error(error);
    deps.sendServiceUnavailable(res, error);
  }
}
