import { sendAuthInvalidatedEmail } from "./company-auth.js";
import {
  authPoolEntries,
  authPoolQuotaLatest,
  clearInvalidatedAuthState,
  markInvalidatedAuthNotified,
  upsertInvalidatedAuthState,
} from "./db.js";

const AUTH_INVALIDATED_ERROR = "auth invalidated (token_invalidated)";
const INVALIDATED_NOTIFY_AFTER_MS = 24 * 60 * 60 * 1000;
const INVALIDATED_NOTIFY_REPEAT_MS = 24 * 60 * 60 * 1000;

function reportKey(report) {
  return `${report.source}\0${report.account_id}`;
}

function entryKey(entry) {
  return `${entry.source}\0${entry.account_id}`;
}

function isAuthInvalidatedReport(report) {
  return report?.status === "error" && report?.error === AUTH_INVALIDATED_ERROR;
}

function ownerEmailForEntry(entry) {
  return entry?.uploader_email || entry?.email || null;
}

export async function maybeNotifyInvalidatedAuthOwner(
  entry,
  report,
  {
    now = new Date(),
    upsertInvalidatedAuthStateImpl = upsertInvalidatedAuthState,
    markInvalidatedAuthNotifiedImpl = markInvalidatedAuthNotified,
    clearInvalidatedAuthStateImpl = clearInvalidatedAuthState,
    sendAuthInvalidatedEmailImpl = sendAuthInvalidatedEmail,
  } = {}
) {
  if (!entry?.source || !entry?.account_id) {
    return { source: entry?.source || null, account_id: entry?.account_id || null, notified: false, reason: "missing_entry_identity" };
  }

  if (!isAuthInvalidatedReport(report)) {
    await clearInvalidatedAuthStateImpl({ source: entry.source, accountId: entry.account_id });
    return { source: entry.source, account_id: entry.account_id, notified: false, reason: "not_invalidated" };
  }

  const ownerEmail = ownerEmailForEntry(entry);
  if (!ownerEmail) {
    return { source: entry.source, account_id: entry.account_id, notified: false, reason: "missing_owner_email" };
  }

  const state = await upsertInvalidatedAuthStateImpl({
    source: entry.source,
    accountId: entry.account_id,
    invalidatedAt: report.reported_at || now.toISOString(),
    error: report.error,
  });
  const firstInvalidatedAt = state?.first_invalidated_at;
  const firstInvalidatedMs = Date.parse(firstInvalidatedAt || "");
  if (!Number.isFinite(firstInvalidatedMs) || now.getTime() - firstInvalidatedMs < INVALIDATED_NOTIFY_AFTER_MS) {
    return {
      source: entry.source,
      account_id: entry.account_id,
      notified: false,
      reason: "not_old_enough",
      owner_email: ownerEmail,
      first_invalidated_at: firstInvalidatedAt,
    };
  }

  const lastNotifiedMs = Date.parse(state?.last_notified_at || "");
  if (Number.isFinite(lastNotifiedMs) && now.getTime() - lastNotifiedMs < INVALIDATED_NOTIFY_REPEAT_MS) {
    return {
      source: entry.source,
      account_id: entry.account_id,
      notified: false,
      reason: "recently_notified",
      owner_email: ownerEmail,
      first_invalidated_at: firstInvalidatedAt,
      last_notified_at: state.last_notified_at,
    };
  }

  await sendAuthInvalidatedEmailImpl({
    email: ownerEmail,
    entry,
    invalidatedSince: firstInvalidatedAt,
  });
  const notifiedAt = now.toISOString();
  await markInvalidatedAuthNotifiedImpl({ source: entry.source, accountId: entry.account_id, notifiedAt });
  return {
    source: entry.source,
    account_id: entry.account_id,
    notified: true,
    owner_email: ownerEmail,
    first_invalidated_at: firstInvalidatedAt,
    notified_at: notifiedAt,
  };
}

export async function notifyInvalidatedAuthOwners({
  now = new Date(),
  authPoolEntriesImpl = authPoolEntries,
  authPoolQuotaLatestImpl = authPoolQuotaLatest,
  maybeNotifyInvalidatedAuthOwnerImpl = maybeNotifyInvalidatedAuthOwner,
} = {}) {
  const [entries, reports] = await Promise.all([authPoolEntriesImpl(), authPoolQuotaLatestImpl()]);
  const reportByKey = new Map(reports.map((report) => [reportKey(report), report]));
  const items = [];

  for (const entry of entries) {
    const report = reportByKey.get(entryKey(entry)) || null;
    items.push(await maybeNotifyInvalidatedAuthOwnerImpl(entry, report, { now }));
  }

  return {
    ok: true,
    generated_at: now.toISOString(),
    count: items.length,
    notified_count: items.filter((item) => item.notified).length,
    items,
  };
}
