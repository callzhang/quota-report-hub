import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function functionBody(source, name) {
  const marker = `export async function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("auth-pool active assignment reads use compact latest-state tables", async () => {
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");

  assert.match(source, /CREATE TABLE IF NOT EXISTS auth_pool_requester_assignments/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS auth_pool_reporter_assignments/);
  assert.match(source, /INSERT INTO auth_pool_requester_assignments/);
  assert.match(source, /INSERT INTO auth_pool_reporter_assignments/);

  const activeAssignments = functionBody(source, "authPoolActiveAssignmentCounts");
  assert.match(activeAssignments, /FROM auth_pool_requester_assignments/);
  assert.doesNotMatch(activeAssignments, /ROW_NUMBER\(\)/);
  assert.doesNotMatch(activeAssignments, /FROM auth_pool_fetch_log/);

  const activeReporters = functionBody(source, "authPoolActiveReporterCounts");
  assert.match(activeReporters, /FROM auth_pool_reporter_assignments/);
  assert.doesNotMatch(activeReporters, /ROW_NUMBER\(\)/);
  assert.doesNotMatch(activeReporters, /FROM auth_pool_quota_events/);

  const fetchLog = functionBody(source, "authPoolFetchLog");
  assert.match(fetchLog, /FROM auth_pool_requester_assignments/);
  assert.doesNotMatch(fetchLog, /ROW_NUMBER\(\)/);
});

test("fetch-best candidate reads are scoped to the requested source", async () => {
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");

  assert.match(source, /CREATE INDEX IF NOT EXISTS auth_pool_quota_latest_source_reported_at_idx/);
  assert.match(source, /CREATE INDEX IF NOT EXISTS auth_pool_entries_source_uploader_idx/);

  const summaries = functionBody(source, "authPoolEntrySummaries");
  assert.match(summaries, /\{ source = null \} = \{\}/);
  assert.match(summaries, /WHERE source = \?/);

  const latest = functionBody(source, "authPoolQuotaLatest");
  assert.match(latest, /\{ source = null \} = \{\}/);
  assert.match(latest, /WHERE source = \?/);

  const best = functionBody(source, "bestAuthPoolEntry");
  assert.match(best, /const source = options\.source \|\| "codex"/);
  assert.match(best, /authPoolQuotaLatest\(\{ source \}\)/);
  assert.match(best, /authPoolEntrySummaries\(\{ source \}\)/);
});

test("users list reads materialized fetch stats instead of counting the audit log", async () => {
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");

  assert.match(source, /CREATE TABLE IF NOT EXISTS auth_pool_user_fetch_stats/);
  assert.match(source, /INSERT INTO auth_pool_user_fetch_stats/);

  const users = functionBody(source, "authUsersList");
  assert.match(users, /LEFT JOIN auth_pool_user_fetch_stats/);
  assert.doesNotMatch(users, /COUNT\(\*\) FROM auth_pool_fetch_log/);
  assert.doesNotMatch(users, /MAX\(f\.fetched_at\) FROM auth_pool_fetch_log/);
});

test("quota ingestion does not scan quota event history to maintain invalidation state", async () => {
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");
  const upsertQuota = functionBody(source, "upsertAuthPoolQuota");

  assert.doesNotMatch(source, /continuousHardInvalidationSince/);
  assert.doesNotMatch(upsertQuota, /FROM auth_pool_quota_events/);
  assert.doesNotMatch(upsertQuota, /LIMIT 1000/);
});

test("dashboard revision uses one singleton row without reading dashboard data", async () => {
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");
  const revision = functionBody(source, "dashboardRevision");

  assert.match(revision, /FROM dashboard_revision WHERE singleton = 1/);
  assert.doesNotMatch(revision, /auth_pool_entries/);
  assert.doesNotMatch(revision, /auth_pool_quota_latest/);
  assert.doesNotMatch(revision, /auth_pool_quota_events/);
  assert.doesNotMatch(revision, /auth_pool_fetch_log/);
  assert.doesNotMatch(revision, /pool_health_snapshots/);
});

test("routine status revision authentication is stateless and does not touch token usage rows", async () => {
  const handler = await readFile(new URL("../api/status-revision.js", import.meta.url), "utf8");
  assert.match(handler, /verifyDashboardRevisionToken/);
  assert.match(handler, /dashboardRevision/);
  assert.doesNotMatch(handler, /authenticateApiRequest|authenticateApiToken|authenticateOrUpgradeApiToken/);
  assert.doesNotMatch(handler, /auth_api_tokens|last_used_at|client\.execute|client\.batch/);
});

test("quota history reads one indexed account range with a finite limit", async () => {
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");
  const history = functionBody(source, "authPoolQuotaEvents");

  assert.match(source, /ON auth_pool_quota_events \(source, account_id, reported_at DESC\)/);
  assert.match(history, /source = \?/);
  assert.match(history, /account_id = \?/);
  assert.match(history, /reported_at >= \?/);
  assert.match(history, /reported_at <= \?/);
  assert.match(history, /LIMIT \?/);
  assert.match(history, /Math\.min\([^,]+, 96\)/);
  assert.doesNotMatch(history, /payload_json|auth_path|auth_last_refresh|email|name|hostname|reporter_name|model_context_window|five_h_used_percent|one_week_used_percent|encrypted_auth_json|refresh_token|access_token/);
});

test("dashboard-visible logical writes batch their data and revision updates atomically", async () => {
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");

  const collapse = functionBody(source, "collapseAuthPoolSessions");
  assert.match(collapse, /client\.batch/);
  assert.match(collapse, /dashboardRevisionUpdate/);

  const fetch = functionBody(source, "recordAuthPoolFetch");
  assert.match(fetch, /client\.batch/);
  assert.doesNotMatch(fetch, /client\.execute/);
  assert.match(fetch, /dashboardRevisionUpdate/);

  for (const name of ["upsertInvalidatedAuthState", "markInvalidatedAuthNotified", "clearInvalidatedAuthState"]) {
    const mutation = functionBody(source, name);
    assert.match(mutation, /client\.batch/);
    assert.match(mutation, /dashboardRevisionUpdate/);
    assert.match(mutation, /changes\(\) > 0/);
  }

  const quota = functionBody(source, "upsertAuthPoolQuota");
  const quotaBatch = quota.slice(quota.indexOf("client.batch"));
  assert.match(quotaBatch, /insertAuthPoolQuotaEventStatement/);
  assert.match(quotaBatch, /reporterAssignment/);
  assert.match(quotaBatch, /auth_pool_quota_latest/);
  assert.match(quotaBatch, /invalidationStatement/);
  assert.match(quotaBatch, /dashboardRevisionUpdate/);

  const auth = functionBody(source, "upsertAuthPoolEntry");
  const authBatch = auth.slice(auth.lastIndexOf("client.batch"));
  assert.match(auth, /cleanupStatements = \[\{[\s\S]*DELETE FROM auth_pool_entries/);
  assert.match(auth, /cleanupStatements\.push\(\{[\s\S]*DELETE FROM auth_pool_quota_latest/);
  assert.match(authBatch, /\.\.\.cleanupStatements/);
  assert.match(authBatch, /INSERT INTO auth_pool_entries/);
  assert.match(authBatch, /dashboardRevisionUpdate/);

  const flag = functionBody(source, "setFeatureFlag");
  assert.doesNotMatch(flag, /SELECT value FROM feature_flags/);
  assert.match(flag, /feature_flags\.value IS NOT excluded\.value/);
  assert.match(flag, /client\.batch/);
  assert.match(flag, /changes\(\) > 0/);
});

test("token usage ingestion is one receipt-gated batch and current reads stay isolated", async () => {
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");
  const ingestion = functionBody(source, "ingestTokenUsageBatch");

  assert.match(ingestion, /client\.batch/);
  assert.doesNotMatch(ingestion, /client\.execute/);
  assert.match(ingestion, /token_usage_batch_receipts/);
  assert.match(ingestion, /applied_at IS NULL/);
  assert.match(ingestion, /token_usage_15m\.input_tokens \+ excluded\.input_tokens/);
  assert.doesNotMatch(ingestion, /FROM token_usage_15m|FROM token_usage_daily/);

  assert.match(source, /CREATE INDEX IF NOT EXISTS token_usage_15m_time_idx/);
  assert.match(source, /CREATE INDEX IF NOT EXISTS token_usage_daily_time_idx/);

  for (const path of [
    "../api/status.js",
    "../api/status-revision.js",
    "../api/auth/quota.js",
    "../api/auth/fetch-best.js",
  ]) {
    const currentRead = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(currentRead, /token_usage_15m|token_usage_daily|token_usage_batch_receipts/);
  }
});

test("token usage query uses bounded indexed ranges without dashboard coupling", async () => {
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");
  const query = functionBody(source, "queryTokenUsage");
  assert.match(query, /client\.batch/);
  assert.match(query, /buildRange\("bucket_start"\)/);
  assert.match(query, /`\$\{timeColumn\} >= \?`/);
  assert.match(query, /`\$\{timeColumn\} < \?`/);
  assert.match(query, /TOKEN_USAGE_TREND_LIMIT \+ 1/);
  assert.match(query, /TOKEN_USAGE_BREAKDOWN_LIMIT \+ 1/);
  assert.match(query, /token_usage_15m/);
  assert.match(query, /token_usage_daily/);
  assert.match(query, /token_usage_reporter_state/);
  assert.match(query, /auth_users/);
  assert.doesNotMatch(query, /auth_pool_quota|auth_pool_entries|auth_pool_fetch_log/);
});

test("remote probe avoids high-frequency platform cron and uses a GitHub runner loop", async () => {
  const vercelConfig = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.ok(vercelConfig.crons.every((cron) => cron.path !== "/api/cron/probe-auth-pool"));

  const workflow = await readFile(new URL("../.github/workflows/probe-auth-pool.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "7 \* \* \* \*"/);
  assert.match(workflow, /PROBE_CYCLES: \$\{\{ github\.event_name == 'schedule' && '12'/);
  assert.match(workflow, /PROBE_INTERVAL_SECONDS: \$\{\{ github\.event_name == 'schedule' && '720'/);
  assert.match(workflow, /for cycle in \$\(seq 1 "\$\{PROBE_CYCLES\}"\)/);

  const cronHandler = await readFile(new URL("../api/cron/probe-auth-pool.js", import.meta.url), "utf8");
  assert.match(cronHandler, /poolHealthSnapshots\(\{ limit: 1 \}\)/);
  assert.match(cronHandler, /GITHUB_WORKFLOW_DISPATCH_TOKEN/);
  assert.match(cronHandler, /recent_probe_snapshot/);
});
