import { refreshValidityFromReport } from "./auth-status.js";
import { deriveAccountAvailability } from "./account-availability.js";

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeWindow(input, defaultMinutes, capturedAt) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const usedPercent = toFiniteNumber(input.used_percent);
  const remainingPercent = toFiniteNumber(input.remaining_percent);
  const resetInSeconds = toFiniteNumber(input.reset_in_seconds);
  const windowMinutes = toFiniteNumber(input.window_minutes) ?? defaultMinutes;
  const resetAt = input.reset_at ? String(input.reset_at) : null;

  if (
    usedPercent === null &&
    remainingPercent === null &&
    resetInSeconds === null &&
    resetAt === null
  ) {
    return null;
  }

  return {
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    window_minutes: windowMinutes,
    reset_in_seconds: resetInSeconds,
    reset_at: resetAt,
    captured_at: capturedAt,
  };
}

function isExpiredClaudeClientStatuslineWindow(input, window) {
  if (!window) {
    return false;
  }
  if (String(input?.source || "") !== "claude") {
    return false;
  }
  if (normalizeReportOrigin(input) !== "client") {
    return false;
  }
  if (input?.usage_summary?.quota_source !== "statusline_snapshot") {
    return false;
  }
  const resetAt = Date.parse(window.reset_at || "");
  const reportedAt = Date.parse(input?.reported_at || "");
  return Number.isFinite(resetAt) && Number.isFinite(reportedAt) && resetAt <= reportedAt;
}

function normalizeReportOrigin(input) {
  const explicit = String(input?.report_origin || "").trim().toLowerCase();
  if (explicit === "client" || explicit === "worker") {
    return explicit;
  }
  if (input?.usage_summary?.probe_source === "github_actions_worker") {
    return "worker";
  }
  return "unknown";
}

export function sanitizeReport(input) {
  const now = new Date().toISOString();
  const reportedAt = String(input.reported_at || now);
  const rawFiveHour = sanitizeWindow(input.windows?.["5h"], 300, reportedAt);
  const rawOneWeek = sanitizeWindow(input.windows?.["1week"], 10080, reportedAt);
  const fiveHour = isExpiredClaudeClientStatuslineWindow(input, rawFiveHour) ? null : rawFiveHour;
  const oneWeek = isExpiredClaudeClientStatuslineWindow(input, rawOneWeek) ? null : rawOneWeek;
  return {
    source: String(input.source || "unknown"),
    hostname: String(input.hostname || "unknown-host"),
    reporter_name: String(input.reporter_name || "unknown"),
    reported_at: reportedAt,
    account_id: String(input.account_id || "unknown-account"),
    email: input.email ? String(input.email) : null,
    name: input.name ? String(input.name) : null,
    plan_name: input.plan_name ? String(input.plan_name) : null,
    auth_path: input.auth_path ? String(input.auth_path) : null,
    auth_last_refresh: input.auth_last_refresh ? String(input.auth_last_refresh) : null,
    status: String(input.status || "ok"),
    error: input.error ? String(input.error) : null,
    model_context_window: input.model_context_window || null,
    usage_summary: input.usage_summary && typeof input.usage_summary === "object" ? input.usage_summary : null,
    report_origin: normalizeReportOrigin(input),
    windows_stale: Boolean(input.windows_stale),
    windows: {
      "5h": fiveHour,
      "1week": oneWeek,
    },
  };
}

function mergeWindow(previousWindow, incomingWindow) {
  return incomingWindow ?? previousWindow ?? null;
}

function resetAtMs(window) {
  const value = Date.parse(window?.reset_at || "");
  return Number.isFinite(value) ? value : null;
}

function reportAtMs(report) {
  const value = Date.parse(report?.reported_at || "");
  return Number.isFinite(value) ? value : null;
}

function incomingWindowJumpsBeforePreviousReset(previousReport, incomingReport, windowName) {
  const previousWindow = previousReport?.windows?.[windowName];
  const incomingWindow = incomingReport?.windows?.[windowName];
  const previousResetMs = resetAtMs(previousWindow);
  const incomingResetMs = resetAtMs(incomingWindow);
  const incomingReportedMs = reportAtMs(incomingReport);
  if (previousResetMs === null || incomingResetMs === null || incomingReportedMs === null) {
    return false;
  }
  if (incomingReportedMs >= previousResetMs) {
    return false;
  }
  const toleranceMs = 5 * 60 * 1000;
  return incomingResetMs > previousResetMs + toleranceMs;
}

