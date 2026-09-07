import test from "node:test";
import assert from "node:assert/strict";

// db.js builds its libsql client at import time and needs a TURSO url; set a dummy file URL so the
// module loads. Tests inject upsertImpl, so no actual DB I/O happens.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-ingest-test.db";
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";

const { codexClientPayloadAccepted, ingestClientQuota, ingestReporterHeartbeat, normalizeReporterHeartbeat } = await import("../lib/quota-ingest.js");

const completeWindow = { remaining_percent: 80, reset_at: "2026-06-14T13:00:00Z" };

test("codexClientPayloadAccepted accepts complete weekly quota without codex 5H", () => {
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "ok", windows: { "5h": completeWindow, "1week": completeWindow } }), true);
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "ok", windows: { "5h": null, "1week": completeWindow } }), true);
  // missing 1week window -> rejected
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "ok", windows: { "5h": completeWindow } }), false);
  // window without reset_at -> rejected
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "ok", windows: { "5h": completeWindow, "1week": { remaining_percent: 50 } } }), false);
  // hard invalidation is accepted even without windows
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "error", error: "auth invalidated (token_invalidated)" }), true);
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "error", error: "auth failed (401 unauthorized)" }), true);
  assert.equal(codexClientPayloadAccepted({ account_id: "a", status: "error", error: "refresh_token_rejected" }), true);
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

