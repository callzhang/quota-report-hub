import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

async function loadDbWithTempStore() {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-quota-events-retention-test-"));
  const previous = {
    url: process.env.TURSO_DATABASE_URL,
    token: process.env.TURSO_AUTH_TOKEN,
    encryption: process.env.AUTH_POOL_ENCRYPTION_KEY,
  };
  process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "retention.db")}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  try {
    const mod = await import(`../lib/db.js?retention=${Date.now()}-${Math.random()}`);
    const { decryptAuthJson } = await import(`../lib/auth-pool.js?retention=${Date.now()}-${Math.random()}`);
    const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
    return {
      mod,
      client,
      decryptAuthJson,
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


// Quota events are a rolling record: the dashboard reads 24h and every verdict lives in
// auth_pool_quota_latest, so anything older than the retention window is only bulk.
test("pruneAuthPoolQuotaEvents deletes only events older than the cut-off", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    const report = (reportedAt) => ({
      source: "claude", hostname: "h", reporter_name: "r@h", reported_at: reportedAt, account_id: "claude-owner@example.com",
      status: "ok", windows: { "5h": { remaining_percent: 50, reset_at: "2026-09-10T00:00:00Z" }, "1week": null },
    });
    await mod.upsertAuthPoolQuota(report("2026-07-01T00:00:00Z"));
    await mod.upsertAuthPoolQuota(report("2026-08-20T00:00:00Z"));
    await mod.upsertAuthPoolQuota(report("2026-09-05T00:00:00Z"));
    const pruned = await mod.pruneAuthPoolQuotaEvents({ before: "2026-08-06T00:00:00.000Z" });
    assert.equal(pruned.deleted, 1);
    const left = await client.execute("SELECT reported_at FROM auth_pool_quota_events ORDER BY reported_at");
    // sanitizeReport normalizes reported_at to the millisecond form on the way in
    assert.deepEqual(left.rows.map((r) => r.reported_at), ["2026-08-20T00:00:00.000Z", "2026-09-05T00:00:00.000Z"]);
    await assert.rejects(() => mod.pruneAuthPoolQuotaEvents({ before: "not a date" }), TypeError);
  } finally {
    cleanup();
  }
});
