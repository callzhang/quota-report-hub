import test from "node:test";
import assert from "node:assert/strict";
import { authPoolStatusPayload, mergeLatestReport, sanitizeReport, statusPayload } from "../lib/reports.js";

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

test("sanitizeReport drops expired claude client statusline windows", () => {
  const sanitized = sanitizeReport({
    source: "claude",
    hostname: "mbp",
    reporter_name: "derek@mbp",
    reported_at: "2026-05-30T09:32:47Z",
    account_id: "claude-leizhang0121@gmail.com",
    status: "ok",
    usage_summary: {
      quota_source: "statusline_snapshot",
      snapshot_reported_at: "2026-05-20T01:08:29Z",
    },
    report_origin: "client",
    windows: {
      "5h": { used_percent: 9, remaining_percent: 91, reset_at: "2026-05-18T11:40:00Z" },
      "1week": { used_percent: 32, remaining_percent: 68, reset_at: "2026-05-19T12:00:00Z" },
    },
  });

  assert.equal(sanitized.windows["5h"], null);
  assert.equal(sanitized.windows["1week"], null);
});

test("sanitizeReport normalizes explicit report origin", () => {
  const sanitized = sanitizeReport({
    source: "codex",
    account_id: "acct-1",
    report_origin: "CLIENT",
    windows: {
      "5h": { remaining_percent: 42, reset_at: "2026-04-22T15:00:00Z" },
      "1week": { remaining_percent: 80, reset_at: "2026-04-28T15:00:00Z" },
    },
  });

  assert.equal(sanitized.report_origin, "client");
});

test("statusPayload counts reports and sources", () => {
  const payload = statusPayload([
    { source: "codex", reported_at: "2026-04-19T20:00:00Z" },
    { source: "claude", reported_at: "2026-04-19T20:10:00Z" },
  ], "2026-04-19T20:30:00Z");

  assert.equal(payload.report_count, 2);
  assert.equal(payload.source_count, 2);
});

test("statusPayload keeps report status even after one hour while marking freshness", () => {
  const payload = statusPayload([
    { source: "codex", status: "ok", reported_at: "2026-04-19T18:00:00Z" },
    { source: "claude", status: "ok", reported_at: "2026-04-19T19:30:30Z" },
  ], "2026-04-19T20:30:31Z");

  assert.equal(payload.items[0].is_stale, true);
  assert.equal(payload.items[0].effective_status, "ok");
  assert.equal(payload.items[0].age_seconds, 9031);
  assert.equal(payload.items[1].is_stale, true);
  assert.equal(payload.items[1].effective_status, "ok");
});

test("statusPayload marks live claude 429 probes as rate_limited", () => {
  const payload = statusPayload([
    {
      source: "claude",
      status: "ok",
      reported_at: "2026-04-19T20:25:00Z",
      usage_summary: {
        rate_limit_probe: {
          status_code: 429,
          api_error: "Rate limited. Please try again later.",
        },
      },
    },
  ], "2026-04-19T20:30:00Z");

  assert.equal(payload.items[0].is_stale, false);
  assert.equal(payload.items[0].effective_status, "rate_limited");
});

test("statusPayload keeps codex rows without quota windows visible", () => {
  const payload = statusPayload([
    {
      source: "codex",
      status: "error",
      account_id: "keep-error",
      windows: { "5h": null, "1week": null },
      reported_at: "2026-04-19T20:00:00Z",
    },
    {
      source: "codex",
      status: "ok",
      account_id: "keep-me",
      windows: {
        "5h": { remaining_percent: 25, reset_at: "2026-04-20T05:00:00Z" },
        "1week": { remaining_percent: 60, reset_at: "2026-04-25T05:00:00Z" },
      },
      reported_at: "2026-04-19T20:01:00Z",
    },
  ], "2026-04-19T20:30:00Z");

  assert.equal(payload.report_count, 2);
  assert.equal(payload.items[0].account_id, "keep-error");
  assert.equal(payload.items[1].account_id, "keep-me");
});

