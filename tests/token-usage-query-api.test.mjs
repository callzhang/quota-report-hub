import test from "node:test";
import assert from "node:assert/strict";

import { TokenUsageValidationError } from "../lib/token-usage.js";

process.env.TURSO_DATABASE_URL ||= "file:quota-report-hub-token-usage-query-api-test.db";
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

function parsedQuery() {
  return {
    start: "2026-08-11T12:00:00.000Z",
    end: "2026-08-18T12:00:00.000Z",
    granularity: "hour",
    groupBy: "hub_user",
    metric: "total",
    hubUsers: [], providers: [], modelAccounts: [], models: [],
    publicQuery: { start: "2026-08-11T12:00:00.000Z", end: "2026-08-18T12:00:00.000Z" },
  };
}

function dependencies(overrides = {}) {
  return {
    authenticateApiRequest: async () => ({ email: "member@stardust.ai" }),
    sendUnauthorized(res) { res.statusCode = 401; res.end("unauthorized"); },
    sendServiceUnavailable(res) { res.statusCode = 503; res.end("unavailable"); },
    withTokenUpgrade: (payload) => payload,
    parseTokenUsageQuery: () => parsedQuery(),
    queryTokenUsage: async () => ({
      totals: { total_tokens: 10 }, trend: [], breakdown: [], reporters: [],
    }),
    now: () => new Date("2026-08-18T12:00:00.000Z"),
    ...overrides,
  };
}

test("query authenticates before parsing and is team-readable for a member", async () => {
  const { tokenUsageQueryHandlerImpl } = await import("../lib/data-api.js");
  const unauthorized = responseRecorder();
  let parses = 0;
  let reads = 0;
  await tokenUsageQueryHandlerImpl({ method: "GET", url: "/api/token-usage-query?bad" }, unauthorized.res, dependencies({
    authenticateApiRequest: async () => null,
    parseTokenUsageQuery: () => { parses += 1; },
    queryTokenUsage: async () => { reads += 1; },
  }));
  assert.equal(unauthorized.res.statusCode, 401);
  assert.equal(parses, 0);
  assert.equal(reads, 0);

  const member = responseRecorder();
  let seenQuery;
  await tokenUsageQueryHandlerImpl({ method: "GET", url: "/api/token-usage-query?valid" }, member.res, dependencies({
    queryTokenUsage: async (query) => {
      seenQuery = query;
      return { totals: { total_tokens: 10 }, trend: [], breakdown: [], reporters: [] };
    },
  }));
  assert.equal(member.res.statusCode, 200);
  assert.equal(seenQuery.groupBy, "hub_user");
  assert.equal(JSON.parse(member.result().body).generated_at, "2026-08-18T12:00:00.000Z");
});

test("query response carries token upgrades and exact public query", async () => {
  const { tokenUsageQueryHandlerImpl } = await import("../lib/data-api.js");
  const recorder = responseRecorder();
  await tokenUsageQueryHandlerImpl({ method: "GET", url: "/api/token-usage-query?valid" }, recorder.res, dependencies({
    authenticateApiRequest: async () => ({ email: "member@stardust.ai", token_upgrade: {} }),
    withTokenUpgrade: (payload) => ({ ...payload, auth_pool_user_token: "rotated" }),
  }));
  const payload = JSON.parse(recorder.result().body);
  assert.deepEqual(payload.query, parsedQuery().publicQuery);
  assert.equal(payload.auth_pool_user_token, "rotated");
});

test("query maps validation, broad results, and service failures without treating them as auth errors", async () => {
  const { tokenUsageQueryHandlerImpl } = await import("../lib/data-api.js");
  const invalid = responseRecorder();
  await tokenUsageQueryHandlerImpl({ method: "GET", url: "/api/token-usage-query" }, invalid.res, dependencies({
    parseTokenUsageQuery: () => { throw new TokenUsageValidationError("bad query"); },
  }));
  assert.equal(invalid.res.statusCode, 400);

  const broad = responseRecorder();
  const broadError = new Error("too broad");
  broadError.code = "query_too_broad";
  await tokenUsageQueryHandlerImpl({ method: "GET", url: "/api/token-usage-query" }, broad.res, dependencies({
    queryTokenUsage: async () => { throw broadError; },
  }));
  assert.equal(broad.res.statusCode, 422);

  const unavailable = responseRecorder();
  let serviceError;
  const databaseError = new Error("database down");
  await tokenUsageQueryHandlerImpl({ method: "GET", url: "/api/token-usage-query" }, unavailable.res, dependencies({
    queryTokenUsage: async () => { throw databaseError; },
    sendServiceUnavailable(res, error) { serviceError = error; res.statusCode = 503; res.end("unavailable"); },
  }));
  assert.equal(unavailable.res.statusCode, 503);
  assert.equal(serviceError, databaseError);
});