test("ingestClientQuota persists codex weekly quota with client origin + defaults", async () => {
  const written = [];
  const res = await ingestClientQuota({
    source: "codex",
    quotaPayload: { account_id: "acct", status: "ok", windows: { "5h": null, "1week": completeWindow } },
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

test("codexClientPayloadAccepted accepts an exhaustion report without windows", () => {
  assert.equal(codexClientPayloadAccepted({
    account_id: "a",
    status: "ok",
    exhausted_until: "2026-09-07T05:26:08Z",
    windows: { "5h": null, "1week": null },
  }), true);
  // a malformed timestamp is not evidence
  assert.equal(codexClientPayloadAccepted({
    account_id: "a",
    status: "ok",
    exhausted_until: "not-a-time",
    windows: { "5h": null, "1week": null },
  }), false);
  // status must still be ok — an error probe with a leftover field stays rejected
  assert.equal(codexClientPayloadAccepted({
    account_id: "a",
    status: "error",
    error: "codex exec failed",
    exhausted_until: "2026-09-07T05:26:08Z",
  }), false);
  // old-client fabricated zero-window shape stays accepted (mixed-fleet phasing, §17.3)
  assert.equal(codexClientPayloadAccepted({
    account_id: "a",
    status: "ok",
    windows: {
      "5h": { remaining_percent: 0, reset_at: "2026-09-07T05:26:08Z" },
      "1week": { remaining_percent: 0, reset_at: "2026-09-07T05:26:08Z" },
    },
  }), true);
  // a bare number is a duration or a year, not a timestamp — not evidence
  assert.equal(codexClientPayloadAccepted({
    account_id: "a",
    status: "ok",
    exhausted_until: 3600,
  }), false);
  // nor is a numeric string
  assert.equal(codexClientPayloadAccepted({
    account_id: "a",
    status: "ok",
    exhausted_until: "3600",
  }), false);
});

// Attribution by token. The client's account_id is a claim it cannot verify; the fingerprint of the
// token it measured through is a fact the hub can check against the tokens it has issued.
const stubEntry = { email: "owner@example.com", name: "Owner Org", plan_name: "Max" };

test("ingestClientQuota files a report under the account its token belongs to, not the account claimed", async () => {
  const writes = [];
  const lookups = [];
  const res = await ingestClientQuota({
    source: "claude",
    reporterEmail: "borrower@example.com",
    quotaPayload: {
      account_id: "claude-stale-claim@example.com",
      email: "stale-claim@example.com",
      name: "Stale Org",
      status: "ok",
      access_token_fingerprint: "fp-of-owner-token",
      usage_summary: { quota_source: "oauth_usage_api" },
      windows: { "5h": completeWindow, "1week": completeWindow },
    },
    upsertImpl: async (payload) => { writes.push(payload); },
    tokenOwnerImpl: async (source, fingerprint) => { lookups.push([source, fingerprint]); return { account_id: "claude-owner@example.com" }; },
    authPoolEntryImpl: async () => stubEntry,
  });

  assert.deepEqual(lookups, [["claude", "fp-of-owner-token"]]);
  assert.equal(res.account_id, "claude-owner@example.com");
  assert.equal(writes.length, 1);
  const [written] = writes;
  assert.equal(written.account_id, "claude-owner@example.com");
  assert.equal(written.email, "owner@example.com", "identity fields follow the resolved account");
  assert.equal(written.name, "Owner Org");
  assert.deepEqual(written.usage_summary.identity, {
    claimed_account_id: "claude-stale-claim@example.com",
    resolved_account_id: "claude-owner@example.com",
    resolved_by: "token_fingerprint",
  });
  assert.equal(written.usage_summary.quota_source, "oauth_usage_api", "the rest of usage_summary is kept");
});

test("a heartbeat keeps the quota bucket its probe read", async () => {
  // The one channel that survives everything: a report about a non-plan bucket has no windows and is
  // refused before the event log, so the heartbeat is where that observation is kept. Bounded like
  // every other free-text heartbeat field.
  const normalized = normalizeReporterHeartbeat({
    source: "codex",
    reporterEmail: "shawn.hou@stardust.ai",
    heartbeat: {
      reporter_name: "shawn@192.168.1.6",
      hostname: "192.168.1.6",
      status: "ok",
      account_id: "algorithm@stardust.ai",
      meter_limit_id: "codex_bengalfox",
    },
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.heartbeat.meter_limit_id, "codex_bengalfox");

  const absent = normalizeReporterHeartbeat({
    source: "claude",
    reporterEmail: "shawn.hou@stardust.ai",
    heartbeat: { reporter_name: "shawn@192.168.1.6", hostname: "192.168.1.6", status: "ok" },
  });
  assert.equal(absent.heartbeat.meter_limit_id, null, "claude has no buckets");

  const oversized = normalizeReporterHeartbeat({
    source: "codex",
    reporterEmail: "shawn.hou@stardust.ai",
    heartbeat: { reporter_name: "r", hostname: "h", status: "ok", meter_limit_id: "x".repeat(500) },
  });
  assert.equal(oversized.heartbeat.meter_limit_id.length, 64);
});

test("ingestClientQuota resolves a codex report by token too, and gates the resolved payload", async () => {
  // Attribution was built source-agnostic but only claude ever sent a fingerprint, so for codex
  // the claim was always taken at face value. The codex acceptance gate must see the RESOLVED
  // payload: reversing the order would judge a report by an account it does not belong to.
  const writes = [];
  const lookups = [];
  const res = await ingestClientQuota({
    source: "codex",
    reporterEmail: "borrower@example.com",
    quotaPayload: {
      account_id: "claimed@example.com",
      email: "claimed@example.com",
      status: "ok",
      access_token_fingerprint: "fp-of-owner-token",
      usage_summary: { meter: { limit_id: "codex", limit_name: null, individual_limit: null } },
      windows: { "5h": null, "1week": completeWindow },
    },
    upsertImpl: async (payload) => { writes.push(payload); },
    tokenOwnerImpl: async (source, fingerprint) => { lookups.push([source, fingerprint]); return { account_id: "owner@example.com" }; },
    authPoolEntryImpl: async () => stubEntry,
  });

  assert.deepEqual(lookups, [["codex", "fp-of-owner-token"]]);
  assert.equal(res.account_id, "owner@example.com");
  assert.equal(writes.length, 1, "the resolved report passes the codex gate and is written");
  const [written] = writes;
  assert.equal(written.account_id, "owner@example.com");
  assert.deepEqual(written.usage_summary.identity, {
    claimed_account_id: "claimed@example.com",
    resolved_account_id: "owner@example.com",
    resolved_by: "token_fingerprint",
  });
  assert.deepEqual(
    written.usage_summary.meter,
    { limit_id: "codex", limit_name: null, individual_limit: null },
    "the meter the numbers were measured on survives alongside the identity annotation",
  );
});

test("ingestClientQuota trusts the claim when the token is one the pool never held", async () => {
  const writes = [];
  await ingestClientQuota({
    source: "claude",
    reporterEmail: "owner@example.com",
    quotaPayload: {
      account_id: "claude-own-login@example.com",
      status: "ok",
      access_token_fingerprint: "fp-the-hub-has-never-seen",
      windows: { "5h": completeWindow, "1week": completeWindow },
    },
    upsertImpl: async (payload) => { writes.push(payload); },
    tokenOwnerImpl: async () => null,
    authPoolEntryImpl: async () => { throw new Error("must not look up an entry for an unknown token"); },
  });
  assert.equal(writes[0].account_id, "claude-own-login@example.com");
  assert.equal(writes[0].usage_summary, undefined, "nothing is annotated when nothing was resolved");
});

test("ingestClientQuota leaves a report without a fingerprint exactly as before", async () => {
  const writes = [];
  await ingestClientQuota({
    source: "claude",
    reporterEmail: "someone@example.com",
    quotaPayload: { account_id: "claude-legacy@example.com", status: "ok", windows: { "5h": completeWindow, "1week": completeWindow } },
    upsertImpl: async (payload) => { writes.push(payload); },
    tokenOwnerImpl: async () => { throw new Error("must not consult the token map without a fingerprint"); },
    authPoolEntryImpl: async () => { throw new Error("unreachable"); },
  });
  assert.equal(writes[0].account_id, "claude-legacy@example.com");
});

// The heartbeat is filed under the token's account too. It is the row the users page reads for
// "which account is this machine on", and it used to carry the machine's own drifting name.
test("ingestReporterHeartbeat files the machine under the account its token belongs to", async () => {
  const writes = [];
  const res = await ingestReporterHeartbeat({
    source: "claude",
    reporterEmail: "borrower@example.com",
    heartbeat: {
      reporter_name: "shawn@192.168.1.2",
      hostname: "192.168.1.2",
      status: "ok",
      account_id: "claude-stale-claim@example.com",
      client_version: "2.3.0",
      client_sha: "454064344cae7ae3d91322b1cc02746a902a36dc",
      access_token_fingerprint: "fp-of-owner-token",
    },
    upsertImpl: async (row) => { writes.push(row); },
    tokenOwnerImpl: async (source, fp) => (source === "claude" && fp === "fp-of-owner-token" ? { account_id: "claude-owner@example.com" } : null),
  });
  assert.equal(res.account_id, "claude-owner@example.com");
  const [row] = writes;
  assert.equal(row.account_id, "claude-owner@example.com");
  assert.equal(row.client_sha, "454064344cae7ae3d91322b1cc02746a902a36dc", "the applied commit travels with the heartbeat");
  assert.equal(row.access_token_fingerprint, undefined, "the fingerprint is consumed, never stored");
});

test("ingestReporterHeartbeat keeps the claimed account for a token the pool never held", async () => {
  const writes = [];
  await ingestReporterHeartbeat({
    source: "claude",
    reporterEmail: "owner@example.com",
    heartbeat: { reporter_name: "owner@mbp", hostname: "mbp", status: "ok", account_id: "claude-own-login@example.com", access_token_fingerprint: "unknown" },
    upsertImpl: async (row) => { writes.push(row); },
    tokenOwnerImpl: async () => null,
  });
  assert.equal(writes[0].account_id, "claude-own-login@example.com");
});

test("ingestReporterHeartbeat does not consult the token map when no fingerprint was sent", async () => {
  const writes = [];
  await ingestReporterHeartbeat({
    source: "claude",
    reporterEmail: "someone@example.com",
    heartbeat: { reporter_name: "legacy@host", hostname: "host", status: "ok", account_id: "claude-legacy@example.com", client_version: "2.1.0" },
    upsertImpl: async (row) => { writes.push(row); },
    tokenOwnerImpl: async () => { throw new Error("must not be called"); },
  });
  assert.equal(writes[0].account_id, "claude-legacy@example.com");
  assert.equal(writes[0].client_sha, null);
});

// "claude auth email unavailable" is the client saying it does not know whose credential it runs. Once
// the hub has answered that by token, the error is moot -- and left in place it turned a healthy
// account's row red every time a borrower with a blank identity record reported.
test("ingestClientQuota clears the client's email-unavailable error when the hub resolved the identity", async () => {
  const writes = [];
  await ingestClientQuota({
    source: "claude",
    reporterEmail: "borrower@example.com",
    quotaPayload: {
      account_id: "claude-email-missing",
      status: "error",
      error: "claude auth email unavailable",
      access_token_fingerprint: "fp-of-owner-token",
      windows: { "5h": completeWindow, "1week": completeWindow },
    },
    upsertImpl: async (payload) => { writes.push(payload); },
    tokenOwnerImpl: async () => ({ account_id: "claude-owner@example.com" }),
    authPoolEntryImpl: async () => stubEntry,
  });
  const [written] = writes;
  assert.equal(written.account_id, "claude-owner@example.com");
  assert.equal(written.status, "ok", "the numbers were measured fine; only the name was missing");
  assert.equal(written.error, null);
  assert.equal(written.email, "owner@example.com");
});

test("ingestClientQuota leaves any other error on a resolved report untouched", async () => {
  const writes = [];
  await ingestClientQuota({
    source: "claude",
    reporterEmail: "borrower@example.com",
    quotaPayload: {
      account_id: "claude-stale@example.com",
      status: "error",
      error: "claude auth invalid (authentication_error)",
      access_token_fingerprint: "fp-of-owner-token",
      windows: { "5h": null, "1week": null },
    },
    upsertImpl: async (payload) => { writes.push(payload); },
    tokenOwnerImpl: async () => ({ account_id: "claude-owner@example.com" }),
    authPoolEntryImpl: async () => stubEntry,
  });
  assert.equal(writes[0].status, "error");
  assert.equal(writes[0].error, "claude auth invalid (authentication_error)", "a token that was refused is still refused, whoever it belongs to");
});

test("the self-updater's outcome is tri-state: working, failing, or too old to say", () => {
  // "This client cannot tell us" and "this client's updater failed" are different facts. Folding
  // them together would mark every pre-2.4.0 machine as broken and bury the ones that are.
  const base = { reporter_name: "u@host", hostname: "host", status: "ok" };
  const failing = normalizeReporterHeartbeat({
    source: "codex",
    reporterEmail: "derek@stardust.ai",
    heartbeat: {
      ...base,
      self_update_ok: false,
      self_update_checked_at: "2026-09-06T18:30:00.000Z",
      self_update_error: `${"x".repeat(600)}`,
    },
  });
  assert.equal(failing.heartbeat.self_update_ok, false);
  assert.equal(failing.heartbeat.self_update_checked_at, "2026-09-06T18:30:00.000Z");
  assert.equal(failing.heartbeat.self_update_error.length, 500, "a runaway message cannot bloat the row");

  const silent = normalizeReporterHeartbeat({
    source: "codex", reporterEmail: "derek@stardust.ai", heartbeat: base,
  });
  assert.equal(silent.heartbeat.self_update_ok, null);
  assert.equal(silent.heartbeat.self_update_error, null);

  // Truthy junk is not a claim that the updater works.
  const junk = normalizeReporterHeartbeat({
    source: "codex", reporterEmail: "derek@stardust.ai", heartbeat: { ...base, self_update_ok: "yes" },
  });
  assert.equal(junk.heartbeat.self_update_ok, null);
});
