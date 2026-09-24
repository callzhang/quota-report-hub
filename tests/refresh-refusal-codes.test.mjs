import test from "node:test";
import assert from "node:assert/strict";

process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-report-hub-test.db";
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";
const { refusedAccountIds, isRealRefreshToken, summarise } = await import("../scripts/refresh_refusal_codes.mjs");

test("only codex accounts whose central refresh the provider refused are selected", () => {
  const ids = refusedAccountIds([
    { source: "codex", account_id: "refused", usage_summary: { central_refresh: { attempted: true, auth_rejected: true } } },
    { source: "codex", account_id: "transient", usage_summary: { central_refresh: { attempted: true, auth_rejected: false } } },
    { source: "codex", account_id: "never-tried", usage_summary: null },
    { source: "claude", account_id: "claude-refused", usage_summary: { central_refresh: { auth_rejected: true } } },
    { source: "codex", account_id: "pending-untested", usage_summary: { central_refresh: { attempted: false } } },
  ]);

  // A token the hub has never presented is not known to be dead, and spending it would destroy it.
  assert.deepEqual(ids, ["refused"]);
});

test("the AT-only placeholder and an empty token are not real refresh tokens", () => {
  assert.equal(isRealRefreshToken("rt.1." + "A".repeat(32)), false);
  assert.equal(isRealRefreshToken(""), false);
  assert.equal(isRealRefreshToken(null), false);
  assert.equal(isRealRefreshToken("rt-some-real-value"), true);
});

test("the tally counts by provider code and names a missing one", () => {
  assert.deepEqual(
    summarise([{ code: "refresh_token_expired" }, { code: "refresh_token_expired" }, { code: "refresh_token_reused" }, { code: null }]),
    { refresh_token_expired: 2, refresh_token_reused: 1, "(no code in body)": 1 },
  );
});
