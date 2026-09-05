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

// The refresh token's verdict, independent of what happened when the access token was last used.
// A central refresh is the worker presenting the POOLED refresh token to the provider; its outcome is
// the most direct evidence there is and is read first. A client's own hard auth error is the next best
// (its refresh, or the token it could not renew, was refused). Only real proof -- a refresh that
// succeeded, centrally or on upload -- reads as confirmed.
export function refreshValidityFromReport(report) {
  const central = report?.usage_summary?.central_refresh;
  if (central?.auth_rejected === true) {
    return "rejected";
  }
  if (report?.status === "error" && isAuthInvalidationError(report?.error)) {
    return "rejected";
  }
  const tokenRefresh = report?.usage_summary?.token_refresh;
  if (tokenRefresh?.status === "auth_rejected") {
    return "rejected";
  }
  if (central?.ok === true || tokenRefresh?.status === "refreshed") {
    return "confirmed";
  }
  return "unverified";
}
