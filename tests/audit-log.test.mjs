import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

function fakeAuthJson({ accountId, email, name = "Test User", plan = "team", lastRefresh = "2026-05-06T00:00:00Z", sid = null }) {
  const payload = Buffer.from(
    JSON.stringify({
      email,
      name,
      ...(sid ? { sid } : {}),
      "https://api.openai.com/auth": {
        chatgpt_plan_type: plan,
      },
    })
  ).toString("base64url");

  return JSON.stringify({
    last_refresh: lastRefresh,
    tokens: {
      account_id: accountId,
      id_token: `x.${payload}.y`,
    },
  });
}

async function loadDbWithTempStore() {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-audit-test-"));
  const dbPath = join(tempDir, "audit.db");
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  const previousEncryptionKey = process.env.AUTH_POOL_ENCRYPTION_KEY;
  const previousTokenIssueKey = process.env.TOKEN_ISSUE_KEY;
  const previousAuthBlobStorageDir = process.env.AUTH_BLOB_STORAGE_DIR;
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  process.env.TOKEN_ISSUE_KEY = "test-token-issue-key-32-bytes!!!";
  try {
    const mod = await import(`../lib/db.js?ts=${Date.now()}`);
    const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
    return {
      mod,
      client,
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
        if (previousTokenIssueKey === undefined) {
          delete process.env.TOKEN_ISSUE_KEY;
        } else {
          process.env.TOKEN_ISSUE_KEY = previousTokenIssueKey;
        }
        if (previousAuthBlobStorageDir === undefined) {
          delete process.env.AUTH_BLOB_STORAGE_DIR;
        } else {
          process.env.AUTH_BLOB_STORAGE_DIR = previousAuthBlobStorageDir;
        }
        rmSync(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

test("authPoolEntrySummaries excludes encrypted auth material for status reads", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({
        accountId: "summary-provider",
        email: "summary@stardust.ai",
      }),
      uploader_email: "owner@stardust.ai",
      reporter_name: "owner@mac",
      hostname: "mac",
    });

    const summaries = await mod.authPoolEntrySummaries();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].account_id, "summary@stardust.ai");
    assert.equal(Object.hasOwn(summaries[0], "encrypted_auth_json"), false);
    assert.equal(Object.hasOwn(summaries[0], "iv"), false);
    assert.equal(Object.hasOwn(summaries[0], "auth_tag"), false);
    assert.equal(Object.hasOwn(summaries[0], "auth_blob_key"), false);
  } finally {
    cleanup();
  }
});

test("upsertAuthPoolEntry stores encrypted auth payload in object storage when configured", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "qrh-auth-blob-store-"));
  const previousAuthBlobStorageDir = process.env.AUTH_BLOB_STORAGE_DIR;
  process.env.AUTH_BLOB_STORAGE_DIR = storageDir;
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    const authJson = fakeAuthJson({
      accountId: "stored-provider",
      email: "stored@stardust.ai",
    });
    await mod.upsertAuthPoolEntry({
      source: "codex",
      auth_json: authJson,
      uploader_email: "owner@stardust.ai",
      reporter_name: "owner@mac",
      hostname: "mac",
    });

    const rows = (await client.execute(`
      SELECT encrypted_auth_json, iv, auth_tag, auth_blob_key
      FROM auth_pool_entries
    `)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].encrypted_auth_json, null);
    assert.equal(rows[0].iv, null);
    assert.equal(rows[0].auth_tag, null);
    assert.match(rows[0].auth_blob_key, /^auth-pool\/codex\/stored%40stardust\.ai\//);

    const { decryptAuthJson } = await import(`../lib/auth-pool.js?ts=${Date.now()}`);
    const entry = await mod.authPoolEntry("codex", "stored@stardust.ai");
    assert.equal(await decryptAuthJson(entry), authJson);
  } finally {
    cleanup();
    if (previousAuthBlobStorageDir === undefined) {
      delete process.env.AUTH_BLOB_STORAGE_DIR;
    } else {
      process.env.AUTH_BLOB_STORAGE_DIR = previousAuthBlobStorageDir;
    }
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("authPoolFetchLog shows only the latest fetch per requester and source", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mod.recordAuthPoolFetch({
      requesterEmail: "alice@stardust.ai",
      source: "codex",
      servedEntry: null,
      reason: "no_better_auth_available",
      currentAccountId: null,
      currentQuota: null,
    });

    const log = await mod.authPoolFetchLog({ limit: 10 });
    assert.equal(log.length, 1);
    const [latest] = log;
    assert.equal(latest.reason, "no_better_auth_available");
    assert.equal(latest.served_account_id, null);
    assert.equal(latest.requester_email, "alice@stardust.ai");
    assert.equal(latest.current_five_h_remaining, null);
  } finally {
    cleanup();
  }
});

