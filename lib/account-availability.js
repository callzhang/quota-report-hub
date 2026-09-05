import { REFRESH_TOKEN_REJECTED_ERROR, isAuthInvalidationError } from "./auth-status.js";
import { MAX_REPORT_AGE_SECONDS, reportIsFresh } from "./report-freshness.js";

const CLAUDE_WINDOWS = ["5h", "1week"];

const STATE_DETAILS = {
  unavailable: { tone: "danger" },
  waiting_for_new_quota: { tone: "warning" },
  quota_unknown: { tone: "muted" },
  low_quota: { tone: "warning" },
  available: { tone: "success" },
};

function sourceWindowNames(item) {
  if (String(item?.source || "").toLowerCase() !== "codex") {
    return CLAUDE_WINDOWS;
  }
  // Codex tiers differ: Plus-tier accounts still meter a 5h window, some higher tiers do not.
  // Judge each account by the windows its own report carries — requiring 5h unconditionally would
  // park windowless accounts in quota_unknown forever.
  return item?.display_windows?.["5h"] ? CLAUDE_WINDOWS : ["1week"];
}

function remainingPercent(window) {
  if (window?.remaining_percent === null || window?.remaining_percent === undefined || window?.remaining_percent === "") {
    return null;
  }
  const value = Number(window?.remaining_percent);
  return Number.isFinite(value) ? value : null;
}

function resetAtMs(window) {
  const value = Date.parse(window?.reset_at || "");
  return Number.isFinite(value) ? value : null;
}

// A window that has consumed nothing carries no reset time (the provider starts the clock on
// first use). Requiring a future reset made the *most* available account read as
// quota_evidence_incomplete. Accept it only when the measurement itself is recent, so a
// carried-forward zero cannot masquerade as current quota forever - with no reset_at there is no
// expiry to fall past, which is exactly how the codex zombie 5h window used to hide.
function isUnstartedWindow(window) {
  return remainingPercent(window) === 100 && resetAtMs(window) === null;
}

function windowMeasuredRecently(window, generatedAtMs) {
  const capturedMs = Date.parse(window?.captured_at || "");
  if (!Number.isFinite(capturedMs)) return false;
  return generatedAtMs - capturedMs <= MAX_REPORT_AGE_SECONDS * 1000;
}

function isCurrentWindow(window, generatedAtMs) {
  const resetMs = resetAtMs(window);
  if (remainingPercent(window) === null || window?.reset_unavailable_reason) {
    return false;
  }
  if (resetMs === null) {
    return isUnstartedWindow(window) && windowMeasuredRecently(window, generatedAtMs);
  }
  return resetMs > generatedAtMs;
}

function hasExpiredWindow(windows, names, generatedAtMs) {
  return names.some((name) => {
    const window = windows[name];
    const resetMs = resetAtMs(window);
    return Boolean(
      window &&
      (window.reset_unavailable_reason === "quota_window_expired" ||
        (resetMs !== null && resetMs <= generatedAtMs)),
    );
  });
}

function buildSnapshot(item, names) {
  const windows = Object.fromEntries(
    names
      .map((name) => {
        const window = item?.display_windows?.[name];
        const remaining = remainingPercent(window);
        if (!window || (remaining === null && !window.reset_at)) {
          return null;
        }
        return [name, {
          remaining_percent: remaining,
          reset_at: window.reset_at || null,
          captured_at: window.captured_at || item?.reported_at || null,
        }];
      })
      .filter(Boolean),
  );
  const primaryName = names.find((name) => windows[name]) || null;
  if (!primaryName) {
    return null;
  }
  const primary = windows[primaryName];
  return {
    window: primaryName,
    remaining_percent: primary.remaining_percent,
    reset_at: primary.reset_at,
    captured_at: primary.captured_at,
    windows,
  };
}

