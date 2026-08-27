import test from "node:test";
import assert from "node:assert/strict";

process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:reporter-health-test.db";
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";

const {
  HEARTBEAT_SILENT_SECONDS,
  PROBE_FAILING_THRESHOLD,
  deriveReporterHealth,
  reporterHealthPayload,
} = await import("../lib/reporter-health.js");
const { normalizeReporterHeartbeat, ingestReporterHeartbeat } = await import("../lib/quota-ingest.js");

const NOW = "2026-08-27T09:00:00.000Z";
const minutesAgo = (minutes) => new Date(Date.parse(NOW) - minutes * 60 * 1000).toISOString();

test("a fresh successful heartbeat is ok", () => {
  const health = deriveReporterHealth(
    { source: "codex", reporter_key: "u@host", hostname: "host", last_run_at: minutesAgo(3), status: "ok", consecutive_failures: 0 },
    NOW,
  );
  assert.equal(health.state, "ok");
  assert.equal(health.tone, "success");
  assert.equal(health.age_seconds, 180);
});

test("a guard that keeps running while its probe fails reads as probe_failing, not silence", () => {
  const health = deriveReporterHealth(
    {
      source: "codex",
      reporter_key: "xienxu@XientekiMacBook-Air.local",
      hostname: "XientekiMacBook-Air.local",
      last_run_at: minutesAgo(4),
      status: "error",
      error: "codex probe failed: URLError: <urlopen error [Errno 8] nodename nor servname provided>",
      consecutive_failures: 9,
    },
    NOW,
  );
  assert.equal(health.state, "probe_failing");
  assert.equal(health.tone, "danger");
  assert.match(health.summary, /9 runs in a row/);
  assert.match(health.summary, /urlopen error/);
});

test("a single failed probe is only a warning", () => {
  const health = deriveReporterHealth(
    { source: "codex", reporter_key: "u@host", last_run_at: minutesAgo(2), status: "error", error: "boom", consecutive_failures: 1 },
    NOW,
  );
  assert.equal(health.state, "probe_error");
  assert.equal(health.tone, "warning");
  assert.ok(PROBE_FAILING_THRESHOLD > 1);
});

test("silence outranks a stale failure: an old heartbeat is silent whatever it last said", () => {
  const stale = minutesAgo(HEARTBEAT_SILENT_SECONDS / 60 + 30);
  for (const status of ["ok", "error"]) {
    const health = deriveReporterHealth(
      { source: "codex", reporter_key: "u@host", last_run_at: stale, status, consecutive_failures: status === "error" ? 5 : 0 },
      NOW,
    );
    assert.equal(health.state, "silent");
    assert.equal(health.tone, "danger");
  }
});

test("a heartbeat with no timestamp is unknown rather than silently healthy", () => {
  const health = deriveReporterHealth({ source: "codex", reporter_key: "u@host", status: "ok" }, NOW);
  assert.equal(health.state, "unknown");
  assert.equal(health.age_seconds, null);
});

test("payload sorts worst-first and counts each state", () => {
  const payload = reporterHealthPayload([
    { source: "codex", reporter_key: "healthy", last_run_at: minutesAgo(1), status: "ok", consecutive_failures: 0 },
    { source: "codex", reporter_key: "failing", last_run_at: minutesAgo(5), status: "error", error: "e", consecutive_failures: 4 },
    { source: "codex", reporter_key: "gone", last_run_at: minutesAgo(600), status: "ok", consecutive_failures: 0 },
    { source: "claude", reporter_key: "blip", last_run_at: minutesAgo(5), status: "error", error: "e", consecutive_failures: 1 },
  ], NOW);
  assert.deepEqual(payload.items.map((item) => item.reporter_key), ["gone", "failing", "blip", "healthy"]);
  assert.equal(payload.silent_count, 1);
  assert.equal(payload.probe_failing_count, 1);
  assert.equal(payload.probe_error_count, 1);
});

test("normalizeReporterHeartbeat keeps a heartbeat attributable and bounds the error text", () => {
  const rejected = normalizeReporterHeartbeat({ source: "codex", heartbeat: { status: "error" } });
  assert.deepEqual(rejected, { ok: false, reason: "missing_reporter_identity" });
  assert.deepEqual(normalizeReporterHeartbeat({ source: "codex", heartbeat: null }), { ok: false, reason: "missing_heartbeat" });

  const normalized = normalizeReporterHeartbeat({
    source: "codex",
    reporterEmail: "derek@stardust.ai",
    heartbeat: { hostname: "host", status: "error", error: "x".repeat(900), last_run_at: NOW },
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.heartbeat.reporter_name, "host");
  assert.equal(normalized.heartbeat.hub_user_email, "derek@stardust.ai");
  assert.equal(normalized.heartbeat.error.length, 500);
});

test("an unrecognized status is stored as ok rather than inventing a failure", async () => {
  const written = [];
  await ingestReporterHeartbeat({
    source: "claude",
    heartbeat: { reporter_name: "u@host", status: "weird" },
    upsertImpl: async (heartbeat) => written.push(heartbeat),
  });
  assert.equal(written.length, 1);
  assert.equal(written[0].status, "ok");
  assert.equal(written[0].error, null);
});
