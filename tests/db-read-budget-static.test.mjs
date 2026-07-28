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
