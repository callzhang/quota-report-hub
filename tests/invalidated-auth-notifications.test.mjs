import test from "node:test";
import assert from "node:assert/strict";

async function loadNotificationsModule() {
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-report-hub-test.db";
  process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";
  try {
    return await import(`../lib/invalidated-auth-notifications.js?ts=${Date.now()}`);
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
  }
}

test("maybeNotifyInvalidatedAuthOwner waits until invalidated auth is older than 24 hours", async () => {
  const { maybeNotifyInvalidatedAuthOwner } = await loadNotificationsModule();
  let emailsSent = 0;

  const result = await maybeNotifyInvalidatedAuthOwner(
    {
      source: "codex",
      account_id: "acct-1",
      uploader_email: "owner@stardust.ai",
    },
    {
      status: "error",
      error: "auth invalidated (token_invalidated)",
      reported_at: "2026-05-06T13:00:00Z",
    },
    {
      now: new Date("2026-05-07T12:00:00Z"),
      upsertInvalidatedAuthStateImpl: async () => ({
        source: "codex",
        account_id: "acct-1",
        first_invalidated_at: "2026-05-06T13:00:00Z",
        last_notified_at: null,
      }),
      clearInvalidatedAuthStateImpl: async () => {
        throw new Error("should not clear invalidated state");
      },
      markInvalidatedAuthNotifiedImpl: async () => {
        throw new Error("should not mark notified");
      },
      sendAuthInvalidatedEmailImpl: async () => {
        emailsSent += 1;
      },
    }
  );

  assert.equal(result.notified, false);
  assert.equal(result.reason, "not_old_enough");
  assert.equal(emailsSent, 0);
});

test("maybeNotifyInvalidatedAuthOwner emails uploader after invalidated auth is older than 24 hours", async () => {
  const { maybeNotifyInvalidatedAuthOwner } = await loadNotificationsModule();
  const emails = [];
  const marks = [];

  const result = await maybeNotifyInvalidatedAuthOwner(
    {
      source: "claude",
      account_id: "claude-acct-1",
      email: "account@stardust.ai",
      uploader_email: "owner@stardust.ai",
      plan_name: "Max",
    },
    {
      status: "error",
      error: "auth invalidated (token_invalidated)",
      reported_at: "2026-05-06T11:00:00Z",
    },
    {
      now: new Date("2026-05-07T12:00:00Z"),
      upsertInvalidatedAuthStateImpl: async () => ({
        source: "claude",
        account_id: "claude-acct-1",
        first_invalidated_at: "2026-05-06T11:00:00Z",
        last_notified_at: null,
      }),
      clearInvalidatedAuthStateImpl: async () => {
        throw new Error("should not clear invalidated state");
      },
      markInvalidatedAuthNotifiedImpl: async (payload) => {
        marks.push(payload);
      },
      sendAuthInvalidatedEmailImpl: async (payload) => {
        emails.push(payload);
      },
    }
  );

  assert.equal(result.notified, true);
  assert.equal(result.owner_email, "owner@stardust.ai");
  assert.equal(emails.length, 1);
  assert.equal(emails[0].email, "owner@stardust.ai");
  assert.equal(emails[0].entry.account_id, "claude-acct-1");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].notifiedAt, "2026-05-07T12:00:00.000Z");
});

test("maybeNotifyInvalidatedAuthOwner rate limits repeated invalidated emails", async () => {
  const { maybeNotifyInvalidatedAuthOwner } = await loadNotificationsModule();
  let emailsSent = 0;

  const result = await maybeNotifyInvalidatedAuthOwner(
    {
      source: "codex",
      account_id: "acct-1",
      uploader_email: "owner@stardust.ai",
    },
    {
      status: "error",
      error: "auth invalidated (token_invalidated)",
    },
    {
      now: new Date("2026-05-07T12:00:00Z"),
      upsertInvalidatedAuthStateImpl: async () => ({
        source: "codex",
        account_id: "acct-1",
        first_invalidated_at: "2026-05-05T12:00:00Z",
        last_notified_at: "2026-05-07T00:00:00Z",
      }),
      clearInvalidatedAuthStateImpl: async () => {
        throw new Error("should not clear invalidated state");
      },
      markInvalidatedAuthNotifiedImpl: async () => {
        throw new Error("should not mark notified");
      },
      sendAuthInvalidatedEmailImpl: async () => {
        emailsSent += 1;
      },
    }
  );

  assert.equal(result.notified, false);
  assert.equal(result.reason, "recently_notified");
  assert.equal(emailsSent, 0);
});

test("maybeNotifyInvalidatedAuthOwner clears notification state after auth recovers", async () => {
  const { maybeNotifyInvalidatedAuthOwner } = await loadNotificationsModule();
  const clears = [];

  const result = await maybeNotifyInvalidatedAuthOwner(
    {
      source: "codex",
      account_id: "acct-1",
      uploader_email: "owner@stardust.ai",
    },
    {
      status: "ok",
      error: null,
    },
    {
      clearInvalidatedAuthStateImpl: async (payload) => {
        clears.push(payload);
      },
    }
  );

  assert.equal(result.notified, false);
  assert.equal(result.reason, "not_invalidated");
  assert.deepEqual(clears, [{ source: "codex", accountId: "acct-1" }]);
});

test("notifyInvalidatedAuthOwners evaluates latest Vercel-side quota rows for each auth entry", async () => {
  const { notifyInvalidatedAuthOwners } = await loadNotificationsModule();
  const calls = [];
  const result = await notifyInvalidatedAuthOwners({
    now: new Date("2026-05-07T12:00:00Z"),
    authPoolEntriesImpl: async () => [
      { source: "codex", account_id: "acct-1" },
      { source: "claude", account_id: "acct-2" },
    ],
    authPoolQuotaLatestImpl: async () => [
      { source: "codex", account_id: "acct-1", status: "error", error: "auth invalidated (token_invalidated)" },
      { source: "claude", account_id: "acct-2", status: "ok", error: null },
    ],
    maybeNotifyInvalidatedAuthOwnerImpl: async (entry, report, options) => {
      calls.push({ entry, report, now: options.now.toISOString() });
      return { source: entry.source, account_id: entry.account_id, notified: report?.status === "error" };
    },
  });

  assert.equal(result.count, 2);
  assert.equal(result.notified_count, 1);
  assert.equal(calls[0].report.status, "error");
  assert.equal(calls[1].report.status, "ok");
  assert.equal(calls[0].now, "2026-05-07T12:00:00.000Z");
});
