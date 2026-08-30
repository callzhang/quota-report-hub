// Server-side token refresh for the hub worker. The hub is the sole refresher in
// disabled_refresh_token, so it holds the real refresh token and rotates centrally. Requests mirror
// what the CLIs send (verified 2026-06-12).

const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_USER_AGENT = "claude-cli (quota-report-hub)";

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

async function postRefresh(url, headers, body, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (error) {
    return { ok: false, auth_rejected: false, status: null, error: String(error?.message || error).slice(0, 200) };
  }
  if (!response.ok) {
    // 400/401 = the refresh token is dead (needs owner re-login); other codes are transient.
    return { ok: false, auth_rejected: [400, 401].includes(response.status), status: response.status, error: `refresh http ${response.status}` };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!payload?.access_token) {
    return { ok: false, auth_rejected: false, status: 200, error: "no access_token in refresh response" };
  }
  return {
    ok: true,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || body.refresh_token,
    expires_in: payload.expires_in,
    id_token: payload.id_token,
    scope: payload.scope ?? null,
  };
}

// One line per provider refresh. The lifetime a provider grants depends on what we ask for, and the
// stored expiry mirrors only show the result after the fact — logging the request/response pair is
// what makes "which scope buys which lifetime" observable in the Vercel and Actions logs.
function logRefreshOutcome(source, requestedScope, result, attempt) {
  try {
    console.log(JSON.stringify({
      event: "token_refresh",
      source,
      attempt,
      requested_scope: requestedScope,
      ok: Boolean(result.ok),
      status: result.status ?? null,
      expires_in: result.expires_in ?? null,
      granted_scope: result.scope ?? null,
      auth_rejected: Boolean(result.auth_rejected),
      error: result.ok ? null : result.error || null,
    }));
  } catch {
    // Telemetry must never be able to fail a refresh.
  }
}

// The scope a claude refresh asks for decides the access token's lifetime: `user:inference` alone
// comes back with expires_in 28800 (8 h), while the CLI's own scope set mints 30-day tokens
// (measured 2026-08-27, same client_id, see AUTH_TOKENS.md §2). An 8-hour token forces the pool to
// rotate ~90x more often, and every rotation is a chance to orphan a custodian, so refresh with the
// credential's own scopes and keep the narrow set as a fallback for grants that no longer carry them.
const CLAUDE_FALLBACK_SCOPE = "user:inference";

// The scopes the stored credential was actually granted, or null when the blob does not record them.
export function claudeScopesFromAuthBlob(authJson) {
  let parsed;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return null;
  }
  const scopes = parsed?.credentials?.claudeAiOauth?.scopes;
  return Array.isArray(scopes) && scopes.length ? scopes : null;
}

export async function refreshClaudeToken(refreshToken, scopes = null, fetchImpl = fetch) {
  if (!refreshToken) {
    return { ok: false, auth_rejected: true, status: null, error: "no refresh token" };
  }
  const requested = Array.isArray(scopes) && scopes.length ? scopes.join(" ") : CLAUDE_FALLBACK_SCOPE;
  const call = (scope) => postRefresh(
    CLAUDE_TOKEN_URL,
    { "Content-Type": "application/json", Accept: "application/json", "User-Agent": CLAUDE_USER_AGENT },
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID, scope },
    fetchImpl,
  );
  const first = await call(requested);
  logRefreshOutcome("claude", requested, first, 1);
  // A rejected refresh does not consume the token, so retrying narrower costs one request and cannot
  // orphan the grant. Only meaningful when the scope we asked for was not already the fallback.
  if (first.ok || !first.auth_rejected || requested === CLAUDE_FALLBACK_SCOPE) {
    return first;
  }
  const second = await call(CLAUDE_FALLBACK_SCOPE);
  logRefreshOutcome("claude", CLAUDE_FALLBACK_SCOPE, second, 2);
  return second;
}

export async function refreshCodexToken(refreshToken, fetchImpl = fetch) {
  if (!refreshToken) {
    return { ok: false, auth_rejected: true, status: null, error: "no refresh token" };
  }
  const result = await postRefresh(
    CODEX_TOKEN_URL,
    { "Content-Type": "application/json", "User-Agent": "codex-cli" },
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CODEX_CLIENT_ID },
    fetchImpl,
  );
  logRefreshOutcome("codex", null, result, 1);
  return result;
}

// Read-only liveness check for a claude access token. Costs nothing and consumes nothing — the
// opposite of proving a credential by spending its refresh token.
//
// Why this is enough on upload: a refresh REVOKES the access tokens already issued for the grant
// (§3.5), so an access token that still answers is itself evidence that nobody has refreshed the
// grant since it was minted — which means the refresh token beside it has not been spent either.
// The access token is a live witness for the refresh token.
//
// The one case it misses is a session revoked out-of-band (owner logged out elsewhere), which kills
// refresh tokens while already-issued access tokens keep working to their expiry. That costs
// borrowers nothing: they use the access token, and the refresh token only matters for renewal, so
// the truth surfaces at the first renewal that fails rather than at upload.
export async function probeClaudeAccessToken(authJson, fetchImpl = fetch) {
  let accessToken;
  try {
    accessToken = JSON.parse(authJson)?.credentials?.claudeAiOauth?.accessToken;
  } catch {
    return { ok: false, status: null, reason: "unparseable" };
  }
  if (!accessToken) return { ok: false, status: null, reason: "no_access_token" };
  try {
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/profile", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    return {
      ok: response.ok,
      status: response.status,
      // 401 is the only answer that means "this credential is not usable"; a 5xx or a rate limit is
      // the network having a bad day and must not be read as a dead account.
      rejected: response.status === 401,
    };
  } catch (error) {
    return { ok: false, status: null, reason: String(error?.message || error).slice(0, 120) };
  }
}

