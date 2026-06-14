import test from "node:test";
import assert from "node:assert/strict";

// db.js builds its libsql client at import time and needs a TURSO url; set a dummy file URL so the
// module loads. Tests inject upsertImpl, so no actual DB I/O happens.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-ingest-test.db";
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";

const { codexClientPayloadAccepted, ingestClientQuota } = await import("../lib/quota-ingest.js");

const completeWindow = { remaining_percent: 80, reset_at: "2026-06-14T13:00:00Z" };

test("codexClientPayloadAccepted: complete windows accepted, partial rejected", () => {
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "ok", windows: { "5h": completeWindow, "1week": completeWindow } }), true);
  // missing 1week window -> rejected
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "ok", windows: { "5h": completeWindow } }), false);
  // window without reset_at -> rejected
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "ok", windows: { "5h": { remaining_percent: 50 }, "1week": completeWindow } }), false);
  // hard invalidation is accepted even without windows
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "error", error: "auth invalidated (token_invalidated)" }), true);
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "error", error: "auth failed (401 unauthorized)" }), true);
  // no account_id -> rejected
  assert.equal(codexClientPayloadAccepted({ status: "ok", windows: { "5h": completeWindow, "1week": completeWindow } }), false);
});

test("ingestClientQuota rejects a missing/invalid quota payload without writing", async () => {
  let calls = 0;
  const upsertImpl = async () => { calls++; };
  assert.deepEqual(await ingestClientQuota({ source: "codex", quotaPayload: null, upsertImpl }), { ok: false, reason: "missing_quota_payload" });
  assert.deepEqual(await ingestClientQuota({ source: "codex", quotaPayload: "x", upsertImpl }), { ok: false, reason: "missing_quota_payload" });
  assert.equal(calls, 0);
});

test("ingestClientQuota requires account_id", async () => {
  let calls = 0;
  const res = await ingestClientQuota({ source: "claude", quotaPayload: { status: "ok" }, upsertImpl: async () => { calls++; } });
  assert.deepEqual(res, { ok: false, reason: "missing_account_id" });
  assert.equal(calls, 0);
});

test("ingestClientQuota ignores an incomplete codex payload (no write)", async () => {
  let calls = 0;
  const res = await ingestClientQuota({
    source: "codex",
    quotaPayload: { account_id: "acct", status: "ok", windows: { "5h": { remaining_percent: 50 } } },
    upsertImpl: async () => { calls++; },
  });
  assert.deepEqual(res, { ok: true, ignored: true, reason: "quota_unavailable", account_id: "acct" });
  assert.equal(calls, 0);
});

test("ingestClientQuota persists a complete codex payload with client origin + defaults", async () => {
  const written = [];
  const res = await ingestClientQuota({
    source: "codex",
    quotaPayload: { account_id: "acct", status: "ok", windows: { "5h": completeWindow, "1week": completeWindow } },
    reporterEmail: "derek@stardust.ai",
    upsertImpl: async (p) => { written.push(p); },
  });
  assert.deepEqual(res, { ok: true, account_id: "acct" });
  assert.equal(written.length, 1);
  assert.equal(written[0].source, "codex");
  assert.equal(written[0].report_origin, "client");
  assert.equal(written[0].reporter_name, "derek@stardust.ai"); // defaulted from reporterEmail
  assert.equal(written[0].hostname, "client-report"); // defaulted
});

test("ingestClientQuota persists any claude payload (no codex completeness gate)", async () => {
  const written = [];
  const res = await ingestClientQuota({
    source: "claude",
    quotaPayload: { account_id: "claude-acct", status: "ok", windows: { "5h": { remaining_percent: 90 } }, reporter_name: "host-a", hostname: "host-a" },
    upsertImpl: async (p) => { written.push(p); },
  });
  assert.deepEqual(res, { ok: true, account_id: "claude-acct" });
  assert.equal(written.length, 1);
  assert.equal(written[0].reporter_name, "host-a"); // preserved when provided
});
