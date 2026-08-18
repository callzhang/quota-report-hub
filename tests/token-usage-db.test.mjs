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

test("queryTokenUsage aggregates indexed detail with exact filters and deterministic groups", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.ingestTokenUsageBatch({
      hubUserEmail: "derek@stardust.ai",
      installationId: "query-install",
      batchId: "query-batch",
      receivedAt: "2026-08-18T12:00:00.000Z",
      rows: [
        usageRow({ bucket_start: "2026-08-18T11:00:00.000Z", total_tokens: 120 }),
        usageRow({ bucket_start: "2026-08-18T11:15:00.000Z", input_tokens: 125, output_tokens: 25, cache_read_tokens: 65, total_tokens: 150 }),
      ],
    });
    await mod.ingestTokenUsageBatch({
      hubUserEmail: "member@stardust.ai",
      installationId: "member-install",
      batchId: "member-batch",
      receivedAt: "2026-08-18T12:00:00.000Z",
      rows: [{
        ...usageRow(),
        bucket_start: "2026-08-18T11:15:00.000Z",
        provider: "claude",
        model_account_id: "claude@stardust.ai",
        model_id: "claude-opus-4-1",
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 30,
        cache_write_tokens: 40,
        reasoning_tokens: 0,
        total_tokens: 100,
      }],
    });
    await client.batch([
      { sql: "INSERT INTO auth_users (email, created_at, last_token_issued_at) VALUES (?, ?, ?)", args: ["derek@stardust.ai", "2026-08-01T00:00:00.000Z", "2026-08-18T00:00:00.000Z"] },
      { sql: "INSERT INTO auth_users (email, created_at, last_token_issued_at) VALUES (?, ?, ?)", args: ["never-reported@stardust.ai", "2026-08-01T00:00:00.000Z", "2026-08-18T00:00:00.000Z"] },
    ], "write");

    const result = await mod.queryTokenUsage({
      start: "2026-08-11T12:00:00.000Z",
      end: "2026-08-18T12:00:00.000Z",
      granularity: "hour",
      groupBy: "hub_user",
      metric: "total",
      hubUsers: ["derek@stardust.ai"],
      providers: [],
      modelAccounts: [],
      models: [],
    });
    assert.equal(result.totals.total_tokens, 270);
    assert.equal(result.totals.input_tokens, 225);
    assert.deepEqual(result.trend.map((point) => ({
      bucket_start: point.bucket_start,
      group_value: point.group_value,
      total_tokens: point.total_tokens,
    })), [{
      bucket_start: "2026-08-18T11:00:00.000Z",
      group_value: "derek@stardust.ai",
      total_tokens: 270,
    }]);
    assert.equal(result.breakdown[0].model_id, "gpt-5.6-sol");
    assert.deepEqual(result.reporters, [
      { hub_user_email: "derek@stardust.ai", last_reported_at: "2026-08-18T12:00:00.000Z" },
      { hub_user_email: "never-reported@stardust.ai", last_reported_at: null },
    ]);

    const claudeOnly = await mod.queryTokenUsage({
      start: "2026-08-18T11:00:00.000Z",
      end: "2026-08-18T12:00:00.000Z",
      granularity: "15m",
      groupBy: "model",
      metric: "cache_write",
      hubUsers: [],
      providers: ["claude"],
      modelAccounts: ["claude@stardust.ai"],
      models: ["claude-opus-4-1"],
    });
    assert.equal(claudeOnly.totals.total_tokens, 100);
    assert.equal(claudeOnly.totals.cache_write_tokens, 40);
    assert.equal(claudeOnly.trend[0].group_value, "claude-opus-4-1");
  } finally {
    cleanup();
  }
});

