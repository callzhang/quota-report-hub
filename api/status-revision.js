import { authenticateApiRequest, sendServiceUnavailable, sendUnauthorized, withTokenUpgrade } from "../lib/api-auth.js";
import { dashboardRevision } from "../lib/db.js";

export default async function handler(req, res) {
  return statusRevisionHandlerImpl(req, res);
}

export async function statusRevisionHandlerImpl(req, res, deps = {
  authenticateApiRequest,
  sendServiceUnavailable,
  sendUnauthorized,
  withTokenUpgrade,
  dashboardRevision,
}) {
  try {
    const authContext = await deps.authenticateApiRequest(req);
    if (!authContext) {
      deps.sendUnauthorized(res);
      return;
    }

    const revision = await deps.dashboardRevision();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(deps.withTokenUpgrade({
      revision: revision.revision,
      updated_at: revision.updated_at,
    }, authContext)));
  } catch (error) {
    console.error(error);
    deps.sendServiceUnavailable(res, error);
  }
}
