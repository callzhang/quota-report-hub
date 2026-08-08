import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.TURSO_DATABASE_URL ||= "file:quota-report-hub-status-revision-test.db";
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

test("revision endpoint rejects missing authentication without reading revision", async () => {
  const { statusRevisionHandlerImpl } = await import("../api/status-revision.js");
  const recorder = responseRecorder();
  let revisionReads = 0;

  await statusRevisionHandlerImpl({}, recorder.res, {
    authenticateDashboardRevisionRequest: () => null,
    sendUnauthorized(res) { res.statusCode = 401; res.end("unauthorized"); },
    sendServiceUnavailable() { assert.fail("unexpected service error"); },
    dashboardRevision: async () => { revisionReads += 1; },
  });

  assert.equal(recorder.res.statusCode, 401);
  assert.equal(recorder.result().body, "unauthorized");
  assert.equal(revisionReads, 0);
});

test("revision endpoint returns only revision metadata", async () => {
  const { statusRevisionHandlerImpl } = await import("../api/status-revision.js");
  const recorder = responseRecorder();

  await statusRevisionHandlerImpl({}, recorder.res, {
    authenticateDashboardRevisionRequest: () => ({ email: "member@stardust.ai" }),
    sendUnauthorized() { assert.fail("unexpected unauthorized response"); },
    sendServiceUnavailable() { assert.fail("unexpected service error"); },
    dashboardRevision: async () => ({ revision: 42, updated_at: "2026-08-08T08:00:00Z" }),
  });

  assert.equal(recorder.res.statusCode, 200);
  assert.equal(recorder.result().headers["Content-Type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(recorder.result().body), {
    revision: 42,
    updated_at: "2026-08-08T08:00:00Z",
  });
});

test("revision endpoint follows the service-unavailable response contract", async () => {
  const { statusRevisionHandlerImpl } = await import("../api/status-revision.js");
  const { sendServiceUnavailable } = await import("../lib/api-auth.js");
  const recorder = responseRecorder();
  const previousConsoleError = console.error;
  console.error = () => {};
  try {
    await statusRevisionHandlerImpl({}, recorder.res, {
      authenticateDashboardRevisionRequest: () => ({ email: "member@stardust.ai" }),
      sendUnauthorized() { assert.fail("unexpected unauthorized response"); },
      sendServiceUnavailable,
      dashboardRevision: async () => { throw new Error("reads are blocked"); },
    });
  } finally {
    console.error = previousConsoleError;
  }

  assert.equal(recorder.res.statusCode, 503);
  assert.equal(JSON.parse(recorder.result().body).reason, "database_reads_blocked");
});

test("revision endpoint depends on the singleton revision reader only", async () => {
  const source = await readFile(new URL("../api/status-revision.js", import.meta.url), "utf8");
  assert.match(source, /dashboardRevision/);
  assert.match(source, /verifyDashboardRevisionToken/);
  assert.doesNotMatch(source, /authenticateApiRequest|authenticateApiToken|authenticateOrUpgradeApiToken|withTokenUpgrade|auth_api_tokens|last_used_at/);
  assert.doesNotMatch(source, /authPoolEntrySummaries|authPoolQuotaLatest|authPoolFetchLog|poolHealthSnapshots|authPoolQuotaEvents/);
});