test("ensureSchema migrates auth_pool_entries primary key to preserve multiple sessions per account", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-old-pk-test-"));
  const dbPath = join(tempDir, "old-pk.db");
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  const previousEncryptionKey = process.env.AUTH_POOL_ENCRYPTION_KEY;
  const previousTokenIssueKey = process.env.TOKEN_ISSUE_KEY;
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  process.env.TOKEN_ISSUE_KEY = "test-token-issue-key-32-bytes!!!";
  const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  try {
    await client.execute(`
      CREATE TABLE auth_pool_entries (
        source TEXT NOT NULL,
        account_id TEXT NOT NULL,
        email TEXT,
        name TEXT,
        plan_name TEXT,
        auth_last_refresh TEXT,
        digest TEXT NOT NULL,
        uploader_email TEXT,
        reporter_name TEXT,
        hostname TEXT,
        uploaded_at TEXT NOT NULL,
        encrypted_auth_json TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        PRIMARY KEY (source, account_id)
      )
    `);
    await client.execute({
      sql: `
        INSERT INTO auth_pool_entries (
          source, account_id, email, name, plan_name, auth_last_refresh, digest,
          uploader_email, reporter_name, hostname, uploaded_at, encrypted_auth_json, iv, auth_tag
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "codex",
        "same@stardust.ai",
        "same@stardust.ai",
        "Same",
        "Team",
        "2026-05-06T00:00:00Z",
        "old-digest",
        "alice@stardust.ai",
        "alice@gpu4",
        "gpu4",
        "2026-05-06T00:00:00Z",
        Buffer.from("{}").toString("base64"),
        Buffer.from("iv").toString("base64"),
        Buffer.from("tag").toString("base64"),
      ],
    });

    const mod = await import(`../lib/db.js?ts=${Date.now()}`);
    await mod.ensureSchema();
    const pk = (await client.execute(`PRAGMA table_info(auth_pool_entries)`)).rows
      .filter((row) => row.pk > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((row) => row.name);
    assert.deepEqual(pk, ["source", "account_id", "session_id"]);

    await mod.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({
        accountId: "same-provider-id",
        email: "same@stardust.ai",
        lastRefresh: "2026-05-06T01:00:00Z",
        sid: "session-b",
      }),
      uploader_email: "bob@stardust.ai",
      reporter_name: "bob@mac",
      hostname: "mac",
    });
    const entries = (await mod.authPoolEntries()).filter((entry) => entry.account_id === "same@stardust.ai");
    assert.equal(entries.length, 2);
    assert.deepEqual(new Set(entries.map((entry) => entry.uploader_email)), new Set(["alice@stardust.ai"]));
  } finally {
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
    if (previousTokenIssueKey === undefined) {
      delete process.env.TOKEN_ISSUE_KEY;
    } else {
      process.env.TOKEN_ISSUE_KEY = previousTokenIssueKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("upsertAuthPoolEntry preserves the first uploader for later same-account uploads", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({
        accountId: "provider-a",
        email: "shared@stardust.ai",
        lastRefresh: "2026-06-08T03:09:11Z",
        sid: "session-a",
      }),
      uploader_email: "owner@stardust.ai",
      reporter_name: "owner@mac",
      hostname: "owner-mac",
    });

    const update = await mod.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({
        accountId: "provider-a",
        email: "shared@stardust.ai",
        lastRefresh: "2026-06-09T01:03:13Z",
        sid: "session-b",
      }),
      uploader_email: "borrower@stardust.ai",
      reporter_name: "borrower@mac",
      hostname: "borrower-mac",
    });

    assert.equal(update.uploader_email, "owner@stardust.ai");
    assert.equal(update.reporter_name, "borrower@mac");

    const entries = (await mod.authPoolEntries()).filter((entry) => entry.account_id === "shared@stardust.ai");
    assert.equal(entries.length, 2);
    assert.deepEqual(new Set(entries.map((entry) => entry.uploader_email)), new Set(["owner@stardust.ai"]));
  } finally {
    cleanup();
  }
});

test("upsertAuthPoolEntry assigns company account ownership to the account user", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.issueApiToken("shared@stardust.ai");
    const entry = await mod.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({
        accountId: "provider-a",
        email: "shared@stardust.ai",
        lastRefresh: "2026-06-09T01:03:13Z",
        sid: "session-a",
      }),
      uploader_email: "borrower@stardust.ai",
      reporter_name: "borrower@mac",
      hostname: "borrower-mac",
    });

    assert.equal(entry.uploader_email, "shared@stardust.ai");
  } finally {
    cleanup();
  }
});

test("upsertAuthPoolEntry maps non-company account aliases to company users", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.issueApiToken("shawn.hou@stardust.ai");
    const entry = await mod.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({
        accountId: "provider-a",
        email: "shawn.hou@preseen.ai",
        lastRefresh: "2026-06-09T01:03:13Z",
        sid: "session-a",
      }),
      uploader_email: "borrower@stardust.ai",
      reporter_name: "borrower@mac",
      hostname: "borrower-mac",
    });

    assert.equal(entry.uploader_email, "shawn.hou@stardust.ai");
  } finally {
    cleanup();
  }
});

test("authPoolFetchLog can show raw repair auth events without requester dedupe", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.recordAuthPoolFetch({
      requesterEmail: "derek@stardust.ai",
      source: "codex",
      servedEntry: {
        account_id: "invalid@example.com",
        email: "invalid@example.com",
        uploader_email: "derek@stardust.ai",
        digest: "bad-digest",
      },
      reason: "repair_auth_returned",
      currentAccountId: "current@example.com",
      currentQuota: { five_h_remaining_percent: 1, one_week_remaining_percent: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mod.recordAuthPoolFetch({
      requesterEmail: "derek@stardust.ai",
      source: "codex",
      servedEntry: null,
      reason: "no_better_auth_available",
      currentAccountId: "current@example.com",
      currentQuota: { five_h_remaining_percent: 1, one_week_remaining_percent: 1 },
    });

    const deduped = await mod.authPoolFetchLog({ limit: 10 });
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].reason, "no_better_auth_available");

    const raw = await mod.authPoolFetchLog({ limit: 10, dedupe: false });
    assert.equal(raw.length, 2);
    const repair = raw.find((row) => row.reason === "repair_auth_returned");
    assert.ok(repair);
    assert.equal(repair.served_account_id, "invalid@example.com");
    assert.equal(repair.served_uploader_email, "derek@stardust.ai");
  } finally {
    cleanup();
  }
});

test("authPoolRecentServedCounts counts only recent served replacements by source", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.recordAuthPoolFetch({
      requesterEmail: "alice@stardust.ai",
      source: "codex",
      servedEntry: {
        account_id: "shared-a",
        email: "shared-a@stardust.ai",
        uploader_email: "owner@stardust.ai",
        digest: "digest-a",
      },
      reason: "served",
    });
    await mod.recordAuthPoolFetch({
      requesterEmail: "bob@stardust.ai",
      source: "codex",
      servedEntry: {
        account_id: "shared-a",
        email: "shared-a@stardust.ai",
        uploader_email: "owner@stardust.ai",
        digest: "digest-a",
      },
      reason: "served",
    });
    await mod.recordAuthPoolFetch({
      requesterEmail: "carol@stardust.ai",
      source: "claude",
      servedEntry: {
        account_id: "shared-a",
        email: "shared-a@stardust.ai",
        uploader_email: "owner@stardust.ai",
        digest: "digest-a",
      },
      reason: "served",
    });
    await mod.recordAuthPoolFetch({
      requesterEmail: "derek@stardust.ai",
      source: "codex",
      servedEntry: {
        account_id: "shared-b",
        email: "shared-b@stardust.ai",
        uploader_email: "owner@stardust.ai",
        digest: "digest-b",
      },
      reason: "repair_auth_returned",
    });

    const counts = await mod.authPoolRecentServedCounts({
      source: "codex",
      since: "2000-01-01T00:00:00Z",
    });

    assert.deepEqual(counts, { "shared-a": 2 });
  } finally {
    cleanup();
  }
});

test("authPoolActiveAssignmentCounts counts each machine's latest installed auth", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.recordAuthPoolFetch({
      requesterEmail: "shared-token@stardust.ai",
      requesterId: "derek@gpu4",
      source: "codex",
      servedEntry: {
        account_id: "shared-a",
        email: "shared-a@stardust.ai",
        uploader_email: "owner@stardust.ai",
        digest: "digest-a",
      },
      reason: "served",
      currentAccountId: "old-a",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mod.recordAuthPoolFetch({
      requesterEmail: "shared-token@stardust.ai",
      requesterId: "derek@gpu4",
      source: "codex",
      servedEntry: null,
      reason: "no_better_auth_available",
      currentAccountId: "shared-a",
      currentQuota: { five_h_remaining_percent: 80, one_week_remaining_percent: 80 },
    });
    await mod.recordAuthPoolFetch({
      requesterEmail: "shared-token@stardust.ai",
      requesterId: "derek@mac",
      source: "codex",
      servedEntry: {
        account_id: "shared-b",
        email: "shared-b@stardust.ai",
        uploader_email: "owner@stardust.ai",
        digest: "digest-b",
      },
      reason: "served",
    });

    const counts = await mod.authPoolActiveAssignmentCounts({
      source: "codex",
      since: "2000-01-01T00:00:00Z",
    });

    assert.deepEqual(counts, { "shared-a": 1, "shared-b": 1 });
  } finally {
    cleanup();
  }
});

test("authPoolActiveReporterCounts counts each reporter's latest quota account", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "gpu4",
      reporter_name: "derek@gpu4",
      reported_at: "2026-05-06T01:00:00Z",
      account_id: "old@example.com",
      status: "ok",
      windows: { "5h": { remaining_percent: 80 }, "1week": { remaining_percent: 80 } },
    });
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "gpu4",
      reporter_name: "derek@gpu4",
      reported_at: "2026-05-06T01:05:00Z",
      account_id: "current@example.com",
      status: "ok",
      windows: { "5h": { remaining_percent: 70 }, "1week": { remaining_percent: 70 } },
    });
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "mac",
      reporter_name: "derek@mac",
      reported_at: "2026-05-06T01:06:00Z",
      account_id: "current@example.com",
      status: "ok",
      windows: { "5h": { remaining_percent: 60 }, "1week": { remaining_percent: 60 } },
    });

    const counts = await mod.authPoolActiveReporterCounts({
      source: "codex",
      since: "2000-01-01T00:00:00Z",
    });

    assert.deepEqual(counts, { "current@example.com": 2 });
  } finally {
    cleanup();
  }
});

test("getInvalidatedUploaderEntry returns the owner's invalidated auth, preferring the current account", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({ accountId: "provider-1", email: "invalid-a@example.com" }),
      uploader_email: "derek@stardust.ai",
    });
    await mod.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({ accountId: "provider-2", email: "invalid-b@example.com" }),
      uploader_email: "derek@stardust.ai",
    });
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "gpu4",
      reporter_name: "worker",
      reported_at: "2026-05-06T01:00:00Z",
      account_id: "invalid-a@example.com",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows: { "5h": null, "1week": null },
    });
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "gpu4",
      reporter_name: "worker",
      reported_at: "2026-05-06T01:01:00Z",
      account_id: "invalid-b@example.com",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows: { "5h": null, "1week": null },
    });

    const different = await mod.getInvalidatedUploaderEntry({
      source: "codex",
      uploaderEmail: "derek@stardust.ai",
      accountId: "current@example.com",
    });
    const matching = await mod.getInvalidatedUploaderEntry({
      source: "codex",
      uploaderEmail: "derek@stardust.ai",
      accountId: "invalid-b@example.com",
    });

    // Even when the requested account isn't one the owner has, we still hand back one
    // of their own invalidated auths so they can re-login it.
    assert.ok(different);
    assert.ok(["invalid-a@example.com", "invalid-b@example.com"].includes(different.account_id));
    // When the current account matches one of the owner's dead auths, that one is preferred.
    assert.equal(matching.account_id, "invalid-b@example.com");
  } finally {
    cleanup();
  }
});

test("hasUploadedAnyHealthyAuth accepts a healthy upload from any source", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({ accountId: "provider-1", email: "codex-only@example.com" }),
      uploader_email: "alice@stardust.ai",
    });
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "gpu4",
      reporter_name: "alice@gpu4",
      reported_at: "2026-05-06T01:00:00Z",
      account_id: "codex-only@example.com",
      status: "ok",
      plan_name: "Team",
      windows: {
        "5h": { remaining_percent: 80, reset_at: "2026-05-06T06:00:00Z" },
        "1week": { remaining_percent: 80, reset_at: "2026-05-13T01:00:00Z" },
      },
    });

    assert.equal(await mod.hasUploadedAnyHealthyAuth({ uploaderEmail: "alice@stardust.ai" }), true);
    assert.equal(await mod.hasUploadedAnyHealthyAuth({ uploaderEmail: "bob@stardust.ai" }), false);
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

test("authenticateOrUpgradeApiToken rejects signed stale tokens", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    const first = await mod.issueApiToken("alice@stardust.ai");
    const second = await mod.issueApiToken("alice@stardust.ai");

    assert.equal(await mod.authenticateApiToken(first.token), null);
    assert.equal((await mod.authenticateApiToken(second.token)).email, "alice@stardust.ai");

    assert.equal(await mod.authenticateOrUpgradeApiToken(first.token), null);
  } finally {
    cleanup();
  }
});

test("sendUnauthorized returns token invalidated payload", async () => {
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  const previousAllowedDomain = process.env.AUTH_ALLOWED_EMAIL_DOMAIN;
  process.env.TURSO_DATABASE_URL = "file:quota-report-hub-test.db";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_ALLOWED_EMAIL_DOMAIN = "preseen.ai";
  try {
    const { sendUnauthorized } = await import(`../lib/api-auth.js?ts=${Date.now()}`);
    const headers = {};
    let body = "";
    const res = {
      setHeader(name, value) {
        headers[name] = value;
      },
      end(value) {
        body = value;
      },
    };

    sendUnauthorized(res);

    assert.equal(res.statusCode, 401);
    assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(body), {
      ok: false,
      error: "token_invalidated",
      reason: "token_invalidated",
      allowed_domain: "preseen.ai",
      message: "Token invalid or expired. Request a new token by email and paste the latest one here.",
    });
  } finally {
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
    if (previousAllowedDomain === undefined) {
      delete process.env.AUTH_ALLOWED_EMAIL_DOMAIN;
    } else {
      process.env.AUTH_ALLOWED_EMAIL_DOMAIN = previousAllowedDomain;
    }
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

test("upsertAuthPoolQuota records every probe event and derives continuous invalidation from history", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "github-actions",
      reporter_name: "worker",
      reported_at: "2026-05-06T00:00:00Z",
      account_id: "acct-history",
      status: "ok",
      windows: { "5h": { remaining_percent: 90 }, "1week": { remaining_percent: 80 } },
    });
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "github-actions",
      reporter_name: "worker",
      reported_at: "2026-05-06T01:00:00Z",
      account_id: "acct-history",
      status: "error",
      error: "auth failed (401 unauthorized)",
      windows: { "5h": null, "1week": null },
    });
    await mod.upsertAuthPoolQuota({
      source: "codex",
      hostname: "github-actions",
      reporter_name: "worker",
      reported_at: "2026-05-06T02:00:00Z",
      account_id: "acct-history",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows: { "5h": null, "1week": null },
    });

    const events = await mod.authPoolQuotaEvents({ source: "codex", accountId: "acct-history", limit: 10 });
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((event) => event.reported_at),
      ["2026-05-06T02:00:00Z", "2026-05-06T01:00:00Z", "2026-05-06T00:00:00Z"]
    );

    const states = await mod.authPoolInvalidatedNotifications();
    assert.equal(states.length, 1);
    assert.equal(states[0].first_invalidated_at, "2026-05-06T01:00:00Z");
    assert.equal(states[0].last_error, "auth invalidated (token_invalidated)");
  } finally {
    cleanup();
  }
});

test("upsertAuthPoolQuota treats claude authentication errors as invalidated auth", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolQuota({
      source: "claude",
      hostname: "github-actions",
      reporter_name: "worker",
      reported_at: "2026-05-06T00:00:00Z",
      account_id: "claude-user@example.com",
      status: "error",
      error: "claude auth invalid (authentication_error)",
      windows: { "5h": null, "1week": null },
    });
    await mod.upsertAuthPoolQuota({
      source: "claude",
      hostname: "github-actions",
      reporter_name: "worker",
      reported_at: "2026-05-06T01:00:00Z",
      account_id: "claude-user@example.com",
      status: "error",
      error: "claude auth invalid (authentication_error)",
      windows: { "5h": null, "1week": null },
    });

    const states = await mod.authPoolInvalidatedNotifications();
    assert.equal(states.length, 1);
    assert.equal(states[0].source, "claude");
    assert.equal(states[0].account_id, "claude-user@example.com");
    assert.equal(states[0].first_invalidated_at, "2026-05-06T00:00:00Z");
    assert.equal(states[0].last_error, "claude auth invalid (authentication_error)");
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
      account_id: "delete@example.com",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows: { "5h": null, "1week": null },
    });

    const result = await mod.deleteAuthPoolEntry({ source: "codex", accountId: "delete@example.com" });
    assert.equal(result.deleted, true);
    assert.equal(await mod.authPoolEntry("codex", "delete@example.com"), null);
    assert.equal((await mod.authPoolQuotaLatest()).filter((row) => row.account_id === "delete@example.com").length, 0);
    assert.equal((await mod.authPoolInvalidatedNotifications()).filter((row) => row.account_id === "delete@example.com").length, 0);
    assert.equal((await mod.authPoolQuotaEvents({ source: "codex", accountId: "delete@example.com" })).length, 1);
  } finally {
    cleanup();
  }
});

test("feature flags default off, set, read back, and toggle", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    assert.equal(await mod.getFeatureFlag("disabled_refresh_token", false), false);
    await mod.setFeatureFlag("disabled_refresh_token", true, "derek@stardust.ai");
    assert.equal(await mod.getFeatureFlag("disabled_refresh_token", false), true);
    assert.equal((await mod.allFeatureFlags()).disabled_refresh_token, true);
    await mod.setFeatureFlag("disabled_refresh_token", false, "derek@stardust.ai");
    assert.equal(await mod.getFeatureFlag("disabled_refresh_token", false), false);
  } finally {
    cleanup();
  }
});

test("upsertAuthPoolEntry rejects a stripped (placeholder-RT) blob so it can't poison the pool", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    const dummyCodex = JSON.stringify({ tokens: { account_id: "x@stardust.ai", refresh_token: "rt.1." + "A".repeat(32), access_token: "AT" } });
    const codexResult = await mod.upsertAuthPoolEntry({ source: "codex", auth_json: dummyCodex, uploader_email: "x@stardust.ai" });
    assert.equal(codexResult.rejected, true);
    assert.equal(codexResult.reason, "stripped_refresh_token");

    const dummyClaude = JSON.stringify({ credentials: { claudeAiOauth: { refreshToken: "disabled-by-hub-refresh-token", accessToken: "AT" } } });
    const claudeResult = await mod.upsertAuthPoolEntry({ source: "claude", auth_json: dummyClaude, uploader_email: "x@stardust.ai" });
    assert.equal(claudeResult.rejected, true);
  } finally {
    cleanup();
  }
});

test("pool health snapshots record and read back in chronological order", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.recordPoolHealthSnapshot({ captured_at: "2026-06-12T00:00:00Z", source: "codex", total: 10, ok_count: 7, hard_dead_count: 3, other_err_count: 0 });
    await mod.recordPoolHealthSnapshot({ captured_at: "2026-06-12T00:15:00Z", source: "codex", total: 10, ok_count: 8, hard_dead_count: 2, other_err_count: 0, central_refresh_attempted: 2, central_refresh_ok: 1, central_refresh_rejected: 1 });
    const snaps = await mod.poolHealthSnapshots({ limit: 96 });
    assert.equal(snaps.length, 2);
    // poolHealthSnapshots returns oldest-first for charting
    assert.equal(snaps[0].captured_at, "2026-06-12T00:00:00Z");
    assert.equal(snaps[0].hard_dead_count, 3);
    assert.equal(snaps[1].ok_count, 8);
    assert.equal(snaps[1].central_refresh_ok, 1);
  } finally {
    cleanup();
  }
});
