import { decryptAuthJson, deriveAuthPoolEntry, humanPlanName } from "./auth-pool.js";
import { sanitizeReport } from "./reports.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage?client_version=0.121.0";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const SERVER_PROBE_HOSTNAME = "quota-report-hub";
const SERVER_PROBE_REPORTER = "hub@quota-report-hub";

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return null;
  }
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function emptyWindows() {
  return { "5h": null, "1week": null };
}

function buildWindow({ usedPercent, windowSeconds, resetAfterSeconds, resetAt }) {
  const used = Number(usedPercent);
  const seconds = Number(windowSeconds);
  if (!Number.isFinite(used) || !Number.isFinite(seconds) || !Number.isFinite(Number(resetAt))) {
    return null;
  }
  return {
    used_percent: used,
    remaining_percent: Math.max(0, Math.round((100 - used) * 10) / 10),
    window_minutes: Math.round(seconds / 60),
    reset_in_seconds: Number.isFinite(Number(resetAfterSeconds)) ? Number(resetAfterSeconds) : null,
    reset_at: unixSecondsToIso(resetAt),
  };
}

function buildClaudeWindow(utilization, resetAt, windowMinutes) {
  const used = Math.round(Number(utilization) * 1000) / 10;
  if (!Number.isFinite(used)) {
    return null;
  }
  return {
    used_percent: used,
    remaining_percent: Math.max(0, Math.round((100 - used) * 10) / 10),
    window_minutes: windowMinutes,
    reset_in_seconds: Math.max(Math.floor(Number(resetAt) - Date.now() / 1000), 0),
    reset_at: unixSecondsToIso(resetAt),
  };
}

function baseReport(source, authJsonText) {
  const derived = deriveAuthPoolEntry(source, authJsonText, {
    hostname: SERVER_PROBE_HOSTNAME,
    reporter_name: SERVER_PROBE_REPORTER,
  });
  return {
    source: derived.source,
    hostname: SERVER_PROBE_HOSTNAME,
    reporter_name: SERVER_PROBE_REPORTER,
    reported_at: isoNow(),
    account_id: derived.account_id,
    email: derived.email,
    name: derived.name,
    plan_name: derived.plan_name,
    auth_last_refresh: derived.auth_last_refresh,
  };
}

function codexErrorMessage(status, text) {
  const lowered = String(text || "").toLowerCase();
  if (status === 401 && lowered.includes("token_invalidated")) {
    return "auth invalidated (token_invalidated)";
  }
  if (status === 401) {
    return "auth failed (401 unauthorized)";
  }
  return `codex usage probe failed (${status})`;
}

function parseJsonSafe(text) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function probeCodexAuthJson(authJsonText) {
  const auth = JSON.parse(authJsonText);
  const token = auth?.tokens?.access_token || auth?.tokens?.id_token;
  const report = baseReport("codex", authJsonText);

  if (!token) {
    return sanitizeReport({
      ...report,
      status: "error",
      error: "auth json is missing tokens.access_token and tokens.id_token",
      windows: emptyWindows(),
    });
  }

  const response = await fetch(CODEX_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "quota-report-hub/server-probe",
    },
  });
  const text = await response.text();
  const payload = parseJsonSafe(text);

  if (!response.ok) {
    return sanitizeReport({
      ...report,
      status: "error",
      error: codexErrorMessage(response.status, text),
      windows: emptyWindows(),
    });
  }

  if (!payload || typeof payload !== "object") {
    return sanitizeReport({
      ...report,
      status: "error",
      error: "codex usage probe returned non-json response",
      windows: emptyWindows(),
    });
  }

  const primary = payload?.rate_limit?.primary_window;
  const secondary = payload?.rate_limit?.secondary_window;
  if (!primary || !secondary) {
    return sanitizeReport({
      ...report,
      status: "error",
      error: "codex usage response was missing rate limit windows",
      windows: emptyWindows(),
    });
  }
  const fiveHourWindow = buildWindow({
    usedPercent: primary.used_percent,
    windowSeconds: primary.limit_window_seconds,
    resetAfterSeconds: primary.reset_after_seconds,
    resetAt: primary.reset_at,
  });
  const weeklyWindow = buildWindow({
    usedPercent: secondary.used_percent,
    windowSeconds: secondary.limit_window_seconds,
    resetAfterSeconds: secondary.reset_after_seconds,
    resetAt: secondary.reset_at,
  });
  if (!fiveHourWindow || !weeklyWindow) {
    return sanitizeReport({
      ...report,
      status: "error",
      error: "codex usage response was missing reset times",
      windows: emptyWindows(),
    });
  }

  return sanitizeReport({
    ...report,
    plan_name: humanPlanName(payload?.plan_type) || report.plan_name,
    status: "ok",
    windows: {
      "5h": fiveHourWindow,
      "1week": weeklyWindow,
    },
    usage_summary: {
      credits: payload?.credits || null,
      spend_control: payload?.spend_control || null,
      rate_limit_reached_type: payload?.rate_limit_reached_type || null,
    },
  });
}

function parseClaudeHeaders(headers) {
  const fiveHourUtilization = headers.get("anthropic-ratelimit-unified-5h-utilization");
  const fiveHourReset = headers.get("anthropic-ratelimit-unified-5h-reset");
  const sevenDayUtilization = headers.get("anthropic-ratelimit-unified-7d-utilization");
  const sevenDayReset = headers.get("anthropic-ratelimit-unified-7d-reset");
  return {
    "5h":
      fiveHourUtilization && fiveHourReset
        ? buildClaudeWindow(fiveHourUtilization, fiveHourReset, 300)
        : null,
    "1week":
      sevenDayUtilization && sevenDayReset
        ? buildClaudeWindow(sevenDayUtilization, sevenDayReset, 10080)
        : null,
  };
}

async function probeClaudeAuthJson(authJsonText) {
  const payload = JSON.parse(authJsonText);
  const token = payload?.credentials?.claudeAiOauth?.accessToken;
  const report = baseReport("claude", authJsonText);

  if (!token) {
    return sanitizeReport({
      ...report,
      status: "error",
      error: "missing Claude OAuth access token",
      windows: emptyWindows(),
    });
  }

  const response = await fetch(CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "quota-report-hub/server-probe",
    },
  });
  const text = await response.text();
  const body = parseJsonSafe(text) || {};
  const windows = parseClaudeHeaders(response.headers);
  const hasWindows = Boolean(windows["5h"] || windows["1week"]);

  return sanitizeReport({
    ...report,
    status: hasWindows ? "ok" : "error",
    error: hasWindows ? null : ((body.error || {}).message || `claude usage probe failed (${response.status})`),
    windows,
    usage_summary: {
      subscription_type: payload?.credentials?.claudeAiOauth?.subscriptionType || null,
      rate_limit_tier: payload?.credentials?.claudeAiOauth?.rateLimitTier || null,
      oauth_expires_at: payload?.credentials?.claudeAiOauth?.expiresAt || null,
    },
  });
}

export async function probeAuthJson(source, authJsonText) {
  if (source === "codex") {
    return probeCodexAuthJson(authJsonText);
  }
  if (source === "claude") {
    return probeClaudeAuthJson(authJsonText);
  }
  throw new Error(`unsupported auth probe source: ${source}`);
}

export async function probeStoredAuthPoolEntry(entry) {
  return probeAuthJson(entry.source, decryptAuthJson(entry));
}
