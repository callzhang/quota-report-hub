import test from "node:test";
import assert from "node:assert/strict";

test("status returns JSON service-unavailable when database reads are blocked", async () => {
  const previousEnv = {
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
    AUTH_POOL_ENCRYPTION_KEY: process.env.AUTH_POOL_ENCRYPTION_KEY,
  };
  const previousConsoleError = console.error;
  process.env.TURSO_DATABASE_URL = "file:quota-report-hub-status-test.db";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
  console.error = () => {};

  try {
    const { statusHandlerImpl } = await import(`../api/status.js?ts=${Date.now()}`);
    const headers = {};
    let body = "";
    const res = {
      setHeader(name, value) {
        headers[name] = value;
      },
      end(value) {
        body = value;
      },
    };

    await statusHandlerImpl({}, res, {
      authenticateApiRequest: async () => {
        throw new Error("BLOCKED: SQL read operations are forbidden (reads are blocked, do you need to upgrade your plan?)");
      },
      sendServiceUnavailable: (await import(`../lib/api-auth.js?ts=${Date.now()}`)).sendServiceUnavailable,
    });

    assert.equal(res.statusCode, 503);
    assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(body), {
      ok: false,
      error: "hub_unavailable",
      reason: "database_reads_blocked",
      message: "Hub database reads are currently blocked by the database provider. The token was not rejected; restore the database plan or quota, then unlock again.",
    });
  } finally {
    console.error = previousConsoleError;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("status returns the dashboard revision loaded with current state", async () => {
  const { statusHandlerImpl } = await import(`../api/status.js?revision=${Date.now()}`);
  let body = "";
  const res = {
    setHeader() {},
    end(value) { body = value; },
  };
  const emptyDataset = {
    items: [],
    archived_invalidated_items: [],
  };

  await statusHandlerImpl({}, res, {
    authenticateApiRequest: async () => ({ email: "member@stardust.ai" }),
    sendServiceUnavailable() { assert.fail("unexpected service error"); },
    sendUnauthorized() { assert.fail("unexpected unauthorized response"); },
    withTokenUpgrade: (payload) => payload,
    dbConfigured: () => true,
    authPoolEntrySummaries: async () => [],
    authPoolQuotaLatest: async () => [],
    authPoolInvalidatedNotifications: async () => [],
    authPoolFetchLog: async () => [],
    poolHealthSnapshots: async () => [],
    dashboardRevision: async () => ({ revision: 17, updated_at: "2026-08-08T08:00:00Z" }),
    authPoolStatusPayload: () => emptyDataset,
    getFeatureFlag: async () => false,
    isAdminEmail: () => false,
  });

  const payload = JSON.parse(body);
  assert.equal(payload.dashboard_revision, 17);
  assert.equal(payload.dashboard_updated_at, "2026-08-08T08:00:00Z");
});