// Whether the access token can still be used. Expiry is an upper bound (a refresh elsewhere revokes
// it sooner), so a probe that was refused outranks the clock; an entry with no expiry on record has
// nothing that says its token works, so it is not assumed to. Mirrors reports.js accessTokenState.
function accessTokenUsable(item) {
  if (item?.status === "error" && isAuthInvalidationError(item?.error)) {
    return false;
  }
  if (!Number.isFinite(Date.parse(item?.auth_expires_at || ""))) {
    return false;
  }
  return !item?.auth_expired;
}

function refreshTokenDead(item) {
  return Boolean(item?.first_invalidated_at) || item?.refresh_validity?.status === "rejected";
}

// Unavailable means nobody can use this account right now. A dead refresh token on its own is not
// that: the access token keeps working until it expires, and only then does the account go dark for
// good. So the refresh verdict makes an account unavailable only once the access token is gone too;
// until then it is a warning with a deadline (see attachRefreshWarning).
function unavailableReason(item) {
  if (item?.plan_name === "Free") {
    return "account_ineligible";
  }
  if (item?.status === "error" && isAuthInvalidationError(item?.error)) {
    return item.error === REFRESH_TOKEN_REJECTED_ERROR ? "refresh_token_rejected" : "auth_invalidated";
  }
  if (refreshTokenDead(item) && !accessTokenUsable(item)) {
    // Name the token that actually killed it: an expired access token nobody can renew reads as
    // access_token_expired; before expiry the refresh-side fact is the reason, keeping the older
    // distinction between an open invalidation record and a bare rejected refresh.
    if (item?.auth_expired) {
      return "access_token_expired";
    }
    return item?.first_invalidated_at ? "auth_invalidated" : "refresh_token_rejected";
  }
  if (item?.auth_expired && item?.has_refresh_token === false) {
    return "access_token_expired";
  }
  return null;
}

function stateResult(state, reason, summary, currentQuota = null, historicalSnapshot = null) {
  return {
    state,
    currently_usable: state === "available",
    reason,
    tone: STATE_DETAILS[state].tone,
    summary,
    current_quota: currentQuota,
    historical_snapshot: historicalSnapshot,
  };
}

function nextTransitionAt(item, names, generatedAtMs) {
  const candidates = [];
  const reportedAtMs = Date.parse(item?.reported_at || "");
  if (Number.isFinite(reportedAtMs)) candidates.push(reportedAtMs + 3600 * 1000 + 1);
  for (const name of names) {
    const resetMs = resetAtMs(item?.display_windows?.[name]);
    if (resetMs !== null) candidates.push(resetMs);
  }
  const expiresAtMs = Date.parse(item?.auth_expires_at || "");
  if (Number.isFinite(expiresAtMs)) candidates.push(expiresAtMs);
  const exhaustedMs = Date.parse(item?.exhausted_until || "");
  if (Number.isFinite(exhaustedMs)) candidates.push(exhaustedMs);
  const next = candidates.filter((value) => value > generatedAtMs).sort((a, b) => a - b)[0];
  return next ? new Date(next).toISOString() : null;
}

function withNextTransition(result, item, names, generatedAtMs) {
  return { ...result, next_transition_at: nextTransitionAt(item, names, generatedAtMs) };
}

function unavailableSummary(reason) {
  if (reason === "refresh_token_rejected") {
    return "Refresh token rejected - owner must log in again.";
  }
  if (reason === "auth_invalidated") {
    return "Authentication is invalidated - owner must log in again.";
  }
  if (reason === "account_ineligible") {
    return "Account is ineligible for rotation.";
  }
  return "Access token expired and cannot be recovered.";
}

// A dead refresh token with a live access token: usable, but on a clock nobody can extend. The
// warning names the deadline so the person reading it knows both what is wrong and when it matters.
function attachRefreshWarning(result, item) {
  if (result.state === "unavailable" || !refreshTokenDead(item)) {
    return result;
  }
  return {
    ...result,
    warning: {
      code: "refresh_token_rejected",
      usable_until: item?.auth_expires_at || null,
      summary: "Refresh token rejected - usable until the access token expires; owner must log in again.",
    },
  };
}

