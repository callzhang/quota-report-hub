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

test("statusPayload counts reports and sources", () => {
  const payload = statusPayload([
    { source: "codex", reported_at: "2026-04-19T20:00:00Z" },
    { source: "claude", reported_at: "2026-04-19T20:10:00Z" },
  ]);

  assert.equal(payload.report_count, 2);
  assert.equal(payload.source_count, 2);
});
