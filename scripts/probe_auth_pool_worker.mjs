import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  authPoolEntries,
  authPoolQuotaLatestForEntry,
  deleteAuthPoolEntry,
  deleteAuthPoolEntryRow,
  getFeatureFlag,
  recordPoolHealthSnapshot,
  upsertAuthPoolEntry,
  upsertAuthPoolQuota,
} from "../lib/db.js";
import { decryptAuthJson } from "../lib/auth-pool.js";
import { probeAuthJson } from "../lib/auth-pool-probe.js";
import { refreshClaudeToken, refreshCodexToken, applyRefreshToBlob, accessTokenMsUntilExpiry } from "../lib/token-refresh.js";

// Proactively refresh an access token (claude OR codex) once it is within this window of expiry.
// The cron nominally fires every ~15 min, but GitHub Actions can delay it; a 1-hour window keeps the
// served token comfortably alive across normal jitter. Unknown expiry (null) also triggers a refresh.
// One threshold for both sources keeps the refresh path uniform — no per-source special casing.
const REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

// Skip the cloud probe for an entry whose owner re-uploaded fresh auth within this window. A recent
// upload means the credential is alive and the client just reported its quota, so re-probing only
// ages the token for no new information. Entries quiet for longer than this — or with no prior
// report to fall back on — are still probed. The cron cycle re-evaluates this per entry every run.
const PROBE_STALE_MS = 60 * 60 * 1000;

function refreshTokenFromBlob(authJsonText, source) {
  try {
    const parsed = JSON.parse(authJsonText);
    if (source === "claude") return parsed?.credentials?.claudeAiOauth?.refreshToken || null;
    if (source === "codex") return parsed?.tokens?.refresh_token || null;
  } catch {
    return null;
  }
  return null;
}

