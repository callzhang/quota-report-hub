import test from "node:test";
import assert from "node:assert/strict";

// db.js builds its libsql client at import time and needs a TURSO url; set a dummy file URL so the
// module loads. Tests inject upsertImpl, so no actual DB I/O happens.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-ingest-test.db";
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";

const { codexClientPayloadAccepted, ingestClientQuota, ingestReporterHeartbeat } = await import("../lib/quota-ingest.js");

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