test("mergeLatestReport keeps prior good windows when a newer report has n/a windows", () => {
  const previous = sanitizeReport({
    source: "codex",
    hostname: "gpu4",
    reporter_name: "derek@gpu4",
    reported_at: "2026-04-21T04:00:00Z",
    account_id: "acct-1",
    status: "ok",
    windows: {
      "5h": { used_percent: 25, remaining_percent: 75, reset_at: "2026-04-21T09:00:00Z" },
      "1week": { used_percent: 40, remaining_percent: 60, reset_at: "2026-04-27T09:00:00Z" },
    },
  });
  const incoming = sanitizeReport({
    source: "codex",
    hostname: "gpu4",
    reporter_name: "derek@gpu4",
    reported_at: "2026-04-21T04:15:00Z",
    account_id: "acct-1",
    status: "error",
    error: "missing quota details",
    windows: { "5h": null, "1week": null },
  });

  const merged = mergeLatestReport(previous, incoming);

  assert.equal(merged.reported_at, "2026-04-21T04:15:00Z");
  assert.equal(merged.error, "missing quota details");
  assert.equal(merged.windows_stale, true);
  assert.equal(merged.windows["5h"].remaining_percent, 75);
  assert.equal(merged.windows["1week"].remaining_percent, 60);
});

test("mergeLatestReport accepts newer non-null windows", () => {
  const previous = sanitizeReport({
    source: "codex",
    hostname: "gpu4",
    reporter_name: "derek@gpu4",
    reported_at: "2026-04-21T04:00:00Z",
    account_id: "acct-1",
    status: "ok",
    windows: {
      "5h": { used_percent: 25, remaining_percent: 75, reset_at: "2026-04-21T09:00:00Z" },
      "1week": { used_percent: 40, remaining_percent: 60, reset_at: "2026-04-27T09:00:00Z" },
    },
  });
  const incoming = sanitizeReport({
    source: "codex",
    hostname: "gpu4",
    reporter_name: "derek@gpu4",
    reported_at: "2026-04-28T10:00:00Z",
    account_id: "acct-1",
    status: "ok",
    windows: {
      "5h": { used_percent: 10, remaining_percent: 90, reset_at: "2026-04-28T15:00:00Z" },
      "1week": { used_percent: 35, remaining_percent: 65, reset_at: "2026-04-28T10:00:00Z" },
    },
  });

  const merged = mergeLatestReport(previous, incoming);

  assert.equal(merged.reported_at, "2026-04-28T10:00:00Z");
  assert.equal(merged.windows_stale, false);
  assert.equal(merged.windows["5h"].remaining_percent, 90);
  assert.equal(merged.windows["1week"].remaining_percent, 65);
});

test("mergeLatestReport keeps worker claude windows when a newer client statusline is expired", () => {
  const previous = sanitizeReport({
    source: "claude",
    hostname: "github-actions",
    reporter_name: "actions@runner",
    reported_at: "2026-05-30T09:19:11Z",
    account_id: "claude-leizhang0121@gmail.com",
    status: "ok",
    report_origin: "worker",
    windows: {
      "5h": { used_percent: 1, remaining_percent: 99, reset_at: "2026-05-30T11:10:00Z" },
      "1week": { used_percent: 7, remaining_percent: 93, reset_at: "2026-06-04T03:00:00Z" },
    },
  });
  const incoming = sanitizeReport({
    source: "claude",
    hostname: "mbp",
    reporter_name: "derek@mbp",
    reported_at: "2026-05-30T09:32:47Z",
    account_id: "claude-leizhang0121@gmail.com",
    status: "ok",
    report_origin: "client",
    usage_summary: {
      quota_source: "statusline_snapshot",
      snapshot_reported_at: "2026-05-20T01:08:29Z",
    },
    windows: {
      "5h": { used_percent: 9, remaining_percent: 91, reset_at: "2026-05-18T11:40:00Z" },
      "1week": { used_percent: 32, remaining_percent: 68, reset_at: "2026-05-19T12:00:00Z" },
    },
  });

  const merged = mergeLatestReport(previous, incoming);

  assert.equal(merged.reported_at, "2026-05-30T09:32:47Z");
  assert.equal(merged.windows_stale, true);
  assert.equal(merged.windows["5h"].remaining_percent, 99);
  assert.equal(merged.windows["1week"].remaining_percent, 93);
});

