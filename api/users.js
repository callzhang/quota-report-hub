import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../lib/api-auth.js";
import { normalizeEmail } from "../lib/company-auth.js";
import {
  adminRole,
  authPoolFetchLog,
  authUsersList,
  dbConfigured,
  listAdmins,
  setAuthUserDisabled,
} from "../lib/db.js";
import { readJsonBody } from "../lib/http.js";
import { DEMAND_SHARE_PERCENTILE, PREMIUM_RATIO_WINDOW_DAYS, teamDemand } from "../lib/premium-ratio.js";

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

// Disabling is open to every admin, not just the owner: it is the off-boarding switch, and whoever
// runs off-boarding should not need the owner online. Admins themselves cannot be disabled — that
// would let one admin lock out another, or the owner; the owner removes admin standing first.
async function changeDisabled(req, res, authContext, viewerRole) {
  if (viewerRole === null) {
    json(res, 403, { error: "Only an admin may disable users" });
    return;
  }
  const body = await readJsonBody(req);
  const email = normalizeEmail(body?.email);
  if (!email || typeof body?.disabled !== "boolean") {
    json(res, 400, { error: "email and a boolean disabled are required" });
    return;
  }
  if (body.disabled && (await adminRole(email)) !== null) {
    json(res, 400, { error: "An admin cannot be disabled; remove their admin standing first" });
    return;
  }
  if (!(await setAuthUserDisabled({ email, disabled: body.disabled, by: authContext.email }))) {
    json(res, 404, { error: "No such user" });
    return;
  }
  json(res, 200, withTokenUpgrade({ ok: true, email, disabled: body.disabled }, authContext));
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return;
  }
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
        demand_share_percentile: DEMAND_SHARE_PERCENTILE,
        demand_share_line: null,
        users: [],
        fetch_log: [],
      }, authContext))
    );
    return;
  }

  const viewerRole = await adminRole(authContext.email);
  if (req.method === "POST") {
    await changeDisabled(req, res, authContext, viewerRole);
    return;
  }

  const limitParam = Number(new URL(req.url, "http://placeholder").searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 200;

  // The same window the fetch gate prices demand over, so a reader comparing their row against the
  // notice they were sent is looking at the one number that produced it, not a near-miss of it.
  const spendSince = new Date(Date.now() - PREMIUM_RATIO_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [users, fetchLog, admins] = await Promise.all([
    authUsersList({ spendSince }),
    authPoolFetchLog({ limit, dedupe: false }),
    viewerRole !== null ? listAdmins() : [],
  ]);
  // Who administers is not a member-facing fact (§6.7), so only an admin viewer gets per-row roles —
  // which is also what the page needs to know which rows can carry a Disable control.
  if (viewerRole !== null) {
    const roles = new Map(admins.map((admin) => [admin.email, admin.role]));
    for (const user of users) user.admin_role = roles.get(user.email) || null;
  }

  // The line comes from the same function the gate uses, over the same window, so the page cannot
  // describe a different rule than the one that rations. null = nobody is above it (too few
  // spenders); JSON would turn Infinity into null anyway, this just says so.
  const { teamCost, demandCostLine } = teamDemand(users.map((user) => user.spend_usd));

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify(withTokenUpgrade({
      viewer_email: authContext.email,
      viewer_admin_role: viewerRole,
      generated_at: new Date().toISOString(),
      spend_window_days: PREMIUM_RATIO_WINDOW_DAYS,
      demand_share_percentile: DEMAND_SHARE_PERCENTILE,
      demand_share_line: teamCost > 0 && Number.isFinite(demandCostLine) ? demandCostLine / teamCost : null,
      users,
      fetch_log: fetchLog,
    }, authContext))
  );
}