test("daily query combines compacted rows and recent detail", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.ensureSchema();
    await client.execute({
      sql: `
        INSERT INTO token_usage_daily (
          hub_user_email, provider, model_account_id, model_id, day_start,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, total_tokens, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: ["derek@stardust.ai", "codex", "ir@stardust.ai", "gpt-5.5", "2026-08-01T00:00:00.000Z", 250, 50, 100, 0, 20, 300, "2026-08-18T00:00:00.000Z"],
    });
    await mod.ingestTokenUsageBatch({
      hubUserEmail: "derek@stardust.ai",
      installationId: "recent-install",
      batchId: "recent-batch",
      receivedAt: "2026-08-18T12:00:00.000Z",
      rows: [usageRow({ bucket_start: "2026-08-18T11:00:00.000Z" })],
    });
    const result = await mod.queryTokenUsage({
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-19T00:00:00.000Z",
      granularity: "day",
      groupBy: "provider",
      metric: "reasoning",
    });
    assert.equal(result.totals.total_tokens, 420);
    assert.deepEqual(result.trend.map((point) => point.bucket_start), [
      "2026-08-01T00:00:00.000Z",
      "2026-08-18T00:00:00.000Z",
    ]);
  } finally {
    cleanup();
  }
});

test("queryTokenUsage rejects result sets beyond finite trend and breakdown limits", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.ensureSchema();
    const rows = [];
    for (let index = 0; index < 501; index += 1) {
      rows.push({
        sql: `
          INSERT INTO token_usage_15m (
            hub_user_email, provider, model_account_id, model_id, bucket_start,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            reasoning_tokens, total_tokens, updated_at
          ) VALUES (?, 'codex', ?, ?, '2026-08-18T11:00:00.000Z', 1, 0, 0, 0, 0, 1, '2026-08-18T12:00:00.000Z')
        `,
        args: [`member-${index}@stardust.ai`, `account-${index}`, `model-${index}`],
      });
    }
    await client.batch(rows, "write");
    await assert.rejects(mod.queryTokenUsage({
      start: "2026-08-18T10:00:00.000Z",
      end: "2026-08-18T12:00:00.000Z",
      granularity: "15m",
      groupBy: "hub_user",
      metric: "total",
    }), (error) => error?.code === "query_too_broad");
  } finally {
    cleanup();
  }
});

test("queryTokenUsage rejects more than 2000 chronological trend points", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.ensureSchema();
    await client.execute(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 0
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 2000
      )
      INSERT INTO token_usage_15m (
        hub_user_email, provider, model_account_id, model_id, bucket_start,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens, updated_at
      )
      SELECT
        'trend@stardust.ai', 'codex', 'trend-account', 'trend-model',
        strftime('%Y-%m-%dT%H:%M:00.000Z', '2026-07-28T15:00:00Z', '+' || (value * 15) || ' minutes'),
        1, 0, 0, 0, 0, 1, '2026-08-18T12:00:00.000Z'
      FROM sequence
    `);
    await assert.rejects(mod.queryTokenUsage({
      start: "2026-07-28T15:00:00.000Z",
      end: "2026-08-18T12:00:00.000Z",
      granularity: "15m",
      groupBy: "provider",
      metric: "total",
    }), (error) => error?.code === "query_too_broad");
  } finally {
    cleanup();
  }
});

