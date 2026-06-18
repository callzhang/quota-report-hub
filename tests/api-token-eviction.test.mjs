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

test("api tokens for one email coexist — neither issuing nor using one evicts the others", async () => {
  const db = await loadDb();
  const email = "owner@example.com";

  const t1 = await db.issueApiToken(email);
  await delay(15); // strictly later created_at
  const t2 = await db.issueApiToken(email);

  assert.notEqual(t1.token, t2.token);

  // Issuing t2 does not evict t1.
  assert.ok(await db.authenticateApiToken(t1.token), "t1 valid after t2 is issued");
  // Using t2 does not evict t1 — the whole point: a person's guard + browser + 2nd machine each hold
  // their own token under one identity and must all keep working (no ping-pong).
  assert.ok(await db.authenticateApiToken(t2.token), "t2 valid");
  assert.ok(await db.authenticateApiToken(t1.token), "t1 STILL valid after t2 was used");
  // And using t1 does not evict t2.
  assert.ok(await db.authenticateApiToken(t2.token), "t2 STILL valid after t1 was used");
});
