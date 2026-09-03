import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

async function loadDbWithTempStore() {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-invalidation-clock-test-"));
  const previous = {
    url: process.env.TURSO_DATABASE_URL,
    token: process.env.TURSO_AUTH_TOKEN,
    encryption: process.env.AUTH_POOL_ENCRYPTION_KEY,
  };
  process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "invalidation-clock.db")}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  try {
    const mod = await import(`../lib/db.js?invalidation-clock=${Date.now()}-${Math.random()}`);
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

const ACCOUNT = "claude-borrowed@example.com";

function centralRefreshRejection(reportedAt) {
  return {
    source: "claude",
    hostname: "github-actions",
    reporter_name: "actions@github-actions",
    reported_at: reportedAt,
    account_id: ACCOUNT,
    status: "error",
    error: "refresh_token_rejected",
    report_origin: "worker",
    usage_summary: { central_refresh: { attempted: true, ok: false, auth_rejected: true, status: 400 } },
    windows: { "5h": null, "1week": null },
  };
}

function clientHealthyReport(reportedAt) {
  return {
    source: "claude",
    hostname: "192.168.1.4",
    reporter_name: "borrower@192.168.1.4",
    reported_at: reportedAt,
    account_id: ACCOUNT,
    status: "ok",
    error: null,
    report_origin: "client",
    windows: {
      "5h": { remaining_percent: 91, reset_at: "2026-09-04T01:59:59Z" },
      "1week": { remaining_percent: 82, reset_at: "2026-09-08T11:59:59Z" },
    },
  };
}

async function invalidationRow(client) {
  const result = await client.execute({
    sql: "SELECT first_invalidated_at, last_error FROM auth_pool_invalidated_notifications WHERE source = ? AND account_id = ?",
    args: ["claude", ACCOUNT],
  });
  return result.rows[0] || null;
}

// The archive rule and the owner-notification rule both measure how long a credential has been
// invalid, from first_invalidated_at. A client's healthy probe says nothing about the POOLED
// credential -- mergeLatestReport already refuses to let it lift a central-refresh rejection -- so
// it must not restart that clock either. It used to: the invalidation row was written from the
// report that had just arrived rather than from the merged verdict, so every unrelated "ok" deleted
// the row and the next rejection recreated it with a fresh timestamp. A credential dead for weeks
// stayed permanently "just invalidated": never archived, and its owner never told.
test("a borrower's healthy report does not restart the invalidation clock", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolQuota(centralRefreshRejection("2026-09-01T00:00:00Z"));
    const opened = await invalidationRow(client);
    assert.equal(opened.first_invalidated_at, "2026-09-01T00:00:00Z");

    await mod.upsertAuthPoolQuota(clientHealthyReport("2026-09-01T00:20:00Z"));
    const afterHealthyReport = await invalidationRow(client);
    assert.ok(afterHealthyReport, "the invalidation record survives an unrelated healthy report");
    assert.equal(
      afterHealthyReport.first_invalidated_at,
      "2026-09-01T00:00:00Z",
      "the clock still runs from the rejection, not from the report that arrived last"
    );

    await mod.upsertAuthPoolQuota(centralRefreshRejection("2026-09-01T00:33:00Z"));
    const afterNextRejection = await invalidationRow(client);
    assert.equal(
      afterNextRejection.first_invalidated_at,
      "2026-09-01T00:00:00Z",
      "a repeated rejection does not reset the clock either"
    );
  } finally {
    cleanup();
  }
});

// The other direction: proof about the pooled credential itself must still clear the record, or a
// repaired account could never leave the invalidated state.
test("a verified upload clears the invalidation record", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    await mod.upsertAuthPoolQuota(centralRefreshRejection("2026-09-01T00:00:00Z"));
    assert.ok(await invalidationRow(client));

    await mod.upsertAuthPoolQuota({
      ...clientHealthyReport("2026-09-01T01:00:00Z"),
      usage_summary: { token_refresh: { status: "refreshed", source: "upload" } },
    });
    assert.equal(
      await invalidationRow(client),
      null,
      "an upload the hub verified is proof about the pooled credential and lifts the verdict"
    );
  } finally {
    cleanup();
  }
});
