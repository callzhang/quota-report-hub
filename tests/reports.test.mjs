import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeReport, statusPayload } from "../lib/reports.js";

test("sanitizeReport normalizes the quota payload", () => {
  const sanitized = sanitizeReport({
    source: "codex",
    hostname: "mbp",
    reporter_name: "derek@mbp",
    reported_at: "2026-04-19T20:00:00Z",
    account_id: "acct-1",
    email: "a@example.com",
    plan_name: "Pro Lite",
    windows: {
      "5h": { remaining_percent: 42.0 },
      "1week": { remaining_percent: 77.0 }
    }
  });

  assert.equal(sanitized.email, "a@example.com");
  assert.equal(sanitized.windows["5h"].remaining_percent, 42.0);
  assert.equal(sanitized.windows["1week"].remaining_percent, 77.0);
});

test("sanitizeReport keeps unavailable windows null instead of forcing fake zeros", () => {
  const sanitized = sanitizeReport({
    source: "codex",
    hostname: "gpu4",
    reporter_name: "derek@gpu4",
    account_id: "acct-2",
    status: "error",
    error: "missing quota details",
    windows: {
      "5h": null,
      "1week": null,
    },
  });

  assert.equal(sanitized.windows["5h"], null);
  assert.equal(sanitized.windows["1week"], null);
});

test("sanitizeReport preserves claude usage summary payloads", () => {
  const sanitized = sanitizeReport({
    source: "claude",
    hostname: "mbp",
    reporter_name: "derek@mbp",
    account_id: "claude-oauth-123",
    plan_name: "Max",
    usage_summary: {
      auth_method: "oauth_token",
      rate_limit_tier: "default_claude_max_20x",
      stats: {
        total_sessions: 31,
      },
    },
  });

  assert.equal(sanitized.plan_name, "Max");
  assert.equal(sanitized.usage_summary.rate_limit_tier, "default_claude_max_20x");
  assert.equal(sanitized.usage_summary.stats.total_sessions, 31);
});

test("statusPayload counts reports and sources", () => {
  const payload = statusPayload([
    { source: "codex", reported_at: "2026-04-19T20:00:00Z" },
    { source: "claude", reported_at: "2026-04-19T20:10:00Z" },
  ]);

  assert.equal(payload.report_count, 2);
  assert.equal(payload.source_count, 2);
});