function shouldPreservePreviousWindow(previousReport, incomingReport, windowName) {
  return incomingWindowJumpsBeforePreviousReset(previousReport, incomingReport, windowName);
}

function mergeTrustedWindow(previousReport, incomingReport, windowName) {
  if (shouldPreservePreviousWindow(previousReport, incomingReport, windowName)) {
    return previousReport.windows?.[windowName] ?? null;
  }
  return mergeWindow(previousReport.windows?.[windowName], incomingReport.windows?.[windowName]);
}

function hasCompleteWindow(window) {
  return Boolean(
    window &&
    window.remaining_percent !== null &&
    window.remaining_percent !== undefined &&
    window.reset_at
  );
}

function reportSource(report) {
  return String(report?.source || "").trim().toLowerCase();
}

function liveQuotaWindowNames(report) {
  return reportSource(report) === "codex" ? ["1week"] : ["5h", "1week"];
}

function hasCompleteQuotaWindows(report) {
  return (
    report?.status === "ok" &&
    liveQuotaWindowNames(report).every((windowName) => hasCompleteWindow(report?.windows?.[windowName]))
  );
}

function hasAnyUnexpiredWindow(report, referenceReport) {
  const referenceMs = reportAtMs(referenceReport);
  if (referenceMs === null) {
    return false;
  }
  return liveQuotaWindowNames(report).some((windowName) => {
    const resetMs = resetAtMs(report?.windows?.[windowName]);
    return resetMs !== null && resetMs > referenceMs;
  });
}

function reportOrigin(report) {
  return normalizeReportOrigin(report || {});
}

function isHardInvalidation(report) {
  return (
    report.status === "error" &&
    refreshValidityFromReport(report) === "rejected"
  );
}

function isAccountIneligible(report) {
  return report?.plan_name === "Free";
}

function reportAuthRefreshMs(report) {
  const value = Date.parse(report?.auth_last_refresh || "");
  return Number.isFinite(value) ? value : null;
}

function isOlderAuthReport(incoming, previous) {
  const incomingRefresh = reportAuthRefreshMs(incoming);
  const previousRefresh = reportAuthRefreshMs(previous);
  return incomingRefresh !== null && previousRefresh !== null && incomingRefresh < previousRefresh;
}

function cloneWindow(window) {
  if (!window) {
    return null;
  }
  return {
    used_percent: window.used_percent,
    remaining_percent: window.remaining_percent,
    window_minutes: window.window_minutes,
    reset_in_seconds: window.reset_in_seconds,
    reset_at: window.reset_at,
    captured_at: window.captured_at || null,
  };
}

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function authExpiryFields(row, generatedAt) {
  const expiresAtMs = timestampMs(row.auth_expires_at);
  const generatedAtMs = timestampMs(generatedAt);
  if (expiresAtMs === null || generatedAtMs === null) {
    return {
      auth_expired: false,
      auth_expires_in_seconds: null,
      auth_expiry_metadata_stale: false,
    };
  }
  const seconds = Math.floor((expiresAtMs - generatedAtMs) / 1000);
  const reportedAtMs = timestampMs(row.reported_at);
  const metadataStale =
    seconds <= 0 &&
    row.status === "ok" &&
    reportedAtMs !== null &&
    reportedAtMs > expiresAtMs;
  return {
    auth_expired: seconds <= 0 && !metadataStale,
    auth_expires_in_seconds: metadataStale ? null : seconds,
    auth_expiry_metadata_stale: metadataStale,
  };
}

