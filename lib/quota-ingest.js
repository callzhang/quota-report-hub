import { upsertAuthPoolQuota } from "./db.js";

function isHardInvalidation(payload) {
  return (
    payload?.status === "error" &&
    (
      payload?.error === "auth invalidated (token_invalidated)" ||
      payload?.error === "auth failed (401 unauthorized)"
    )
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

// Codex client quota is only trustworthy with both windows complete (or a hard invalidation):
// a half-finished probe must never overwrite a good report. Claude has no such gate here.
export function codexClientPayloadAccepted(payload) {
  if (!payload?.account_id) {
    return false;
  }
  if (isHardInvalidation(payload)) {
    return true;
  }
  return (
    payload?.status === "ok" &&
    hasCompleteWindow(payload?.windows?.["5h"]) &&
    hasCompleteWindow(payload?.windows?.["1week"])
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