// When disabled_refresh_token is on, the hub is the sole refresher (borrowers hold a stripped RT), so
// proactively rotate any near-expiry access token — claude or codex alike — and persist the rotated
// tokens to the pool. Selective: only entries whose AT is within REFRESH_THRESHOLD_MS of expiry are
// refreshed; everything else returns { attempted: false } untouched (no RT replay, no needless rotation).
// Returns the (possibly refreshed) auth_json plus a small result for the run report.
async function refreshEntryIfNeeded(
  authJsonText,
  entry,
  source,
  { refreshTokenImpl, upsertAuthPoolEntryImpl, nowImpl },
) {
  const now = nowImpl().getTime();
  const msLeft = accessTokenMsUntilExpiry(authJsonText, source, now);
  if (msLeft !== null && msLeft > REFRESH_THRESHOLD_MS) {
    return { authJsonText, result: { attempted: false } };
  }
  const refreshToken = refreshTokenFromBlob(authJsonText, source);
  if (!refreshToken) {
    return { authJsonText, result: { attempted: false, reason: "no_refresh_token" } };
  }
  const refreshed = await refreshTokenImpl(refreshToken);
  if (!refreshed.ok) {
    return { authJsonText, result: { attempted: true, ok: false, auth_rejected: refreshed.auth_rejected, status: refreshed.status } };
  }
  const refreshedAuthJson = applyRefreshToBlob(authJsonText, source, refreshed, now);
  await upsertAuthPoolEntryImpl({
    source,
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

function entryRecentlyUpdated(entry, now = new Date()) {
  const uploadedAt = parseDateMillis(entry.uploaded_at);
  if (uploadedAt === null) {
    return false;
  }
  const ageMillis = now.getTime() - uploadedAt;
  return ageMillis >= 0 && ageMillis < PROBE_STALE_MS;
}

// Why this entry's probe can be skipped this cycle, or null if it must be probed. The cron cycle
// re-runs this per entry: we skip when the client already reported fresh quota, or when the owner
// re-uploaded fresh auth within PROBE_STALE_MS. A brand-new entry (no prior report) is always probed
// so it gets a baseline quota reading. The recently-updated skip applies ONLY when the prior report
// was healthy (status ok): a previously-errored account that was just re-uploaded is a recovery, and
// must be re-probed promptly to clear the stale error and publish fresh quota — the client often
// cannot report quota right after a re-login (empty statusline snapshot / usage backoff).
function probeSkipReason(entry, previousReport, now = new Date()) {
  if (shouldSkipFreshClientQuotaReport(entry, previousReport, now)) {
    return "fresh_client_quota_report";
  }
  if (previousReport && previousReport.status === "ok" && entryRecentlyUpdated(entry, now)) {
    return "recently_updated";
  }
  return null;
}

function skippedProbeItem(entry, previousReport, skipReason, centralRefreshResult) {
  return {
    source: entry.source,
    account_id: entry.account_id,
    status: previousReport?.status ?? null,
    error: previousReport?.error ?? null,
    skipped_cloud_probe: true,
    skip_reason: skipReason,
    latest_reported_at: previousReport?.reported_at ?? null,
    refreshed_auth_written: false,
    refreshed_auth_result: null,
    central_refresh: centralRefreshResult,
  };
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
    refreshCodexTokenImpl = refreshCodexToken,
    atOnlyMode = false,
    nowImpl = () => new Date(),
  } = {}
) {
  const now = nowImpl();
  const previousReport = await authPoolQuotaLatestForEntryImpl({ source: entry.source, accountId: entry.account_id });
  const skipReason = probeSkipReason(entry, previousReport, now);
  const probeNeeded = skipReason === null;

  // Nothing to do this cycle: not probing and not in central-refresh mode. Skip before decrypt.
  if (!probeNeeded && !atOnlyMode) {
    return skippedProbeItem(entry, previousReport, skipReason, null);
  }

  let report = null;
  let centralRefreshResult = null;
  try {
    let authJsonText = await decryptAuthJsonImpl(entry);
    if (atOnlyMode && (entry.source === "claude" || entry.source === "codex")) {
      const refreshTokenImpl = entry.source === "claude" ? refreshClaudeTokenImpl : refreshCodexTokenImpl;
      const refreshed = await refreshEntryIfNeeded(authJsonText, entry, entry.source, {
        refreshTokenImpl,
        upsertAuthPoolEntryImpl,
        nowImpl,
      });
      authJsonText = refreshed.authJsonText;
      centralRefreshResult = refreshed.result;
    }
    if (!probeNeeded) {
      // Central refresh was evaluated above; the probe is the only part we defer for a fresh entry.
      return skippedProbeItem(entry, previousReport, skipReason, centralRefreshResult);
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
    if (!probeNeeded) {
      return skippedProbeItem(entry, previousReport, skipReason, centralRefreshResult);
    }
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
      central_refresh: centralRefreshResult,
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
    central_refresh: centralRefreshResult,
  };
}

const POOL_HEALTH_HARD_ERRORS = new Set([
  "auth invalidated (token_invalidated)",
  "auth failed (401 unauthorized)",
  "claude auth invalid (authentication_error)",
  "claude auth email unavailable",
]);

// Aggregate a worker run's per-entry results into one health row per source: how many auths are
// ok vs hard-dead (RT gone, needs owner re-login) vs other errors, plus central-refresh outcomes.
// Deleted entries are excluded (they're no longer in the pool).
export function summarizePoolHealth(items) {
  const bySource = {};
  for (const item of items) {
    if (!item || item.deleted_from_auth_pool) {
      continue;
    }
    const source = item.source || "unknown";
    const h = bySource[source] || (bySource[source] = {
      source,
      total: 0,
      ok_count: 0,
      hard_dead_count: 0,
      other_err_count: 0,
      central_refresh_attempted: 0,
      central_refresh_ok: 0,
      central_refresh_rejected: 0,
    });
    h.total++;
    if (item.status === "ok") {
      h.ok_count++;
    } else if (POOL_HEALTH_HARD_ERRORS.has(item.error)) {
      h.hard_dead_count++;
    } else {
      h.other_err_count++;
    }
    const refresh = item.central_refresh;
    if (refresh && refresh.attempted) {
      h.central_refresh_attempted++;
      if (refresh.ok) {
        h.central_refresh_ok++;
      } else if (refresh.auth_rejected) {
        h.central_refresh_rejected++;
      }
    }
  }
  return bySource;
}

// Collapse pool entries to one canonical session per (source, account_id), keeping the freshest
// by uploaded_at. Multiple sessions of one account each hold a refresh token from a different
// rotation generation of the SAME OAuth token family; centrally refreshing more than one of them
// makes the hub replay a superseded refresh token, which the provider treats as token reuse and
// answers by revoking the whole family — i.e. the death spiral the disabled_refresh_token kill
// switch was meant to stop, reintroduced inside the worker itself. We only ever process/refresh
// the canonical session and prune the rest. Rows with no account_id are always kept (each is its
// own group), so an unidentified entry can never swallow another.
export function dedupeEntriesByAccount(entries) {
  const groups = new Map();
  let anonymousSeq = 0;
  for (const entry of entries) {
    const accountId = entry?.account_id ? String(entry.account_id) : "";
    const key = accountId
      ? `${entry.source} ${accountId}`
      : `${entry.source} __anon__ ${anonymousSeq++}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  const canonical = [];
  const stale = [];
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      canonical.push(bucket[0]);
      continue;
    }
    const ranked = bucket
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => {
        const leftAt = Date.parse(left.entry.uploaded_at || "") || 0;
        const rightAt = Date.parse(right.entry.uploaded_at || "") || 0;
        if (leftAt !== rightAt) return rightAt - leftAt; // freshest upload first
        const leftSession = String(left.entry.session_id || "");
        const rightSession = String(right.entry.session_id || "");
        if (leftSession !== rightSession) return leftSession < rightSession ? 1 : -1;
        return left.index - right.index;
      })
      .map((ranked) => ranked.entry);
    canonical.push(ranked[0]);
    for (const duplicate of ranked.slice(1)) stale.push(duplicate);
  }
  return { canonical, stale };
}

export async function main() {
  const allEntries = await authPoolEntries();
  const { canonical: entries, stale } = dedupeEntriesByAccount(allEntries);
  const atOnlyMode = await getFeatureFlag("disabled_refresh_token", false);

  // Prune stale duplicate sessions before any refresh runs, so the worker never replays a
  // superseded refresh token of an account whose canonical session it is about to refresh.
  const prunedDuplicates = [];
  for (const entry of stale) {
    try {
      const result = await deleteAuthPoolEntryRow({
        source: entry.source,
        accountId: entry.account_id,
        sessionId: entry.session_id || "",
      });
      if (result?.deleted) {
        prunedDuplicates.push({ source: entry.source, account_id: entry.account_id, session_id: entry.session_id || "" });
      }
    } catch (error) {
      console.error("failed to prune duplicate auth pool entry:", error?.message || error);
    }
  }

  const items = [];
  for (const entry of entries) {
    items.push(await processAuthPoolEntry(entry, { atOnlyMode }));
  }

  const health = summarizePoolHealth(items);
  const capturedAt = new Date().toISOString();
  for (const snapshot of Object.values(health)) {
    try {
      await recordPoolHealthSnapshot({ ...snapshot, captured_at: capturedAt });
    } catch (error) {
      console.error("failed to record pool health snapshot:", error?.message || error);
    }
  }

  console.log(
    JSON.stringify(
      { ok: true, count: items.length, pruned_duplicates: prunedDuplicates.length, atOnlyMode, health, pruned: prunedDuplicates, items },
      null,
      2
    )
  );
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