function deriveDisplayWindow(window, report, generatedAt) {
  if (!window) {
    return null;
  }

  const displayWindow = cloneWindow(window);
  const invalidatedStale = (isHardInvalidation(report) || isAccountIneligible(report)) && window !== null;
  const missingReset = window.remaining_percent !== null && window.remaining_percent !== undefined && !window.reset_at;
  const resetAtMs = timestampMs(window.reset_at);
  const generatedAtMs = timestampMs(generatedAt);
  const resetExpired = resetAtMs !== null && generatedAtMs !== null && resetAtMs <= generatedAtMs;
  const authExpired = authExpiryFields(report, generatedAt).auth_expired;
  let resetUnavailableReason = null;

  if (invalidatedStale) {
    resetUnavailableReason = "auth_invalidated";
  } else if (authExpired) {
    resetUnavailableReason = "auth_token_expired";
  } else if (missingReset) {
    resetUnavailableReason = "probe_missing_reset";
  } else if (resetExpired) {
    resetUnavailableReason = report.status === "error" ? "stale_error_probe" : "quota_window_expired";
  }

  return {
    ...displayWindow,
    invalidated_stale: invalidatedStale,
    inferred_ready: false,
    reset_unavailable_reason: resetUnavailableReason,
  };
}

function deriveDisplayWindows(report, generatedAt) {
  if (reportSource(report) === "codex") {
    return {
      "5h": null,
      "1week": deriveDisplayWindow(report.windows?.["1week"], report, generatedAt),
    };
  }
  return {
    "5h": deriveDisplayWindow(report.windows?.["5h"], report, generatedAt),
    "1week": deriveDisplayWindow(report.windows?.["1week"], report, generatedAt),
  };
}

function displayWindowsStale(report, displayWindows) {
  if (!report?.windows_stale) {
    return false;
  }
  if (reportSource(report) !== "codex") {
    return true;
  }
  const weekly = displayWindows?.["1week"];
  return !(report.status === "ok" && weekly && !weekly.reset_unavailable_reason);
}

export function mergeLatestReport(previous, incoming) {
  if (!previous) {
    return incoming;
  }

  if (isHardInvalidation(incoming) && hasCompleteQuotaWindows(previous) && isOlderAuthReport(incoming, previous)) {
    return previous;
  }

  if (isHardInvalidation(incoming) || isAccountIneligible(incoming)) {
    const mergedFiveHour = mergeWindow(previous.windows?.["5h"], incoming.windows?.["5h"]);
    const mergedOneWeek = mergeWindow(previous.windows?.["1week"], incoming.windows?.["1week"]);
    return {
      ...previous,
      ...incoming,
      windows_stale: mergedFiveHour !== null || mergedOneWeek !== null,
      windows: {
        "5h": mergedFiveHour,
        "1week": mergedOneWeek,
      },
    };
  }

  if (
    reportOrigin(previous) === "client" &&
    hasCompleteQuotaWindows(previous) &&
    reportOrigin(incoming) === "worker" &&
    !hasCompleteQuotaWindows(incoming) &&
    hasAnyUnexpiredWindow(previous, incoming)
  ) {
    return previous;
  }

  if (previous.windows_stale && reportOrigin(incoming) === "client" && hasCompleteQuotaWindows(incoming)) {
    return {
      ...previous,
      ...incoming,
      windows_stale: false,
    };
  }

  const mergedFiveHour = mergeTrustedWindow(previous, incoming, "5h");
  const mergedOneWeek = mergeTrustedWindow(previous, incoming, "1week");
  const preservedFiveHour = mergedFiveHour === previous.windows?.["5h"] && incoming.windows?.["5h"] !== previous.windows?.["5h"];
  const preservedOneWeek = mergedOneWeek === previous.windows?.["1week"] && incoming.windows?.["1week"] !== previous.windows?.["1week"];
  const preservedByWindow = { "5h": preservedFiveHour, "1week": preservedOneWeek };
  const mergedByWindow = { "5h": mergedFiveHour, "1week": mergedOneWeek };
  const windowsStale = liveQuotaWindowNames(incoming).some(
    (windowName) =>
      (incoming.windows?.[windowName] === null && mergedByWindow[windowName] !== null) ||
      preservedByWindow[windowName]
  );

  return {
    ...previous,
    ...incoming,
    windows_stale: windowsStale,
    windows: {
      "5h": mergedFiveHour,
      "1week": mergedOneWeek,
    },
  };
}

function deriveStatus(row) {
  const rateLimitProbe = row.usage_summary?.rate_limit_probe;
  if (row.source === "claude" && rateLimitProbe?.status_code === 429) {
    return "rate_limited";
  }
  return row.status;
}

