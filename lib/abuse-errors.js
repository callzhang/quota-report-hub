// Ban / abuse / rate-limit class errors. These are categorically different from ordinary RT
// failures (token_invalidated / 401 / authentication_error), which mean "refresh token died" —
// NOT "the provider is pushing back on this auth". Sharing one access token across many machines
// is unique to disabled_refresh_token mode, so we watch for provider pushback explicitly.
export const ABUSE_ERROR_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /suspicious/i,
  /suspend/i,
  /\block(ed)?\b/i,
  /\bbanned?\b/i,
  /forbidden/i,
  /\b403\b/,
  /abuse/i,
];

export function isAbuseClassError(error) {
  if (!error || typeof error !== "string") {
    return false;
  }
  return ABUSE_ERROR_PATTERNS.some((p) => p.test(error));
}