test("mergeLatestReport preserves known quota when a client jumps reset before the current window resets", () => {
  const previous = sanitizeReport({
    source: "codex",
    hostname: "gpu4",
    reporter_name: "derek@gpu4",
    reported_at: "2026-05-21T09:45:01Z",
    report_origin: "client",
    account_id: "leizhang0121@gmail.com",
    status: "ok",
    windows: {
      "5h": { used_percent: 10, remaining_percent: 90, reset_at: "2026-05-21T13:37:02Z" },
      "1week": { used_percent: 56, remaining_percent: 44, reset_at: "2026-05-26T21:23:39Z" },
    },
  });
  const incoming = sanitizeReport({
    source: "codex",
    hostname: "old-client",
    reporter_name: "old@old-client",
    reported_at: "2026-05-21T09:59:32Z",
    report_origin: "client",
    account_id: "leizhang0121@gmail.com",
    status: "ok",
    windows: {
      "5h": { used_percent: 0, remaining_percent: 100, reset_at: "2026-05-21T15:01:26Z" },
      "1week": { used_percent: 0, remaining_percent: 100, reset_at: "2026-05-28T10:01:26Z" },
    },
  });

  const merged = mergeLatestReport(previous, incoming);

  assert.equal(merged.reported_at, "2026-05-21T09:59:32Z");
  assert.equal(merged.hostname, "old-client");
  assert.equal(merged.windows_stale, true);
  assert.equal(merged.windows["5h"].remaining_percent, 90);
  assert.equal(merged.windows["5h"].reset_at, "2026-05-21T13:37:02Z");
  assert.equal(merged.windows["1week"].remaining_percent, 44);
  assert.equal(merged.windows["1week"].reset_at, "2026-05-26T21:23:39Z");
});

test("mergeLatestReport accepts newer zero client quota over stale positive quota", () => {
  const previous = sanitizeReport({
    source: "codex",
    hostname: "teammate-mac",
    reporter_name: "teammate@teammate-mac",
    reported_at: "2026-05-15T06:18:30Z",
    report_origin: "client",
    account_id: "pre-sales@stardust.ai",
    status: "ok",
    windows: {
      "5h": { used_percent: 77, remaining_percent: 23, reset_at: "2026-05-15T10:44:12Z" },
      "1week": { used_percent: 64, remaining_percent: 36, reset_at: "2026-05-20T02:46:31Z" },
    },
  });
  const incoming = sanitizeReport({
    source: "codex",
    hostname: "teammate-mac",
    reporter_name: "teammate@teammate-mac",
    reported_at: "2026-05-15T07:20:00Z",
    report_origin: "client",
    account_id: "pre-sales@stardust.ai",
    status: "ok",
    windows: {
      "5h": { used_percent: 100, remaining_percent: 0, reset_at: "2026-05-15T10:44:12Z" },
      "1week": { used_percent: 100, remaining_percent: 0, reset_at: "2026-05-20T02:46:31Z" },
    },
  });

  const merged = mergeLatestReport(previous, incoming);

  assert.equal(merged.reported_at, "2026-05-15T07:20:00Z");
  assert.equal(merged.windows_stale, false);
  assert.equal(merged.windows["5h"].remaining_percent, 0);
  assert.equal(merged.windows["1week"].remaining_percent, 0);
});

