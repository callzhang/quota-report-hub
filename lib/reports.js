function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeWindow(input, defaultMinutes) {
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
  };
}

export function sanitizeReport(input) {
  const now = new Date().toISOString();
  const fiveHour = sanitizeWindow(input.windows?.["5h"], 300);
  const oneWeek = sanitizeWindow(input.windows?.["1week"], 10080);
  return {
    source: String(input.source || "unknown"),
    hostname: String(input.hostname || "unknown-host"),
    reporter_name: String(input.reporter_name || "unknown"),
    reported_at: String(input.reported_at || now),
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

function isHardInvalidation(report) {
  return (
    report.source === "codex" &&
    report.status === "error" &&
    (
      report.error === "auth invalidated (token_invalidated)" ||
      report.error === "auth failed (401 unauthorized)"
    )
  );
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
  };
}

function deriveDisplayWindow(window, report, generatedAt) {
  if (!window) {
    return null;
  }

  const displayWindow = cloneWindow(window);
  const invalidatedStale = isHardInvalidation(report) && window !== null;
  const missingReset = window.remaining_percent !== null && window.remaining_percent !== undefined && !window.reset_at;
  const resetAtMs = Date.parse(window.reset_at || "");
  const generatedAtMs = Date.parse(generatedAt);
  const canInferReset =
    invalidatedStale &&
    Number.isFinite(resetAtMs) &&
    Number.isFinite(generatedAtMs) &&
    resetAtMs <= generatedAtMs;

  if (!canInferReset) {
    return {
      ...displayWindow,
      invalidated_stale: invalidatedStale,
      inferred_ready: false,
      reset_unavailable_reason: missingReset
        ? invalidatedStale
          ? "auth_invalidated"
          : "probe_missing_reset"
        : null,
    };
  }

  return {
    ...displayWindow,
    used_percent: 0,
    remaining_percent: 100,
    invalidated_stale: invalidatedStale,
    inferred_ready: true,
  };
}

function deriveDisplayWindows(report, generatedAt) {
  return {
    "5h": deriveDisplayWindow(report.windows?.["5h"], report, generatedAt),
    "1week": deriveDisplayWindow(report.windows?.["1week"], report, generatedAt),
  };
}

export function mergeLatestReport(previous, incoming) {
  if (!previous) {
    return incoming;
  }

  if (isHardInvalidation(incoming)) {
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

  const mergedFiveHour = mergeWindow(previous.windows?.["5h"], incoming.windows?.["5h"]);
  const mergedOneWeek = mergeWindow(previous.windows?.["1week"], incoming.windows?.["1week"]);
  const windowsStale =
    (incoming.windows?.["5h"] === null && previous.windows?.["5h"] !== null) ||
    (incoming.windows?.["1week"] === null && previous.windows?.["1week"] !== null);

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

  return {
    ...row,
    age_seconds: ageSeconds,
    stale_after_seconds: 3600,
    is_stale: isStale,
    effective_status: deriveStatus(row),
    display_windows: deriveDisplayWindows(row, generatedAt),
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

function shouldHideAuthPoolRow(row, generatedAt) {
  if (
    row.error !== "auth invalidated (token_invalidated)" &&
    row.error !== "auth failed (401 unauthorized)"
  ) {
    return false;
  }

  const reportedAtMs = Date.parse(row.reported_at || "");
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(reportedAtMs) || !Number.isFinite(generatedAtMs)) {
    return false;
  }

  return generatedAtMs - reportedAtMs > 48 * 60 * 60 * 1000;
}

export function authPoolStatusPayload(entries, reports, generatedAt = new Date().toISOString()) {
  const reportByKey = new Map(reports.map((report) => [`${report.source}:${report.account_id}`, report]));
  const rows = entries.map((entry) => {
    const report = reportByKey.get(`${entry.source}:${entry.account_id}`) || null;
    return {
      source: entry.source,
      hostname: entry.hostname,
      reporter_name: entry.reporter_name,
      uploaded_at: entry.uploaded_at,
      uploader_email: entry.uploader_email,
      reported_at: report?.reported_at || entry.uploaded_at,
      account_id: entry.account_id,
      email: entry.email,
      name: entry.name,
      plan_name: entry.plan_name,
      auth_path: null,
      auth_last_refresh: entry.auth_last_refresh,
      digest: entry.digest,
      status: report?.status || "unknown",
      error: report?.error || null,
      model_context_window: report?.model_context_window || null,
      usage_summary: report?.usage_summary || null,
      windows_stale: Boolean(report?.windows_stale),
      windows: report?.windows || { "5h": null, "1week": null },
    };
  }).filter((row) => !shouldHideAuthPoolRow(row, generatedAt));

  const payload = statusPayload(rows, generatedAt);
  return {
    ...payload,
    auth_pool_count: rows.length,
  };
}
