import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessTokenFingerprint } from "../lib/fetch-best.js";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

async function loadDbWithTempStore() {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-token-fingerprint-test-"));
  const previous = {
    url: process.env.TURSO_DATABASE_URL,
    token: process.env.TURSO_AUTH_TOKEN,
    encryption: process.env.AUTH_POOL_ENCRYPTION_KEY,
  };
  process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "token-fingerprint.db")}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  try {
    const mod = await import(`../lib/db.js?token-fingerprint=${Date.now()}-${Math.random()}`);
    return {
      mod,
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

function claudeBlob(accountId, accessToken) {
  return JSON.stringify({
    schema: "claude_credentials_v1",
    account_id: accountId,
    session_id: `${accountId}-session`,
    email: accountId.replace(/^claude-/, ""),
    name: "Owner Org",
    plan_name: "Max",
    auth_last_refresh: "1776668828033",
    credentials: { claudeAiOauth: { accessToken, refreshToken: "a-real-refresh-token", expiresAt: 1776668828033 } },
  });
}

test("accessTokenFingerprint names the access token in either blob shape and nothing else", () => {
  assert.equal(accessTokenFingerprint(claudeBlob("claude-a@example.com", "tok-a"), "claude"), sha256("tok-a"));
  assert.equal(accessTokenFingerprint(JSON.stringify({ tokens: { access_token: "codex-tok" } }), "codex"), sha256("codex-tok"));
  assert.equal(accessTokenFingerprint(JSON.stringify({ credentials: { claudeAiOauth: { accessToken: "  " } } }), "claude"), null);
  assert.equal(accessTokenFingerprint("not json", "claude"), null);
  assert.equal(accessTokenFingerprint(null, "claude"), null);
});

// The pool learns whose token it is holding the moment it holds it. That single write point covers
// everything the hub can later hand out, so a report carrying the fingerprint of any token that was
// ever pooled resolves to its account -- however many rotations ago that token was current.
test("storing an auth records its access token against its account, and older tokens stay resolvable", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolEntry({
      source: "claude",
      auth_json: claudeBlob("claude-owner@example.com", "first-access-token"),
      uploader_email: "owner@example.com",
      reporter_name: "owner@mbp",
      hostname: "mbp",
    });
    assert.deepEqual(
      await mod.authPoolTokenOwner("claude", sha256("first-access-token")),
      { account_id: "claude-owner@example.com" }
    );

    // a central refresh rotates the pooled token; a borrower may still be running the first one
    await mod.upsertAuthPoolEntry({
      source: "claude",
      auth_json: claudeBlob("claude-owner@example.com", "rotated-access-token"),
      reporter_name: "hub@refresh",
      hostname: "hub",
    });
    assert.deepEqual(await mod.authPoolTokenOwner("claude", sha256("rotated-access-token")), { account_id: "claude-owner@example.com" });
    assert.deepEqual(
      await mod.authPoolTokenOwner("claude", sha256("first-access-token")),
      { account_id: "claude-owner@example.com" },
      "a rotated-past token still resolves: borrowers keep running it"
    );

    assert.equal(await mod.authPoolTokenOwner("claude", sha256("never-pooled")), null);
  } finally {
    cleanup();
  }
});
