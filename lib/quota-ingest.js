import { upsertAuthPoolQuota, upsertReporterProbeHeartbeat } from "./db.js";
import { isAuthInvalidationError } from "./auth-status.js";
import { normalizeExhaustedUntil } from "./reports.js";

function isHardInvalidation(payload) {
  return (
    payload?.status === "error" &&
    isAuthInvalidationError(payload?.error)
  );
}

function hasCompleteWindow(window) {
  return Boolean(
    window &&
    window.remaining_percent !== null &&
    window.remaining_percent !== undefined &&
    window.reset_at
  );
}

// A client Codex report is trustworthy when the weekly window is complete, when it is a hard
// invalidation, or when it reports exhausted_until (a limit-hit measured "unusable until T").
// Claude has no such gate here.
export function codexClientPayloadAccepted(payload) {
  if (!payload?.account_id) {
    return false;
  }
  if (isHardInvalidation(payload)) {
    return true;
  }
  return (
    payload?.status === "ok" &&
    (hasCompleteWindow(payload?.windows?.["1week"]) ||
      // A limit-hit probe measures "unusable until T" instead of windows; that is a complete,
      // trustworthy quota fact in its own right (§6.6). Shares normalizeExhaustedUntil with
      // sanitizeReport so the gate and the sanitizer can never disagree about what counts as a
      // valid timestamp. The complete-weekly branch above must stay too: old clients keep
      // sending fabricated zero-window pairs for at least one self-update cycle after this
      // ships, so both shapes are accepted during that mixed-fleet phasing (§17.3).
      normalizeExhaustedUntil(payload?.exhausted_until) !== null)
  );
}

// Normalize a client-reported quota payload into a stored report and persist it. Shared by the
// /api/auth/quota endpoint and the quota-bundled-with-upload path (/api/auth/upload) so both apply
// identical acceptance rules. Never throws on a merely-unacceptable payload — it returns a small
// result object instead, leaving HTTP-status decisions to the caller.
export async function ingestClientQuota({ source, quotaPayload, reporterEmail, upsertImpl = upsertAuthPoolQuota }) {
  if (!quotaPayload || typeof quotaPayload !== "object") {
    return { ok: false, reason: "missing_quota_payload" };
  }
  const payload = {
    ...quotaPayload,
    source,
    report_origin: "client",
    reporter_name: quotaPayload.reporter_name || reporterEmail,
    hostname: quotaPayload.hostname || "client-report",
  };
  if (!payload.account_id) {
    return { ok: false, reason: "missing_account_id" };
  }
  if (source === "codex" && !codexClientPayloadAccepted(payload)) {
    return { ok: true, ignored: true, reason: "quota_unavailable", account_id: payload.account_id };
  }
  await upsertImpl(payload);
  return { ok: true, account_id: payload.account_id };
}

const HEARTBEAT_ERROR_MAX_LENGTH = 500;

// A heartbeat is deliberately much cheaper to accept than a quota report: it carries no quota
// numbers, so there is nothing to validate against and nothing it can corrupt. The only thing that
// matters is that it is attributable to a machine, which is why a reporter identity is the sole
// hard requirement.
export function normalizeReporterHeartbeat({ source, heartbeat, reporterEmail }) {
  if (!heartbeat || typeof heartbeat !== "object") {
    return { ok: false, reason: "missing_heartbeat" };
  }
  const reporterName = String(heartbeat.reporter_name || "").trim();
  const hostname = String(heartbeat.hostname || "").trim();
  if (!reporterName && !hostname) {
    return { ok: false, reason: "missing_reporter_identity" };
  }
  const status = heartbeat.status === "error" ? "error" : "ok";
  const error = status === "error"
    ? String(heartbeat.error || "probe failed").trim().slice(0, HEARTBEAT_ERROR_MAX_LENGTH)
    : null;
  return {
    ok: true,
    heartbeat: {
      source: String(source),
      reporter_name: reporterName || hostname,
      hostname: hostname || null,
      hub_user_email: reporterEmail || null,
      last_run_at: heartbeat.last_run_at || new Date().toISOString(),
      status,
      error,
      account_id: heartbeat.account_id ? String(heartbeat.account_id) : null,
      client_version: heartbeat.client_version ? String(heartbeat.client_version) : null,
    },
  };
}

export async function ingestReporterHeartbeat({
  source,
  heartbeat,
  reporterEmail,
  upsertImpl = upsertReporterProbeHeartbeat,
}) {
  const normalized = normalizeReporterHeartbeat({ source, heartbeat, reporterEmail });
  if (!normalized.ok) {
    return normalized;
  }
  await upsertImpl(normalized.heartbeat);
  return { ok: true, reporter_name: normalized.heartbeat.reporter_name, status: normalized.heartbeat.status };
}
