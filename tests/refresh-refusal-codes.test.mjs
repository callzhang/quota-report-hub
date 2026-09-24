import test from "node:test";
import assert from "node:assert/strict";

process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-report-hub-test.db";
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";
const { isKnownRefused, hasRealRefreshToken, summarise } = await import("../scripts/refresh_refusal_codes.mjs");

const REFUSED = { source: "codex", reported_at: "2026-09-23T11:27:27Z", usage_summary: { central_refresh: { attempted: true, auth_rejected: true } } };
const STORED_EARLIER = { uploaded_at: "2026-08-17T03:35:46Z", refresh_handoff_state: null };

test("a refusal reported after the current blob was stored, on a non-pending entry, is known", () => {
  assert.equal(isKnownRefused(REFUSED, STORED_EARLIER), true);
});

test("a pending entry is never selected: its refusal is older than the RT now stored", () => {
  // hr@stardust.ai and projects@stardust.ai on 2026-09-23: re-logged-in and uploaded (pending) beside
  // a sticky "refused" verdict about the previous token. Presenting the new one would rotate it and lose it.
  assert.equal(isKnownRefused(REFUSED, { uploaded_at: "2026-09-22T22:11:05Z", refresh_handoff_state: "pending" }), false);
});

test("a refusal that predates the stored blob is about a different token", () => {
  assert.equal(isKnownRefused(REFUSED, { uploaded_at: "2026-09-24T00:00:00Z", refresh_handoff_state: null }), false);
});

test("never-presented, transient, claude and orphaned entries are not selected", () => {
  const transient = { ...REFUSED, usage_summary: { central_refresh: { attempted: true, auth_rejected: false } } };
  const untried = { ...REFUSED, usage_summary: null };
  assert.equal(isKnownRefused(transient, STORED_EARLIER), false);
  assert.equal(isKnownRefused(untried, STORED_EARLIER), false);
  assert.equal(isKnownRefused({ ...REFUSED, source: "claude" }, STORED_EARLIER), false);
  assert.equal(isKnownRefused(REFUSED, null), false);
  assert.equal(isKnownRefused({ ...REFUSED, reported_at: "not a date" }, STORED_EARLIER), false);
});

function blobWith(refreshToken) {
  return JSON.stringify({ tokens: { refresh_token: refreshToken, access_token: "at", id_token: "id" } });
}

test("the AT-only placeholder and an empty token are not real refresh tokens", () => {
  assert.equal(hasRealRefreshToken(blobWith("rt.1." + "A".repeat(32))), false);
  assert.equal(hasRealRefreshToken(blobWith("")), false);
  assert.equal(hasRealRefreshToken(blobWith("   ")), false);
});

test("a real refresh token that happens to start with rt.1. is still real", () => {
  // The format's own version prefix. A startsWith("rt.1.") test — this script's first version —
  // skipped every real token as a placeholder and reported "no real refresh token" for all five.
  assert.equal(hasRealRefreshToken(blobWith("rt.1." + "Zq8Xv2".repeat(20))), true);
  assert.equal(hasRealRefreshToken(blobWith("rt-some-real-value")), true);
});

test("the tally counts by provider code and names a missing one", () => {
  assert.deepEqual(
    summarise([{ code: "refresh_token_expired" }, { code: "refresh_token_expired" }, { code: "refresh_token_reused" }, { code: null }]),
    { refresh_token_expired: 2, refresh_token_reused: 1, "(no code in body)": 1 },
  );
});
