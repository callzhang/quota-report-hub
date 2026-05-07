import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

async function loadDbWithTempStore() {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-audit-test-"));
  const dbPath = join(tempDir, "audit.db");
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  const previousEncryptionKey = process.env.AUTH_POOL_ENCRYPTION_KEY;
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
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
        if (previousEncryptionKey === undefined) {
          delete process.env.AUTH_POOL_ENCRYPTION_KEY;
        } else {
          process.env.AUTH_POOL_ENCRYPTION_KEY = previousEncryptionKey;
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

test("authUsersList collapses duplicate token rows for the same email", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.issueApiToken("derek@stardust.ai");
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
    await client.execute({
      sql: `
        INSERT INTO auth_api_tokens (token_hash, email, created_at, last_used_at)
        VALUES (?, ?, ?, ?)
      `,
      args: ["legacy-token-hash", "derek@stardust.ai", "2026-05-03T00:00:00Z", "2026-05-03T01:00:00Z"],
    });

    const users = await mod.authUsersList();
    const derekUsers = users.filter((u) => u.email === "derek@stardust.ai");
    assert.equal(derekUsers.length, 1);
    assert.equal(derekUsers[0].has_active_token, true);
  } finally {
    cleanup();
  }
});

test("invalidated auth notification state preserves first invalidated time and clears on recovery", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    const first = await mod.upsertInvalidatedAuthState({
      source: "codex",
      accountId: "acct-1",
      invalidatedAt: "2026-05-06T00:00:00Z",
      error: "auth invalidated (token_invalidated)",
    });
    assert.equal(first.first_invalidated_at, "2026-05-06T00:00:00Z");
    assert.equal(first.last_notified_at, null);

    await mod.markInvalidatedAuthNotified({
      source: "codex",
      accountId: "acct-1",
      notifiedAt: "2026-05-07T01:00:00Z",
    });

    const second = await mod.upsertInvalidatedAuthState({
      source: "codex",
      accountId: "acct-1",
      invalidatedAt: "2026-05-07T02:00:00Z",
      error: "auth invalidated (token_invalidated)",
    });
    assert.equal(second.first_invalidated_at, "2026-05-06T00:00:00Z");
    assert.equal(second.last_notified_at, "2026-05-07T01:00:00Z");

    await mod.clearInvalidatedAuthState({ source: "codex", accountId: "acct-1" });
    const third = await mod.upsertInvalidatedAuthState({
      source: "codex",
      accountId: "acct-1",
      invalidatedAt: "2026-05-08T00:00:00Z",
      error: "auth invalidated (token_invalidated)",
    });
    assert.equal(third.first_invalidated_at, "2026-05-08T00:00:00Z");
    assert.equal(third.last_notified_at, null);
  } finally {
    cleanup();
  }
});

test("upsertAuthPoolQuota tracks continuous invalidated episodes and clears them on recovery", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "gpu4",
      reporter_name: "worker",
      reported_at: "2026-05-06T00:00:00Z",
      account_id: "acct-invalid",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows: { "5h": null, "1week": null },
    });
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "gpu4",
      reporter_name: "worker",
      reported_at: "2026-05-06T01:00:00Z",
      account_id: "acct-invalid",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows: { "5h": null, "1week": null },
    });
    let states = await mod.authPoolInvalidatedNotifications();
    assert.equal(states.length, 1);
    assert.equal(states[0].first_invalidated_at, "2026-05-06T00:00:00Z");

    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "gpu4",
      reporter_name: "worker",
      reported_at: "2026-05-06T02:00:00Z",
      account_id: "acct-invalid",
      status: "ok",
      windows: { "5h": { remaining_percent: 80 }, "1week": { remaining_percent: 60 } },
    });
    states = await mod.authPoolInvalidatedNotifications();
    assert.equal(states.length, 0);

    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "gpu4",
      reporter_name: "worker",
      reported_at: "2026-05-06T03:00:00Z",
      account_id: "acct-invalid",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows: { "5h": null, "1week": null },
    });
    states = await mod.authPoolInvalidatedNotifications();
    assert.equal(states.length, 1);
    assert.equal(states[0].first_invalidated_at, "2026-05-06T03:00:00Z");
  } finally {
    cleanup();
  }
});

test("deleteAuthPoolEntry removes entry, latest quota, and invalidated state", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    const authJson = JSON.stringify({
      last_refresh: "2026-05-06T00:00:00Z",
      tokens: {
        account_id: "acct-delete",
        id_token: "x.eyJlbWFpbCI6ICJkZWxldGVAZXhhbXBsZS5jb20iLCAibmFtZSI6ICJEZWxldGUiLCAiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9hdXRoIjogeyJjaGF0Z3B0X3BsYW5fdHlwZSI6ICJ0ZWFtIn19.y",
      },
    });
    await mod.upsertAuthPoolEntry({
      source: "codex",
      auth_json: authJson,
      uploader_email: "derek@stardust.ai",
    });
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "gpu4",
      reporter_name: "worker",
      reported_at: "2026-05-06T01:00:00Z",
      account_id: "acct-delete",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows: { "5h": null, "1week": null },
    });

    const result = await mod.deleteAuthPoolEntry({ source: "codex", accountId: "acct-delete" });
    assert.equal(result.deleted, true);
    assert.equal(await mod.authPoolEntry("codex", "acct-delete"), null);
    assert.equal((await mod.authPoolQuotaLatest()).filter((row) => row.account_id === "acct-delete").length, 0);
    assert.equal((await mod.authPoolInvalidatedNotifications()).filter((row) => row.account_id === "acct-delete").length, 0);
  } finally {
    cleanup();
  }
});