test("mergeLatestReport preserves old windows as stale on hard auth invalidation", () => {
  const previous = sanitizeReport({
    source: "codex",
    hostname: "gpu4",
    reporter_name: "derek@gpu4",
    reported_at: "2026-04-21T04:00:00Z",
    account_id: "acct-1",
    status: "ok",
    windows: {
      "5h": { used_percent: 25, remaining_percent: 75, reset_at: "2026-04-21T09:00:00Z" },
      "1week": { used_percent: 40, remaining_percent: 60, reset_at: "2026-04-27T09:00:00Z" },
    },
  });
  const incoming = sanitizeReport({
    source: "codex",
    hostname: "gpu4",
    reporter_name: "derek@gpu4",
    reported_at: "2026-04-21T04:15:00Z",
    account_id: "acct-1",
    status: "error",
    error: "auth invalidated (token_invalidated)",
    windows: { "5h": null, "1week": null },
  });

  const merged = mergeLatestReport(previous, incoming);

  assert.equal(merged.reported_at, "2026-04-21T04:15:00Z");
  assert.equal(merged.windows_stale, true);
  assert.equal(merged.windows["5h"].remaining_percent, 75);
  assert.equal(merged.windows["1week"].remaining_percent, 60);
  assert.equal(merged.error, "auth invalidated (token_invalidated)");
  assert.equal(merged.status, "error");
});

test("mergeLatestReport ignores invalidation from older auth refresh than current healthy report", () => {
  const previous = sanitizeReport({
    source: "codex",
    report_origin: "client",
    hostname: "stardust-GPU4",
    reporter_name: "derek@stardust-GPU4",
    reported_at: "2026-05-19T20:45:00Z",
    account_id: "derek@preseen.ai",
    auth_last_refresh: "2026-05-19T20:40:00Z",
    status: "ok",
    windows: {
      "5h": { used_percent: 10, remaining_percent: 90, reset_at: "2026-05-19T23:00:00Z" },
      "1week": { used_percent: 20, remaining_percent: 80, reset_at: "2026-05-23T23:00:00Z" },
    },
  });
  const incoming = sanitizeReport({
    source: "codex",
    report_origin: "client",
    hostname: "Dereks-MacBook-Air-13.local",
    reporter_name: "derek@Dereks-MacBook-Air-13.local",
    reported_at: "2026-05-19T20:49:00Z",
    account_id: "derek@preseen.ai",
    auth_last_refresh: "2026-05-19T08:23:42Z",
    status: "error",
    error: "auth invalidated (token_invalidated)",
    windows: { "5h": null, "1week": null },
  });

  const merged = mergeLatestReport(previous, incoming);

  assert.equal(merged.hostname, "stardust-GPU4");
  assert.equal(merged.reported_at, "2026-05-19T20:45:00Z");
  assert.equal(merged.status, "ok");
  assert.equal(merged.error, null);
  assert.equal(merged.windows["5h"].remaining_percent, 90);
  assert.equal(merged.windows["1week"].remaining_percent, 80);
});

test("mergeLatestReport keeps good client codex quota when a newer worker soft-fails", () => {
  const previous = sanitizeReport({
    source: "codex",
    report_origin: "client",
    hostname: "gpu4",
    reporter_name: "derek@gpu4",
    reported_at: "2026-04-21T04:10:00Z",
    account_id: "acct-1",
    status: "ok",
    windows: {
      "5h": { used_percent: 20, remaining_percent: 80, reset_at: "2026-04-21T09:00:00Z" },
      "1week": { used_percent: 35, remaining_percent: 65, reset_at: "2026-04-27T09:00:00Z" },
    },
  });
  const incoming = sanitizeReport({
    source: "codex",
    report_origin: "worker",
    hostname: "github-actions",
    reporter_name: "actions@github-actions",
    reported_at: "2026-04-21T04:15:00Z",
    account_id: "acct-1",
    status: "error",
    error: "token_count event was present but missing quota details",
    windows: { "5h": null, "1week": null },
    usage_summary: { probe_source: "github_actions_worker" },
  });

  const merged = mergeLatestReport(previous, incoming);

  assert.equal(merged.report_origin, "client");
  assert.equal(merged.reported_at, "2026-04-21T04:10:00Z");
  assert.equal(merged.status, "ok");
  assert.equal(merged.error, null);
  assert.equal(merged.windows["5h"].remaining_percent, 80);
  assert.equal(merged.windows["1week"].remaining_percent, 65);
});

