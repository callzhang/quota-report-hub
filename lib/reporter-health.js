// Reporter probe heartbeats: the hub's answer to "is this machine's guard alive, and is its
// quota probe actually working?"
//
// Why this exists: a quota report only reaches the hub when the probe produced a usable payload
// (see lib/quota-ingest.js). Every other outcome -- a network failure reaching auth.openai.com, a
// rate-limited probe whose exhaustion could not be confirmed -- produces an error payload that is
// never reported. From the hub's side that is indistinguishable from a machine that is powered off,
// so a guard that runs every 15 minutes and fails every time looks exactly like one that never runs.
// The heartbeat is sent on EVERY guard run regardless of probe outcome, so the two cases separate.

// The guard runs every 900s. Four consecutive missed runs is well past a transient hiccup, and
// still tight enough that a machine that dropped off this morning is visibly silent by lunchtime.
export const HEARTBEAT_SILENT_SECONDS = 3600;

// One failed probe is a blip (a flaky DNS lookup, a laptop waking up mid-run). Two in a row is a
// condition worth showing someone.
export const PROBE_FAILING_THRESHOLD = 2;

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }
  const text = String(value);
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function ageSeconds(lastRunAt, generatedAt) {
  const runMs = Date.parse(String(lastRunAt || ""));
  const nowMs = Date.parse(String(generatedAt || ""));
  if (Number.isNaN(runMs) || Number.isNaN(nowMs)) {
    return null;
  }
  return Math.max(0, Math.round((nowMs - runMs) / 1000));
}

function describeError(error) {
  const text = String(error || "").trim();
  if (!text) {
    return "probe failed";
  }
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}

// Order matters: silence wins over a stale failure. A machine whose last heartbeat is hours old is
// silent NOW, whatever its last probe happened to say.
export function deriveReporterHealth(heartbeat, generatedAt = new Date().toISOString()) {
  const lastRunAt = toIsoOrNull(heartbeat?.last_run_at);
  const age = ageSeconds(lastRunAt, generatedAt);
  const consecutiveFailures = Number(heartbeat?.consecutive_failures || 0);
  const status = String(heartbeat?.status || "").trim().toLowerCase();

  const base = {
    source: heartbeat?.source || null,
    reporter_key: heartbeat?.reporter_key || null,
    reporter_name: heartbeat?.reporter_name || null,
    hostname: heartbeat?.hostname || null,
    hub_user_email: heartbeat?.hub_user_email || null,
    account_id: heartbeat?.account_id || null,
    client_version: heartbeat?.client_version || null,
    last_run_at: lastRunAt,
    last_ok_at: toIsoOrNull(heartbeat?.last_ok_at),
    status: status || null,
    error: heartbeat?.error || null,
    consecutive_failures: consecutiveFailures,
    age_seconds: age,
    silent_after_seconds: HEARTBEAT_SILENT_SECONDS,
  };

  if (age === null) {
    return { ...base, state: "unknown", tone: "warning", summary: "No heartbeat recorded yet." };
  }
  if (age > HEARTBEAT_SILENT_SECONDS) {
    const minutes = Math.round(age / 60);
    return {
      ...base,
      state: "silent",
      tone: "danger",
      summary: `No guard run reported for ${minutes} minutes — the machine is off, asleep, or the scheduled job stopped.`,
    };
  }
  if (status === "error" && consecutiveFailures >= PROBE_FAILING_THRESHOLD) {
    return {
      ...base,
      state: "probe_failing",
      tone: "danger",
      summary: `Guard is running but the quota probe has failed ${consecutiveFailures} runs in a row: ${describeError(base.error)}`,
    };
  }
  if (status === "error") {
    return {
      ...base,
      state: "probe_error",
      tone: "warning",
      summary: `Last quota probe failed: ${describeError(base.error)}`,
    };
  }
  return { ...base, state: "ok", tone: "success", summary: "Guard is running and the quota probe succeeded." };
}

// Sorted worst-first so the dashboard can render the top of the list and stop.
const STATE_ORDER = { silent: 0, probe_failing: 1, probe_error: 2, unknown: 3, ok: 4 };

export function reporterHealthPayload(heartbeats, generatedAt = new Date().toISOString()) {
  const items = (heartbeats || [])
    .map((heartbeat) => deriveReporterHealth(heartbeat, generatedAt))
    .sort((left, right) => {
      const byState = (STATE_ORDER[left.state] ?? 9) - (STATE_ORDER[right.state] ?? 9);
      if (byState !== 0) {
        return byState;
      }
      return String(left.reporter_key || "").localeCompare(String(right.reporter_key || ""));
    });
  return {
    generated_at: generatedAt,
    items,
    silent_count: items.filter((item) => item.state === "silent").length,
    probe_failing_count: items.filter((item) => item.state === "probe_failing").length,
    probe_error_count: items.filter((item) => item.state === "probe_error").length,
  };
}