test("compactTokenUsage moves only rows before cutoff, adds to daily data, and prunes old receipts", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.ensureSchema();
    const detailSql = `
      INSERT INTO token_usage_15m (
        hub_user_email, provider, model_account_id, model_id, bucket_start,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens, updated_at
      ) VALUES (?, 'codex', 'account', ?, ?, ?, ?, 0, 0, 0, ?, '2026-08-18T12:00:00.000Z')
    `;
    await client.batch([
      { sql: detailSql, args: ["derek@stardust.ai", "gpt-5.5", "2026-05-19T23:45:00.000Z", 100, 20, 120] },
      { sql: detailSql, args: ["derek@stardust.ai", "gpt-5.6-sol", "2026-05-19T23:45:00.000Z", 80, 20, 100] },
      { sql: detailSql, args: ["derek@stardust.ai", "boundary", "2026-05-20T12:00:00.000Z", 1, 0, 1] },
      { sql: detailSql, args: ["derek@stardust.ai", "after", "2026-05-20T12:15:00.000Z", 1, 0, 1] },
      {
        sql: `
          INSERT INTO token_usage_daily (
            hub_user_email, provider, model_account_id, model_id, day_start,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            reasoning_tokens, total_tokens, updated_at
          ) VALUES ('derek@stardust.ai', 'codex', 'account', 'gpt-5.5', '2026-05-19T00:00:00.000Z', 10, 0, 0, 0, 0, 10, '2026-05-20T00:00:00.000Z')
        `,
        args: [],
      },
      {
        sql: `INSERT INTO token_usage_batch_receipts VALUES ('derek@stardust.ai', 'old', 'old', 'digest-old', '2026-05-20T11:59:59.999Z', '2026-05-20T11:59:59.999Z', 'marker-old')`,
        args: [],
      },
      {
        sql: `INSERT INTO token_usage_batch_receipts VALUES ('derek@stardust.ai', 'boundary', 'boundary', 'digest-boundary', '2026-05-20T12:00:00.000Z', '2026-05-20T12:00:00.000Z', 'marker-boundary')`,
        args: [],
      },
    ], "write");

    const result = await mod.compactTokenUsage({
      before: "2026-05-20T12:00:00.000Z",
      receiptBefore: "2026-05-20T12:00:00.000Z",
      maxDays: 7,
    });
    assert.deepEqual(result.days, ["2026-05-19"]);
    assert.equal(result.detail_rows_removed, 2);
    assert.equal(result.daily_rows_affected, 2);
    assert.equal(result.receipts_removed, 1);

    const daily = await client.execute("SELECT model_id, total_tokens FROM token_usage_daily ORDER BY model_id");
    assert.deepEqual(daily.rows.map((row) => [row.model_id, Number(row.total_tokens)]), [
      ["gpt-5.5", 130],
      ["gpt-5.6-sol", 100],
    ]);
    const remaining = await client.execute("SELECT bucket_start FROM token_usage_15m ORDER BY bucket_start");
    assert.deepEqual(remaining.rows.map((row) => row.bucket_start), [
      "2026-05-20T12:00:00.000Z",
      "2026-05-20T12:15:00.000Z",
    ]);
    const receipts = await client.execute("SELECT installation_id FROM token_usage_batch_receipts ORDER BY installation_id");
    assert.deepEqual(receipts.rows.map((row) => row.installation_id), ["boundary"]);

    assert.deepEqual(await mod.compactTokenUsage({
      before: "2026-05-20T12:00:00.000Z",
      receiptBefore: "2026-05-20T12:00:00.000Z",
      maxDays: 7,
    }), {
      days: [], detail_rows_removed: 0, daily_rows_affected: 0, receipts_removed: 0,
    });
  } finally {
    cleanup();
  }
});

test("compactTokenUsage processes at most seven UTC days per call", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.ensureSchema();
    const statements = Array.from({ length: 8 }, (_, index) => ({
      sql: `
        INSERT INTO token_usage_15m (
          hub_user_email, provider, model_account_id, model_id, bucket_start,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, total_tokens, updated_at
        ) VALUES ('derek@stardust.ai', 'codex', 'account', 'model', ?, 1, 0, 0, 0, 0, 1, '2026-08-18T12:00:00.000Z')
      `,
      args: [`2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`],
    }));
    await client.batch(statements, "write");
    const result = await mod.compactTokenUsage({ before: "2026-06-01T00:00:00.000Z", maxDays: 7 });
    assert.equal(result.days.length, 7);
    const remaining = await client.execute("SELECT COUNT(*) AS count FROM token_usage_15m");
    assert.equal(Number(remaining.rows[0].count), 1);
  } finally {
    cleanup();
  }
});

test("failed daily aggregation leaves that day's detail untouched", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.ensureSchema();
    await client.execute(`
      INSERT INTO token_usage_15m (
        hub_user_email, provider, model_account_id, model_id, bucket_start,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens, updated_at
      ) VALUES ('derek@stardust.ai', 'codex', 'account', 'model', '2026-05-01T00:00:00.000Z', 1, 0, 0, 0, 0, 1, '2026-08-18T12:00:00.000Z')
    `);
    await client.execute(`
      CREATE TRIGGER fail_token_usage_daily
      BEFORE INSERT ON token_usage_daily
      BEGIN
        SELECT RAISE(ABORT, 'forced daily failure');
      END
    `);
    await assert.rejects(mod.compactTokenUsage({ before: "2026-06-01T00:00:00.000Z", maxDays: 7 }));
    const remaining = await client.execute("SELECT COUNT(*) AS count FROM token_usage_15m");
    assert.equal(Number(remaining.rows[0].count), 1);
  } finally {
    cleanup();
  }
});
