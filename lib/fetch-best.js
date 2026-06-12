export function invalidatedEntryToRepairAuth(invalidatedEntry) {
  if (!invalidatedEntry) {
    return null;
  }
  return {
    source: invalidatedEntry.source,
    account_id: invalidatedEntry.account_id,
    session_id: invalidatedEntry.session_id || "",
    email: invalidatedEntry.email,
    name: invalidatedEntry.name,
    plan_name: invalidatedEntry.plan_name,
    auth_last_refresh: invalidatedEntry.auth_last_refresh,
    digest: invalidatedEntry.digest,
    uploaded_at: invalidatedEntry.uploaded_at,
    reporter_name: invalidatedEntry.reporter_name,
    hostname: invalidatedEntry.hostname,
    latest_report: null,
    auth_json: invalidatedEntry.auth_json,
  };
}

// Placeholder refresh tokens served when disabled_refresh_token is on. They must keep the shape the
// CLI expects (codex parse-errors on a missing field and chokes on a malformed value), but
// be useless for refreshing — the hub is the sole refresher, clients re-fetch on expiry.
const STRIPPED_CODEX_REFRESH_TOKEN = "rt.1." + "A".repeat(32);
const STRIPPED_CLAUDE_REFRESH_TOKEN = "disabled-by-hub-refresh-token";

// Remove the real refresh token from an auth blob before serving it, so a borrower's CLI
// can use the access token but cannot rotate the shared refresh token.
export function stripRefreshToken(authJson, source) {
  if (!authJson) {
    return authJson;
  }
  let parsed;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return authJson;
  }
  if (source === "codex") {
    if (parsed?.tokens && "refresh_token" in parsed.tokens) {
      parsed.tokens.refresh_token = STRIPPED_CODEX_REFRESH_TOKEN;
    }
  } else if (source === "claude") {
    const oauth = parsed?.credentials?.claudeAiOauth;
    if (oauth && "refreshToken" in oauth) {
      oauth.refreshToken = STRIPPED_CLAUDE_REFRESH_TOKEN;
    }
  }
  return JSON.stringify(parsed);
}

export function repairAuthOnlyPayload(repairAuth) {
  return {
    ok: true,
    replacement: null,
    repair_auth: repairAuth,
    reason: "uploaded_auth_requires_reauth",
    message: "Your uploaded auth has been invalidated. Re-login this auth and upload fresh credentials.",
  };
}
