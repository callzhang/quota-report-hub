import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

// The refresh-attempt log exists to tell three explanations of one dead refresh token apart: unused
// for too long (refresh_token_expired), spent by someone else (refresh_token_reused), session ended
// (refresh_token_invalidated). Everything upstream used to see only "refresh http 401". These tests
// pin that the provider's own code and the RT's idle age both reach the log.
const DB_FILE = "quota-report-hub-refresh-attempts-test.db";
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.TURSO_AUTH_TOKEN = "test-token";
// refreshTokenFingerprint keys an HMAC off this; 64 hex characters, test-only.
process.env.AUTH_POOL_ENCRYPTION_KEY = process.env.AUTH_POOL_ENCRYPTION_KEY || "0".repeat(64);
for (const suffix of ["", "-shm", "-wal"]) {
  rmSync(DB_FILE + suffix, { force: true });
}

const db = await import("../lib/db.js");
const { providerRefreshErrorCode, refreshCodexToken, verifyAndRefreshAuthBlob } = await import("../lib/token-refresh.js");
const { refreshSerializedAuthPoolEntry, refreshTokenAgeSeconds } = await import("../lib/auth-pool-refresh.js");

function refusal(status, body) {
  return async () => ({
    ok: false,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  });
}

function codexBlob(lastRefresh) {
  return JSON.stringify({ tokens: { refresh_token: "rt-real-value", access_token: "at", id_token: "id" }, last_refresh: lastRefresh });
}

test("the provider's code is read from a nested error object or a bare string, and nothing else rides along", () => {
  assert.equal(providerRefreshErrorCode({ error: { code: "refresh_token_expired", message: "x" } }), "refresh_token_expired");
  assert.equal(providerRefreshErrorCode({ error: "invalid_grant" }), "invalid_grant");
  assert.equal(providerRefreshErrorCode({ error: { code: "Refresh_Token_Reused" } }), "refresh_token_reused");
  assert.equal(providerRefreshErrorCode({ error: { code: "has spaces and a token eyJabc.def.ghi" } }), null);
  assert.equal(providerRefreshErrorCode({ error: { code: "x".repeat(81) } }), null);
  assert.equal(providerRefreshErrorCode(null), null);
  assert.equal(providerRefreshErrorCode("<html>502</html>"), null);
});

test("a refused codex refresh keeps the provider's reason instead of collapsing to 'refresh http 401'", async () => {
  const expired = await refreshCodexToken("rt", refusal(401, { error: { code: "refresh_token_expired" } }));
  assert.equal(expired.ok, false);
  assert.equal(expired.auth_rejected, true);
  assert.equal(expired.status, 401);
  assert.equal(expired.provider_error_code, "refresh_token_expired");

  const reused = await refreshCodexToken("rt", refusal(401, { error: { code: "refresh_token_reused" } }));
  assert.equal(reused.provider_error_code, "refresh_token_reused");
});

test("a gateway page with no JSON body still reports the refusal, with no code", async () => {
  const result = await refreshCodexToken("rt", refusal(502, undefined));
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.auth_rejected, false);
  assert.equal(result.provider_error_code, null);
});

test("verifyAndRefreshAuthBlob carries the code up to the routes that persist it", async () => {
  const result = await verifyAndRefreshAuthBlob(codexBlob("2026-09-21T14:17:03.219Z"), "codex", refusal(401, { error: { code: "refresh_token_invalidated" } }));
  assert.equal(result.attempted, true);
  assert.equal(result.provider_error_code, "refresh_token_invalidated");
});

test("an RT's age is how long ago the blob's last_refresh minted it — codex only", () => {
  const now = Date.parse("2026-09-23T11:27:27Z");
  assert.equal(refreshTokenAgeSeconds(codexBlob("2026-09-21T14:17:03.000Z"), "codex", now), 45 * 3600 + 10 * 60 + 24);
  // claude's field mirrors the access token's EXPIRY, a future time: an age from it would be negative
  // and look like data.
  assert.equal(refreshTokenAgeSeconds(JSON.stringify({ auth_last_refresh: "1790708346219" }), "claude", now), null);
  assert.equal(refreshTokenAgeSeconds(codexBlob("2027-01-01T00:00:00Z"), "codex", now), null);
  assert.equal(refreshTokenAgeSeconds("not json", "codex", now), null);
});