test("statusPayload keeps last invalidated quota window before reset and marks it stale", () => {
  const payload = statusPayload([
    {
      source: "codex",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows_stale: true,
      account_id: "acct-1",
      reported_at: "2026-04-21T04:15:00Z",
      windows: {
        "5h": { used_percent: 25, remaining_percent: 75, reset_at: "2026-04-21T09:00:00Z" },
        "1week": { used_percent: 40, remaining_percent: 60, reset_at: "2026-04-27T09:00:00Z" },
      },
    },
  ], "2026-04-21T05:00:00Z");

  assert.equal(payload.items[0].display_windows["5h"].remaining_percent, 75);
  assert.equal(payload.items[0].display_windows["5h"].invalidated_stale, true);
  assert.equal(payload.items[0].display_windows["5h"].inferred_ready, false);
  assert.equal(payload.items[0].display_windows["1week"].invalidated_stale, true);
  assert.equal(payload.items[0].display_windows["1week"].inferred_ready, false);
});

test("statusPayload marks preserved invalidated windows gray even when windows_stale is false", () => {
  const payload = statusPayload([
    {
      source: "codex",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows_stale: false,
      account_id: "acct-1",
      reported_at: "2026-04-21T05:15:00Z",
      windows: {
        "5h": { used_percent: 60, remaining_percent: 40, reset_at: "2026-04-21T09:00:00Z" },
        "1week": { used_percent: 20, remaining_percent: 80, reset_at: "2026-04-27T09:00:00Z" },
      },
    },
  ], "2026-04-21T06:00:00Z");

  assert.equal(payload.items[0].display_windows["5h"].invalidated_stale, true);
  assert.equal(payload.items[0].display_windows["1week"].invalidated_stale, true);
  assert.equal(payload.items[0].display_windows["5h"].inferred_ready, false);
  assert.equal(payload.items[0].display_windows["1week"].inferred_ready, false);
});

test("statusPayload infers a gray 100 percent window after reset for stale invalidated auth", () => {
  const payload = statusPayload([
    {
      source: "codex",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows_stale: true,
      account_id: "acct-1",
      reported_at: "2026-04-21T10:15:00Z",
      windows: {
        "5h": { used_percent: 100, remaining_percent: 0, reset_at: "2026-04-21T10:00:00Z" },
        "1week": { used_percent: 40, remaining_percent: 60, reset_at: "2026-04-27T09:00:00Z" },
      },
    },
  ], "2026-04-21T10:30:00Z");

  assert.equal(payload.items[0].display_windows["5h"].remaining_percent, 100);
  assert.equal(payload.items[0].display_windows["5h"].used_percent, 0);
  assert.equal(payload.items[0].display_windows["5h"].inferred_ready, true);
});

test("statusPayload also infers the weekly window independently after weekly reset", () => {
  const payload = statusPayload([
    {
      source: "codex",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows_stale: true,
      account_id: "acct-1",
      reported_at: "2026-04-28T10:15:00Z",
      windows: {
        "5h": { used_percent: 20, remaining_percent: 80, reset_at: "2026-04-28T15:00:00Z" },
        "1week": { used_percent: 100, remaining_percent: 0, reset_at: "2026-04-28T10:00:00Z" },
      },
    },
  ], "2026-04-28T10:30:00Z");

  assert.equal(payload.items[0].display_windows["5h"].remaining_percent, 80);
  assert.equal(payload.items[0].display_windows["5h"].inferred_ready, false);
  assert.equal(payload.items[0].display_windows["1week"].remaining_percent, 100);
  assert.equal(payload.items[0].display_windows["1week"].used_percent, 0);
  assert.equal(payload.items[0].display_windows["1week"].inferred_ready, true);
});

