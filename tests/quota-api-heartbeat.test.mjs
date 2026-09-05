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
    // the write-path floor only refuses once the gate phase has begun; tests opt in explicitly
    activePhases: () => ({ notice: true, reporter_gate: false, cooldown: false }),
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

// The version floor is enforced where data is written. The heartbeat is always kept -- it is how the
// machine and its version are seen at all -- but an outdated client's quota numbers are refused once
// the reporter_gate phase has begun, and merely warned about before it.
function outdatedBody() {
  return {
    source: "claude",
    quota_payload: { account_id: "claude-a@example.com", status: "ok", windows: { "5h": null, "1week": null } },
    heartbeat: { reporter_name: "old@host", hostname: "host", status: "ok", client_version: "2.1.0" },
  };
}

test("an outdated client's quota report is refused once the reporter gate is active, its heartbeat is kept", async () => {
  const { deps, calls } = makeDeps(outdatedBody(), { activePhases: () => ({ notice: true, reporter_gate: true, cooldown: false }) });
  const res = makeRes();
  await quotaHandlerImpl({ method: "POST" }, res, deps);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "reporter_upgrade_required");
  assert.equal(body.client_version, "2.1.0");
  assert.equal(body.notices[0].code, "reporter_upgrade_required");
  assert.equal(calls.heartbeat.length, 1, "the heartbeat is still ingested");
  assert.equal(calls.quota.length, 0, "the quota numbers are not");
});

test("before the gate, an outdated client is warned but its report is still taken", async () => {
  const { deps, calls } = makeDeps(outdatedBody(), { activePhases: () => ({ notice: true, reporter_gate: false, cooldown: false }) });
  const res = makeRes();
  await quotaHandlerImpl({ method: "POST" }, res, deps);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(calls.quota.length, 1);
  assert.equal(body.notices?.[0]?.code, "reporter_upgrade_required");
});

test("a current client passes the write gate with no notice", async () => {
  const current = outdatedBody();
  current.heartbeat.client_version = "2.3.0";
  const { deps, calls } = makeDeps(current, { activePhases: () => ({ notice: true, reporter_gate: true, cooldown: false }) });
  const res = makeRes();
  await quotaHandlerImpl({ method: "POST" }, res, deps);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(calls.quota.length, 1);
  assert.deepEqual(body.notices ?? [], []);
});