function lease() {
  return { claimLease: async () => ({ claimed: true }), releaseLease: async () => {} };
}

test("every refresh that reached the provider is recorded with the RT's age and the provider's code", async () => {
  const recorded = [];
  const now = Date.parse("2026-09-23T11:27:27Z");
  await refreshSerializedAuthPoolEntry({
    source: "codex",
    accountId: "derek@stardust.ai",
    authJson: codexBlob("2026-09-21T14:17:03.000Z"),
    ...lease(),
    refreshAuthBlob: async () => ({ ok: false, attempted: true, auth_rejected: true, status: 401, provider_error_code: "refresh_token_expired" }),
    persistRefreshedAuth: async () => assert.fail("nothing to persist for a refusal"),
    recordAttempt: async (attempt) => recorded.push(attempt),
    path: "worker",
    now: () => now,
  });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].path, "worker");
  assert.equal(recorded[0].accountId, "derek@stardust.ai");
  assert.equal(recorded[0].rtAgeSeconds, 45 * 3600 + 10 * 60 + 24);
  assert.equal(recorded[0].result.provider_error_code, "refresh_token_expired");
  assert.equal(recorded[0].attemptedAt, "2026-09-23T11:27:27.000Z");
});

test("a lease that was not won, or a superseded RT, is not a use of the token and is not recorded", async () => {
  const recorded = [];
  await refreshSerializedAuthPoolEntry({
    source: "codex",
    accountId: "a",
    authJson: codexBlob("2026-09-21T14:17:03.000Z"),
    claimLease: async () => ({ claimed: false, reason: "refresh_in_progress" }),
    releaseLease: async () => {},
    refreshAuthBlob: async () => assert.fail("must not reach the provider"),
    persistRefreshedAuth: async () => {},
    recordAttempt: async (attempt) => recorded.push(attempt),
  });
  assert.deepEqual(recorded, []);
});

test("a recorder that throws cannot stop a rotated refresh token being persisted", async () => {
  // The provider has already accepted the old RT by the time the log is written. Losing the persist
  // would strand the pool on a spent token, so telemetry must not be able to cause that.
  const persisted = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await refreshSerializedAuthPoolEntry({
      source: "codex",
      accountId: "a",
      authJson: codexBlob("2026-09-21T14:17:03.000Z"),
      ...lease(),
      refreshAuthBlob: async () => ({ ok: true, attempted: true, auth_json: '{"rotated":true}' }),
      persistRefreshedAuth: async (blob) => persisted.push(blob),
      recordAttempt: async () => {
        throw new Error("database is locked");
      },
    });
    assert.equal(result.ok, true);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(persisted, ['{"rotated":true}']);
});

test("attempts round-trip through the database, newest first, and can be filtered by account", async () => {
  await db.recordAuthPoolRefreshAttempt({
    source: "codex", accountId: "derek@stardust.ai", path: "fetch_best", attemptedAt: "2026-09-21T14:00:00.000Z",
    rtAgeSeconds: 3600, result: { ok: true, status: 200 },
  });
  await db.recordAuthPoolRefreshAttempt({
    source: "codex", accountId: "derek@stardust.ai", path: "worker", attemptedAt: "2026-09-23T11:27:27.000Z",
    rtAgeSeconds: 162624, result: { ok: false, status: 401, provider_error_code: "refresh_token_expired" },
  });
  await db.recordAuthPoolRefreshAttempt({
    source: "codex", accountId: "someone-else@stardust.ai", path: "worker", attemptedAt: "2026-09-23T11:30:00.000Z",
    rtAgeSeconds: null, result: { ok: false, status: 400 },
  });

  const mine = await db.authPoolRefreshAttempts({ accountId: "derek@stardust.ai" });
  assert.deepEqual(mine.map((row) => [row.path, row.ok, row.http_status, row.provider_error_code, row.rt_age_seconds]), [
    ["worker", false, 401, "refresh_token_expired", 162624],
    ["fetch_best", true, 200, null, 3600],
  ]);
  const all = await db.authPoolRefreshAttempts({});
  assert.equal(all.length, 3);
  assert.equal(all[0].rt_age_seconds, null);
});
