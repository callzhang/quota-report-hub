import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  authPoolEntries,
  authPoolQuotaLatestForEntry,
  deleteAuthPoolEntry,
  getFeatureFlag,
  upsertAuthPoolEntry,
  upsertAuthPoolQuota,
} from "../lib/db.js";
import { decryptAuthJson } from "../lib/auth-pool.js";
import { probeAuthJson } from "../lib/auth-pool-probe.js";
import { refreshClaudeToken, applyRefreshToBlob, accessTokenMsUntilExpiry } from "../lib/token-refresh.js";

// Refresh a claude access token this far from expiry. The worker runs every ~15 min, so a
// 30-minute window guarantees the served token always has comfortable life left. Unknown
// expiry (null) also triggers a refresh.
const CLAUDE_REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

function claudeRefreshToken(authJsonText) {
  try {
    return JSON.parse(authJsonText)?.credentials?.claudeAiOauth?.refreshToken || null;
  } catch {
    return null;
  }
}

// In at_only_mode the hub is the sole refresher for claude (borrowers hold a stripped RT), so
// proactively rotate any near-expiry claude AT and persist the rotated tokens to the pool.
// Returns the (possibly refreshed) auth_json plus a small result for the run report.
async function refreshClaudeEntryIfNeeded(
  authJsonText,
  entry,
  { refreshClaudeTokenImpl, upsertAuthPoolEntryImpl, nowImpl },
) {
  const msLeft = accessTokenMsUntilExpiry(authJsonText, "claude", nowImpl().getTime());
  if (msLeft !== null && msLeft > CLAUDE_REFRESH_THRESHOLD_MS) {
    return { authJsonText, result: { attempted: false } };
  }
  const refreshToken = claudeRefreshToken(authJsonText);
  if (!refreshToken) {
    return { authJsonText, result: { attempted: false, reason: "no_refresh_token" } };
  }
  const refreshed = await refreshClaudeTokenImpl(refreshToken);
  if (!refreshed.ok) {
    return { authJsonText, result: { attempted: true, ok: false, auth_rejected: refreshed.auth_rejected, status: refreshed.status } };
  }
  const refreshedAuthJson = applyRefreshToBlob(authJsonText, "claude", refreshed, nowImpl().getTime());
  await upsertAuthPoolEntryImpl({
    source: "claude",
    auth_json: refreshedAuthJson,
    uploader_email: entry.uploader_email || null,
    reporter_name: "actions@github-actions",
    hostname: "github-actions",
  });
  return { authJsonText: refreshedAuthJson, result: { attempted: true, ok: true } };
}

function probeCodexAuthJson(authJsonText) {
  const tempDir = mkdtempSync(join(tmpdir(), "quota-report-codex-"));
  const authBlobPath = join(tempDir, "auth.json");
  writeFileSync(authBlobPath, authJsonText, "utf8");
  try {
    const result = spawnSync(
      "python3",
      [join(process.cwd(), "scripts/probe_codex_auth_blob.py"), "--auth-blob-path", authBlobPath],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      }
    );
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || "codex cloud probe failed").trim());
    }
    return JSON.parse(result.stdout);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function probeClaudeAuthJson(authJsonText) {
  const tempDir = mkdtempSync(join(tmpdir(), "quota-report-claude-"));
  const authBlobPath = join(tempDir, "auth.json");
  writeFileSync(authBlobPath, authJsonText, "utf8");
  try {
    const result = spawnSync(
      "python3",
      [join(process.cwd(), "scripts/probe_claude_auth_blob.py"), "--auth-blob-path", authBlobPath],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      }
    );
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || "claude cloud probe failed").trim());
    }
    return JSON.parse(result.stdout);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function failureReport(entry, error) {
  return {
    source: entry.source,
    report_origin: "worker",
    hostname: "github-actions",
    reporter_name: "actions@github-actions",
    reported_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    account_id: entry.account_id,
    email: entry.email || null,
    name: entry.name || null,
    plan_name: entry.plan_name || null,
    auth_path: null,
    auth_last_refresh: entry.auth_last_refresh || null,
    status: "error",
    error: String(error?.message || error || "cloud probe failed").slice(0, 1200),
    model_context_window: null,
    windows: { "5h": null, "1week": null },
    usage_summary: {
      probe_source: "github_actions_worker",
    },
  };
}

function withoutSensitiveRefreshCapture(report) {
  if (!report?.refresh_capture) {
    return report;
  }
  const refreshCapture = { ...report.refresh_capture };
  delete refreshCapture.refreshed_auth_json;
  return {
    ...report,
    refresh_capture: refreshCapture,
  };
}

function isFreePlan(value) {
  return String(value || "").trim().toLowerCase() === "free";
}

function isAuthFailed401(report) {
  return report?.error === "auth failed (401 unauthorized)";
}

function isAccountIdMigrated(entry, report) {
  // Detect when a probe returns a different account_id than the pool entry,
  // which happens when canonicalCodexAccountId switched UUID→email format.
  return (
    entry.source === "codex" &&
    report?.account_id &&
    report.account_id !== entry.account_id &&
    report.account_id === entry.email
  );
}

function shouldDeleteUnusableAuthPoolEntry(entry, report, previousReport = null) {
  if (entry.source !== "codex") {
    return false;
  }
  if (isFreePlan(entry.plan_name) || isFreePlan(report?.plan_name) || isFreePlan(report?.refresh_capture?.refreshed_metadata?.plan_name)) {
    return true;
  }
  if (isAuthFailed401(report) && isAuthFailed401(previousReport)) {
    return true;
  }
  if (report?.error === "token_count event was present but missing quota details") {
    return true;
  }
  // Old UUID-based entry where probe returns email-based account_id — the
  // email-based entry (or its upsert) covers this auth now.
  if (isAccountIdMigrated(entry, report)) {
    return true;
  }
  return false;
}

