import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.TURSO_DATABASE_URL ||= "file:quota-report-hub-quota-history-test.db";
process.env.TURSO_AUTH_TOKEN ||= "test-token";
process.env.AUTH_POOL_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

function responseRecorder() {
  const headers = {};
  let body = "";
  return {
    res: {
      setHeader(name, value) { headers[name] = value; },
      end(value) { body = value; },
    },
    result() { return { headers, body }; },
  };
}

function dependencies(overrides = {}) {
  return {
    authenticateApiRequest: async () => ({ email: "member@stardust.ai" }),
    sendUnauthorized(res) { res.statusCode = 401; res.end("unauthorized"); },
    sendServiceUnavailable(res) { res.statusCode = 503; res.end("unavailable"); },
    withTokenUpgrade: (payload) => payload,
    authPoolQuotaEvents: async () => [],
    now: () => new Date("2026-08-08T08:00:00Z"),
    ...overrides,
  };
}

test("quota history rejects missing authentication before parsing or reading", async () => {
  const { quotaHistoryHandlerImpl } = await import("../api/quota-history.js");
  const recorder = responseRecorder();
  let reads = 0;

  await quotaHistoryHandlerImpl({ url: "/api/quota-history" }, recorder.res, dependencies({
    authenticateApiRequest: async () => null,
    authPoolQuotaEvents: async () => { reads += 1; },
  }));

  assert.equal(recorder.res.statusCode, 401);
  assert.equal(reads, 0);
});

for (const url of [
  "/api/quota-history?account_id=acct-1",
  "/api/quota-history?source=codex",
  "/api/quota-history?source=%20&account_id=acct-1",
  "/api/quota-history?source=codex&account_id=%20",
  "/api/quota-history?source=codex&source=claude&account_id=acct-1",
]) {
  test(`quota history rejects malformed exact parameters: ${url}`, async () => {
    const { quotaHistoryHandlerImpl } = await import("../api/quota-history.js");
    const recorder = responseRecorder();
    let reads = 0;
    await quotaHistoryHandlerImpl({ url }, recorder.res, dependencies({
      authPoolQuotaEvents: async () => { reads += 1; },
    }));
    assert.equal(recorder.res.statusCode, 400);
    assert.equal(reads, 0);
  });
}

test("quota history decodes exact account parameters and returns a safe 24-hour series", async () => {
  const { quotaHistoryHandlerImpl } = await import("../api/quota-history.js");
  const recorder = responseRecorder();
  let query;

  await quotaHistoryHandlerImpl({
    url: "/api/quota-history?source=claude&account_id=user%2Bchart%40example.com",
  }, recorder.res, dependencies({
    authenticateApiRequest: async () => ({
      email: "member@stardust.ai",
      token_upgrade: { auth_pool_user_token: "new-token", email: "member@stardust.ai" },
    }),
    withTokenUpgrade: (payload) => ({ ...payload, auth_pool_user_token: "new-token" }),
    authPoolQuotaEvents: async (options) => {
      query = options;
      return [{
        source: "claude",
        account_id: "user+chart@example.com",
        reported_at: "2026-08-08T07:00:00Z",
        status: "error",
        error: "temporary failure",
        windows: {
          "5h": { remaining_percent: 45, reset_at: "2026-08-08T10:00:00Z" },
          "1week": { remaining_percent: 70, reset_at: "2026-08-15T00:00:00Z" },
        },
        email: "private@example.com",
        auth_path: "/private/auth.json",
        refresh_token: "secret",
        payload_json: "secret-payload",
      }];
    },
  }));

  assert.deepEqual(query, {
    source: "claude",
    accountId: "user+chart@example.com",
    since: "2026-08-07T08:00:00.000Z",
    limit: 96,
  });
  assert.equal(recorder.res.statusCode, 200);
  assert.equal(recorder.result().headers["Content-Type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(recorder.result().body), {
    source: "claude",
    account_id: "user+chart@example.com",
    from: "2026-08-07T08:00:00.000Z",
    generated_at: "2026-08-08T08:00:00.000Z",
    points: [{
      reported_at: "2026-08-08T07:00:00Z",
      status: "error",
      error: "temporary failure",
      five_h_remaining_percent: 45,
      five_h_reset_at: "2026-08-08T10:00:00Z",
      one_week_remaining_percent: 70,
      one_week_reset_at: "2026-08-15T00:00:00Z",
    }],
    auth_pool_user_token: "new-token",
  });
});

test("quota history follows the service-unavailable contract", async () => {
  const { quotaHistoryHandlerImpl } = await import("../api/quota-history.js");
  const recorder = responseRecorder();
  const previousConsoleError = console.error;
  console.error = () => {};
  try {
    await quotaHistoryHandlerImpl({
      url: "/api/quota-history?source=codex&account_id=acct-1",
    }, recorder.res, dependencies({
      authPoolQuotaEvents: async () => { throw new Error("reads are blocked"); },
    }));
  } finally {
    console.error = previousConsoleError;
  }
  assert.equal(recorder.res.statusCode, 503);
  assert.equal(recorder.result().body, "unavailable");
});

test("quota history endpoint uses primary auth and exposes no unsafe fields", async () => {
  const source = await readFile(new URL("../api/quota-history.js", import.meta.url), "utf8");
  assert.match(source, /authenticateApiRequest/);
  assert.match(source, /withTokenUpgrade/);
  assert.match(source, /authPoolQuotaEvents/);
  assert.match(source, /limit: 96/);
  assert.doesNotMatch(source, /verifyDashboardRevisionToken|authenticateDashboardRevisionRequest/);
  assert.doesNotMatch(source, /email: event|auth_path: event|payload_json: event|refresh_token|access_token|encrypted_auth_json/);
});
