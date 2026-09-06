import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import { companyEmailAllowed, normalizeEmail } from "../../lib/company-auth.js";
import { addAdmin, adminRole, allFeatureFlags, dbConfigured, listAdmins, removeAdmin, setFeatureFlag } from "../../lib/db.js";
import { readJsonBody } from "../../lib/http.js";

// Flags an admin is allowed to flip at runtime.
const ALLOWED_FLAGS = new Set(["disabled_refresh_token", "require_contribution"]);

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  const authContext = await authenticateApiRequest(req);
  if (!authContext) {
    sendUnauthorized(res);
    return;
  }
  if (!dbConfigured()) {
    json(res, 500, { error: "Feature flags are not configured" });
    return;
  }

  const role = await adminRole(authContext.email);

  if (req.method === "GET") {
    json(res, 200, withTokenUpgrade({
      ok: true,
      flags: await allFeatureFlags(),
      is_admin: role !== null,
      admin_role: role,
      // The list is for the admin panel only; other viewers have no reason to see who administers.
      ...(role !== null ? { admins: await listAdmins() } : {}),
    }, authContext));
    return;
  }

  if (req.method === "POST") {
    if (role === null) {
      json(res, 403, { error: "Only an admin may change settings" });
      return;
    }
    const body = await readJsonBody(req);

    // Admin-list changes are the owner's alone: an admin who could appoint admins would be an
    // owner in everything but name, and the whole point of the role split is that they are not.
    if (body?.add_admin !== undefined || body?.remove_admin !== undefined) {
      if (role !== "owner") {
        json(res, 403, { error: "Only the owner may change the admin list" });
        return;
      }
      if (body.add_admin !== undefined) {
        const email = normalizeEmail(body.add_admin);
        if (!companyEmailAllowed(email)) {
          json(res, 400, { error: "Admin must be a company email" });
          return;
        }
        await addAdmin({ email, addedBy: authContext.email });
      }
      if (body.remove_admin !== undefined) {
        const email = normalizeEmail(body.remove_admin);
        if ((await adminRole(email)) === "owner") {
          json(res, 400, { error: "The owner cannot be removed" });
          return;
        }
        await removeAdmin(email);
      }
      json(res, 200, withTokenUpgrade({
        ok: true,
        admin_role: role,
        admins: await listAdmins(),
        flags: await allFeatureFlags(),
      }, authContext));
      return;
    }

    const updated = {};
    for (const key of Object.keys(body || {})) {
      if (!ALLOWED_FLAGS.has(key)) {
        continue;
      }
      await setFeatureFlag(key, Boolean(body[key]), authContext.email);
      updated[key] = Boolean(body[key]);
    }
    json(res, 200, withTokenUpgrade(
      { ok: true, updated, flags: await allFeatureFlags(), admin_role: role },
      authContext,
    ));
    return;
  }

  res.statusCode = 405;
  res.setHeader("Allow", "GET, POST");
  res.end("Method Not Allowed");
}
