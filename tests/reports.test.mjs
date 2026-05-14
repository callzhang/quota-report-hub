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
    reported_at: "2026-04-21T04:15:00Z",
    account_id: "acct-1",
    status: "ok",
    windows: {
      "5h": { used_percent: 10, remaining_percent: 90, reset_at: "2026-04-21T10:00:00Z" },
      "1week": { used_percent: 35, remaining_percent: 65, reset_at: "2026-04-28T10:00:00Z" },
    },
  });

  const merged = mergeLatestReport(previous, incoming);

  assert.equal(merged.reported_at, "2026-04-21T04:15:00Z");
  assert.equal(merged.windows_stale, false);
  assert.equal(merged.windows["5h"].remaining_percent, 90);
  assert.equal(merged.windows["1week"].remaining_percent, 65);
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
  // Orphaned Claude report moves to archived
  assert.equal(payload.archived_invalidated_count, 1);
  const archivedItem = payload.archived_invalidated_items.find((item) => item.account_id === "claude-x");
  assert.ok(archivedItem);
  assert.equal(archivedItem.source, "claude");
  assert.equal(archivedItem.status, "ok");
  assert.equal(archivedItem.digest, null);
  assert.equal(archivedItem.uploaded_at, null);
  assert.equal(archivedItem.uploader_email, null);
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
