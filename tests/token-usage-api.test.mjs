import test from "node:test";
import assert from "node:assert/strict";

import { TokenUsageValidationError } from "../lib/token-usage.js";

process.env.TURSO_DATABASE_URL ||= "file:quota-report-hub-token-usage-api-test.db";
process.env.TURSO_AUTH_TOKEN ||= "test-token";
process.env.AUTH_POOL_ENCRYPTION_KEY ||= "0".repeat(64);

function responseRecorder() {
  const headers = {};
  let body = "";
  return {
    res: {
      setHeader(name, value) { headers[name] = value; },
      end(value = "") { body = value; },
    },
    result() { return { headers, body }; },
  };
}

function dependencies(overrides = {}) {
  const normalized = {
    installation_id: "install-1",
    batch_id: "batch-1",
    rows: [{ model_id: "gpt-5.6-sol" }],
  };
  return {
    authenticateApiRequest: async () => ({ email: "derek@stardust.ai" }),
    sendUnauthorized(res) { res.statusCode = 401; res.end("unauthorized"); },
    sendServiceUnavailable(res) { res.statusCode = 503; res.end("unavailable"); },
    withTokenUpgrade: (payload) => payload,
    readJsonBody: async () => ({ installation_id: "install-1", batch_id: "batch-1", rows: [] }),
    normalizeTokenUsageBatch: () => normalized,
    ingestTokenUsageBatch: async () => ({
      applied: true,
      received_at: "2026-08-18T12:00:00.000Z",
      applied_at: "2026-08-18T12:00:00.000Z",
    }),
    now: () => new Date("2026-08-18T12:00:00.000Z"),
    ...overrides,
  };
}

test("token usage accepts POST only", async () => {
  const { tokenUsageHandlerImpl } = await import("../lib/data-api.js");
  const recorder = responseRecorder();
  let authenticated = false;
  await tokenUsageHandlerImpl({ method: "GET" }, recorder.res, dependencies({
    authenticateApiRequest: async () => { authenticated = true; },
  }));
  assert.equal(recorder.res.statusCode, 405);
  assert.equal(recorder.result().headers.Allow, "POST");
  assert.equal(authenticated, false);
});

test("missing auth returns before body parsing and database writes", async () => {
  const { tokenUsageHandlerImpl } = await import("../lib/data-api.js");
  const recorder = responseRecorder();
  let bodyReads = 0;
  let writes = 0;
  await tokenUsageHandlerImpl({ method: "POST" }, recorder.res, dependencies({
    authenticateApiRequest: async () => null,
    readJsonBody: async () => { bodyReads += 1; },
    ingestTokenUsageBatch: async () => { writes += 1; },
  }));
  assert.equal(recorder.res.statusCode, 401);
  assert.equal(bodyReads, 0);
  assert.equal(writes, 0);
});

test("uses authenticated email and passes normalized rows once", async () => {
  const { tokenUsageHandlerImpl } = await import("../lib/data-api.js");
  const recorder = responseRecorder();
  const requestBody = { installation_id: "raw", batch_id: "raw", rows: [] };
  const normalizedRows = [{ model_id: "gpt-5.6-sol" }];
  let normalizeArgs;
  let seenIngest;
  await tokenUsageHandlerImpl({ method: "POST" }, recorder.res, dependencies({
    readJsonBody: async () => requestBody,
    normalizeTokenUsageBatch: (body, options) => {
      normalizeArgs = { body, options };
      return { installation_id: "install-1", batch_id: "batch-1", rows: normalizedRows };
    },
    ingestTokenUsageBatch: async (input) => {
      seenIngest = input;
      return { applied: true, received_at: "2026-08-18T12:00:00.000Z" };
    },
  }));

  assert.equal(normalizeArgs.body, requestBody);
  assert.equal(normalizeArgs.options.now.toISOString(), "2026-08-18T12:00:00.000Z");
  assert.deepEqual(seenIngest, {
    hubUserEmail: "derek@stardust.ai",
    installationId: "install-1",
    batchId: "batch-1",
    clientVersion: undefined,
    rows: normalizedRows,
    receivedAt: "2026-08-18T12:00:00.000Z",
  });
  assert.equal(recorder.res.statusCode, 200);
  assert.deepEqual(JSON.parse(recorder.result().body), {
    ok: true,
    hub_user_email: "derek@stardust.ai",
    batch_id: "batch-1",
    applied: true,
    received_at: "2026-08-18T12:00:00.000Z",
  });
});

