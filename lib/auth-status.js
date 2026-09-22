export const REFRESH_TOKEN_REJECTED_ERROR = "refresh_token_rejected";

// A claude access token the provider refuses for inference. For the pool it is as unusable as a 401,
// and the remedy is the same: a central refresh, asking for the grant's own scopes, mints a token that
// can infer if the grant still allows it; if not, the refresh fails and the owner is asked to re-login.
export const CLAUDE_INFERENCE_SCOPE_MISSING_ERROR = "claude access token lacks inference scope";

const AUTH_INVALIDATION_ERRORS = new Set([
  REFRESH_TOKEN_REJECTED_ERROR,
  "auth invalidated (token_invalidated)",
  "auth failed (401 unauthorized)",
  "claude auth invalid (authentication_error)",
  CLAUDE_INFERENCE_SCOPE_MISSING_ERROR,
]);

// The client could not learn WHOSE credential it runs (no email in its local identity record). That is a
// statement about the machine's bookkeeping, not about the token -- and it is exactly the question the
// hub answers when it resolves a report by token fingerprint.
export const CLAUDE_EMAIL_UNAVAILABLE_ERROR = "claude auth email unavailable";

const NON_REFRESH_HARD_AUTH_ERRORS = new Set([
  CLAUDE_EMAIL_UNAVAILABLE_ERROR,
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

// Whether an upload that was not refreshed on the way in ends the refresh-token verdict recorded
// against the credential it replaced.
//
// The verdict is sticky because a client's healthy probe says nothing about the POOLED refresh token.
// An upload the hub refreshes lifts it by that refresh. Two kinds of upload are not refreshed: a
// claude upload is verified by probing its access token (upload.js explains why), and a codex custody
// upload is deferred until the uploader's app-server hands the refresh token over (SYSTEM_DESIGN
// §3.5). Without this, nothing either owner did could end a rejection: claude-leizhang0121 re-logged
// in on 2026-09-17 and bd@stardust.ai (codex) re-uploaded on 2026-09-22, each put a working refresh
// token in the pool, and each was still told "refresh token rejected" -- the verdict belonged to the
// token that upload had just replaced.
//
// Every condition is load-bearing. The upload must have replaced the pooled blob (a deduplicated one
// changed nothing), carry a real refresh token (not the hub placeholder), and that token must differ from the one the verdict
// is about -- a re-upload of the refused token with fresher metadata is exactly the flip-flop that kept
// claude-qpt0311 "just invalidated" for ten days. And the access token beside it must have been seen
// working: evidence the upload is a live credential and not a stale copy of a dead one. What the
// refresh token itself is worth is still unproven, so the report stays "unverified" and the first
// central refresh that presents it records a fresh verdict against THIS token if it is refused.
export function uploadSupersedesRefreshVerdict({ accessTokenLive, deduplicated, incomingHasRealRefreshToken, previousRefreshFingerprint, incomingRefreshFingerprint }) {
  return Boolean(
    accessTokenLive &&
    !deduplicated &&
    // A borrower's AT-only upload is merged into the stored blob, not refused, and its placeholder
    // fingerprints differently from the real token -- it must not read as a new generation.
    incomingHasRealRefreshToken &&
    incomingRefreshFingerprint &&
    incomingRefreshFingerprint !== previousRefreshFingerprint
  );
}

// The codex half of uploadSupersedesRefreshVerdict's "access token seen working". A deferred codex
// upload is never refreshed or probed by the hub -- presenting it could collide with the app-server
// still holding it -- but the guard bundles the probe it just ran, and that probe names the access
// token it ran on. It is a witness only for the token being uploaded: if the CLI rotated the file
// between probe and upload the fingerprints differ and the upload proves nothing.
export function bundledProbeWitnessesAccessToken({ quotaPayload, uploadedAccessTokenFingerprint }) {
  return Boolean(
    quotaPayload?.status === "ok" &&
    uploadedAccessTokenFingerprint &&
    quotaPayload.access_token_fingerprint === uploadedAccessTokenFingerprint
  );
}
