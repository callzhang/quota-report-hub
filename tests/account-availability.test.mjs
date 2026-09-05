import test from "node:test";
import assert from "node:assert/strict";
import { deriveAccountAvailability } from "../lib/account-availability.js";

const now = "2026-08-08T07:37:12Z";

function unstartedWindow(capturedAt) {
  // Nothing consumed, so the provider reports no reset time yet.
  return { remaining_percent: 100, reset_at: null, reset_unavailable_reason: null, captured_at: capturedAt };
}

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
      name: "expired access without refresh recovery evidence is unavailable",
      item: {
        source: "codex",
        auth_expired: true,
        has_refresh_token: false,
        display_windows: { "1week": window(99, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "unavailable", currently_usable: false, reason: "access_token_expired" },
    },
    {
      name: "expired access with an untested refresh token is recoverable but unknown",
      item: {
        source: "codex",
        auth_expired: true,
        has_refresh_token: true,
        refresh_validity: { status: "unverified" },
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: { "1week": window(99, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "quota_unknown", currently_usable: false, reason: "access_expired_recoverable" },
    },
    {
      name: "expired access with a confirmed refresh token is recoverable but unknown",
      item: {
        source: "codex",
        auth_expired: true,
        has_refresh_token: true,
        refresh_validity: { status: "confirmed" },
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: { "1week": window(99, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "quota_unknown", currently_usable: false, reason: "access_expired_recoverable" },
    },
    {
      name: "expired AT-only access is unavailable even when refresh has not been tested",
      item: {
        source: "codex",
        auth_expired: true,
        has_refresh_token: false,
        refresh_validity: { status: "unverified" },
        display_windows: { "1week": window(99, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "unavailable", currently_usable: false, reason: "access_token_expired" },
    },
    {
      name: "expired legacy access with unknown refresh capability does not demand login",
      item: {
        source: "codex",
        auth_expired: true,
        has_refresh_token: null,
        refresh_validity: { status: "unverified" },
        display_windows: { "1week": window(99, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "quota_unknown", currently_usable: false, reason: "refresh_recovery_unknown" },
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
      name: "a quota report exactly one hour old is still current",
      item: {
        source: "codex",
        effective_status: "ok",
        reported_at: "2026-08-08T06:37:12Z",
        display_windows: { "1week": window(6, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "available", currently_usable: true, reason: "meets_rotation_threshold" },
    },
    {
      name: "a quota report older than one hour is unknown but remains historical evidence",
      item: {
        source: "codex",
        effective_status: "ok",
        reported_at: "2026-08-08T06:37:11Z",
        display_windows: { "1week": window(6, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "quota_unknown", currently_usable: false, reason: "quota_evidence_incomplete" },
      historical: {
        remaining_percent: 6,
        captured_at: "2026-08-08T06:37:11Z",
        reset_at: "2026-08-15T00:00:00Z",
      },
    },
    {
      name: "a quota report with an invalid timestamp is unknown",
      item: {
        source: "codex",
        effective_status: "ok",
        reported_at: "not-a-timestamp",
        display_windows: { "1week": window(6, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "quota_unknown", currently_usable: false, reason: "quota_evidence_incomplete" },
      historical: {
        remaining_percent: 6,
        captured_at: "not-a-timestamp",
        reset_at: "2026-08-15T00:00:00Z",
      },
    },
    {
      name: "a quota report without a timestamp is unknown",
      item: {
        source: "codex",
        effective_status: "ok",
        display_windows: { "1week": window(6, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "quota_unknown", currently_usable: false, reason: "quota_evidence_incomplete" },
      historical: {
        remaining_percent: 6,
        captured_at: null,
        reset_at: "2026-08-15T00:00:00Z",
      },
    },
    {
      name: "Codex with an expired five-hour window waits for a fresh snapshot",
      item: {
        source: "codex",
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: {
          "5h": window(0, "2026-08-08T07:30:26Z", "quota_window_expired"),
          "1week": window(6, "2026-08-15T00:00:00Z"),
        },
      },
      expected: { state: "waiting_for_new_quota", currently_usable: false, reason: "quota_window_expired" },
    },
    {
      name: "Codex five-hour quota below the rotation threshold is low quota",
      item: {
        source: "codex",
        effective_status: "ok",
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: {
          "5h": window(12, "2026-08-08T09:00:00Z"),
          "1week": window(70, "2026-08-15T00:00:00Z"),
        },
      },
      expected: { state: "low_quota", currently_usable: false, reason: "below_rotation_threshold" },
    },
    {
      name: "Codex without a five-hour window is judged on weekly quota alone",
      item: {
        source: "codex",
        effective_status: "ok",
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: {
          "1week": window(70, "2026-08-15T00:00:00Z"),
        },
      },
      expected: { state: "available", currently_usable: true, reason: "meets_rotation_threshold" },
    },
    {
      name: "Claude needs both live quota windows before it can be available",
      item: {
        source: "claude",
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: {
          "5h": window(20, "2026-08-08T09:00:00Z"),
          "1week": null,
        },
      },
      expected: { state: "quota_unknown", currently_usable: false, reason: "quota_evidence_incomplete" },
      historical: {
        remaining_percent: 20,
        captured_at: "2026-08-08T07:24:12Z",
        reset_at: "2026-08-08T09:00:00Z",
      },
    },
    {
      name: "Claude quota below either sharing threshold is low",
      item: {
        source: "claude",
        reported_at: "2026-08-08T07:24:12Z",
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
        reported_at: "2026-08-08T07:24:12Z",
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
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: {
          "5h": window(20, "2026-08-08T09:00:00Z"),
          "1week": window(5, "2026-08-15T00:00:00Z"),
        },
      },
      expected: { state: "available", currently_usable: true, reason: "meets_rotation_threshold" },
    },
    {
      name: "a failed probe retains its last quota as historical evidence",
      item: {
        source: "codex",
        effective_status: "error",
        reported_at: "2026-08-08T07:24:12Z",
        display_windows: { "1week": window(90, "2026-08-15T00:00:00Z") },
      },
      expected: { state: "quota_unknown", currently_usable: false, reason: "quota_evidence_incomplete" },
      historical: {
        remaining_percent: 90,
        captured_at: "2026-08-08T07:24:12Z",
        reset_at: "2026-08-15T00:00:00Z",
      },
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

test("deriveAccountAvailability reports an exhausted account as low_quota until its reset", () => {
  const item = {
    source: "codex",
    status: "ok",
    effective_status: "ok",
    reported_at: "2026-09-03T21:45:21Z",
    exhausted_until: "2026-09-07T05:26:08Z",
    display_windows: {},
    refresh_validity: { status: "unverified" },
  };
  const result = deriveAccountAvailability(item, "2026-09-03T22:00:00Z");
  assert.equal(result.state, "low_quota");
  assert.equal(result.reason, "usage_limit_exhausted");
  assert.equal(result.currently_usable, false);
  // nextTransitionAt picks the EARLIEST future transition. The report-staleness boundary
  // (reported_at + 3600s + 1) comes before the exhaustion reset here, and that is correct — a
  // report going stale changes the display before the quota resets. The staleness boundary
  // usually binds; the exhausted_until candidate binds only in the final stretch before reset,
  // when the deadline is nearer than staleness (see the near-reset test below).
  // (the +1 in nextTransitionAt is one millisecond past the freshness boundary, hence .001)
  assert.equal(result.next_transition_at, "2026-09-03T22:45:21.001Z");
});

test("deriveAccountAvailability schedules the next transition at a near exhaustion reset", () => {
  // The staleness boundary (reported_at + 1h + 1ms) usually binds; the exhausted_until candidate
  // exists for the final stretch before the reset, when the deadline is NEARER than staleness —
  // that is when the dashboard must wake up because the account actually recovers.
  const item = {
    source: "codex",
    status: "ok",
    effective_status: "ok",
    reported_at: "2026-09-03T21:55:00Z",
    exhausted_until: "2026-09-03T22:20:00Z",
    display_windows: {},
    refresh_validity: { status: "unverified" },
  };
  const result = deriveAccountAvailability(item, "2026-09-03T22:00:00Z");
  assert.equal(result.state, "low_quota");
  assert.equal(result.next_transition_at, "2026-09-03T22:20:00.000Z");
});

test("deriveAccountAvailability ignores a past exhausted_until", () => {
  const item = {
    source: "codex",
    status: "ok",
    effective_status: "ok",
    reported_at: "2026-09-07T06:00:00Z",
    exhausted_until: "2026-09-07T05:26:08Z",
    display_windows: {
      "1week": { remaining_percent: 96, reset_at: "2026-09-14T00:00:00Z" },
    },
    refresh_validity: { status: "unverified" },
  };
  const result = deriveAccountAvailability(item, "2026-09-07T06:05:00Z");
  assert.equal(result.state, "available");
  assert.notEqual(result.reason, "usage_limit_exhausted");
});

test("a freshly measured window with nothing consumed counts as current quota", () => {
  // Requiring a future reset made the *most* available account read as quota_evidence_incomplete:
  // a full window has no reset time because the clock has not started.
  const result = deriveAccountAvailability({
    source: "claude",
    effective_status: "ok",
    reported_at: "2026-08-08T07:24:12Z",
    display_windows: {
      "5h": unstartedWindow("2026-08-08T07:24:12Z"),
      "1week": unstartedWindow("2026-08-08T07:24:12Z"),
    },
  }, now);

  assert.equal(result.state, "available");
  assert.equal(result.currently_usable, true);
  assert.equal(result.reason, "meets_rotation_threshold");
});

test("a stale carried-forward zero window does not masquerade as current quota", () => {
  // With no reset_at there is no expiry to fall past, so staleness has to come from captured_at -
  // otherwise a zero measured days ago would keep an account permanently "available".
  const result = deriveAccountAvailability({
    source: "claude",
    effective_status: "ok",
    reported_at: "2026-08-08T07:24:12Z",
    display_windows: {
      "5h": unstartedWindow("2026-08-05T01:00:00Z"),
      "1week": unstartedWindow("2026-08-05T01:00:00Z"),
    },
  }, now);

  assert.equal(result.state, "quota_unknown");
  assert.equal(result.reason, "quota_evidence_incomplete");
});

// A dead refresh token is a warning with a deadline, not unavailability. The access token keeps working
// until it expires; only then -- or when the token is refused outright -- does the account go dark.
test("deriveAccountAvailability keeps a dead-refresh-token account usable until its access token expires", () => {
  const generatedAt = "2026-09-10T01:00:00Z";
  const base = {
    source: "claude",
    status: "ok",
    effective_status: "ok",
    reported_at: "2026-09-10T00:58:00Z",
    first_invalidated_at: "2026-09-01T00:00:00Z",
    refresh_validity: { status: "rejected", deadline: "2026-09-29T18:59:06.219Z" },
    auth_expires_at: "2026-09-29T18:59:06.219Z",
    auth_expired: false,
    has_refresh_token: true,
    display_windows: {
      "5h": window(80, "2026-09-10T03:00:00Z"),
      "1week": window(60, "2026-09-14T00:00:00Z"),
    },
  };

  const live = deriveAccountAvailability(base, generatedAt);
  assert.equal(live.state, "available");
  assert.equal(live.currently_usable, true);
  assert.deepEqual(live.warning, {
    code: "refresh_token_rejected",
    usable_until: "2026-09-29T18:59:06.219Z",
    summary: "Refresh token rejected - usable until the access token expires; owner must log in again.",
  });

  // the access token has now expired: nobody can renew it, so the account is unavailable for good
  const expired = deriveAccountAvailability({ ...base, auth_expired: true }, "2026-09-29T20:00:00Z");
  assert.equal(expired.state, "unavailable");
  assert.equal(expired.reason, "access_token_expired");
  assert.equal(expired.warning, undefined, "unavailable already says it all");

  // no expiry on record: nothing says the token works, so the dead refresh token is decisive
  const unknown = deriveAccountAvailability({ ...base, auth_expires_at: null, auth_expired: false }, generatedAt);
  assert.equal(unknown.state, "unavailable");
  assert.equal(unknown.reason, "auth_invalidated");

  // a probe that was refused outranks the clock
  const refused = deriveAccountAvailability({ ...base, status: "error", effective_status: "error", error: "claude auth invalid (authentication_error)" }, generatedAt);
  assert.equal(refused.state, "unavailable");
  assert.equal(refused.reason, "auth_invalidated");
});
