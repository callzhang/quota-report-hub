import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

// Transitions are recorded inside upsertAuthPoolQuota, the one point every ingest path passes
// through, so these run against a real (file-backed) database rather than injected impls: the bug
// this file exists for was a hook that only the worker reached, and only an integration-level test
// notices that a client-observed transition never lands.
const DB_FILE = "quota-report-hub-death-events-test.db";
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.TURSO_AUTH_TOKEN = "test-token";
for (const suffix of ["", "-shm", "-wal"]) {
  rmSync(DB_FILE + suffix, { force: true });
}

const db = await import("../lib/db.js");

let seq = 0;
function account() {
  return `seat-${++seq}@stardust.ai`;
}

function report(accountId, { status, error = null, at, authLastRefresh = "2026-09-06T05:59:27.839Z", central = null }) {
  return {
    source: "codex",
    account_id: accountId,
    hostname: "test-host",
    reporter_name: "tester@test-host",
    reported_at: at,
    plan_name: "Team",
    auth_last_refresh: authLastRefresh,
    status,
    error,
    windows:
      status === "ok"
        ? { "5h": { remaining_percent: 80, reset_at: at }, "1week": { remaining_percent: 70, reset_at: at } }
        : {},
    ...(central ? { usage_summary: { central_refresh: central } } : {}),
  };
}

async function eventsFor(accountId) {
  const all = await db.authPoolDeathEvents({ limit: 500 });
  return all.filter((e) => e.account_id === accountId).sort((a, b) => a.id - b.id);
}

const DEAD = "auth invalidated (token_invalidated)";

test("a healthy account going hard-dead appends one death with the hub's own last refresh", async () => {
  const a = account();
  await db.upsertAuthPoolQuota(report(a, { status: "ok", at: "2026-09-06T06:51:00Z" }));
  await db.upsertAuthPoolQuota(report(a, { status: "error", error: DEAD, at: "2026-09-06T07:13:06Z" }));

  const events = await eventsFor(a);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "death");
  assert.equal(events[0].error, DEAD);
  assert.equal(events[0].hub_last_refresh_at, "2026-09-06T05:59:27.839Z");
  assert.equal(events[0].last_healthy_probe_at, "2026-09-06T06:51:00Z");
  assert.equal(events[0].central_refresh_verdict, "not_attempted");
});

test("a client-observed revival is recorded — the worker is not the only path", async () => {
  const a = account();
  await db.upsertAuthPoolQuota(report(a, { status: "ok", at: "2026-09-08T01:00:00Z" }));
  await db.upsertAuthPoolQuota(report(a, { status: "error", error: DEAD, at: "2026-09-08T01:40:41Z" }));
  // What actually happened on 2026-09-08: the owner re-onboarded and their own machine reported ok.
  // The hook this replaces lived in the worker and saw nothing.
  await db.upsertAuthPoolQuota(report(a, { status: "ok", at: "2026-09-08T02:00:10Z" }));

  const events = await eventsFor(a);
  assert.deepEqual(events.map((e) => e.event), ["death", "revival"]);
  assert.equal(events[1].observed_at, "2026-09-08T02:00:10Z");
  assert.equal(events[1].error, null);
});

test("a revival records no central-refresh verdict — it would describe the replaced credential", async () => {
  const a = account();
  await db.upsertAuthPoolQuota(report(a, { status: "ok", at: "2026-09-08T01:00:00Z" }));
  await db.upsertAuthPoolQuota(
    report(a, {
      status: "error",
      error: DEAD,
      at: "2026-09-08T01:40:41Z",
      central: { attempted: true, ok: false, auth_rejected: true },
    })
  );
  await db.upsertAuthPoolQuota(report(a, { status: "ok", at: "2026-09-08T02:36:41Z" }));

  const events = await eventsFor(a);
  assert.deepEqual(events.map((e) => e.event), ["death", "revival"]);
  assert.equal(events[0].central_refresh_verdict, "rejected");
  // The merge keeps the rejection sticky, so without this the revival inherits it and reads as a
  // credential that came back while its refresh token was still refused.
  assert.equal(events[1].central_refresh_verdict, null);
});

test("staying dead appends nothing — the row marks the transition, not the state", async () => {
  const a = account();
  await db.upsertAuthPoolQuota(report(a, { status: "ok", at: "2026-09-06T06:00:00Z" }));
  await db.upsertAuthPoolQuota(report(a, { status: "error", error: DEAD, at: "2026-09-06T07:13:06Z" }));
  for (const at of ["2026-09-06T07:35:00Z", "2026-09-06T07:57:00Z", "2026-09-06T08:19:00Z"]) {
    await db.upsertAuthPoolQuota(report(a, { status: "error", error: DEAD, at }));
  }

  const events = await eventsFor(a);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "death");
});

test("an account first seen already dead is recorded, with no healthy probe to name", async () => {
  const a = account();
  await db.upsertAuthPoolQuota(report(a, { status: "error", error: DEAD, at: "2026-09-06T07:13:06Z" }));

  const events = await eventsFor(a);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "death");
  assert.equal(events[0].last_healthy_probe_at, null);
});

test("a rejected central refresh is recorded as the verdict, separating RT death from AT death", async () => {
  const a = account();
  await db.upsertAuthPoolQuota(report(a, { status: "ok", at: "2026-09-06T06:51:00Z" }));
  await db.upsertAuthPoolQuota(
    report(a, {
      status: "error",
      error: DEAD,
      at: "2026-09-06T07:13:06Z",
      central: { attempted: true, ok: false, auth_rejected: true },
    })
  );

  const events = await eventsFor(a);
  assert.equal(events.length, 1);
  assert.equal(events[0].central_refresh_verdict, "rejected");
});

test("a probe failure is not a death — only hard auth errors flip the state", async () => {
  const a = account();
  await db.upsertAuthPoolQuota(report(a, { status: "ok", at: "2026-09-06T06:51:00Z" }));
  await db.upsertAuthPoolQuota(
    report(a, {
      status: "error",
      error: "token_count event was present but missing quota details",
      at: "2026-09-06T07:13:06Z",
    })
  );

  assert.deepEqual(await eventsFor(a), []);
});
