import test from "node:test";
import assert from "node:assert/strict";
import {
  refreshClaudeToken,
  refreshCodexToken,
  applyRefreshToBlob,
  accessTokenMsUntilExpiry,
} from "../lib/token-refresh.js";
import { deriveAuthPoolEntry, shouldReplaceAuthPoolEntry } from "../lib/auth-pool.js";

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (typeof next === "function") return next();
    return next;
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("refreshClaudeToken returns rotated tokens and sends the refresh grant", async () => {
  const fetchImpl = mockFetch([jsonResponse(200, { access_token: "NEW_AT", refresh_token: "NEW_RT", expires_in: 3600 })]);
  const result = await refreshClaudeToken("OLD_RT", null, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.access_token, "NEW_AT");
  assert.equal(result.refresh_token, "NEW_RT");
  assert.equal(fetchImpl.calls[0].body.grant_type, "refresh_token");
  assert.equal(fetchImpl.calls[0].body.refresh_token, "OLD_RT");
  assert.equal(fetchImpl.calls[0].body.scope, "user:inference");
});

test("refreshClaudeToken keeps the old RT when the response omits a new one", async () => {
  const fetchImpl = mockFetch([jsonResponse(200, { access_token: "NEW_AT" })]);
  const result = await refreshClaudeToken("OLD_RT", null, fetchImpl);
  assert.equal(result.refresh_token, "OLD_RT");
});

test("refresh flags 401 as auth_rejected and 500 as transient", async () => {
  assert.equal((await refreshCodexToken("RT", mockFetch([jsonResponse(401, {})]))).auth_rejected, true);
  assert.equal((await refreshCodexToken("RT", mockFetch([jsonResponse(500, {})]))).auth_rejected, false);
});

test("refresh returns auth_rejected without calling fetch when no RT is present", async () => {
  const fetchImpl = mockFetch([]);
  const result = await refreshClaudeToken("", null, fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.auth_rejected, true);
  assert.equal(fetchImpl.calls.length, 0);
});

test("refresh treats a thrown fetch as transient (not auth_rejected)", async () => {
  const fetchImpl = mockFetch([() => { throw new Error("network down"); }]);
  const result = await refreshCodexToken("RT", fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.auth_rejected, false);
});

test("applyRefreshToBlob updates claude tokens + expiry and preserves siblings", () => {
  const blob = JSON.stringify({
    credentials: { claudeAiOauth: { accessToken: "OLD", refreshToken: "OLD", expiresAt: 1 }, mcpOAuth: { keep: "me" } },
  });
  const out = JSON.parse(applyRefreshToBlob(blob, "claude", { access_token: "NEW_AT", refresh_token: "NEW_RT", expires_in: 3600 }, 1000));
  assert.equal(out.credentials.claudeAiOauth.accessToken, "NEW_AT");
  assert.equal(out.credentials.claudeAiOauth.refreshToken, "NEW_RT");
  assert.equal(out.credentials.claudeAiOauth.expiresAt, 1000 + 3600 * 1000);
  assert.deepEqual(out.credentials.mcpOAuth, { keep: "me" });
  // must advance the top-level mirror too, or the freshness gate drops the rotated blob (see below)
  assert.equal(out.auth_last_refresh, String(1000 + 3600 * 1000));
});

test("claude refresh write-back survives the freshness gate (regression: rotated RT used to be silently dropped)", () => {
  // A pooled claude blob. The guard sets auth_last_refresh = expiresAt (ms string).
  const stored = JSON.stringify({
    schema: "claude_credentials_v1",
    account_id: "acct-1",
    email: "owner@example.com",
    auth_last_refresh: "1781600000000",
    credentials: { claudeAiOauth: { accessToken: "AT0", refreshToken: "RT0", expiresAt: 1781600000000 } },
  });
  const existing = deriveAuthPoolEntry("claude", stored);

  // Worker central refresh: RT0 -> RT1 (RT0 now spent at the provider), expiry advances.
  const refreshedBlob = applyRefreshToBlob(
    stored,
    "claude",
    { access_token: "AT1", refresh_token: "RT1", expires_in: 28800 },
    1781620000000,
  );
  const incoming = deriveAuthPoolEntry("claude", refreshedBlob);

  // The bug: without bumping auth_last_refresh, incoming === existing -> gate returns false ->
  // the rotated blob is dropped -> the hub keeps the spent RT0 and replays it -> family revoked.
  assert.notEqual(incoming.auth_last_refresh, existing.auth_last_refresh);
  assert.ok(
    shouldReplaceAuthPoolEntry(existing, incoming),
    "refreshed claude blob must replace the stale pooled entry, else the hub replays a spent RT",
  );
});

test("applyRefreshToBlob updates codex tokens and last_refresh", () => {
  const blob = JSON.stringify({ tokens: { access_token: "OLD", refresh_token: "OLD", id_token: "OLD", account_id: "x" }, last_refresh: "old" });
  const out = JSON.parse(applyRefreshToBlob(blob, "codex", { access_token: "NEW_AT", refresh_token: "NEW_RT", id_token: "NEW_ID" }, 0));
  assert.equal(out.tokens.access_token, "NEW_AT");
  assert.equal(out.tokens.refresh_token, "NEW_RT");
  assert.equal(out.tokens.id_token, "NEW_ID");
  assert.equal(out.tokens.account_id, "x");
  assert.equal(out.last_refresh, new Date(0).toISOString());
});

test("accessTokenMsUntilExpiry reads claude expiresAt and codex access_token exp", () => {
  const claude = JSON.stringify({ credentials: { claudeAiOauth: { expiresAt: 10_000 } } });
  assert.equal(accessTokenMsUntilExpiry(claude, "claude", 4_000), 6_000);

  // codex: access_token JWT exp takes priority over id_token exp
  const atPayload = Buffer.from(JSON.stringify({ exp: 100 })).toString("base64url");
  const idPayload = Buffer.from(JSON.stringify({ exp: 5 })).toString("base64url");
  const codexBothTokens = JSON.stringify({
    tokens: {
      access_token: `h.${atPayload}.s`,
      id_token: `h.${idPayload}.s`,
    },
  });
  // access_token exp=100s, id_token exp=5s, now=0 → should use access_token → 100_000ms
  assert.equal(accessTokenMsUntilExpiry(codexBothTokens, "codex", 0), 100 * 1000);

  // codex: falls back to id_token when access_token is absent or not a decodable JWT
  const codexIdTokenOnly = JSON.stringify({ tokens: { id_token: `h.${idPayload}.s` } });
  assert.equal(accessTokenMsUntilExpiry(codexIdTokenOnly, "codex", 0), 5 * 1000);

  // codex: access_token present but not a valid JWT (e.g. opaque string) → fallback to id_token
  const codexOpaqueAt = JSON.stringify({
    tokens: {
      access_token: "not-a-jwt",
      id_token: `h.${idPayload}.s`,
    },
  });
  assert.equal(accessTokenMsUntilExpiry(codexOpaqueAt, "codex", 0), 5 * 1000);

  assert.equal(accessTokenMsUntilExpiry("not json", "claude"), null);
  assert.equal(accessTokenMsUntilExpiry(JSON.stringify({ tokens: {} }), "codex"), null);
});