function annotateFreshness(row, generatedAt) {
  const reportedAtMs = Date.parse(row.reported_at || "");
  const generatedAtMs = Date.parse(generatedAt);
  const ageSeconds = Number.isFinite(reportedAtMs)
    ? Math.max(Math.floor((generatedAtMs - reportedAtMs) / 1000), 0)
    : null;
  const isStale = ageSeconds !== null && ageSeconds > 3600;
  const displayWindows = deriveDisplayWindows(row, generatedAt);
  const quotaSnapshotState = deriveQuotaSnapshotState(row, displayWindows, isStale);
  const refreshStatus = row.first_invalidated_at ? "rejected" : refreshValidityFromReport(row);

  const annotated = {
    ...row,
    ...authExpiryFields(row, generatedAt),
    age_seconds: ageSeconds,
    stale_after_seconds: 3600,
    is_stale: isStale,
    effective_status: deriveStatus(row),
    display_windows: displayWindows,
    display_windows_stale: displayWindowsStale(row, displayWindows),
    token_state: deriveTokenState(row),
    quota_snapshot_state: quotaSnapshotState,
    refresh_validity: {
      status: refreshStatus,
      label: refreshValidityLabel(refreshStatus),
      checked_at: refreshStatus === "unverified" ? null : row.reported_at,
    },
  };

  return {
    ...annotated,
    availability: deriveAccountAvailability(annotated, generatedAt),
  };
}

function deriveTokenState(row) {
  if (!row.uploaded_at) {
    return {
      status: "missing",
      label: "token not uploaded",
      uploaded_at: null,
      uploader_email: row.uploader_email || null,
    };
  }
  return {
    status: "uploaded",
    label: "token uploaded",
    uploaded_at: row.uploaded_at,
    uploader_email: row.uploader_email || null,
  };
}

function refreshValidityLabel(status) {
  if (status === "confirmed") {
    return "refresh verified";
  }
  if (status === "rejected") {
    return "refresh rejected";
  }
  return "refresh not verified";
}

function deriveQuotaSnapshotState(row, displayWindows, isStale) {
  const liveNames = liveQuotaWindowNames(row);
  const availableCount = liveNames.filter((windowName) => {
    const window = displayWindows?.[windowName];
    return Boolean(window && !window.reset_unavailable_reason && window.remaining_percent !== null && window.remaining_percent !== undefined);
  }).length;

  if (availableCount === liveNames.length) {
    return {
      status: isStale ? "stale" : "fresh",
      label: isStale ? "quota snapshot stale" : "quota snapshot fresh",
      reported_at: row.reported_at || null,
    };
  }
  if (availableCount > 0) {
    return {
      status: "partial",
      label: "quota snapshot partial",
      reported_at: row.reported_at || null,
    };
  }
  return {
    status: "unavailable",
    label: "quota unavailable",
    reported_at: row.reported_at || null,
  };
}

export function statusPayload(rows, generatedAt = new Date().toISOString()) {
  const annotatedRows = rows.map((row) => annotateFreshness(row, generatedAt));
  return {
    generated_at: generatedAt,
    report_count: annotatedRows.length,
    source_count: new Set(annotatedRows.map((row) => row.source)).size,
    items: annotatedRows,
  };
}

function isRowIneligible(row) {
  return (
    row.plan_name === "Free" ||
    Boolean(row.first_invalidated_at) ||
    refreshValidityFromReport(row) === "rejected"
  );
}

function shouldHideAuthPoolRow(row, generatedAt) {
  if (!isRowIneligible(row)) {
    return false;
  }

  const reportedAtMs = Date.parse(row.reported_at || "");
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(reportedAtMs) || !Number.isFinite(generatedAtMs)) {
    return false;
  }

  return generatedAtMs - reportedAtMs > 48 * 60 * 60 * 1000;
}

function invalidatedStateKey(state) {
  return `${state.source}:${state.account_id}`;
}

function entryTimeMs(entry, field) {
  const value = Date.parse(entry?.[field] || "");
  return Number.isFinite(value) ? value : 0;
}

