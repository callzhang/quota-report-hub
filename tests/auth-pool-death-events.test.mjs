import test from "node:test";
import assert from "node:assert/strict";

async function loadWorkerModule() {
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-report-hub-death-events-test.db";
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

const ENTRY = {
  source: "codex",
  account_id: "seat@stardust.ai",
  plan_name: "Team",
  uploader_email: "seat@stardust.ai",
  auth_last_refresh: "2026-09-06T05:59:27.839Z",
};

function okReport(reportedAt = "2026-09-06T07:13:06Z") {
  return {
    source: "codex",
    account_id: ENTRY.account_id,
    status: "ok",
    error: null,
    reported_at: reportedAt,
    windows: { "5h": { remaining_percent: 80 }, "1week": { remaining_percent: 70 } },
  };
}

function deadReport(reportedAt = "2026-09-06T07:13:06Z") {
  return {
    source: "codex",
    account_id: ENTRY.account_id,
    status: "error",
    error: "auth invalidated (token_invalidated)",
    reported_at: reportedAt,
    windows: {},
  };
}

async function runEntry({ probeReport, previousReport, centralRefresh = null, entry = ENTRY }) {
  const { processAuthPoolEntry } = await loadWorkerModule();
  const deathEvents = [];
  await processAuthPoolEntry(entry, {
    decryptAuthJsonImpl: () =>
      '{"tokens":{"account_id":"seat@stardust.ai","refresh_token":"rt.real.token"}}',
    probeCodexAuthJsonImpl: () => probeReport,
    upsertAuthPoolQuotaImpl: async () => {},
    upsertAuthPoolEntryImpl: async () => ({ deduplicated: false }),
    authPoolQuotaLatestForEntryImpl: async () => previousReport,
    deleteAuthPoolEntryImpl: async () => ({ deleted: true }),
    recordAuthPoolDeathEventImpl: async (event) => {
      deathEvents.push(event);
    },
    ...(centralRefresh
      ? {
          atOnlyMode: true,
          refreshCodexTokenImpl: centralRefresh,
        }
      : {}),
  });
  return deathEvents;
}

test("a healthy entry going hard-dead appends one death carrying the hub's own last refresh", async () => {
  const events = await runEntry({
    probeReport: deadReport(),
    previousReport: okReport("2026-09-06T06:51:00Z"),
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "death");
  assert.equal(events[0].source, "codex");
  assert.equal(events[0].accountId, "seat@stardust.ai");
  // Plan is snapshotted at the death because the entry itself may be deleted moments later.
  assert.equal(events[0].planName, "Team");
  assert.equal(events[0].error, "auth invalidated (token_invalidated)");
  // The two halves of the join the hub could not previously make.
  assert.equal(events[0].hubLastRefreshAt, "2026-09-06T05:59:27.839Z");
  assert.equal(events[0].lastHealthyProbeAt, "2026-09-06T06:51:00Z");
  assert.equal(events[0].centralRefreshVerdict, "not_attempted");
});

test("staying dead appends nothing — the row marks the transition, not the state", async () => {
  const events = await runEntry({
    probeReport: deadReport("2026-09-06T07:35:00Z"),
    previousReport: deadReport("2026-09-06T07:13:06Z"),
  });

  assert.deepEqual(events, []);
});

test("coming back appends a revival, so time-to-repair is recoverable", async () => {
  const events = await runEntry({
    probeReport: okReport("2026-09-07T01:35:17Z"),
    previousReport: deadReport("2026-09-06T07:13:06Z"),
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "revival");
  assert.equal(events[0].error, null);
  // Nothing was healthy before this, so there is no healthy probe to point at.
  assert.equal(events[0].lastHealthyProbeAt, null);
});

test("an entry first seen already dead is recorded, with no healthy probe to name", async () => {
  const events = await runEntry({
    probeReport: deadReport(),
    previousReport: null,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "death");
  assert.equal(events[0].lastHealthyProbeAt, null);
});

test("a rejected central refresh is recorded as the verdict, separating RT death from AT death", async () => {
  const events = await runEntry({
    probeReport: deadReport(),
    previousReport: okReport("2026-09-06T06:51:00Z"),
    centralRefresh: async () => ({ ok: false, auth_rejected: true, status: 400 }),
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "death");
  assert.equal(events[0].centralRefreshVerdict, "rejected");
});

test("a probe failure is not a death — only hard auth errors flip the state", async () => {
  const events = await runEntry({
    probeReport: {
      ...deadReport(),
      error: "token_count event was present but missing quota details",
    },
    previousReport: okReport("2026-09-06T06:51:00Z"),
  });

  assert.deepEqual(events, []);
});
