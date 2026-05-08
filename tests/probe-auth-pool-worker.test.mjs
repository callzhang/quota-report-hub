import test from "node:test";
import assert from "node:assert/strict";

async function loadWorkerModule() {
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-report-hub-test.db";
  process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";
  try {
    return await import(`../scripts/probe_auth_pool_worker.mjs?ts=${Date.now()}`);
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

test("processAuthPoolEntry writes refreshed codex auth back to the pool", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  const quotaReports = [];
  const authWrites = [];

  const result = await processAuthPoolEntry(
    {
      source: "codex",
      account_id: "acct-1",
      uploader_email: "derek@stardust.ai",
    },
    {
      decryptAuthJsonImpl: () => '{"tokens":{"account_id":"acct-1"}}',
      probeCodexAuthJsonImpl: () => ({
        source: "codex",
        account_id: "acct-1",
        status: "ok",
        error: null,
        windows: { "5h": { remaining_percent: 80 }, "1week": { remaining_percent: 70 } },
        refresh_capture: {
          delta: {
            same_account: true,
            account_changed: false,
            refresh_changed: true,
            digest_changed: true,
            refreshed: true,
          },
          refreshed_auth_json: '{"tokens":{"account_id":"acct-1"},"last_refresh":"2026-04-27T08:30:13Z"}',
        },
      }),
      upsertAuthPoolQuotaImpl: async (report) => {
        quotaReports.push(report);
      },
      upsertAuthPoolEntryImpl: async (entry) => {
        authWrites.push(entry);
        return { deduplicated: false, account_id: "acct-1" };
      },
    }
  );

  assert.equal(quotaReports.length, 1);
  assert.equal(quotaReports[0].refresh_capture.refreshed_auth_json, undefined);
  assert.equal(authWrites.length, 1);
  assert.equal(authWrites[0].uploader_email, "derek@stardust.ai");
  assert.equal(result.refreshed_auth_written, true);
});

test("processAuthPoolEntry does not write back when codex probe did not refresh auth", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  const authWrites = [];

  const result = await processAuthPoolEntry(
    {
      source: "codex",
      account_id: "acct-1",
      uploader_email: "derek@stardust.ai",
    },
    {
      decryptAuthJsonImpl: () => '{"tokens":{"account_id":"acct-1"}}',
      probeCodexAuthJsonImpl: () => ({
        source: "codex",
        account_id: "acct-1",
        status: "ok",
        error: null,
        windows: { "5h": { remaining_percent: 80 }, "1week": { remaining_percent: 70 } },
        refresh_capture: {
          delta: {
            same_account: false,
            account_changed: true,
            refresh_changed: true,
            digest_changed: true,
            refreshed: false,
          },
        },
      }),
      upsertAuthPoolQuotaImpl: async () => {},
      upsertAuthPoolEntryImpl: async (entry) => {
        authWrites.push(entry);
        return { deduplicated: false };
      },
    }
  );

  assert.equal(authWrites.length, 0);
  assert.equal(result.refreshed_auth_written, false);
});

test("processAuthPoolEntry deletes unusable codex auths with missing quota details", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  const quotaReports = [];
  const deletions = [];

  const result = await processAuthPoolEntry(
    {
      source: "codex",
      account_id: "acct-missing-quota",
      email: "lili.zhang@stardust.ai",
      plan_name: "Pro Lite",
    },
    {
      decryptAuthJsonImpl: () => '{"tokens":{"account_id":"acct-missing-quota"}}',
      probeCodexAuthJsonImpl: () => ({
        source: "codex",
        account_id: "acct-missing-quota",
        email: "lili.zhang@stardust.ai",
        plan_name: "Pro Lite",
        status: "error",
        error: "token_count event was present but missing quota details",
        windows: { "5h": null, "1week": null },
      }),
      upsertAuthPoolQuotaImpl: async (report) => {
        quotaReports.push(report);
      },
      deleteAuthPoolEntryImpl: async (payload) => {
        deletions.push(payload);
        return { deleted: true, ...payload };
      },
    }
  );

  assert.equal(result.deleted_from_auth_pool, true);
  assert.equal(result.delete_reason, "missing_quota_details");
  assert.deepEqual(deletions, [{ source: "codex", accountId: "acct-missing-quota" }]);
  assert.equal(quotaReports.length, 1);
  assert.equal(quotaReports[0].error, "token_count event was present but missing quota details");
});

test("processAuthPoolEntry deletes codex auths when refreshed metadata shows Free plan", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  const authWrites = [];
  const quotaReports = [];
  const deletions = [];

  const result = await processAuthPoolEntry(
    {
      source: "codex",
      account_id: "acct-free",
      email: "derekz@stardust.ai",
      plan_name: "Pro Lite",
    },
    {
      decryptAuthJsonImpl: () => '{"tokens":{"account_id":"acct-free"}}',
      probeCodexAuthJsonImpl: () => ({
        source: "codex",
        account_id: "acct-free",
        email: "derekz@stardust.ai",
        plan_name: "Pro Lite",
        status: "error",
        error: "token_count event was present but missing quota details",
        windows: { "5h": null, "1week": null },
        refresh_capture: {
          delta: { refreshed: true },
          refreshed_metadata: { plan_name: "Free" },
          refreshed_auth_json: '{"tokens":{"account_id":"acct-free"}}',
        },
      }),
      upsertAuthPoolEntryImpl: async (entry) => {
        authWrites.push(entry);
        return { deduplicated: false };
      },
      upsertAuthPoolQuotaImpl: async (report) => {
        quotaReports.push(report);
      },
      deleteAuthPoolEntryImpl: async (payload) => {
        deletions.push(payload);
        return { deleted: true, ...payload };
      },
    }
  );

  assert.equal(result.deleted_from_auth_pool, true);
  assert.equal(result.delete_reason, "free_plan");
  assert.equal(authWrites.length, 0);
  assert.equal(quotaReports.length, 1);
  assert.equal(quotaReports[0].refresh_capture.refreshed_auth_json, undefined);
  assert.deepEqual(deletions, [{ source: "codex", accountId: "acct-free" }]);
});
