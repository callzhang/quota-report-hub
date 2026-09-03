import { REFRESH_TOKEN_REJECTED_ERROR, isAuthInvalidationError } from "./auth-status.js";
import { reportIsFresh } from "./report-freshness.js";

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

function isCurrentWindow(window, generatedAtMs) {
  const resetMs = resetAtMs(window);
  return (
    remainingPercent(window) !== null &&
    !window?.reset_unavailable_reason &&
    resetMs !== null &&
    resetMs > generatedAtMs
  );
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

function unavailableReason(item) {
  if (item?.error === REFRESH_TOKEN_REJECTED_ERROR) {
    return "refresh_token_rejected";
  }
  if (item?.first_invalidated_at || isAuthInvalidationError(item?.error)) {
    return "auth_invalidated";
  }
  if (item?.refresh_validity?.status === "rejected") {
    return "refresh_token_rejected";
  }
  if (item?.plan_name === "Free") {
    return "account_ineligible";
  }
  if (item?.auth_expired && (item?.has_refresh_token === false || item?.refresh_validity?.status === "rejected")) {
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

export function deriveAccountAvailability(item, generatedAt = new Date().toISOString()) {
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
