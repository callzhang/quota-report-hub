import { allowedDomain, bearerTokenFromHeaders } from "./company-auth.js";
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
    allowed_domain: allowedDomain(),
    message: "Token invalid or expired. Request a new token by email and paste the latest one here.",
  }));
}

function unavailableReason(error) {
  const message = String(error?.message || "");
  if (message.includes("reads are blocked") || message.includes("SQL read operations are forbidden")) {
    return {
      reason: "database_reads_blocked",
      message: "Hub database reads are currently blocked by the database provider. The token was not rejected; restore the database plan or quota, then unlock again.",
    };
  }
  return {
    reason: "service_unavailable",
    message: "Hub data is temporarily unavailable. Your token was not rejected; try again after the service recovers.",
  };
}

export function sendServiceUnavailable(res, error) {
  const payload = unavailableReason(error);
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({
    ok: false,
    error: "hub_unavailable",
    ...payload,
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
