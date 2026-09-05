import { createHash } from "node:crypto";

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

// True when an auth blob carries a hub-issued placeholder refresh token (i.e. it came from a
// disabled_refresh_token serve). Such a blob must never be written back into the pool: it has
// no usable refresh token, so accepting it would overwrite the real shared RT and leave the
// hub unable to refresh that account centrally — poisoning the whole pool entry.
export function isStrippedRefreshToken(authJson, source) {
  if (!authJson) {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return false;
  }
  // "No usable real refresh token" = the hub placeholder OR empty/absent/whitespace. Any of these,
  // if written back, overwrites the real shared RT with nothing and leaves the hub unable to refresh
  // centrally. The Claude Desktop app rewrites the CLI keychain credential access-token-only (RT=""),
  // and the guard would otherwise upload that empty RT — so reject empty/absent, not just the literal
  // placeholder.
  const noUsableRt = (rt, placeholder) => !rt || !String(rt).trim() || rt === placeholder;
  if (source === "codex") {
    return noUsableRt(parsed?.tokens?.refresh_token, STRIPPED_CODEX_REFRESH_TOKEN);
  }
  if (source === "claude") {
    return noUsableRt(parsed?.credentials?.claudeAiOauth?.refreshToken, STRIPPED_CLAUDE_REFRESH_TOKEN);
  }
  return false;
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

// A stable, non-secret name for an access token: SHA-256 of the token itself. The client computes the
// same digest over the token it is running (skills/quota-reporter: claude_access_token_fingerprint), so
// the hub can recognise which of the tokens it has held produced a given report without either side
// ever sending the token. Both blob shapes: claude {credentials.claudeAiOauth.accessToken} and codex
// {tokens.access_token}.
export function accessTokenFingerprint(authJson, source) {
  if (!authJson) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return null;
  }
  const token = source === "codex"
    ? parsed?.tokens?.access_token
    : parsed?.credentials?.claudeAiOauth?.accessToken;
  if (!token || !String(token).trim()) {
    return null;
  }
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

// Take the access token from an access-token-only upload into the blob the pool already holds for
// that account, leaving the pooled refresh token exactly as it is. Only a token that outlives the
// pooled one is worth taking; anything else is a stale copy of what the pool served. Claude only:
// a codex access token is refreshed hourly by every codex client, so an AT-only codex upload is
// never fresher than the pool and there is nothing to merge.
export function mergeStrippedAccessToken(storedAuthJson, strippedAuthJson, source) {
  if (source !== "claude" || !storedAuthJson || !strippedAuthJson) {
    return null;
  }
  let stored;
  let incoming;
  try {
    stored = JSON.parse(storedAuthJson);
    incoming = JSON.parse(strippedAuthJson);
  } catch {
    return null;
  }
  const storedOauth = stored?.credentials?.claudeAiOauth;
  const incomingOauth = incoming?.credentials?.claudeAiOauth;
  if (!storedOauth || !incomingOauth?.accessToken || !String(incomingOauth.accessToken).trim()) {
    return null;
  }
  const incomingExpiresAt = Number(incomingOauth.expiresAt);
  const storedExpiresAt = Number(storedOauth.expiresAt);
  if (!Number.isFinite(incomingExpiresAt) || (Number.isFinite(storedExpiresAt) && incomingExpiresAt <= storedExpiresAt)) {
    return null;
  }
  storedOauth.accessToken = incomingOauth.accessToken;
  storedOauth.expiresAt = incomingExpiresAt;
  // The freshness gate compares this mirror, not expiresAt; leaving it behind drops the write.
  stored.auth_last_refresh = String(incomingExpiresAt);
  return JSON.stringify(stored);
}
