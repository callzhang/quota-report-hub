// Claude quota, read from the endpoint Claude Code itself reads.
//
// `claude -p /usage` was the previous source: the worker shelled out to the CLI and scraped
// "Current session: N% used" out of its text. That text is not a contract. On 2026-09-05 the CLI
// (2.1.260) printed a usage-behaviour breakdown with no window lines at all on one machine and
// intermittently on the runners -- 10 of 36 probes of a healthy account came back "no usage windows"
// and flipped its row to error. /api/oauth/usage returns the same two windows as JSON, with the
// access token alone, in one request; the guard has parsed exactly this body since it existed
// (parse_claude_oauth_usage_body). A 401 here is also the one answer that means the token is dead,
// so this replaces the separate /api/oauth/profile liveness check.
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function parseWindow(raw, windowMinutes) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const used = Number(raw.utilization);
  if (!Number.isFinite(used)) {
    return null;
  }
  const usedPercent = Math.round(Math.min(Math.max(used, 0), 100) * 10) / 10;
  const resetMs = Date.parse(raw.resets_at || "");
  return {
    used_percent: usedPercent,
    remaining_percent: Math.round(Math.max(0, 100 - usedPercent) * 10) / 10,
    window_minutes: windowMinutes,
    reset_at: Number.isFinite(resetMs) ? new Date(resetMs).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
  };
}

// The 200 body: {"five_hour": {"utilization": <percent>, "resets_at": <ISO>}, "seven_day": {...}}.
// `utilization` is already a percentage (2.0 == 2%).
export function parseClaudeUsageBody(body) {
  return {
    "5h": parseWindow(body?.five_hour, 300),
    "1week": parseWindow(body?.seven_day, 10080),
  };
}

export async function probeClaudeUsage(authJson, fetchImpl = fetch) {
  let accessToken;
  try {
    accessToken = JSON.parse(authJson)?.credentials?.claudeAiOauth?.accessToken;
  } catch {
    return { ok: false, rejected: false, status: null, reason: "unparseable", windows: null };
  }
  if (!accessToken) {
    return { ok: false, rejected: false, status: null, reason: "no_access_token", windows: null };
  }
  let response;
  try {
    response = await fetchImpl(CLAUDE_USAGE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
  } catch (error) {
    return { ok: false, rejected: false, status: null, reason: String(error?.message || error).slice(0, 120), windows: null };
  }
  // 401 is the only answer that means "this token is not usable"; a 429 or a 5xx is the endpoint
  // having a bad moment and must not be read as a dead account -- or as a quota reading.
  if (response.status === 401) {
    return { ok: false, rejected: true, status: 401, reason: "access_token_rejected", windows: null };
  }
  if (!response.ok) {
    return { ok: false, rejected: false, status: response.status, reason: `http_${response.status}`, windows: null };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, rejected: false, status: response.status, reason: "unparseable_body", windows: null };
  }
  const windows = parseClaudeUsageBody(body);
  if (windows["5h"] === null && windows["1week"] === null) {
    return { ok: false, rejected: false, status: response.status, reason: "no_usage_windows", windows: null };
  }
  return { ok: true, rejected: false, status: response.status, reason: null, windows };
}
