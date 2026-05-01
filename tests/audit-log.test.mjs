import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadDbWithTempStore() {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-audit-test-"));
  const dbPath = join(tempDir, "audit.db");
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  try {
    const mod = await import(`../lib/db.js?ts=${Date.now()}`);
    return {
      mod,
      cleanup() {
        if (previousUrl === undefined) {
          delete process.env.TURSO_DATABASE_URL;
        } else {
          process.env.TURSO_DATABASE_URL = previousUrl;
        }
        if (previousToken === undefined) {
          delete process.env.TURSO_AUTH_TOKEN;
        } else {
          process.env.TURSO_AUTH_TOKEN = previousToken;
        }
        rmSync(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

test("recordAuthPoolFetch persists served entries and shows them in authPoolFetchLog", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.recordAuthPoolFetch({
      requesterEmail: "Alice@Stardust.AI",
      source: "codex",
      servedEntry: {
        account_id: "acct-1",
        email: "shared@stardust.ai",
        uploader_email: "bob@stardust.ai",
        digest: "deadbeef",
      },
      reason: "served",
      currentAccountId: "acct-2",
      currentQuota: { five_h_remaining_percent: 12, one_week_remaining_percent: 80 },
    });
    await mod.recordAuthPoolFetch({
      requesterEmail: "alice@stardust.ai",
      source: "codex",
      servedEntry: null,
      reason: "no_better_auth_available",
      currentAccountId: null,
      currentQuota: null,
    });

    const log = await mod.authPoolFetchLog({ limit: 10 });
    assert.equal(log.length, 2);
    const [latest, earliest] = log;
    assert.equal(latest.reason, "no_better_auth_available");
    assert.equal(latest.served_account_id, null);
    assert.equal(latest.requester_email, "alice@stardust.ai");
    assert.equal(latest.current_five_h_remaining, null);

    assert.equal(earliest.reason, "served");
    assert.equal(earliest.served_account_id, "acct-1");
    assert.equal(earliest.served_email, "shared@stardust.ai");
    assert.equal(earliest.served_uploader_email, "bob@stardust.ai");
    assert.equal(earliest.served_digest, "deadbeef");
    assert.equal(earliest.requester_email, "alice@stardust.ai", "email should be normalized");
    assert.equal(earliest.current_account_id, "acct-2");
    assert.equal(earliest.current_five_h_remaining, 12);
    assert.equal(earliest.current_one_week_remaining, 80);
  } finally {
    cleanup();
  }
});

test("authUsersList joins active tokens and fetch counts per user", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.issueApiToken("Alice@stardust.ai");
    await mod.issueApiToken("bob@stardust.ai");
    // Re-issue revokes Alice's first token but keeps the user row.
    await mod.issueApiToken("alice@stardust.ai");

    await mod.recordAuthPoolFetch({
      requesterEmail: "alice@stardust.ai",
      source: "codex",
      servedEntry: { account_id: "acct-x", email: null, uploader_email: null, digest: null },
      reason: "served",
    });
    await mod.recordAuthPoolFetch({
      requesterEmail: "alice@stardust.ai",
      source: "claude",
      servedEntry: null,
      reason: "no_better_auth_available",
    });
    await mod.recordAuthPoolFetch({
      requesterEmail: "bob@stardust.ai",
      source: "codex",
      servedEntry: { account_id: "acct-y", email: null, uploader_email: null, digest: null },
      reason: "served",
    });

    const users = await mod.authUsersList();
    assert.equal(users.length, 2);
    const byEmail = Object.fromEntries(users.map((u) => [u.email, u]));

    assert.equal(byEmail["alice@stardust.ai"].fetch_count, 2);
    assert.equal(byEmail["alice@stardust.ai"].has_active_token, true);
    assert.ok(byEmail["alice@stardust.ai"].last_fetched_at, "alice should have a last_fetched_at");

    assert.equal(byEmail["bob@stardust.ai"].fetch_count, 1);
    assert.equal(byEmail["bob@stardust.ai"].has_active_token, true);
  } finally {
    cleanup();
  }
});
