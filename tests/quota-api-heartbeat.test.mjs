import test from "node:test";
import assert from "node:assert/strict";

process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-report-hub-quota-api-test.db";
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";

const { quotaHandlerImpl } = await import("../api/auth/quota.js");

function makeRes() {
  const res = { statusCode: 0, headers: {}, body: "" };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.end = (value) => { res.body = value; };
  return res;
}

function makeDeps(body, overrides = {}) {
  const calls = { quota: [], heartbeat: [] };
  const deps = {
    authenticateApiRequest: async () => ({ email: "derek@stardust.ai" }),
    sendUnauthorized: () => assert.fail("unexpected unauthorized"),
    withTokenUpgrade: (payload) => payload,
    dbConfigured: () => true,
    authPoolConfigured: () => true,
    readJsonBody: async () => body,
    ingestClientQuota: async (args) => {
      calls.quota.push(args);
      return { ok: true, account_id: args.quotaPayload?.account_id };
    },
    ingestReporterHeartbeat: async (args) => {
      calls.heartbeat.push(args);
      return { ok: true, reporter_name: args.heartbeat?.reporter_name, status: args.heartbeat?.status };
    },
    ...overrides,
  };
  return { deps, calls };
}

test("a heartbeat-only POST is accepted — that is the run a failing probe produces", async () => {
  const heartbeat = {
    reporter_name: "xienxu@XientekiMacBook-Air.local",
    hostname: "XientekiMacBook-Air.local",
    status: "error",
    error: "codex probe failed: URLError: dns",
    client_version: "2.1.0",
  };
  const { deps, calls } = makeDeps({ source: "codex", heartbeat });
  const res = makeRes();

  await quotaHandlerImpl({ method: "POST" }, res, deps);

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.reason, "heartbeat_only");
  assert.equal(payload.heartbeat.status, "error");
  assert.equal(calls.quota.length, 0, "no quota reading exists, so nothing should be ingested as one");
  assert.equal(calls.heartbeat.length, 1);
  assert.equal(calls.heartbeat[0].reporterEmail, "derek@stardust.ai");
});

test("a POST carrying both a quota payload and a heartbeat records both", async () => {
  const { deps, calls } = makeDeps({
    source: "codex",
    quota_payload: { account_id: "bd@stardust.ai", status: "ok" },
    heartbeat: { reporter_name: "u@host", status: "ok" },
  });
  const res = makeRes();

  await quotaHandlerImpl({ method: "POST" }, res, deps);

  const payload = JSON.parse(res.body);
  assert.equal(payload.account_id, "bd@stardust.ai");
  assert.equal(payload.heartbeat.status, "ok");
  assert.equal(calls.quota.length, 1);
  assert.equal(calls.heartbeat.length, 1);
});

test("an older client that sends only a quota payload still works", async () => {
  const { deps, calls } = makeDeps({
    source: "claude",
    quota_payload: { account_id: "claude-a@example.com", status: "ok" },
  });
  const res = makeRes();

  await quotaHandlerImpl({ method: "POST" }, res, deps);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).account_id, "claude-a@example.com");
  assert.equal(calls.heartbeat.length, 0);
});

test("a POST with neither a quota payload nor a heartbeat is a bad request", async () => {
  const { deps, calls } = makeDeps({ source: "codex" });
  const res = makeRes();

  await quotaHandlerImpl({ method: "POST" }, res, deps);

  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /quota_payload or heartbeat/);
  assert.equal(calls.quota.length + calls.heartbeat.length, 0);
});

test("an unreportable quota payload still returns the heartbeat result", async () => {
  const { deps } = makeDeps(
    {
      source: "codex",
      quota_payload: { account_id: "acct", status: "ok" },
      heartbeat: { reporter_name: "u@host", status: "error", error: "no usable payload" },
    },
    { ingestClientQuota: async () => ({ ok: true, ignored: true, reason: "quota_unavailable" }) },
  );
  const res = makeRes();

  await quotaHandlerImpl({ method: "POST" }, res, deps);

  const payload = JSON.parse(res.body);
  assert.equal(payload.reason, "quota_unavailable");
  assert.equal(payload.heartbeat.status, "error");
});
