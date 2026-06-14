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
      authPoolQuotaLatestForEntryImpl: async () => null,
    }
  );

  assert.equal(quotaReports.length, 1);
  assert.equal(quotaReports[0].refresh_capture.refreshed_auth_json, undefined);
  assert.equal(authWrites.length, 1);
  assert.equal(authWrites[0].uploader_email, "derek@stardust.ai");
  assert.equal(result.refreshed_auth_written, true);
});

test("processAuthPoolEntry centrally refreshes a near-expiry claude auth in disabled_refresh_token", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  const authWrites = [];
  const now = new Date("2026-06-12T00:00:00Z");
  // expiresAt only 5 minutes out -> inside the 30-minute refresh window.
  const expiringBlob = JSON.stringify({
    credentials: { claudeAiOauth: { accessToken: "OLD_AT", refreshToken: "REAL_RT", expiresAt: now.getTime() + 5 * 60 * 1000 } },
  });

  const result = await processAuthPoolEntry(
    { source: "claude", account_id: "acct-claude", uploader_email: "derek@stardust.ai" },
    {
      atOnlyMode: true,
      nowImpl: () => now,
      decryptAuthJsonImpl: () => expiringBlob,
      refreshClaudeTokenImpl: async (rt) => {
        assert.equal(rt, "REAL_RT");
        return { ok: true, access_token: "NEW_AT", refresh_token: "NEW_RT", expires_in: 28800 };
      },
      probeClaudeAuthJsonImpl: (authJsonText) => {
        // the probe must see the freshly refreshed access token, not the stale one
        const oauth = JSON.parse(authJsonText).credentials.claudeAiOauth;
        assert.equal(oauth.accessToken, "NEW_AT");
        return { source: "claude", account_id: "acct-claude", status: "ok", error: null, windows: { "5h": null, "1week": null } };
      },
      upsertAuthPoolQuotaImpl: async () => {},
      upsertAuthPoolEntryImpl: async (entry) => {
        authWrites.push(entry);
        return { deduplicated: false };
      },
      authPoolQuotaLatestForEntryImpl: async () => null,
    }
  );

  assert.equal(result.claude_refresh.ok, true);
  assert.equal(authWrites.length, 1);
  const persisted = JSON.parse(authWrites[0].auth_json).credentials.claudeAiOauth;
  assert.equal(persisted.accessToken, "NEW_AT");
  assert.equal(persisted.refreshToken, "NEW_RT");
});

test("processAuthPoolEntry leaves a claude auth untouched when disabled_refresh_token is off", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  let refreshCalled = false;
  const now = new Date("2026-06-12T00:00:00Z");
  const expiringBlob = JSON.stringify({
    credentials: { claudeAiOauth: { accessToken: "OLD_AT", refreshToken: "REAL_RT", expiresAt: now.getTime() + 5 * 60 * 1000 } },
  });

  const result = await processAuthPoolEntry(
    { source: "claude", account_id: "acct-claude", uploader_email: "derek@stardust.ai" },
    {
      atOnlyMode: false,
      nowImpl: () => now,
      decryptAuthJsonImpl: () => expiringBlob,
      refreshClaudeTokenImpl: async () => {
        refreshCalled = true;
        return { ok: true, access_token: "NEW_AT", refresh_token: "NEW_RT", expires_in: 28800 };
      },
      probeClaudeAuthJsonImpl: () => ({ source: "claude", account_id: "acct-claude", status: "ok", error: null, windows: { "5h": null, "1week": null } }),
      upsertAuthPoolQuotaImpl: async () => {},
      upsertAuthPoolEntryImpl: async () => ({ deduplicated: false }),
      authPoolQuotaLatestForEntryImpl: async () => null,
    }
  );

  assert.equal(refreshCalled, false);
  assert.equal(result.claude_refresh, null);
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
      authPoolQuotaLatestForEntryImpl: async () => null,
    }
  );

  assert.equal(authWrites.length, 0);
  assert.equal(result.refreshed_auth_written, false);
});

