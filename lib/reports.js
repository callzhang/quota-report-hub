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
    windows: {
      "5h": fiveHour,
      "1week": oneWeek,
    },
  };
}

function mergeWindow(previousWindow, incomingWindow) {
  return incomingWindow ?? previousWindow ?? null;
}

export function mergeLatestReport(previous, incoming) {
  if (!previous) {
    return incoming;
  }

  return {
    ...previous,
    ...incoming,
    windows: {
      "5h": mergeWindow(previous.windows?.["5h"], incoming.windows?.["5h"]),
      "1week": mergeWindow(previous.windows?.["1week"], incoming.windows?.["1week"]),
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
