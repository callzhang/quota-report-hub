import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { mergeStrippedAccessToken, stripRefreshToken } from "../lib/fetch-best.js";

async function loadDbWithTempStore() {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-at-only-supply-test-"));
  const previous = {
    url: process.env.TURSO_DATABASE_URL,
    token: process.env.TURSO_AUTH_TOKEN,
    encryption: process.env.AUTH_POOL_ENCRYPTION_KEY,
  };
  process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "at-only.db")}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  try {
    const mod = await import(`../lib/db.js?at-only=${Date.now()}-${Math.random()}`);
    const { decryptAuthJson } = await import(`../lib/auth-pool.js?at-only=${Date.now()}-${Math.random()}`);
    const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
    return {
      mod,
      client,
      decryptAuthJson,
      cleanup() {
        if (previous.url === undefined) delete process.env.TURSO_DATABASE_URL;
        else process.env.TURSO_DATABASE_URL = previous.url;
        if (previous.token === undefined) delete process.env.TURSO_AUTH_TOKEN;
        else process.env.TURSO_AUTH_TOKEN = previous.token;
        if (previous.encryption === undefined) delete process.env.AUTH_POOL_ENCRYPTION_KEY;
        else process.env.AUTH_POOL_ENCRYPTION_KEY = previous.encryption;
        rmSync(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

const OWNER = "claude-owner@example.com";
function claudeBlob({ accessToken, refreshToken = "REAL_RT", expiresAt }) {
  return JSON.stringify({
    schema: "claude_credentials_v1",
    account_id: OWNER,
    session_id: "owner-session",
    email: "owner@example.com",
    name: "Owner Org",
    plan_name: "Max",
    auth_last_refresh: String(expiresAt),
    credentials: { claudeAiOauth: { accessToken, refreshToken, expiresAt } },
  });
}
const T0 = Date.parse("2026-09-01T00:00:00Z");
const DAY = 24 * 3600 * 1000;

test("mergeStrippedAccessToken takes a longer-lived access token and never touches the refresh token", () => {
  const stored = claudeBlob({ accessToken: "OLD_AT", expiresAt: T0 + DAY });
  const fresher = stripRefreshToken(claudeBlob({ accessToken: "NEW_AT", expiresAt: T0 + 30 * DAY }), "claude");
  const merged = JSON.parse(mergeStrippedAccessToken(stored, fresher, "claude"));
  assert.equal(merged.credentials.claudeAiOauth.accessToken, "NEW_AT");
  assert.equal(merged.credentials.claudeAiOauth.refreshToken, "REAL_RT", "the pooled RT is preserved verbatim");
  assert.equal(merged.credentials.claudeAiOauth.expiresAt, T0 + 30 * DAY);
  assert.equal(merged.auth_last_refresh, String(T0 + 30 * DAY), "the freshness mirror moves with the token");

  const staler = stripRefreshToken(claudeBlob({ accessToken: "STALE_AT", expiresAt: T0 + DAY - 1 }), "claude");
  assert.equal(mergeStrippedAccessToken(stored, staler, "claude"), null, "a token that does not outlive the pooled one is not supply");
  assert.equal(mergeStrippedAccessToken(stored, fresher, "codex"), null, "codex has nothing to merge");
  assert.equal(mergeStrippedAccessToken(null, fresher, "claude"), null);
});

// The two guards this replaces existed because a placeholder RT once reached the RT field and wiped
// the real one. The merge writes the access token and its expiry, nothing else -- so the account keeps
// its pooled RT, its owner, and its owner's machine, and only its token gets newer.
test("an access-token-only upload tops up the pooled entry's token and keeps its refresh token and owner", async () => {
  const { mod, client, decryptAuthJson, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolEntry({
      source: "claude",
      auth_json: claudeBlob({ accessToken: "POOLED_AT", expiresAt: T0 + DAY }),
      uploader_email: "owner@example.com",
      reporter_name: "owner@mbp",
      hostname: "mbp",
    });

    const result = await mod.upsertAuthPoolEntry({
      source: "claude",
      auth_json: stripRefreshToken(claudeBlob({ accessToken: "FRESH_30D_AT", expiresAt: T0 + 30 * DAY }), "claude"),
      uploader_email: "borrower@example.com",
      reporter_name: "shawn@192.168.1.2",
      hostname: "192.168.1.2",
    });
    assert.notEqual(result.rejected, true, `expected the top-up to be taken, got ${JSON.stringify(result)}`);

    const [entry] = await mod.authPoolEntries();
    const blob = JSON.parse(await decryptAuthJson(entry));
    assert.equal(blob.credentials.claudeAiOauth.accessToken, "FRESH_30D_AT");
    assert.equal(blob.credentials.claudeAiOauth.refreshToken, "REAL_RT");
    assert.equal(entry.has_refresh_token, true);
    assert.equal(entry.auth_expires_at, new Date(T0 + 30 * DAY).toISOString());
    assert.equal(entry.uploader_email, "owner@example.com", "a borrower's top-up does not make the borrower the owner");
    assert.equal(entry.reporter_name, "owner@mbp");
    assert.equal(entry.hostname, "mbp");
    // the fresh token is now known to the pool too
    const rows = await client.execute("SELECT COUNT(*) AS n FROM auth_pool_token_fingerprints WHERE source = 'claude'");
    assert.equal(Number(rows.rows[0].n), 2);
  } finally {
    cleanup();
  }
});

test("an access-token-only upload is refused when it is not fresher, or when the account is not pooled", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    const unknown = await mod.upsertAuthPoolEntry({
      source: "claude",
      auth_json: stripRefreshToken(claudeBlob({ accessToken: "AT", expiresAt: T0 + 30 * DAY }), "claude"),
      uploader_email: "borrower@example.com",
    });
    assert.deepEqual(unknown, { rejected: true, reason: "stripped_refresh_token", deduplicated: true }, "nothing to top up: no pooled entry");

    await mod.upsertAuthPoolEntry({ source: "claude", auth_json: claudeBlob({ accessToken: "POOLED_AT", expiresAt: T0 + 30 * DAY }), uploader_email: "owner@example.com" });
    const stale = await mod.upsertAuthPoolEntry({
      source: "claude",
      auth_json: stripRefreshToken(claudeBlob({ accessToken: "OLDER_AT", expiresAt: T0 + DAY }), "claude"),
      uploader_email: "borrower@example.com",
    });
    assert.deepEqual(stale, { rejected: true, reason: "stripped_access_token_not_newer", deduplicated: true });
    const [entry] = await mod.authPoolEntries();
    assert.equal(entry.auth_expires_at, new Date(T0 + 30 * DAY).toISOString(), "the pooled token is untouched");
  } finally {
    cleanup();
  }
});
