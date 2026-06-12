import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import { isAdminEmail } from "../../lib/company-auth.js";
import { allFeatureFlags, dbConfigured, setFeatureFlag } from "../../lib/db.js";
import { readJsonBody } from "../../lib/http.js";

// Flags an admin is allowed to flip at runtime.
const ALLOWED_FLAGS = new Set(["disabled_refresh_token"]);

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

  if (req.method === "GET") {
    json(res, 200, withTokenUpgrade(
      { ok: true, flags: await allFeatureFlags(), is_admin: isAdminEmail(authContext.email) },
      authContext,
    ));
    return;
  }

  if (req.method === "POST") {
    if (!isAdminEmail(authContext.email)) {
      json(res, 403, { error: "Only an admin may change feature flags" });
      return;
    }
    const body = await readJsonBody(req);
    const updated = {};
    for (const key of Object.keys(body || {})) {
      if (!ALLOWED_FLAGS.has(key)) {
        continue;
      }
      await setFeatureFlag(key, Boolean(body[key]), authContext.email);
      updated[key] = Boolean(body[key]);
    }
    json(res, 200, withTokenUpgrade(
      { ok: true, updated, flags: await allFeatureFlags() },
      authContext,
    ));
    return;
  }

  res.statusCode = 405;
  res.setHeader("Allow", "GET, POST");
  res.end("Method Not Allowed");
}
