import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

// api/auth/upload.js binds lib/db.js once per process, so this file shares one database.
const tempDir = mkdtempSync(join(tmpdir(), "qrh-upload-exclusions-"));
process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "exclusions.db")}`;
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
process.env.TOKEN_ISSUE_KEY = "test-token-issue-key-32-bytes!!!";
test.after(() => rmSync(tempDir, { recursive: true, force: true }));

const db = await import("../lib/db.js");
const { default: uploadHandler } = await import("../api/auth/upload.js");
const { quotaHandlerImpl } = await import("../api/auth/quota.js");
const { tokenUsageHandlerImpl, uploadExclusionsHandlerImpl } = await import("../lib/data-api.js");

const OWNER = "melody@stardust.ai";
const EXCLUDED = "private.person@gmail.com";

async function exclude(source, accountId, ownerEmail = OWNER) {
  await db.ensureSchema();
  await createClient({ url: process.env.TURSO_DATABASE_URL }).execute({
    sql: `INSERT OR IGNORE INTO auth_pool_upload_exclusions (source, account_id, owner_email, created_at) VALUES (?, ?, ?, ?)`,
    args: [source, accountId, ownerEmail, "2026-10-16T00:00:00.000Z"],
  });
}

function recorder() {
  const out = { statusCode: 200, body: "" };
  out.setHeader = () => {};
  out.end = (value = "") => { out.body = value; };
  return out;
}

function codexAuthJson(email) {
  const claims = { email, name: "P", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } };
  return JSON.stringify({
    last_refresh: "2026-10-15T20:00:00Z",
    tokens: {
      account_id: "provider-uuid",
      id_token: `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`,
      access_token: "at",
      refresh_token: "rt",
    },
  });
}

test("the list a client may read holds its own user's accounts and no one else's", async () => {
  await exclude("codex", EXCLUDED);
  await exclude("codex", "someone.else@gmail.com", "other@stardust.ai");
  const res = recorder();
  await uploadExclusionsHandlerImpl({ method: "GET" }, res, {
    authenticateApiRequest: async () => ({ email: OWNER }),
    sendUnauthorized() { assert.fail("unexpected unauthorized"); },
    sendServiceUnavailable() { assert.fail("unexpected failure"); },
    withTokenUpgrade: (payload) => payload,
    uploadExclusionsOwnedBy: db.uploadExclusionsOwnedBy,
  });
  assert.deepEqual(JSON.parse(res.body).exclusions, [{ source: "codex", account_id: EXCLUDED }]);
});

test("an excluded account's credential is refused before it is stored", async () => {
  await exclude("codex", EXCLUDED);
  const token = (await db.issueApiToken(OWNER)).token;
  const body = { source: "codex", auth_json: codexAuthJson(EXCLUDED), defer_codex_refresh: true };
  const req = {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    async on() {},
    [Symbol.asyncIterator]: async function* iterator() { yield Buffer.from(JSON.stringify(body), "utf8"); },
  };
  const res = recorder();
  await uploadHandler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, "upload_excluded");
  assert.equal(await db.authPoolEntry("codex", EXCLUDED), null);
});

function quotaDeps(calls) {
  return {
    authenticateApiRequest: async () => ({ email: OWNER }),
    sendUnauthorized: () => assert.fail("unexpected unauthorized"),
    withTokenUpgrade: (payload) => payload,
    dbConfigured: () => true,
    authPoolConfigured: () => true,
    readJsonBody: async () => calls.body,
    ingestClientQuota: async (args) => { calls.quota.push(args); return { ok: true, account_id: args.quotaPayload.account_id }; },
    ingestReporterHeartbeat: async (args) => { calls.heartbeat.push(args); return { ok: true }; },
    activePhases: () => ({ notice: true, reporter_gate: false, cooldown: false }),
    uploadExcludedAccountIds: async () => new Set([EXCLUDED]),
  };
}

test("an excluded account's quota is not stored and its identity leaves the heartbeat", async () => {
  const calls = {
    quota: [],
    heartbeat: [],
    body: {
      source: "codex",
      quota_payload: { account_id: EXCLUDED, windows: {} },
      heartbeat: { reporter_name: "m", status: "ok", account_id: EXCLUDED, access_token_fingerprint: "fp", client_version: "9.9.9" },
    },
  };
  const res = recorder();
  await quotaHandlerImpl({ method: "POST" }, res, quotaDeps(calls));
  assert.equal(calls.quota.length, 0);
  assert.equal(calls.heartbeat.length, 1);
  assert.equal(calls.heartbeat[0].heartbeat.account_id, null);
  assert.equal(calls.heartbeat[0].heartbeat.access_token_fingerprint, null);
  assert.equal(calls.heartbeat[0].heartbeat.reporter_name, "m");
  assert.equal(JSON.parse(res.body).reason, "upload_excluded");
});

test("another account's quota still reaches ingest", async () => {
  const calls = {
    quota: [],
    heartbeat: [],
    body: { source: "codex", quota_payload: { account_id: "ok@stardust.ai", windows: {} } },
  };
  await quotaHandlerImpl({ method: "POST" }, recorder(), quotaDeps(calls));
  assert.equal(calls.quota.length, 1);
});

test("usage measured on an excluded account is dropped and the rest of the batch is stored", async () => {
  const written = [];
  const res = recorder();
  await tokenUsageHandlerImpl({ method: "POST" }, res, {
    authenticateApiRequest: async () => ({ email: OWNER }),
    sendUnauthorized() { assert.fail("unexpected unauthorized"); },
    sendServiceUnavailable() { assert.fail("unexpected failure"); },
    withTokenUpgrade: (payload) => payload,
    readJsonBody: async () => ({}),
    normalizeTokenUsageBatch: () => ({
      installation_id: "i", batch_id: "b", client_version: "9.9.9",
      rows: [
        { provider: "codex", model_account_id: EXCLUDED, model_id: "m" },
        { provider: "codex", model_account_id: "ok@stardust.ai", model_id: "m" },
      ],
      messages: [
        { message_key: "k1", model_account_id: `claude-${EXCLUDED}`, model_id: "m" },
        { message_key: "k2", model_account_id: "claude-ok@stardust.ai", model_id: "m" },
      ],
    }),
    ingestTokenUsageBatch: async (args) => { written.push(args); return { applied: true, received_at: "t" }; },
    activePhases: () => ({ notice: true, reporter_gate: false, cooldown: false }),
    uploadExcludedAccountIds: async (source) => new Set(source === "codex" ? [EXCLUDED] : [`claude-${EXCLUDED}`]),
    now: () => new Date("2026-10-16T00:00:00.000Z"),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(written[0].rows.map((row) => row.model_account_id), ["ok@stardust.ai"]);
  assert.deepEqual(written[0].messages.map((message) => message.message_key), ["k2"]);
});

test("a user who excluded an account still counts as supplying the pool", async () => {
  const since = "2026-10-01T00:00:00.000Z";
  await exclude("codex", "kept.private@gmail.com", "private.owner@stardust.ai");
  assert.equal((await db.fetchPolicyInputs({ email: "private.owner@stardust.ai", since })).hasHealthyUpload, true);
  assert.equal((await db.fetchPolicyInputs({ email: "nobody@stardust.ai", since })).hasHealthyUpload, false);
});