test("statusPayload classifies missing reset time on invalidated stale windows", () => {
  const payload = statusPayload([
    {
      source: "codex",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      account_id: "acct-1",
      reported_at: "2026-04-21T10:15:00Z",
      windows: {
        "5h": { used_percent: 100, remaining_percent: 0, reset_at: null },
        "1week": { used_percent: 100, remaining_percent: 0, reset_at: null },
      },
    },
  ], "2026-04-21T10:30:00Z");

  assert.equal(payload.items[0].display_windows["5h"].reset_unavailable_reason, "auth_invalidated");
  assert.equal(payload.items[0].display_windows["1week"].reset_unavailable_reason, "auth_invalidated");
});

test("statusPayload classifies missing reset time as probe failure for non-invalidated windows", () => {
  const payload = statusPayload([
    {
      source: "codex",
      status: "ok",
      account_id: "acct-1",
      reported_at: "2026-04-21T10:15:00Z",
      windows: {
        "5h": { used_percent: 100, remaining_percent: 0, reset_at: null },
        "1week": { used_percent: 100, remaining_percent: 0, reset_at: null },
      },
    },
  ], "2026-04-21T10:30:00Z");

  assert.equal(payload.items[0].display_windows["5h"].reset_unavailable_reason, "probe_missing_reset");
  assert.equal(payload.items[0].display_windows["1week"].reset_unavailable_reason, "probe_missing_reset");
});

test("authPoolStatusPayload only includes cloud auth pool entries", () => {
  const payload = authPoolStatusPayload(
    [
      {
        source: "codex",
        account_id: "acct-1",
        email: "a@example.com",
        plan_name: "Pro",
        digest: "digest-1",
        auth_last_refresh: "2026-04-22T09:00:00Z",
        uploader_email: "derek@stardust.ai",
        reporter_name: "derek@gpu4",
        hostname: "gpu4",
        uploaded_at: "2026-04-22T10:00:00Z",
      },
    ],
    [
      {
        source: "codex",
        account_id: "acct-1",
        hostname: "quota-host",
        reporter_name: "quota-reporter@quota-host",
        report_origin: "client",
        status: "ok",
        reported_at: "2026-04-22T10:30:00Z",
        windows: {
          "5h": { remaining_percent: 80, reset_at: "2026-04-22T15:00:00Z" },
          "1week": { remaining_percent: 60, reset_at: "2026-04-28T15:00:00Z" },
        },
      },
      {
        source: "claude",
        account_id: "claude-x",
        status: "ok",
        reported_at: "2026-04-22T10:40:00Z",
      },
    ],
    "2026-04-22T11:00:00Z"
  );

  assert.equal(payload.auth_pool_count, 1);
  assert.equal(payload.orphaned_count, 0);
  assert.equal(payload.report_count, 1);
  // First item is the entry-backed report
  const entryItem = payload.items.find((item) => item.account_id === "acct-1");
  assert.equal(entryItem.email, "a@example.com");
  assert.equal(entryItem.uploader_email, "derek@stardust.ai");
  assert.equal(entryItem.hostname, "gpu4");
  assert.equal(entryItem.reporter_name, "derek@gpu4");
  assert.equal(entryItem.report_origin, "client");
  assert.equal(entryItem.windows["5h"].remaining_percent, 80);
  assert.equal(entryItem.display_windows["5h"].remaining_percent, 80);
  assert.equal(entryItem.digest, "digest-1");
  // Orphaned reports do not represent stored auth entries and stay out of both active and archived tables.
  assert.equal(payload.archived_invalidated_count, 0);
  assert.equal(payload.archived_invalidated_items.length, 0);
});

