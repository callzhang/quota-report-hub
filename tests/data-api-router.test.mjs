import test from "node:test";
import assert from "node:assert/strict";

process.env.TURSO_DATABASE_URL ||= "file:quota-report-hub-data-router-test.db";
process.env.TURSO_AUTH_TOKEN ||= "test-token";
process.env.AUTH_POOL_ENCRYPTION_KEY ||= "0".repeat(64);

const { routeDataRequest } = await import("../api/data.js");

test("consolidated data function routes and removes its private selector", async () => {
  let observedUrl;
  const req = {
    url: "/api/data?route=token-usage-query&start=2026-08-18T00%3A00%3A00.000Z",
    query: { route: "token-usage-query" },
  };
  const res = { end() {} };
  await routeDataRequest(req, res, {
    "token-usage-query": async (request) => { observedUrl = request.url; },
  });
  assert.equal(observedUrl, "/api/data?start=2026-08-18T00%3A00%3A00.000Z");
});

test("consolidated data function rejects unknown routes", async () => {
  let body = "";
  const res = { end(value) { body = value; } };
  await routeDataRequest({ url: "/api/data?route=unknown", query: {} }, res, {});
  assert.equal(res.statusCode, 404);
  assert.equal(body, "Not Found");
});
