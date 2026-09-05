import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

async function loadDbWithTempStore() {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-heartbeat-test-"));
  const previous = {
    url: process.env.TURSO_DATABASE_URL,
    token: process.env.TURSO_AUTH_TOKEN,
    encryption: process.env.AUTH_POOL_ENCRYPTION_KEY,
  };
  process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "heartbeat.db")}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  try {
    const mod = await import(`../lib/db.js?heartbeat=${Date.now()}-${Math.random()}`);
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
    return {
      mod,
      client,
      cleanup() {
        if (previous.url === undefined) delete process.env.TURSO_DATABASE_URL;
        else process.env.TURSO_DATABASE_URL = previous.url;
        if (previous.token === undefined) delete process.env.TURSO_AUTH_TOKEN;
        else process.env.TURSO_AUTH_TOKEN = previous.token;
        if (previous.encryption === undefined) delete process.env.AUTH_POOL_ENCRYPTION_KEY;
        else process.env.AUTH_POOL_ENCRYPTION_KEY = previous.encryption;
        rmSync(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function heartbeat(overrides = {}) {
  return {
    source: "codex",
    reporter_name: "xienxu@XientekiMacBook-Air.local",
    hostname: "XientekiMacBook-Air.local",
    hub_user_email: "derek@stardust.ai",
    last_run_at: "2026-08-27T09:00:00.000Z",
    status: "ok",
    error: null,
    account_id: "bd@stardust.ai",
    client_version: "2.1.0",
    ...overrides,
  };
}

async function revision(client) {
  const result = await client.execute("SELECT revision FROM dashboard_revision WHERE singleton = 1");
  return Number(result.rows[0].revision);
}

test("consecutive probe failures accumulate and reset on the first success", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertReporterProbeHeartbeat(heartbeat());
    let [row] = await mod.reporterProbeHeartbeats();
    assert.equal(row.consecutive_failures, 0);
    assert.equal(row.last_ok_at, "2026-08-27T09:00:00.000Z");

    for (const [index, minute] of ["15", "30", "45"].entries()) {
      await mod.upsertReporterProbeHeartbeat(heartbeat({
        last_run_at: `2026-08-27T09:${minute}:00.000Z`,
        status: "error",
        error: "codex probe failed: URLError: dns",
      }));
      [row] = await mod.reporterProbeHeartbeats();
      assert.equal(row.consecutive_failures, index + 1);
      // The last good reading is preserved across the failures, so the dashboard can say how long
      // this machine has been blind rather than just "unknown".
      assert.equal(row.last_ok_at, "2026-08-27T09:00:00.000Z");
    }

    await mod.upsertReporterProbeHeartbeat(heartbeat({ last_run_at: "2026-08-27T10:00:00.000Z" }));
    [row] = await mod.reporterProbeHeartbeats();
    assert.equal(row.consecutive_failures, 0);
    assert.equal(row.error, null);
    assert.equal(row.last_ok_at, "2026-08-27T10:00:00.000Z");
  } finally {
    cleanup();
  }
});

test("an out-of-order heartbeat never rewinds the stored run", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertReporterProbeHeartbeat(heartbeat({ last_run_at: "2026-08-27T10:00:00.000Z" }));
    await mod.upsertReporterProbeHeartbeat(heartbeat({
      last_run_at: "2026-08-27T09:00:00.000Z",
      status: "error",
      error: "late arrival",
    }));
    const [row] = await mod.reporterProbeHeartbeats();
    assert.equal(row.last_run_at, "2026-08-27T10:00:00.000Z");
    assert.equal(row.status, "ok");
  } finally {
    cleanup();
  }
});

test("only a visible state change bumps the dashboard revision", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertReporterProbeHeartbeat(heartbeat());
    const afterFirst = await revision(client);

    // A second healthy run changes nothing anyone can see: every reporter pings every 15 minutes,
    // and bumping here would make every open dashboard refetch for nothing.
    await mod.upsertReporterProbeHeartbeat(heartbeat({ last_run_at: "2026-08-27T09:15:00.000Z" }));
    assert.equal(await revision(client), afterFirst);

    await mod.upsertReporterProbeHeartbeat(heartbeat({
      last_run_at: "2026-08-27T09:30:00.000Z",
      status: "error",
      error: "codex probe failed",
    }));
    const afterFailure = await revision(client);
    assert.ok(afterFailure > afterFirst, "ok -> error must reach the dashboard");

    await mod.upsertReporterProbeHeartbeat(heartbeat({
      last_run_at: "2026-08-27T09:45:00.000Z",
      status: "error",
      error: "codex probe failed",
    }));
    assert.equal(await revision(client), afterFailure);

    await mod.upsertReporterProbeHeartbeat(heartbeat({ last_run_at: "2026-08-27T10:00:00.000Z" }));
    assert.ok(await revision(client) > afterFailure, "recovery must reach the dashboard too");
  } finally {
    cleanup();
  }
});

test("a heartbeat without a reporter identity is refused instead of creating a nameless row", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    const result = await mod.upsertReporterProbeHeartbeat(heartbeat({ reporter_name: null, hostname: null }));
    assert.deepEqual(result, { ok: false, reason: "missing_reporter_key" });
    assert.deepEqual(await mod.reporterProbeHeartbeats(), []);
  } finally {
    cleanup();
  }
});

// The heartbeat records which commit the guard runs, not only the hand-maintained version string.
test("a heartbeat stores and returns the guard's applied commit", async () => {
  const { mod, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertReporterProbeHeartbeat(heartbeat({ client_version: "2.3.0", client_sha: "454064344cae7ae3d91322b1cc02746a902a36dc" }));
    const [row] = await mod.reporterProbeHeartbeats();
    assert.equal(row.client_version, "2.3.0");
    assert.equal(row.client_sha, "454064344cae7ae3d91322b1cc02746a902a36dc");

    // an older client that sends no sha leaves the column empty rather than failing the write
    await mod.upsertReporterProbeHeartbeat(heartbeat({ last_run_at: "2026-08-27T09:15:00.000Z", client_version: "2.1.0" }));
    const [again] = await mod.reporterProbeHeartbeats();
    assert.equal(again.client_sha, null);
  } finally {
    cleanup();
  }
});
