import test from "node:test";
import assert from "node:assert/strict";
import { deriveAccountAvailability } from "../lib/account-availability.js";

const now = "2026-08-08T07:37:12Z";

function window(remainingPercent, resetAt, resetUnavailableReason = null) {
  return {
    remaining_percent: remainingPercent,
    reset_at: resetAt,
    reset_unavailable_reason: resetUnavailableReason,
  };
}

test("deriveAccountAvailability applies account-state precedence", () => {
  const cases = [
    {
      name: "waits for a post-reset Codex weekly snapshot instead of using historical zero quota",
      item: {
        source: "codex",
        effective_status: "ok",
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: {
          "1week": window(0, "2026-08-08T07:30:26Z", "quota_window_expired"),
        },
        refresh_validity: { status: "unverified" },
      },
      expected: {
        state: "waiting_for_new_quota",
        currently_usable: false,
        reason: "quota_window_expired",
      },
      historical: {
        remaining_percent: 0,
        captured_at: "2026-08-08T07:24:12Z",
        reset_at: "2026-08-08T07:30:26Z",
      },
    },
    {
      name: "refresh rejection overrides otherwise healthy quota",
      item: {
        source: "codex",
        reported_at: "2026-08-08T07:24:12Z",
        refresh_validity: { status: "rejected" },
        display_windows: { "1week": window(99, "2026-08-15T00:00:00Z") },
      },
      expected: {
        state: "unavailable",
        currently_usable: false,
        reason: "refresh_token_rejected",
      },
    },
    {
      name: "auth invalidation overrides otherwise healthy quota",
      item: {
        source: "codex",
        first_invalidated_at: "2026-08-08T07:00:00Z",
        display_windows: { "1week": window(99, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "unavailable", currently_usable: false, reason: "auth_invalidated" },
    },
    {
      name: "ineligible accounts are unavailable",
      item: {
        source: "codex",
        plan_name: "Free",
        display_windows: { "1week": window(99, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "unavailable", currently_usable: false, reason: "account_ineligible" },
    },
    {
      name: "unrecoverably expired access is unavailable",
      item: {
        source: "codex",
        auth_expired: true,
        display_windows: { "1week": window(99, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "unavailable", currently_usable: false, reason: "access_token_expired" },
    },
    {
      name: "a successful probe without complete quota is unknown",
      item: {
        source: "codex",
        effective_status: "ok",
        refresh_validity: { status: "confirmed" },
        display_windows: { "1week": window(null, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "quota_unknown", currently_usable: false, reason: "quota_evidence_incomplete" },
    },
    {
      name: "an expired Codex window without a remaining value waits for a new snapshot",
      item: {
        source: "codex",
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: {
          "1week": window(null, "2026-08-08T07:30:26Z", "quota_window_expired"),
        },
      },
      expected: { state: "waiting_for_new_quota", currently_usable: false, reason: "quota_window_expired" },
      historical: {
        remaining_percent: null,
        captured_at: "2026-08-08T07:24:12Z",
        reset_at: "2026-08-08T07:30:26Z",
      },
    },
    {
      name: "Codex weekly quota below the share threshold is low",
      item: {
        source: "codex",
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: { "1week": window(3, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "low_quota", currently_usable: false, reason: "below_rotation_threshold" },
    },
    {
      name: "Codex weekly quota at the share threshold is available",
      item: {
        source: "codex",
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: { "1week": window(5, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "available", currently_usable: true, reason: "meets_rotation_threshold" },
    },
    {
      name: "Codex ignores an expired legacy five-hour window",
      item: {
        source: "codex",
        display_windows: {
          "5h": window(0, "2026-08-08T07:30:26Z", "quota_window_expired"),
          "1week": window(6, "2026-08-15T00:00:00Z"),
        },
      },
      expected: { state: "available", currently_usable: true, reason: "meets_rotation_threshold" },
    },
    {
      name: "Claude needs both live quota windows before it can be available",
      item: {
        source: "claude",
        display_windows: {
          "5h": window(20, "2026-08-08T09:00:00Z"),
          "1week": null,
        },
      },
      expected: { state: "quota_unknown", currently_usable: false, reason: "quota_evidence_incomplete" },
    },
    {
      name: "Claude quota below either sharing threshold is low",
      item: {
        source: "claude",
        display_windows: {
          "5h": window(19, "2026-08-08T09:00:00Z"),
          "1week": window(5, "2026-08-15T00:00:00Z"),
        },
      },
      expected: { state: "low_quota", currently_usable: false, reason: "below_rotation_threshold" },
    },
    {
      name: "Claude weekly quota below its sharing threshold is low",
      item: {
        source: "claude",
        display_windows: {
          "5h": window(20, "2026-08-08T09:00:00Z"),
          "1week": window(4, "2026-08-15T00:00:00Z"),
        },
      },
      expected: { state: "low_quota", currently_usable: false, reason: "below_rotation_threshold" },
    },
    {
      name: "Claude quota meeting both sharing thresholds is available",
      item: {
        source: "claude",
        display_windows: {
          "5h": window(20, "2026-08-08T09:00:00Z"),
          "1week": window(5, "2026-08-15T00:00:00Z"),
        },
      },
      expected: { state: "available", currently_usable: true, reason: "meets_rotation_threshold" },
    },
  ];

  for (const { name, item, expected, historical } of cases) {
    const result = deriveAccountAvailability(item, now);
    assert.deepEqual(
      {
        state: result.state,
        currently_usable: result.currently_usable,
        reason: result.reason,
      },
      expected,
      name,
    );
    assert.equal(typeof result.summary, "string", `${name}: summary`);
    assert.equal(typeof result.tone, "string", `${name}: tone`);
    if (historical) {
      assert.deepEqual(
        {
          remaining_percent: result.historical_snapshot.remaining_percent,
          captured_at: result.historical_snapshot.captured_at,
          reset_at: result.historical_snapshot.reset_at,
        },
        historical,
        name,
      );
    }
  }
});

test("deriveAccountAvailability preserves historical window values without treating them as current", () => {
  const result = deriveAccountAvailability({
    source: "claude",
    reported_at: "2026-08-08T07:24:12Z",
    display_windows: {
      "5h": window(0, "2026-08-08T07:30:26Z", "quota_window_expired"),
      "1week": window(80, "2026-08-15T00:00:00Z"),
    },
  }, now);

  assert.equal(result.state, "waiting_for_new_quota");
  assert.equal(result.current_quota, null);
  assert.deepEqual(result.historical_snapshot, {
    window: "5h",
    remaining_percent: 0,
    reset_at: "2026-08-08T07:30:26Z",
    captured_at: "2026-08-08T07:24:12Z",
    windows: {
      "5h": {
        remaining_percent: 0,
        reset_at: "2026-08-08T07:30:26Z",
        captured_at: "2026-08-08T07:24:12Z",
      },
      "1week": {
        remaining_percent: 80,
        reset_at: "2026-08-15T00:00:00Z",
        captured_at: "2026-08-08T07:24:12Z",
      },
    },
  });
});