function deleteReason(entry, report, previousReport = null) {
  if (isFreePlan(entry.plan_name) || isFreePlan(report?.plan_name) || isFreePlan(report?.refresh_capture?.refreshed_metadata?.plan_name)) {
    return "free_plan";
  }
  if (isAuthFailed401(report) && isAuthFailed401(previousReport)) {
    return "continuous_401";
  }
  if (report?.error === "token_count event was present but missing quota details") {
    return "missing_quota_details";
  }
  if (isAccountIdMigrated(entry, report)) {
    return "account_id_migrated";
  }
  return "unknown";
}

function parseDateMillis(value) {
  const millis = Date.parse(String(value || ""));
  return Number.isFinite(millis) ? millis : null;
}

function shouldSkipFreshClientQuotaReport(entry, previousReport, now = new Date()) {
  if (previousReport?.report_origin !== "client") {
    return false;
  }
  const reportedAt = parseDateMillis(previousReport.reported_at);
  if (reportedAt === null) {
    return false;
  }
  const ageMillis = now.getTime() - reportedAt;
  if (ageMillis < 0 || ageMillis >= 60 * 60 * 1000) {
    return false;
  }
  if (entry.auth_last_refresh && previousReport.auth_last_refresh !== entry.auth_last_refresh) {
    return false;
  }
  return true;
}

export async function processAuthPoolEntry(
  entry,
  {
    decryptAuthJsonImpl = decryptAuthJson,
    probeAuthJsonImpl = probeAuthJson,
    probeCodexAuthJsonImpl = probeCodexAuthJson,
    probeClaudeAuthJsonImpl = probeClaudeAuthJson,
    upsertAuthPoolQuotaImpl = upsertAuthPoolQuota,
    upsertAuthPoolEntryImpl = upsertAuthPoolEntry,
    deleteAuthPoolEntryImpl = deleteAuthPoolEntry,
    authPoolQuotaLatestForEntryImpl = authPoolQuotaLatestForEntry,
    refreshClaudeTokenImpl = refreshClaudeToken,
    atOnlyMode = false,
    nowImpl = () => new Date(),
  } = {}
) {
  const previousReport = await authPoolQuotaLatestForEntryImpl({ source: entry.source, accountId: entry.account_id });
  if (shouldSkipFreshClientQuotaReport(entry, previousReport, nowImpl())) {
    return {
      source: entry.source,
      account_id: entry.account_id,
      status: previousReport.status,
      error: previousReport.error,
      skipped_cloud_probe: true,
      skip_reason: "fresh_client_quota_report",
      latest_reported_at: previousReport.reported_at,
      refreshed_auth_written: false,
      refreshed_auth_result: null,
    };
  }

  let report;
  let claudeRefreshResult = null;
  try {
    let authJsonText = await decryptAuthJsonImpl(entry);
    if (atOnlyMode && entry.source === "claude") {
      const refreshed = await refreshClaudeEntryIfNeeded(authJsonText, entry, {
        refreshClaudeTokenImpl,
        upsertAuthPoolEntryImpl,
        nowImpl,
      });
      authJsonText = refreshed.authJsonText;
      claudeRefreshResult = refreshed.result;
    }
    report =
      entry.source === "codex"
        ? probeCodexAuthJsonImpl(authJsonText)
        : entry.source === "claude"
          ? probeClaudeAuthJsonImpl(authJsonText)
          : await probeAuthJsonImpl(entry.source, authJsonText);
    report = {
      ...report,
      report_origin: "worker",
    };
  } catch (error) {
    report = failureReport(entry, error);
  }
  if (shouldDeleteUnusableAuthPoolEntry(entry, report, previousReport)) {
    await upsertAuthPoolQuotaImpl(withoutSensitiveRefreshCapture(report));
    const deleteResult = await deleteAuthPoolEntryImpl({ source: entry.source, accountId: entry.account_id });
    return {
      source: entry.source,
      account_id: entry.account_id,
      status: report.status,
      error: report.error,
      deleted_from_auth_pool: Boolean(deleteResult?.deleted),
      delete_reason: deleteReason(entry, report, previousReport),
      refreshed_auth_written: false,
      refreshed_auth_result: null,
      claude_refresh: claudeRefreshResult,
    };
  }
  let refreshedAuthResult = null;
  const refreshCapture = report?.refresh_capture;
  if (entry.source === "codex" && refreshCapture?.delta?.refreshed && refreshCapture?.refreshed_auth_json) {
    refreshedAuthResult = await upsertAuthPoolEntryImpl({
      source: "codex",
      auth_json: refreshCapture.refreshed_auth_json,
      uploader_email: entry.uploader_email || null,
      reporter_name: "actions@github-actions",
      hostname: "github-actions",
    });
  }
  await upsertAuthPoolQuotaImpl(withoutSensitiveRefreshCapture(report));

  return {
    source: entry.source,
    account_id: entry.account_id,
    status: report.status,
    error: report.error,
    refreshed_auth_written: Boolean(refreshedAuthResult && !refreshedAuthResult.deduplicated),
    refreshed_auth_result: refreshedAuthResult,
    claude_refresh: claudeRefreshResult,
  };
}

export async function main() {
  const entries = await authPoolEntries();
  const atOnlyMode = await getFeatureFlag("at_only_mode", false);
  const items = [];

  for (const entry of entries) {
    items.push(await processAuthPoolEntry(entry, { atOnlyMode }));
  }

  console.log(JSON.stringify({ ok: true, count: items.length, atOnlyMode, items }, null, 2));
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
