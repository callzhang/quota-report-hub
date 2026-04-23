import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { authPoolEntries, upsertAuthPoolQuota } from "../lib/db.js";
import { decryptAuthJson } from "../lib/auth-pool.js";
import { probeAuthJson } from "../lib/auth-pool-probe.js";

function probeClaudeAuthJson(authJsonText) {
  const tempDir = mkdtempSync(join(tmpdir(), "quota-report-claude-"));
  const authBlobPath = join(tempDir, "claude-auth.json");
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

async function main() {
  const entries = await authPoolEntries();
  const items = [];

  for (const entry of entries) {
    let report;
    try {
      const authJsonText = decryptAuthJson(entry);
      report =
        entry.source === "claude"
          ? probeClaudeAuthJson(authJsonText)
          : await probeAuthJson(entry.source, authJsonText);
    } catch (error) {
      report = failureReport(entry, error);
    }
    await upsertAuthPoolQuota(report);
    items.push({
      source: entry.source,
      account_id: entry.account_id,
      status: report.status,
      error: report.error,
    });
  }

  console.log(JSON.stringify({ ok: true, count: items.length, items }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