test("processAuthPoolEntry skips cloud probe after fresh client quota report for same auth", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  let decryptCalled = false;
  let quotaWritten = false;

  const result = await processAuthPoolEntry(
    {
      source: "codex",
      account_id: "acct-client-fresh",
      auth_last_refresh: "2026-06-09T10:32:06Z",
    },
    {
      decryptAuthJsonImpl: () => {
        decryptCalled = true;
        return '{"tokens":{"account_id":"acct-client-fresh"}}';
      },
      upsertAuthPoolQuotaImpl: async () => {
        quotaWritten = true;
      },
      authPoolQuotaLatestForEntryImpl: async () => ({
        source: "codex",
        account_id: "acct-client-fresh",
        auth_last_refresh: "2026-06-09T10:32:06Z",
        reported_at: "2026-06-09T23:30:00Z",
        report_origin: "client",
        status: "ok",
        windows: { "5h": { remaining_percent: 80 }, "1week": { remaining_percent: 70 } },
      }),
      nowImpl: () => new Date("2026-06-09T23:45:00Z"),
    }
  );

  assert.equal(decryptCalled, false);
  assert.equal(quotaWritten, false);
  assert.equal(result.skipped_cloud_probe, true);
  assert.equal(result.skip_reason, "fresh_client_quota_report");
});

test("processAuthPoolEntry probes when fresh client quota belongs to older auth refresh", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  let decryptCalled = false;

  const result = await processAuthPoolEntry(
    {
      source: "codex",
      account_id: "acct-client-stale-auth",
      auth_last_refresh: "2026-06-09T11:32:06Z",
    },
    {
      decryptAuthJsonImpl: () => {
        decryptCalled = true;
        return '{"tokens":{"account_id":"acct-client-stale-auth"}}';
      },
      probeCodexAuthJsonImpl: () => ({
        source: "codex",
        account_id: "acct-client-stale-auth",
        status: "ok",
        windows: { "5h": { remaining_percent: 80 }, "1week": { remaining_percent: 70 } },
      }),
      upsertAuthPoolQuotaImpl: async () => {},
      authPoolQuotaLatestForEntryImpl: async () => ({
        source: "codex",
        account_id: "acct-client-stale-auth",
        auth_last_refresh: "2026-06-09T10:32:06Z",
        reported_at: "2026-06-09T23:30:00Z",
        report_origin: "client",
        status: "ok",
        windows: { "5h": { remaining_percent: 80 }, "1week": { remaining_percent: 70 } },
      }),
      nowImpl: () => new Date("2026-06-09T23:45:00Z"),
    }
  );

  assert.equal(decryptCalled, true);
  assert.equal(result.skipped_cloud_probe, undefined);
  assert.equal(result.status, "ok");
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
      authPoolQuotaLatestForEntryImpl: async () => null,
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
      authPoolQuotaLatestForEntryImpl: async () => null,
    }
  );

  assert.equal(result.deleted_from_auth_pool, true);
  assert.equal(result.delete_reason, "free_plan");
  assert.equal(authWrites.length, 0);
  assert.equal(quotaReports.length, 1);
  assert.equal(quotaReports[0].refresh_capture.refreshed_auth_json, undefined);
  assert.deepEqual(deletions, [{ source: "codex", accountId: "acct-free" }]);
});

