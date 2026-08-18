import test from "node:test";
import assert from "node:assert/strict";

process.env.TURSO_DATABASE_URL ||= "file:quota-report-hub-token-usage-retention-api-test.db";
process.env.TURSO_AUTH_TOKEN ||= "test-token";
process.env.AUTH_POOL_ENCRYPTION_KEY ||= "0".repeat(64);

function responseRecorder() {
  const headers = {};
  let body = "";
  return {
    res: { setHeader(name, value) { headers[name] = value; }, end(value = "") { body = value; } },
    result() { return { headers, body }; },
  };
}

function dependencies(overrides = {}) {
  return {
    cronSecret: () => "cron-secret",
    dbConfigured: () => true,
    compactTokenUsage: async () => ({ days: [], detail_rows_removed: 0, daily_rows_affected: 0, receipts_removed: 0 }),
    now: () => new Date("2026-08-18T12:00:00.000Z"),
    ...overrides,
  };
}

test("retention cron accepts GET and POST only", async () => {
  const { tokenUsageRetentionHandlerImpl } = await import("../lib/data-api.js");
  const recorder = responseRecorder();
  await tokenUsageRetentionHandlerImpl({ method: "PUT", headers: {} }, recorder.res, dependencies());
  assert.equal(recorder.res.statusCode, 405);
  assert.equal(recorder.result().headers.Allow, "GET, POST");
});

test("retention cron requires the configured bearer secret", async () => {
  const { tokenUsageRetentionHandlerImpl } = await import("../lib/data-api.js");
  for (const authorization of [undefined, "Bearer wrong"]) {
    const recorder = responseRecorder();
    await tokenUsageRetentionHandlerImpl({ method: "GET", headers: { authorization } }, recorder.res, dependencies());
    assert.equal(recorder.res.statusCode, 401);
  }
});

test("retention cron requires only database configuration", async () => {
  const { tokenUsageRetentionHandlerImpl } = await import("../lib/data-api.js");
  const recorder = responseRecorder();
  let calls = 0;
  await tokenUsageRetentionHandlerImpl({ method: "GET", headers: { authorization: "Bearer cron-secret" } }, recorder.res, dependencies({
    dbConfigured: () => false,
    compactTokenUsage: async () => { calls += 1; },
  }));
  assert.equal(recorder.res.statusCode, 500);
  assert.equal(calls, 0);
});

test("retention cron uses an exact 90-day cutoff and seven-day bound", async () => {
  const { tokenUsageRetentionHandlerImpl } = await import("../lib/data-api.js");
  const recorder = responseRecorder();
  let seen;
  await tokenUsageRetentionHandlerImpl({ method: "POST", headers: { authorization: "Bearer cron-secret" } }, recorder.res, dependencies({
    compactTokenUsage: async (options) => {
      seen = options;
      return { days: ["2026-05-19"], detail_rows_removed: 2, daily_rows_affected: 1, receipts_removed: 3 };
    },
  }));
  assert.deepEqual(seen, {
    before: "2026-05-20T12:00:00.000Z",
    receiptBefore: "2026-05-20T12:00:00.000Z",
    maxDays: 7,
  });
  assert.equal(recorder.res.statusCode, 200);
  assert.equal(JSON.parse(recorder.result().body).detail_rows_removed, 2);
});

test("retention cron returns service failure without exposing internals", async () => {
  const { tokenUsageRetentionHandlerImpl } = await import("../lib/data-api.js");
  const recorder = responseRecorder();
  await tokenUsageRetentionHandlerImpl({ method: "GET", headers: { authorization: "Bearer cron-secret" } }, recorder.res, dependencies({
    compactTokenUsage: async () => { throw new Error("private database detail"); },
  }));
  assert.equal(recorder.res.statusCode, 503);
  assert.equal(recorder.result().body.includes("private database detail"), false);
});
