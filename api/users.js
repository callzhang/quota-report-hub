import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../lib/api-auth.js";
import {
  authPoolFetchLog,
  authUsersList,
  dbConfigured,
} from "../lib/db.js";
import { DEMAND_SHARE_TOLERANCE, PREMIUM_RATIO_WINDOW_DAYS } from "../lib/premium-ratio.js";

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
        spend_window_days: PREMIUM_RATIO_WINDOW_DAYS,
        demand_share_tolerance: DEMAND_SHARE_TOLERANCE,
        users: [],
        fetch_log: [],
      }, authContext))
    );
    return;
  }

  const limitParam = Number(new URL(req.url, "http://placeholder").searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 200;

  // The same window the fetch gate prices demand over, so a reader comparing their row against the
  // notice they were sent is looking at the one number that produced it, not a near-miss of it.
  const spendSince = new Date(Date.now() - PREMIUM_RATIO_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [users, fetchLog] = await Promise.all([
    authUsersList({ spendSince }),
    authPoolFetchLog({ limit, dedupe: false }),
  ]);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify(withTokenUpgrade({
      viewer_email: authContext.email,
      generated_at: new Date().toISOString(),
      spend_window_days: PREMIUM_RATIO_WINDOW_DAYS,
      demand_share_tolerance: DEMAND_SHARE_TOLERANCE,
      users,
      fetch_log: fetchLog,
    }, authContext))
  );
}
