import { bearerTokenFromHeaders } from "./company-auth.js";
import { authenticateOrUpgradeApiToken } from "./db.js";

export async function authenticateApiRequest(req) {
  return authenticateOrUpgradeApiToken(bearerTokenFromHeaders(req.headers));
}

export function sendUnauthorized(res) {
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({
    ok: false,
    error: "token_invalidated",
    reason: "token_invalidated",
    message: "Token invalid or expired. Request a new token by email and paste the latest one here.",
  }));
}

export function withTokenUpgrade(payload, authContext) {
  if (!authContext?.token_upgrade) {
    return payload;
  }
  return {
    ...payload,
    auth_pool_user_token: authContext.token_upgrade.auth_pool_user_token,
    token_upgrade: {
      email: authContext.token_upgrade.email,
      created_at: authContext.token_upgrade.created_at,
      reason: authContext.token_upgrade.reason,
    },
  };
}
