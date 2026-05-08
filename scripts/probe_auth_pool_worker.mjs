import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  authPoolEntries,
  authPoolQuotaLatestForEntry,
  deleteAuthPoolEntry,
  upsertAuthPoolEntry,
  upsertAuthPoolQuota,
} from "../lib/db.js";
import { decryptAuthJson } from "../lib/auth-pool.js";
import { probeAuthJson } from "../lib/auth-pool-probe.js";

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
  return report?.error === "token_count event was present but missing quota details";
}

function deleteReason(entry, report, previousReport = null) {
  if (isFreePlan(entry.plan_name) || isFreePlan(report?.plan_name) || isFreePlan(report?.refresh_capture?.refreshed_metadata?.plan_name)) {
    return "free_plan";
  }
  if (isAuthFailed401(report) && isAuthFailed401(previousReport)) {
    return "continuous_401";
  }
  return "missing_quota_details";
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
  } = {}
) {
  let report;
  try {
    const authJsonText = decryptAuthJsonImpl(entry);
    report =
      entry.source === "codex"
        ? probeCodexAuthJsonImpl(authJsonText)
        : entry.source === "claude"
          ? probeClaudeAuthJsonImpl(authJsonText)
          : await probeAuthJsonImpl(entry.source, authJsonText);
  } catch (error) {
    report = failureReport(entry, error);
  }
  const previousReport = await authPoolQuotaLatestForEntryImpl({ source: entry.source, accountId: entry.account_id });
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
  };
}

export async function main() {
  const entries = await authPoolEntries();
  const items = [];

  for (const entry of entries) {
    items.push(await processAuthPoolEntry(entry));
  }

  console.log(JSON.stringify({ ok: true, count: items.length, items }, null, 2));
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
