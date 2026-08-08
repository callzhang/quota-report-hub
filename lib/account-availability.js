import { REFRESH_TOKEN_REJECTED_ERROR, isAuthInvalidationError } from "./auth-status.js";

const CODEX_WINDOWS = ["1week"];
const CLAUDE_WINDOWS = ["5h", "1week"];

const STATE_DETAILS = {
  unavailable: { tone: "danger" },
  waiting_for_new_quota: { tone: "warning" },
  quota_unknown: { tone: "muted" },
  low_quota: { tone: "warning" },
  available: { tone: "success" },
};

function sourceWindowNames(item) {
  return String(item?.source || "").toLowerCase() === "codex" ? CODEX_WINDOWS : CLAUDE_WINDOWS;
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
  const capturedAt = item?.reported_at || null;
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
          captured_at: capturedAt,
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
  if (item?.auth_expired) {
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
    return stateResult("unavailable", unavailable, unavailableSummary(unavailable), null, historicalSnapshot);
  }

  if (hasExpiredWindow(windows, names, generatedAtMs)) {
    return stateResult(
      "waiting_for_new_quota",
      "quota_window_expired",
      "Previous quota window has reset; waiting for a new quota snapshot.",
      null,
      historicalSnapshot,
    );
  }

  const currentWindows = names.map((name) => windows[name]);
  const allCurrent = currentWindows.every((window) => isCurrentWindow(window, generatedAtMs));
  const probeSucceeded = item?.effective_status === undefined || item.effective_status === "ok";
  if (!probeSucceeded || !allCurrent) {
    return stateResult(
      "quota_unknown",
      "quota_evidence_incomplete",
      "Current quota evidence is incomplete.",
    );
  }

  const currentQuota = buildSnapshot(item, names);
  const meetsThreshold = names.every((name) => {
    const remaining = remainingPercent(windows[name]);
    const threshold = name === "5h" ? 20 : 5;
    return remaining >= threshold;
  });
  if (!meetsThreshold) {
    return stateResult(
      "low_quota",
      "below_rotation_threshold",
      "Current quota is below the rotation threshold.",
      currentQuota,
    );
  }

  return stateResult(
    "available",
    "meets_rotation_threshold",
    "Current quota meets the rotation threshold.",
    currentQuota,
  );
}