export function deriveAccountAvailability(item, generatedAt = new Date().toISOString()) {
  return attachRefreshWarning(deriveAccountAvailabilityState(item, generatedAt), item);
}

function deriveAccountAvailabilityState(item, generatedAt) {
  const names = sourceWindowNames(item);
  const generatedAtMs = Date.parse(generatedAt);
  const windows = item?.display_windows || {};
  const historicalSnapshot = buildSnapshot(item, names);
  const unavailable = unavailableReason(item);

  if (unavailable) {
    return withNextTransition(stateResult("unavailable", unavailable, unavailableSummary(unavailable), null, historicalSnapshot), item, names, generatedAtMs);
  }

  // A limit-hit probe measured the account as unusable until a known time. This outranks the
  // window-derived states below: the windows of an exhaustion report are empty (or stale
  // carry-forward), but the account state itself is fully known — drained, recovering at T.
  // It also deliberately outranks the recoverable-auth states below: an exhausted account is out
  // of rotation regardless of auth-expiry recoverability, so that hint waits until quota recovers.
  const exhaustedUntilMs = Date.parse(item?.exhausted_until || "");
  if (Number.isFinite(exhaustedUntilMs) && exhaustedUntilMs > generatedAtMs) {
    return withNextTransition(stateResult(
      "low_quota",
      "usage_limit_exhausted",
      "Usage limit exhausted; the provider resets it automatically.",
      null,
      historicalSnapshot,
    ), item, names, generatedAtMs);
  }

  if (hasExpiredWindow(windows, names, generatedAtMs)) {
    return withNextTransition(stateResult(
      "waiting_for_new_quota",
      "quota_window_expired",
      "Previous quota window has reset; waiting for a new quota snapshot.",
      null,
      historicalSnapshot,
    ), item, names, generatedAtMs);
  }

  if (item?.auth_expired && item?.has_refresh_token) {
    return withNextTransition(stateResult(
      "quota_unknown",
      "access_expired_recoverable",
      "Access token expired; refresh recovery is available and will be checked automatically.",
      null,
      historicalSnapshot,
    ), item, names, generatedAtMs);
  }

  if (item?.auth_expired && item?.has_refresh_token == null) {
    return withNextTransition(stateResult(
      "quota_unknown",
      "refresh_recovery_unknown",
      "Access token expired; refresh recovery capability is not recorded yet.",
      null,
      historicalSnapshot,
    ), item, names, generatedAtMs);
  }

  const currentWindows = names.map((name) => windows[name]);
  const allCurrent = currentWindows.every((window) => isCurrentWindow(window, generatedAtMs));
  const probeSucceeded = item?.effective_status === undefined || item.effective_status === "ok";
  const reportFresh = reportIsFresh(item, { now: generatedAt });
  if (!probeSucceeded || !reportFresh || !allCurrent) {
    return withNextTransition(stateResult(
      "quota_unknown",
      "quota_evidence_incomplete",
      "Current quota evidence is incomplete.",
      null,
      historicalSnapshot,
    ), item, names, generatedAtMs);
  }

  const currentQuota = buildSnapshot(item, names);
  const meetsThreshold = names.every((name) => {
    const remaining = remainingPercent(windows[name]);
    const threshold = name === "5h" ? 20 : 5;
    return remaining >= threshold;
  });
  if (!meetsThreshold) {
    return withNextTransition(stateResult(
      "low_quota",
      "below_rotation_threshold",
      "Current quota is below the rotation threshold.",
      currentQuota,
    ), item, names, generatedAtMs);
  }

  return withNextTransition(stateResult(
    "available",
    "meets_rotation_threshold",
    "Current quota meets the rotation threshold.",
    currentQuota,
  ), item, names, generatedAtMs);
}
