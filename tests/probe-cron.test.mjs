import test from "node:test";
import assert from "node:assert/strict";

function responseRecorder() {
  const headers = {};
  let body = "";
  return {
    res: {
      setHeader(name, value) {
        headers[name] = value;
      },
      end(value) {
        body = value;
      },
    },
    headers,
    body: () => body,
  };
}

async function loadProbeCronModule() {
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-report-hub-probe-cron-test.db";
  process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";
  try {
    return await import(`../api/cron/probe-auth-pool.js?ts=${Date.now()}`);
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

test("probe cron rejects requests without the cron secret", async () => {
  const { probeCronHandlerImpl } = await loadProbeCronModule();
  const out = responseRecorder();

  await probeCronHandlerImpl({ method: "GET", headers: {} }, out.res, {
    dbConfigured: () => true,
    poolHealthSnapshots: async () => [],
    dispatchProbeWorkflow: async () => {
      throw new Error("should not dispatch");
    },
    env: { CRON_SECRET: "secret" },
    now: () => new Date("2026-08-03T04:00:00Z"),
  });

  assert.equal(out.res.statusCode, 401);
  assert.deepEqual(JSON.parse(out.body()), { error: "Unauthorized" });
});

test("probe cron skips dispatch when a recent health snapshot exists", async () => {
  const { probeCronHandlerImpl } = await loadProbeCronModule();
  const out = responseRecorder();
  let dispatches = 0;

  await probeCronHandlerImpl({ method: "GET", headers: { authorization: "Bearer secret" } }, out.res, {
    dbConfigured: () => true,
    poolHealthSnapshots: async (args) => {
      assert.deepEqual(args, { limit: 1 });
      return [{ captured_at: "2026-08-03T03:50:00Z" }];
    },
    dispatchProbeWorkflow: async () => {
      dispatches += 1;
      return { ok: true };
    },
    env: { CRON_SECRET: "secret" },
    now: () => new Date("2026-08-03T04:00:00Z"),
  });

  assert.equal(out.res.statusCode, 200);
  assert.equal(dispatches, 0);
  assert.deepEqual(JSON.parse(out.body()), {
    ok: true,
    dispatched: false,
    reason: "recent_probe_snapshot",
    latest_captured_at: "2026-08-03T03:50:00Z",
    latest_age_seconds: 600,
    min_interval_seconds: 1200,
  });
});

test("probe cron dispatches GitHub workflow when health snapshots are stale", async () => {
  const { probeCronHandlerImpl } = await loadProbeCronModule();
  const out = responseRecorder();
  const calls = [];

  await probeCronHandlerImpl({ method: "POST", headers: { authorization: "Bearer secret" } }, out.res, {
    dbConfigured: () => true,
    poolHealthSnapshots: async () => [{ captured_at: "2026-08-03T03:00:00Z" }],
    dispatchProbeWorkflow: async (payload) => {
      calls.push(payload);
      return { ok: true, repo: "callzhang/quota-report-hub", workflow: "probe-auth-pool.yml", ref: "main" };
    },
    env: { CRON_SECRET: "secret", GITHUB_WORKFLOW_DISPATCH_TOKEN: "github-token" },
    now: () => new Date("2026-08-03T04:00:00Z"),
  });

  assert.equal(out.res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.GITHUB_WORKFLOW_DISPATCH_TOKEN, "github-token");
  assert.deepEqual(JSON.parse(out.body()), {
    ok: true,
    dispatched: true,
    repo: "callzhang/quota-report-hub",
    workflow: "probe-auth-pool.yml",
    ref: "main",
    latest_captured_at: "2026-08-03T03:00:00Z",
    latest_age_seconds: 3600,
    min_interval_seconds: 1200,
  });
});

test("dispatchProbeWorkflow calls GitHub workflow dispatch API", async () => {
  const { dispatchProbeWorkflow } = await loadProbeCronModule();
  const calls = [];
  const result = await dispatchProbeWorkflow({
    env: {
      GITHUB_WORKFLOW_DISPATCH_TOKEN: "github-token",
      GITHUB_WORKFLOW_DISPATCH_REPO: "owner/repo",
      GITHUB_WORKFLOW_DISPATCH_WORKFLOW: "probe.yml",
      GITHUB_WORKFLOW_DISPATCH_REF: "main",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { status: 204 };
    },
  });

  assert.deepEqual(result, {
    ok: true,
    status: 204,
    repo: "owner/repo",
    workflow: "probe.yml",
    ref: "main",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/owner/repo/actions/workflows/probe.yml/dispatches");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer github-token");
  assert.equal(calls[0].options.body, JSON.stringify({ ref: "main" }));
});

test("dispatchProbeWorkflow returns configuration error without a token", async () => {
  const { dispatchProbeWorkflow } = await loadProbeCronModule();
  const result = await dispatchProbeWorkflow({
    env: {},
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });

  assert.deepEqual(result, {
    ok: false,
    status: 500,
    error: "github_workflow_dispatch_token_missing",
  });
});
