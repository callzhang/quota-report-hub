export function sanitizeReport(input) {
  const now = new Date().toISOString();
  const fiveHour = input.windows?.["5h"] || {};
  const oneWeek = input.windows?.["1week"] || {};
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
    windows: {
      "5h": {
        used_percent: Number(fiveHour.used_percent || 0),
        remaining_percent: Number(fiveHour.remaining_percent || 0),
        window_minutes: Number(fiveHour.window_minutes || 300),
        reset_in_seconds: Number(fiveHour.reset_in_seconds || 0),
        reset_at: fiveHour.reset_at ? String(fiveHour.reset_at) : null,
      },
      "1week": {
        used_percent: Number(oneWeek.used_percent || 0),
        remaining_percent: Number(oneWeek.remaining_percent || 0),
        window_minutes: Number(oneWeek.window_minutes || 10080),
        reset_in_seconds: Number(oneWeek.reset_in_seconds || 0),
        reset_at: oneWeek.reset_at ? String(oneWeek.reset_at) : null,
      },
    },
  };
}

export function statusPayload(rows) {
  return {
    generated_at: new Date().toISOString(),
    report_count: rows.length,
    source_count: new Set(rows.map((row) => row.source)).size,
    items: rows,
  };
}
