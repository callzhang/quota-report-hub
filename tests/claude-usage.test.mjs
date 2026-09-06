import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeUsageBody, probeClaudeUsage } from "../lib/claude-usage.js";

const BLOB = JSON.stringify({ credentials: { claudeAiOauth: { accessToken: "AT", refreshToken: "RT" } } });
const body = {
  five_hour: { utilization: 9.4, resets_at: "2026-09-06T02:00:00+00:00" },
  seven_day: { utilization: 7, resets_at: "2026-09-08T12:00:00Z" },
  extra_usage: { is_enabled: false },
};
const fetchWith = (status, json) => async (url, init) => {
  assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(init.headers.Authorization, "Bearer AT");
  return { ok: status >= 200 && status < 300, status, json: async () => json };
};

test("parseClaudeUsageBody reads both windows the way the guard does: utilization is already a percent", () => {
  const windows = parseClaudeUsageBody(body);
  assert.deepEqual(windows["5h"], { used_percent: 9.4, remaining_percent: 90.6, window_minutes: 300, reset_at: "2026-09-06T02:00:00Z" });
  assert.deepEqual(windows["1week"], { used_percent: 7, remaining_percent: 93, window_minutes: 10080, reset_at: "2026-09-08T12:00:00Z" });
  assert.deepEqual(parseClaudeUsageBody({ five_hour: { utilization: 0 } })["5h"], { used_percent: 0, remaining_percent: 100, window_minutes: 300, reset_at: null }, "an unstarted window has no reset yet");
  assert.equal(parseClaudeUsageBody({})["5h"], null);
});

test("probeClaudeUsage returns windows on 200, rejection on 401, and a transient miss otherwise", async () => {
  const good = await probeClaudeUsage(BLOB, fetchWith(200, body));
  assert.equal(good.ok, true);
  assert.equal(good.windows["5h"].remaining_percent, 90.6);

  const dead = await probeClaudeUsage(BLOB, fetchWith(401, { error: "unauthorized" }));
  assert.deepEqual({ ok: dead.ok, rejected: dead.rejected, status: dead.status }, { ok: false, rejected: true, status: 401 });

  const throttled = await probeClaudeUsage(BLOB, fetchWith(429, { error: "rate_limit" }));
  assert.deepEqual({ ok: throttled.ok, rejected: throttled.rejected, reason: throttled.reason }, { ok: false, rejected: false, reason: "http_429" }, "a throttled endpoint is not a dead account");

  const empty = await probeClaudeUsage(BLOB, fetchWith(200, { extra_usage: {} }));
  assert.deepEqual({ ok: empty.ok, reason: empty.reason }, { ok: false, reason: "no_usage_windows" });

  const noToken = await probeClaudeUsage(JSON.stringify({ credentials: { claudeAiOauth: {} } }), fetchWith(200, body));
  assert.equal(noToken.reason, "no_access_token");
});
