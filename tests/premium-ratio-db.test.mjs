import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { weightedTokens } from "../lib/premium-ratio.js";

async function loadDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-premium-ratio-test-"));
  const previous = {
    url: process.env.TURSO_DATABASE_URL,
    token: process.env.TURSO_AUTH_TOKEN,
    encryption: process.env.AUTH_POOL_ENCRYPTION_KEY,
  };
  process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "ratio.db")}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  const mod = await import(`../lib/db.js?premium-ratio=${Date.now()}-${Math.random()}`);
  return {
    mod,
    cleanup() {
      for (const [key, value] of [
        ["TURSO_DATABASE_URL", previous.url],
        ["TURSO_AUTH_TOKEN", previous.token],
        ["AUTH_POOL_ENCRYPTION_KEY", previous.encryption],
      ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function row(overrides = {}) {
  return {
    bucket_start: "2026-09-21T00:00:00.000Z",
    provider: "codex",
    model_account_id: "pool@example.com",
    model_id: "gpt-5.6-sol",
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_tokens: 800,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 1100,
    ...overrides,
  };
}

test("fetchPolicyInputs splits weighted usage into premium and total", async () => {
  const { mod, cleanup } = await loadDb();
  try {
    const rows = [
      row(),
      row({ model_id: "gpt-5.5", bucket_start: "2026-09-21T00:15:00.000Z" }),
      // A model the tier table has never seen counts as premium: guessing "cheap" would open a
      // loophole that stays open until somebody notices the bill.
      row({ model_id: "gpt-9.9-unreleased", bucket_start: "2026-09-21T00:30:00.000Z" }),
    ];
    await mod.ingestTokenUsageBatch({
      hubUserEmail: "Heavy@Example.com",
      installationId: "install-1",
      batchId: "batch-1",
      clientVersion: "2.1.0",
      rows,
      receivedAt: "2026-09-21T01:00:00.000Z",
    });

    const inputs = await mod.fetchPolicyInputs({
      email: "heavy@example.com",
      since: "2026-09-14T00:00:00.000Z",
    });

    const expectedTotal = rows.reduce((sum, item) => sum + weightedTokens(item), 0);
    const expectedPremium = rows
      .filter((item) => item.model_id !== "gpt-5.5")
      .reduce((sum, item) => sum + weightedTokens(item), 0);

    assert.equal(inputs.totalWeighted, expectedTotal);
    assert.equal(inputs.premiumWeighted, expectedPremium);
    assert.equal(inputs.lastReportAt, "2026-09-21T01:00:00.000Z");
    assert.equal(inputs.clientVersion, "2.1.0");
  } finally {
    cleanup();
  }
});

test("fetchPolicyInputs excludes buckets outside the rolling window", async () => {
  const { mod, cleanup } = await loadDb();
  try {
    await mod.ingestTokenUsageBatch({
      hubUserEmail: "heavy@example.com",
      installationId: "install-1",
      batchId: "batch-old",
      rows: [row({ bucket_start: "2026-09-01T00:00:00.000Z" })],
      receivedAt: "2026-09-21T01:00:00.000Z",
    });
    const inputs = await mod.fetchPolicyInputs({
      email: "heavy@example.com",
      since: "2026-09-14T00:00:00.000Z",
    });
    assert.equal(inputs.totalWeighted, 0);
    assert.equal(inputs.premiumWeighted, 0);
  } finally {
    cleanup();
  }
});

test("only a real serve starts the cooldown clock", async () => {
  const { mod, cleanup } = await loadDb();
  try {
    const entry = { source: "codex", account_id: "pool@example.com", email: "pool@example.com" };
    await mod.recordAuthPoolFetch({
      requesterEmail: "heavy@example.com", source: "codex",
      servedEntry: entry, reason: "served",
    });
    const afterServe = await mod.fetchPolicyInputs({
      email: "heavy@example.com", since: "2026-09-14T00:00:00.000Z",
    });
    assert.ok(afterServe.lastServedAt, "a served fetch records last_served_at");

    await mod.recordAuthPoolFetch({
      requesterEmail: "heavy@example.com", source: "codex",
      servedEntry: null, reason: "premium_ratio_cooldown",
    });
    const afterBlock = await mod.fetchPolicyInputs({
      email: "heavy@example.com", since: "2026-09-14T00:00:00.000Z",
    });
    assert.equal(afterBlock.lastServedAt, afterServe.lastServedAt,
      "a refused fetch must not push the next allowed attempt further away");
  } finally {
    cleanup();
  }
});
