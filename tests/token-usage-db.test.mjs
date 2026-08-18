import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

async function loadDbWithTempStore() {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-token-usage-test-"));
  const previous = {
    url: process.env.TURSO_DATABASE_URL,
    token: process.env.TURSO_AUTH_TOKEN,
    encryption: process.env.AUTH_POOL_ENCRYPTION_KEY,
  };
  process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "usage.db")}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  try {
    const mod = await import(`../lib/db.js?token-usage=${Date.now()}-${Math.random()}`);
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

function usageRow(overrides = {}) {
  return {
    bucket_start: "2026-08-18T11:45:00.000Z",
    provider: "codex",
    model_account_id: "ir@stardust.ai",
    model_id: "gpt-5.6-sol",
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 60,
    cache_write_tokens: 0,
    reasoning_tokens: 5,
    total_tokens: 120,
    ...overrides,
  };
}

test("ensureSchema creates bounded token usage tables and time indexes", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.ensureSchema();
    const objects = await client.execute(`
      SELECT type, name, sql FROM sqlite_master
      WHERE name LIKE 'token_usage_%'
      ORDER BY name
    `);
    const names = objects.rows.map((row) => row.name);
    assert.ok(names.includes("token_usage_batch_receipts"));
    assert.ok(names.includes("token_usage_15m"));
    assert.ok(names.includes("token_usage_daily"));
    assert.ok(names.includes("token_usage_reporter_state"));
    assert.ok(names.includes("token_usage_15m_time_idx"));
    assert.ok(names.includes("token_usage_daily_time_idx"));
  } finally {
    cleanup();
  }
});

test("identical retries add counters exactly once", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    const batch = {
      hubUserEmail: "derek@stardust.ai",
      installationId: "install-1",
      batchId: "batch-1",
      rows: [usageRow()],
    };
    const first = await mod.ingestTokenUsageBatch({
      ...batch,
      receivedAt: "2026-08-18T12:00:00.000Z",
    });
    const retry = await mod.ingestTokenUsageBatch({
      ...batch,
      receivedAt: "2026-08-18T12:01:00.000Z",
    });
    assert.equal(first.applied, true);
    assert.equal(retry.applied, false);
    const detail = await client.execute("SELECT total_tokens FROM token_usage_15m");
    assert.deepEqual(detail.rows.map((row) => Number(row.total_tokens)), [120]);
    const reporter = await client.execute("SELECT hub_user_email, last_reported_at FROM token_usage_reporter_state");
    assert.deepEqual(reporter.rows.map((row) => ({ ...row })), [{
      hub_user_email: "derek@stardust.ai",
      last_reported_at: "2026-08-18T12:00:00.000Z",
    }]);
  } finally {
    cleanup();
  }
});

test("concurrent identical first attempts have one applying caller", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    const batch = {
      hubUserEmail: "member@stardust.ai",
      installationId: "install-concurrent",
      batchId: "batch-concurrent",
      rows: [usageRow({ model_id: "gpt-5.5" })],
      receivedAt: "2026-08-18T12:00:00.000Z",
    };
    const results = await Promise.all([
      mod.ingestTokenUsageBatch(batch),
      mod.ingestTokenUsageBatch(batch),
    ]);
    assert.equal(results.filter((result) => result.applied).length, 1);
    assert.equal(results.filter((result) => !result.applied).length, 1);
    const detail = await client.execute("SELECT total_tokens FROM token_usage_15m");
    assert.equal(Number(detail.rows[0].total_tokens), 120);
  } finally {
    cleanup();
  }
});

test("reusing a batch identity with another digest fails without mutation", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    const identity = {
      hubUserEmail: "derek@stardust.ai",
      installationId: "install-conflict",
      batchId: "batch-conflict",
      receivedAt: "2026-08-18T12:00:00.000Z",
    };
    await mod.ingestTokenUsageBatch({ ...identity, rows: [usageRow()] });
    await assert.rejects(
      mod.ingestTokenUsageBatch({ ...identity, rows: [usageRow({ total_tokens: 121, output_tokens: 21 })] }),
      (error) => error?.code === "token_usage_batch_conflict",
    );
    const detail = await client.execute("SELECT total_tokens FROM token_usage_15m");
    assert.equal(Number(detail.rows[0].total_tokens), 120);
  } finally {
    cleanup();
  }
});

test("one invalid row rolls back receipt, details, and reporter state", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await assert.rejects(mod.ingestTokenUsageBatch({
      hubUserEmail: "derek@stardust.ai",
      installationId: "install-invalid",
      batchId: "batch-invalid",
      rows: [usageRow(), usageRow({ model_id: null })],
      receivedAt: "2026-08-18T12:00:00.000Z",
    }));
    for (const table of ["token_usage_batch_receipts", "token_usage_15m", "token_usage_reporter_state"]) {
      const result = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
      assert.equal(Number(result.rows[0].count), 0, table);
    }
  } finally {
    cleanup();
  }
});
