import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../lib/api-auth.js";
import {
  authPoolFetchLog,
  authUsersList,
  dbConfigured,
} from "../lib/db.js";

export default async function handler(req, res) {
  const authContext = await authenticateApiRequest(req);
  if (!authContext) {
    sendUnauthorized(res);
    return;
  }

  if (!dbConfigured()) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify(withTokenUpgrade({
        viewer_email: authContext.email,
        generated_at: new Date().toISOString(),
        users: [],
        fetch_log: [],
      }, authContext))
    );
    return;
  }

  const limitParam = Number(new URL(req.url, "http://placeholder").searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 200;

  const [users, fetchLog] = await Promise.all([
    authUsersList(),
    authPoolFetchLog({ limit }),
  ]);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify(withTokenUpgrade({
      viewer_email: authContext.email,
      generated_at: new Date().toISOString(),
      users,
      fetch_log: fetchLog,
    }, authContext))
  );
}
