import test from "node:test";
import assert from "node:assert/strict";
import { refreshSerializedAuthPoolEntry } from "../lib/auth-pool-refresh.js";

process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);

test("a leased refresh refuses a blob whose RT generation has already moved", async () => {
  let refreshCalls = 0;
  let releaseCalls = 0;
  const result = await refreshSerializedAuthPoolEntry({
    source: "codex",
    accountId: "owner@example.com",
    authJson: JSON.stringify({ tokens: { refresh_token: "rt-stale" } }),
    claimLease: async () => ({ claimed: true, reason: null }),
    releaseLease: async () => { releaseCalls += 1; },
    loadCurrentAuthJson: async () => JSON.stringify({ tokens: { refresh_token: "rt-current" } }),
    refreshAuthBlob: async () => { refreshCalls += 1; return { ok: true, auth_json: "unreachable" }; },
    persistRefreshedAuth: async () => assert.fail("a stale RT must never be written back"),
  });

  assert.deepEqual(result, { ok: false, attempted: false, reason: "refresh_superseded" });
  assert.equal(refreshCalls, 0);
  assert.equal(releaseCalls, 1);
});

test("a leased refresh persists exactly one provider rotation", async () => {
  const authJson = JSON.stringify({ tokens: { refresh_token: "rt-current" } });
  let persisted = null;
  const result = await refreshSerializedAuthPoolEntry({
    source: "codex",
    accountId: "owner@example.com",
    authJson,
    claimLease: async () => ({ claimed: true, reason: null }),
    releaseLease: async () => {},
    loadCurrentAuthJson: async () => authJson,
    refreshAuthBlob: async () => ({ ok: true, attempted: true, auth_json: "rotated-auth" }),
    persistRefreshedAuth: async (refreshedAuthJson) => { persisted = refreshedAuthJson; },
  });

  assert.deepEqual(result, { ok: true, attempted: true, auth_json: "rotated-auth" });
  assert.equal(persisted, "rotated-auth");
});
