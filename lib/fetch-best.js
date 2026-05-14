export function invalidatedEntryToRepairAuth(invalidatedEntry) {
  if (!invalidatedEntry) {
    return null;
  }
  return {
    source: invalidatedEntry.source,
    account_id: invalidatedEntry.account_id,
    session_id: invalidatedEntry.session_id || "",
    email: invalidatedEntry.email,
    name: invalidatedEntry.name,
    plan_name: invalidatedEntry.plan_name,
    auth_last_refresh: invalidatedEntry.auth_last_refresh,
    digest: invalidatedEntry.digest,
    uploaded_at: invalidatedEntry.uploaded_at,
    reporter_name: invalidatedEntry.reporter_name,
    hostname: invalidatedEntry.hostname,
    latest_report: null,
    auth_json: invalidatedEntry.auth_json,
  };
}

export function repairAuthOnlyPayload(repairAuth) {
  return {
    ok: true,
    replacement: null,
    repair_auth: repairAuth,
    reason: "uploaded_auth_requires_reauth",
    message: "Your uploaded auth has been invalidated. Re-login this auth and upload fresh credentials.",
  };
}