test("authPoolStatusPayload hides legacy empty session when account has session entries", () => {
  const payload = authPoolStatusPayload(
    [
      {
        source: "claude",
        account_id: "claude-a@example.com",
        session_id: "session-a",
        email: "a@example.com",
        plan_name: "Max",
        digest: "digest-session",
        auth_last_refresh: "2026-06-01T10:00:00Z",
        uploader_email: "derek@stardust.ai",
        reporter_name: "derek@mac",
        hostname: "mac",
        uploaded_at: "2026-06-01T10:00:00Z",
      },
      {
        source: "claude",
        account_id: "claude-a@example.com",
        session_id: "",
        email: "a@example.com",
        plan_name: "Max",
        digest: "digest-legacy",
        auth_last_refresh: "2026-06-01T09:00:00Z",
        uploader_email: "derek@stardust.ai",
        reporter_name: "legacy@mac",
        hostname: "legacy",
        uploaded_at: "2026-06-01T09:00:00Z",
      },
    ],
    [
      {
        source: "claude",
        account_id: "claude-a@example.com",
        status: "ok",
        reported_at: "2026-06-01T10:05:00Z",
        windows: {
          "5h": { remaining_percent: 90, reset_at: "2026-06-01T15:00:00Z" },
          "1week": { remaining_percent: 80, reset_at: "2026-06-08T10:00:00Z" },
        },
      },
    ],
    "2026-06-01T10:10:00Z"
  );

  assert.equal(payload.auth_pool_count, 1);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].session_id, "session-a");
  assert.equal(payload.items[0].digest, "digest-session");
});

test("authPoolStatusPayload archives hard-invalidated auths older than 48 hours by first invalidation time", () => {
  const payload = authPoolStatusPayload(
    [
      {
        source: "codex",
        account_id: "old-invalid",
        email: "old@example.com",
        plan_name: "Team",
        digest: "digest-1",
        auth_last_refresh: "2026-04-20T09:00:00Z",
        uploader_email: "derek@stardust.ai",
        reporter_name: "derek@gpu4",
        hostname: "gpu4",
        uploaded_at: "2026-04-20T10:00:00Z",
      },
      {
        source: "codex",
        account_id: "fresh-invalid",
        email: "fresh@example.com",
        plan_name: "Team",
        digest: "digest-2",
        auth_last_refresh: "2026-04-22T09:00:00Z",
        uploader_email: "derek@stardust.ai",
        reporter_name: "derek@gpu4",
        hostname: "gpu4",
        uploaded_at: "2026-04-22T10:00:00Z",
      },
    ],
    [
      sanitizeReport({
        source: "codex",
        hostname: "gpu4",
        reporter_name: "derek@gpu4",
        reported_at: "2026-04-20T12:00:00Z",
        account_id: "old-invalid",
        status: "error",
        error: "auth invalidated (token_invalidated)",
        windows: { "5h": null, "1week": null },
      }),
      sanitizeReport({
        source: "codex",
        hostname: "gpu4",
        reporter_name: "derek@gpu4",
        reported_at: "2026-04-22T12:00:02Z",
        account_id: "fresh-invalid",
        status: "error",
        error: "auth invalidated (token_invalidated)",
        windows: { "5h": null, "1week": null },
      }),
    ],
    "2026-04-24T12:00:01Z",
    [
      {
        source: "codex",
        account_id: "old-invalid",
        first_invalidated_at: "2026-04-20T12:00:00Z",
        last_notified_at: "2026-04-22T12:00:00Z",
        last_error: "auth invalidated (token_invalidated)",
      },
      {
        source: "codex",
        account_id: "fresh-invalid",
        first_invalidated_at: "2026-04-23T12:00:02Z",
        last_notified_at: null,
        last_error: "auth invalidated (token_invalidated)",
      },
    ]
  );

  assert.equal(payload.auth_pool_count, 1);
  assert.equal(payload.report_count, 1);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].account_id, "fresh-invalid");
  assert.equal(payload.items[0].first_invalidated_at, "2026-04-23T12:00:02Z");
  assert.equal(payload.archived_invalidated_count, 1);
  assert.equal(payload.archived_invalidated_items.length, 1);
  assert.equal(payload.archived_invalidated_items[0].account_id, "old-invalid");
  assert.equal(payload.archived_invalidated_items[0].first_invalidated_at, "2026-04-20T12:00:00Z");
});