function compareAuthPoolEntryRecency(left, right) {
  const refreshDelta = entryTimeMs(left, "auth_last_refresh") - entryTimeMs(right, "auth_last_refresh");
  if (refreshDelta !== 0) {
    return refreshDelta;
  }
  const uploadedDelta = entryTimeMs(left, "uploaded_at") - entryTimeMs(right, "uploaded_at");
  if (uploadedDelta !== 0) {
    return uploadedDelta;
  }
  return String(left?.digest || "").localeCompare(String(right?.digest || ""));
}

function latestEntriesByAccount(entries) {
  const latestByAccount = new Map();
  for (const entry of entries) {
    const key = `${entry.source}:${entry.account_id}`;
    const previous = latestByAccount.get(key);
    if (!previous || compareAuthPoolEntryRecency(entry, previous) > 0) {
      latestByAccount.set(key, entry);
    }
  }
  return Array.from(latestByAccount.values());
}

function isArchivedInvalidatedRow(row, generatedAt) {
  if (!isRowIneligible(row)) {
    return false;
  }

  const firstInvalidatedMs = Date.parse(row.first_invalidated_at || "");
  const generatedAtMs = Date.parse(generatedAt);
  if (Number.isFinite(firstInvalidatedMs) && Number.isFinite(generatedAtMs)) {
    return generatedAtMs - firstInvalidatedMs > 48 * 60 * 60 * 1000;
  }
  return shouldHideAuthPoolRow(row, generatedAt);
}

export function authPoolStatusPayload(entries, reports, generatedAt = new Date().toISOString(), invalidatedStates = []) {
  const accountKeysWithSession = new Set(
    entries
      .filter((entry) => entry.session_id)
      .map((entry) => `${entry.source}:${entry.account_id}`)
  );
  const visibleEntries = latestEntriesByAccount(entries.filter((entry) => {
    if (entry.session_id) {
      return true;
    }
    return !accountKeysWithSession.has(`${entry.source}:${entry.account_id}`);
  }));
  const reportByKey = new Map(reports.map((report) => [`${report.source}:${report.account_id}`, report]));
  const invalidatedStateByKey = new Map(invalidatedStates.map((state) => [invalidatedStateKey(state), state]));
  const entryKeys = new Set(visibleEntries.map((entry) => `${entry.source}:${entry.account_id}`));
  const rows = visibleEntries.map((entry) => {
    const report = reportByKey.get(`${entry.source}:${entry.account_id}`) || null;
    const invalidatedState = invalidatedStateByKey.get(`${entry.source}:${entry.account_id}`) || null;
    return {
      source: entry.source,
      hostname: entry.hostname,
      reporter_name: entry.reporter_name,
      uploaded_at: entry.uploaded_at,
      uploader_email: entry.uploader_email,
      reported_at: report?.reported_at || entry.uploaded_at,
      account_id: entry.account_id,
      session_id: entry.session_id || '',
      email: entry.email,
      name: entry.name,
      plan_name: entry.plan_name,
      auth_path: null,
      auth_last_refresh: entry.auth_last_refresh,
      auth_expires_at: entry.auth_expires_at,
      digest: entry.digest,
      status: report?.status || "unknown",
      error: report?.error || null,
      report_origin: report?.report_origin || null,
      first_invalidated_at: invalidatedState?.first_invalidated_at || null,
      last_invalidated_notification_at: invalidatedState?.last_notified_at || null,
      model_context_window: report?.model_context_window || null,
      usage_summary: report?.usage_summary || null,
      windows_stale: Boolean(report?.windows_stale),
      windows: report?.windows || { "5h": null, "1week": null },
    };
  });
  const activeEntryRows = rows.filter((row) => !isArchivedInvalidatedRow(row, generatedAt));
  const archivedInvalidatedRows = rows.filter((row) => isArchivedInvalidatedRow(row, generatedAt));
  const activeRows = activeEntryRows;

  const payload = statusPayload(activeRows, generatedAt);
  const archivedPayload = statusPayload(archivedInvalidatedRows, generatedAt);
  return {
    ...payload,
    auth_pool_count: activeEntryRows.length,
    orphaned_count: 0,
    archived_invalidated_count: archivedInvalidatedRows.length,
    archived_invalidated_items: archivedPayload.items,
  };
}
