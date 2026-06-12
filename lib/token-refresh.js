// Server-side token refresh for the hub worker. The hub is the sole refresher in
// at_only_mode, so it holds the real refresh token and rotates centrally. Requests mirror
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
  };
}

export async function refreshClaudeToken(refreshToken, scopes = null, fetchImpl = fetch) {
  if (!refreshToken) {
    return { ok: false, auth_rejected: true, status: null, error: "no refresh token" };
  }
  const scope = Array.isArray(scopes) && scopes.length ? scopes.join(" ") : "user:inference";
  return postRefresh(
    CLAUDE_TOKEN_URL,
    { "Content-Type": "application/json", Accept: "application/json", "User-Agent": CLAUDE_USER_AGENT },
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID, scope },
    fetchImpl,
  );
}

export async function refreshCodexToken(refreshToken, fetchImpl = fetch) {
  if (!refreshToken) {
    return { ok: false, auth_rejected: true, status: null, error: "no refresh token" };
  }
  return postRefresh(
    CODEX_TOKEN_URL,
    { "Content-Type": "application/json", "User-Agent": "codex-cli" },
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CODEX_CLIENT_ID },
    fetchImpl,
  );
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
    // codex stores no explicit AT expiry; decode the id_token exp (≈ AT lifetime).
    const idToken = parsed?.tokens?.id_token;
    if (typeof idToken !== "string") return null;
    const part = idToken.split(".")[1];
    if (!part) return null;
    try {
      const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      return typeof claims.exp === "number" ? claims.exp * 1000 - now : null;
    } catch {
      return null;
    }
  }
  return null;
}