test("processAuthPoolEntry deletes codex auths after consecutive 401 probes", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  const quotaReports = [];
  const deletions = [];

  const result = await processAuthPoolEntry(
    {
      source: "codex",
      account_id: "acct-401",
      email: "mrderekzen@gmail.com",
      plan_name: "Pro Lite",
    },
    {
      decryptAuthJsonImpl: () => '{"tokens":{"account_id":"acct-401"}}',
      probeCodexAuthJsonImpl: () => ({
        source: "codex",
        account_id: "acct-401",
        email: "mrderekzen@gmail.com",
        plan_name: "Pro Lite",
        status: "error",
        error: "auth failed (401 unauthorized)",
        windows: { "5h": null, "1week": null },
      }),
      authPoolQuotaLatestForEntryImpl: async () => ({
        source: "codex",
        account_id: "acct-401",
        email: "mrderekzen@gmail.com",
        plan_name: "Pro Lite",
        status: "error",
        error: "auth failed (401 unauthorized)",
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
  assert.equal(result.delete_reason, "continuous_401");
  assert.equal(quotaReports.length, 1);
  assert.equal(quotaReports[0].error, "auth failed (401 unauthorized)");
  assert.deepEqual(deletions, [{ source: "codex", accountId: "acct-401" }]);
});

test("processAuthPoolEntry keeps first 401 probe in the pool", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  const quotaReports = [];
  const deletions = [];

  const result = await processAuthPoolEntry(
    {
      source: "codex",
      account_id: "acct-first-401",
      email: "mrderekzen@gmail.com",
      plan_name: "Pro Lite",
    },
    {
      decryptAuthJsonImpl: () => '{"tokens":{"account_id":"acct-first-401"}}',
      probeCodexAuthJsonImpl: () => ({
        source: "codex",
        account_id: "acct-first-401",
        email: "mrderekzen@gmail.com",
        plan_name: "Pro Lite",
        status: "error",
        error: "auth failed (401 unauthorized)",
        windows: { "5h": null, "1week": null },
      }),
      authPoolQuotaLatestForEntryImpl: async () => null,
      upsertAuthPoolQuotaImpl: async (report) => {
        quotaReports.push(report);
      },
      deleteAuthPoolEntryImpl: async (payload) => {
        deletions.push(payload);
        return { deleted: true, ...payload };
      },
    }
  );

  assert.equal(result.deleted_from_auth_pool, undefined);
  assert.equal(result.status, "error");
  assert.equal(quotaReports.length, 1);
  assert.equal(deletions.length, 0);
});

test("dedupeEntriesByAccount keeps the freshest session per account and marks the rest stale", async () => {
  const { dedupeEntriesByAccount } = await loadWorkerModule();
  const entries = [
    { source: "claude", account_id: "claude-lei", session_id: "newest", uploaded_at: "2026-06-12T14:24:08.664Z" },
    { source: "claude", account_id: "claude-lei", session_id: "mid", uploaded_at: "2026-06-12T06:16:29.254Z" },
    { source: "claude", account_id: "claude-lei", session_id: "oldest", uploaded_at: "2026-06-11T22:08:53.384Z" },
    { source: "claude", account_id: "claude-qpt", session_id: "q-new", uploaded_at: "2026-06-12T05:03:09.126Z" },
    { source: "claude", account_id: "claude-qpt", session_id: "q-old", uploaded_at: "2026-06-11T10:37:03.000Z" },
    { source: "claude", account_id: "claude-solo", session_id: "s1", uploaded_at: "2026-05-28T04:46:08.384Z" },
  ];

  const { canonical, stale } = dedupeEntriesByAccount(entries);

  // one canonical per distinct account, each the freshest upload
  assert.deepEqual(
    canonical.map((entry) => `${entry.account_id}:${entry.session_id}`).sort(),
    ["claude-lei:newest", "claude-qpt:q-new", "claude-solo:s1"]
  );
  // every other session is pruned
  assert.deepEqual(
    stale.map((entry) => `${entry.account_id}:${entry.session_id}`).sort(),
    ["claude-lei:mid", "claude-lei:oldest", "claude-qpt:q-old"]
  );
});

test("dedupeEntriesByAccount keys on source+account so a shared id across sources is not merged", async () => {
  const { dedupeEntriesByAccount } = await loadWorkerModule();
  const entries = [
    { source: "claude", account_id: "leizhang0121@gmail.com", session_id: "c", uploaded_at: "2026-06-12T00:00:00Z" },
    { source: "codex", account_id: "leizhang0121@gmail.com", session_id: "x", uploaded_at: "2026-06-12T00:00:00Z" },
  ];

  const { canonical, stale } = dedupeEntriesByAccount(entries);

  assert.equal(canonical.length, 2);
  assert.equal(stale.length, 0);
});

test("dedupeEntriesByAccount never merges or prunes entries without an account_id", async () => {
  const { dedupeEntriesByAccount } = await loadWorkerModule();
  const entries = [
    { source: "claude", account_id: "", session_id: "a", uploaded_at: "2026-06-12T00:00:00Z" },
    { source: "claude", account_id: null, session_id: "b", uploaded_at: "2026-06-11T00:00:00Z" },
  ];

  const { canonical, stale } = dedupeEntriesByAccount(entries);

  assert.equal(canonical.length, 2);
  assert.equal(stale.length, 0);
});

test("dedupeEntriesByAccount breaks uploaded_at ties deterministically by session_id", async () => {
  const { dedupeEntriesByAccount } = await loadWorkerModule();
  const sameInstant = "2026-06-12T14:24:08.664Z";
  const entries = [
    { source: "claude", account_id: "acct", session_id: "aaa", uploaded_at: sameInstant },
    { source: "claude", account_id: "acct", session_id: "zzz", uploaded_at: sameInstant },
  ];

  const first = dedupeEntriesByAccount(entries);
  const second = dedupeEntriesByAccount([...entries].reverse());

  assert.equal(first.canonical[0].session_id, "zzz");
  assert.equal(second.canonical[0].session_id, "zzz");
});

test("processAuthPoolEntry centrally refreshes a near-expiry codex auth in atOnlyMode", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  const authWrites = [];
  const now = new Date("2026-06-12T00:00:00Z");
  // id_token exp 5 minutes out -> inside the 30-minute window.
  const idToken = "h." + Buffer.from(JSON.stringify({ exp: Math.floor(now.getTime() / 1000) + 300 })).toString("base64url") + ".s";
  const expiringBlob = JSON.stringify({ tokens: { account_id: "acct-x", id_token: idToken, access_token: "OLD_AT", refresh_token: "REAL_RT" }, last_refresh: "old" });

  const result = await processAuthPoolEntry(
    { source: "codex", account_id: "acct-x", uploader_email: "derek@stardust.ai" },
    {
      atOnlyMode: true,
      nowImpl: () => now,
      decryptAuthJsonImpl: () => expiringBlob,
      refreshCodexTokenImpl: async (rt) => {
        assert.equal(rt, "REAL_RT");
        return { ok: true, access_token: "NEW_AT", refresh_token: "NEW_RT", id_token: idToken, expires_in: 3600 };
      },
      probeCodexAuthJsonImpl: (authJsonText) => {
        assert.equal(JSON.parse(authJsonText).tokens.access_token, "NEW_AT"); // probe sees refreshed AT
        return { source: "codex", account_id: "acct-x", status: "ok", error: null, windows: { "5h": null, "1week": null } };
      },
      upsertAuthPoolQuotaImpl: async () => {},
      upsertAuthPoolEntryImpl: async (entry) => { authWrites.push(entry); return { deduplicated: false }; },
      authPoolQuotaLatestForEntryImpl: async () => null,
    }
  );
  assert.equal(result.codex_refresh.ok, true);
  assert.equal(authWrites.length, 1);
  assert.equal(JSON.parse(authWrites[0].auth_json).tokens.refresh_token, "NEW_RT");
});

test("processAuthPoolEntry leaves codex untouched when atOnlyMode is off", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  let refreshCalled = false;
  const now = new Date("2026-06-12T00:00:00Z");
  const idToken = "h." + Buffer.from(JSON.stringify({ exp: Math.floor(now.getTime() / 1000) + 300 })).toString("base64url") + ".s";
  const blob = JSON.stringify({ tokens: { account_id: "acct-x", id_token: idToken, access_token: "OLD", refresh_token: "REAL_RT" } });
  const result = await processAuthPoolEntry(
    { source: "codex", account_id: "acct-x" },
    {
      atOnlyMode: false,
      nowImpl: () => now,
      decryptAuthJsonImpl: () => blob,
      refreshCodexTokenImpl: async () => { refreshCalled = true; return { ok: true, access_token: "N", refresh_token: "N" }; },
      probeCodexAuthJsonImpl: () => ({ source: "codex", account_id: "acct-x", status: "ok", error: null, windows: { "5h": null, "1week": null } }),
      upsertAuthPoolQuotaImpl: async () => {},
      upsertAuthPoolEntryImpl: async () => ({ deduplicated: false }),
      authPoolQuotaLatestForEntryImpl: async () => null,
    }
  );
  assert.equal(refreshCalled, false);
  assert.equal(result.codex_refresh ?? null, null);
});

