import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Loads a fresh db.js bound to a throwaway file-backed libsql store.
async function loadDb() {
  const dir = mkdtempSync(join(tmpdir(), "qrh-token-evict-"));
  process.env.TURSO_DATABASE_URL = `file:${join(dir, "t.db")}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  process.env.TOKEN_ISSUE_KEY = "test-token-issue-key-32-bytes!!!";
  return import(`../lib/db.js?ts=${Date.now()}-${Math.round(performance.now())}`);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("token eviction happens on first USE of the new token, not on issue (no lockout)", async () => {
  const db = await loadDb();
  const email = "owner@example.com";

  const t1 = await db.issueApiToken(email);
  await delay(15); // ensure a strictly later created_at
  const t2 = await db.issueApiToken(email);

  assert.notEqual(t1.token, t2.token);
  assert.ok(t1.created_at < t2.created_at, "t2 must be newer than t1");

  // Issuing t2 must NOT have evicted t1 — the old token still works (this is the lockout fix:
  // a reissued-but-never-pasted token cannot knock out the currently-working one).
  assert.ok(await db.authenticateApiToken(t1.token), "old token still valid after a newer one is issued");

  // Using the OLDER token must not evict the newer (unused) one.
  assert.ok(await db.authenticateApiToken(t2.token), "newer token valid");

  // Now that t2 has been USED, it supersedes t1 → t1 is revoked.
  assert.equal(await db.authenticateApiToken(t1.token), null, "old token revoked once the new one is used");

  // t2 keeps working.
  assert.ok(await db.authenticateApiToken(t2.token), "new token still valid");
});
