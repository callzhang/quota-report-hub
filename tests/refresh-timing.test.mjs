import assert from "node:assert/strict";
import test from "node:test";

import { hubRefreshDue } from "../lib/refresh-timing.js";

const HOUR = 60 * 60 * 1000;

test("codex is refreshed only once its access token has expired", () => {
  assert.equal(hubRefreshDue("codex", 5 * 60 * 1000, HOUR), false, "5 minutes left is not expired");
  assert.equal(hubRefreshDue("codex", 1, HOUR), false);
  assert.equal(hubRefreshDue("codex", 0, HOUR), true);
  assert.equal(hubRefreshDue("codex", -3600_000, HOUR), true);
});

test("claude keeps its proactive window", () => {
  assert.equal(hubRefreshDue("claude", 30 * 60 * 1000, HOUR), true);
  assert.equal(hubRefreshDue("claude", 2 * HOUR, HOUR), false);
});

test("unknown expiry is due for every source", () => {
  assert.equal(hubRefreshDue("codex", null, HOUR), true);
  assert.equal(hubRefreshDue("claude", null, HOUR), true);
});