test("identical retry returns applied false and preserves a token upgrade", async () => {
  const { tokenUsageHandlerImpl } = await import("../lib/data-api.js");
  const recorder = responseRecorder();
  await tokenUsageHandlerImpl({ method: "POST" }, recorder.res, dependencies({
    authenticateApiRequest: async () => ({
      email: "derek@stardust.ai",
      token_upgrade: { auth_pool_user_token: "rotated", email: "derek@stardust.ai" },
    }),
    ingestTokenUsageBatch: async () => ({ applied: false, received_at: "2026-08-18T11:59:00.000Z" }),
    withTokenUpgrade: (payload) => ({ ...payload, auth_pool_user_token: "rotated" }),
  }));
  assert.equal(recorder.res.statusCode, 200);
  const payload = JSON.parse(recorder.result().body);
  assert.equal(payload.applied, false);
  assert.equal(payload.auth_pool_user_token, "rotated");
});

test("client-provided user identity is rejected before ingestion", async () => {
  const { tokenUsageHandlerImpl } = await import("../lib/data-api.js");
  const recorder = responseRecorder();
  let writes = 0;
  await tokenUsageHandlerImpl({ method: "POST" }, recorder.res, dependencies({
    normalizeTokenUsageBatch: () => {
      throw new TokenUsageValidationError("body contains unknown field: hub_user_email");
    },
    ingestTokenUsageBatch: async () => { writes += 1; },
  }));
  assert.equal(recorder.res.statusCode, 400);
  assert.equal(writes, 0);
});

test("maps validation, conflict, and database failures", async () => {
  const { tokenUsageHandlerImpl } = await import("../lib/data-api.js");

  const invalid = responseRecorder();
  await tokenUsageHandlerImpl({ method: "POST" }, invalid.res, dependencies({
    normalizeTokenUsageBatch: () => { throw new TokenUsageValidationError("invalid row"); },
  }));
  assert.equal(invalid.res.statusCode, 400);

  const conflict = responseRecorder();
  const conflictError = new Error("conflict");
  conflictError.code = "token_usage_batch_conflict";
  await tokenUsageHandlerImpl({ method: "POST" }, conflict.res, dependencies({
    ingestTokenUsageBatch: async () => { throw conflictError; },
  }));
  assert.equal(conflict.res.statusCode, 409);

  const unavailable = responseRecorder();
  let serviceError;
  const databaseError = new Error("database down");
  await tokenUsageHandlerImpl({ method: "POST" }, unavailable.res, dependencies({
    ingestTokenUsageBatch: async () => { throw databaseError; },
    sendServiceUnavailable(res, error) {
      serviceError = error;
      res.statusCode = 503;
      res.end("unavailable");
    },
  }));
  assert.equal(unavailable.res.statusCode, 503);
  assert.equal(serviceError, databaseError);
});

test("success never echoes installation identity, rows, or digest", async () => {
  const { tokenUsageHandlerImpl } = await import("../lib/data-api.js");
  const recorder = responseRecorder();
  await tokenUsageHandlerImpl({ method: "POST" }, recorder.res, dependencies());
  const payload = JSON.parse(recorder.result().body);
  assert.equal(Object.hasOwn(payload, "installation_id"), false);
  assert.equal(Object.hasOwn(payload, "rows"), false);
  assert.equal(Object.hasOwn(payload, "payload_digest"), false);
});