function refreshTokenFromAuthBlob(authJson, source) {
  let parsed;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return null;
  }
  if (source === "claude") return parsed?.credentials?.claudeAiOauth?.refreshToken || null;
  if (source === "codex") return parsed?.tokens?.refresh_token || null;
  return null;
}

// Verify a real uploaded refresh token immediately and return the provider's rotated blob.
// AT-only borrowers intentionally remain unverified so they cannot overwrite the pooled RT.
export async function verifyAndRefreshAuthBlob(authJson, source, fetchImpl = fetch) {
  const refreshToken = refreshTokenFromAuthBlob(authJson, source);
  if (!refreshToken) {
    return { ok: false, attempted: false, reason: "no_refresh_token", auth_json: authJson };
  }
  const refreshed = source === "claude"
    ? await refreshClaudeToken(refreshToken, claudeScopesFromAuthBlob(authJson), fetchImpl)
    : source === "codex"
      ? await refreshCodexToken(refreshToken, fetchImpl)
      : { ok: false, attempted: false, reason: "unsupported_source" };
  if (!refreshed.ok) {
    return {
      ok: false,
      attempted: true,
      auth_rejected: Boolean(refreshed.auth_rejected),
      status: refreshed.status,
      error: refreshed.error,
    };
  }
  return {
    ok: true,
    attempted: true,
    auth_json: applyRefreshToBlob(authJson, source, refreshed),
  };
}

// Apply a successful refresh result back into the stored auth blob (preserving everything
// else, e.g. claude's mcpOAuth section), returning the new auth_json string.
export function applyRefreshToBlob(authJson, source, refreshed, now = Date.now()) {
  const parsed = JSON.parse(authJson);
  if (source === "claude") {
    const oauth = parsed?.credentials?.claudeAiOauth;
    if (oauth) {
      oauth.accessToken = refreshed.access_token;
      oauth.refreshToken = refreshed.refresh_token;
      if (refreshed.expires_in) {
        oauth.expiresAt = now + Number(refreshed.expires_in) * 1000;
      }
      // Keep the top-level `auth_last_refresh` mirror in sync (the guard sets it = expiresAt). Without
      // this, the freshness gate `shouldReplaceAuthPoolEntry` sees an UNCHANGED value and silently drops
      // this rotated blob on write-back — the hub then keeps the now-spent RT and replays it next cycle
      // → reuse → family revoked → authentication_error. (Codex bumps its own `last_refresh` below; the
      // claude branch must keep its mirror current too, or central refresh can never persist.)
      parsed.auth_last_refresh = String(oauth.expiresAt);
    }
  } else if (source === "codex") {
    if (parsed?.tokens) {
      parsed.tokens.access_token = refreshed.access_token;
      parsed.tokens.refresh_token = refreshed.refresh_token;
      if (refreshed.id_token) {
        parsed.tokens.id_token = refreshed.id_token;
      }
    }
    parsed.last_refresh = new Date(now).toISOString();
  }
  return JSON.stringify(parsed);
}

function jwtExpMs(token, now) {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 - now : null;
  } catch {
    return null;
  }
}

// Milliseconds until the access token expires, or null if unknown. Used to decide whether the
// worker should proactively refresh before serving.
export function accessTokenMsUntilExpiry(authJson, source, now = Date.now()) {
  let parsed;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return null;
  }
  if (source === "claude") {
    const expiresAt = parsed?.credentials?.claudeAiOauth?.expiresAt;
    return typeof expiresAt === "number" ? expiresAt - now : null;
  }
  if (source === "codex") {
    // codex access_token is a JWT with a real ~10-day exp. Decode it first.
    // Fall back to id_token only when access_token is absent or not a decodable JWT.
    const atMs = jwtExpMs(parsed?.tokens?.access_token, now);
    if (atMs !== null) return atMs;
    return jwtExpMs(parsed?.tokens?.id_token, now);
  }
  return null;
}

// Milliseconds until codex's id_token expires, or null if unknown/not applicable. id_token is a
// ~1-hour OIDC session token minted alongside access_token on every refresh. The codex CLI/app use
// ITS expiry (not access_token's ~10-day one) to decide when to self-refresh. A pooled/AT-only
// client holds a stripped placeholder refresh_token, so once id_token goes stale the client's own
// refresh attempt always fails with "Invalid refresh token" even though access_token is still
// perfectly valid. Only meaningful for codex — claude has no separate id_token in this scheme.
export function codexIdTokenMsUntilExpiry(authJson, now = Date.now()) {
  let parsed;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return null;
  }
  return jwtExpMs(parsed?.tokens?.id_token, now);
}