test("summarizePoolHealth aggregates per-source health and central-refresh outcomes", async () => {
  const { summarizePoolHealth } = await loadWorkerModule();
  const items = [
    { source: "codex", status: "ok" },
    { source: "codex", status: "error", error: "auth failed (401 unauthorized)" },
    { source: "codex", status: "error", error: "something transient" },
    { source: "codex", status: "ok", deleted_from_auth_pool: true }, // excluded from the snapshot
    { source: "claude", status: "ok", claude_refresh: { attempted: true, ok: true } },
    { source: "claude", status: "error", error: "claude auth invalid (authentication_error)", claude_refresh: { attempted: true, ok: false, auth_rejected: true } },
  ];
  const health = summarizePoolHealth(items);
  assert.equal(health.codex.total, 3);
  assert.equal(health.codex.ok_count, 1);
  assert.equal(health.codex.hard_dead_count, 1);
  assert.equal(health.codex.other_err_count, 1);
  assert.equal(health.claude.total, 2);
  assert.equal(health.claude.ok_count, 1);
  assert.equal(health.claude.hard_dead_count, 1);
  assert.equal(health.claude.central_refresh_attempted, 2);
  assert.equal(health.claude.central_refresh_ok, 1);
  assert.equal(health.claude.central_refresh_rejected, 1);
});