test("authPoolStatusPayload archives old invalidations even when latest probe is fresh", () => {
  const payload = authPoolStatusPayload(
    [
      {
        source: "codex",
        account_id: "old-invalid-fresh-probe",
        email: "old@example.com",
        plan_name: "Team",
        digest: "digest-1",
        auth_last_refresh: "2026-04-20T09:00:00Z",
        uploader_email: "derek@stardust.ai",
        reporter_name: "derek@gpu4",
        hostname: "gpu4",
        uploaded_at: "2026-04-20T10:00:00Z",
      },
    ],
    [
      sanitizeReport({
        source: "codex",
        hostname: "github-actions",
        reporter_name: "actions@github-actions",
        reported_at: "2026-04-24T11:55:00Z",
        account_id: "old-invalid-fresh-probe",
        status: "error",
        error: "auth invalidated (token_invalidated)",
        windows: { "5h": null, "1week": null },
      }),
    ],
    "2026-04-24T12:00:01Z",
    [
      {
        source: "codex",
        account_id: "old-invalid-fresh-probe",
        first_invalidated_at: "2026-04-20T12:00:00Z",
        last_notified_at: null,
        last_error: "auth invalidated (token_invalidated)",
      },
    ]
  );

  assert.equal(payload.items.length, 0);
  assert.equal(payload.archived_invalidated_items.length, 1);
  assert.equal(payload.archived_invalidated_items[0].account_id, "old-invalid-fresh-probe");
  assert.equal(payload.archived_invalidated_items[0].uploader_email, "derek@stardust.ai");
  assert.equal(payload.archived_invalidated_items[0].reporter_name, "derek@gpu4");
  assert.equal(payload.archived_invalidated_items[0].hostname, "gpu4");
});

test("authPoolStatusPayload archives old invalidated state even when latest report is still ok", () => {
  const payload = authPoolStatusPayload(
    [
      {
        source: "claude",
        account_id: "claude-old-invalid",
        email: "old@example.com",
        plan_name: "Max",
        digest: "digest-1",
        auth_last_refresh: "1779967209619",
        uploader_email: "derek@stardust.ai",
        reporter_name: "derek@gpu4",
        hostname: "gpu4",
        uploaded_at: "2026-04-20T10:00:00Z",
      },
    ],
    [
      sanitizeReport({
        source: "claude",
        hostname: "derek@gpu4",
        reporter_name: "derek@gpu4",
        reported_at: "2026-04-20T11:00:00Z",
        account_id: "claude-old-invalid",
        email: "old@example.com",
        plan_name: "Max",
        status: "ok",
        windows: {
          "5h": { remaining_percent: 90, reset_at: "2026-04-20T16:00:00Z" },
          "1week": { remaining_percent: 80, reset_at: "2026-04-27T11:00:00Z" },
        },
      }),
    ],
    "2026-04-24T12:00:01Z",
    [
      {
        source: "claude",
        account_id: "claude-old-invalid",
        first_invalidated_at: "2026-04-20T12:00:00Z",
        last_notified_at: null,
        last_error: "claude auth invalid (authentication_error)",
      },
    ]
  );

  assert.equal(payload.items.length, 0);
  assert.equal(payload.archived_invalidated_items.length, 1);
  assert.equal(payload.archived_invalidated_items[0].source, "claude");
  assert.equal(payload.archived_invalidated_items[0].account_id, "claude-old-invalid");
  assert.equal(payload.archived_invalidated_items[0].first_invalidated_at, "2026-04-20T12:00:00Z");
});
