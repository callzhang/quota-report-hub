export const REFRESH_TOKEN_REJECTED_ERROR = "refresh_token_rejected";

const AUTH_INVALIDATION_ERRORS = new Set([
  REFRESH_TOKEN_REJECTED_ERROR,
  "auth invalidated (token_invalidated)",
  "auth failed (401 unauthorized)",
  "claude auth invalid (authentication_error)",
]);

const NON_REFRESH_HARD_AUTH_ERRORS = new Set([
  "claude auth email unavailable",
]);

export function isAuthInvalidationError(error) {
  return AUTH_INVALIDATION_ERRORS.has(String(error || ""));
}

export function isHardAuthError(error, { includeNonRefresh = false } = {}) {
  const normalized = String(error || "");
  return AUTH_INVALIDATION_ERRORS.has(normalized) || (includeNonRefresh && NON_REFRESH_HARD_AUTH_ERRORS.has(normalized));
}

export function refreshValidityFromReport(report) {
  if (report?.status === "error" && isAuthInvalidationError(report?.error)) {
    return "rejected";
  }
  const tokenRefresh = report?.usage_summary?.token_refresh;
  if (tokenRefresh?.status === "refreshed") {
    return "confirmed";
  }
  if (tokenRefresh?.status === "auth_rejected") {
    return "rejected";
  }
  return "unverified";
}
