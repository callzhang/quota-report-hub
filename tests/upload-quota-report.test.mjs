import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// refreshVerificationQuotaReport is a pure function, but api/auth/upload.js imports lib/db.js at
// module load time, which throws on import unless Turso env vars are set — so we still need the
// withTempEnv/dynamic-import dance from tests/fetch-best-handler.test.mjs even though this suite
// never touches the database.
async function withTempEnv(fn) {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-upload-quota-report-test-"));
  const previous = {
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
    AUTH_POOL_ENCRYPTION_KEY: process.env.AUTH_POOL_ENCRYPTION_KEY,
    TOKEN_ISSUE_KEY: process.env.TOKEN_ISSUE_KEY,
  };
  process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "upload-quota-report.db")}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  process.env.TOKEN_ISSUE_KEY = "test-token-issue-key-32-bytes!!!";
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const entry = {
  account_id: "acct-1",
  email: "user@example.com",
  name: "Test User",
  plan_name: "team",
  auth_last_refresh: "2026-09-07T05:00:00Z",
};

test("refreshVerificationQuotaReport carries the bundled exhausted_until forward", async () => {
  await withTempEnv(async () => {
    const { refreshVerificationQuotaReport } = await import(`../api/auth/upload.js?ts=${Date.now()}`);

    const quotaPayload = {
      // status is what a real probe payload always carries, and what the acceptance gate reads
      status: "ok",
      windows: { "5h": { remaining_percent: 40, reset_at: "2026-09-07T10:00:00Z" }, "1week": { remaining_percent: 80, reset_at: "2026-09-13T10:00:00Z" } },
      exhausted_until: "2026-09-07T05:26:08Z",
      usage_summary: { total_tokens: 123 },
      reporter_name: "r",
      hostname: "h",
    };

    const report = refreshVerificationQuotaReport({
      source: "codex",
      entry,
      quotaPayload,
      reporterEmail: "reporter@example.com",
    });

    assert.equal(report.exhausted_until, "2026-09-07T05:26:08Z");
    assert.deepEqual(report.usage_summary.token_refresh, { status: "refreshed", source: "upload" });
    // the caller's usage_summary fields survive alongside the added marker
    assert.equal(report.usage_summary.total_tokens, 123);
    assert.deepEqual(report.windows, quotaPayload.windows);
    assert.equal(report.reporter_name, "r");
    assert.equal(report.hostname, "h");
  });
});

// The pure-function tests above cannot see WHAT the handler feeds it — a call-site regression
// (quotaPayload: undefined, or a revert to an inline literal) would pass them silently. A full
// handler harness needs upstream-network mocking, so pin the wiring statically instead, the way
// tests/db-read-budget-static.test.mjs pins query shapes.
test("the upload handler feeds body.quota_payload to refreshVerificationQuotaReport", () => {
  const source = readFileSync(new URL("../api/auth/upload.js", import.meta.url), "utf8");
  assert.match(source, /refreshVerificationQuotaReport\(\{[\s\S]*?quotaPayload: body\.quota_payload,/);
});

test("refreshVerificationQuotaReport falls back to null exhausted_until and empty windows without a bundled payload", async () => {
  await withTempEnv(async () => {
    const { refreshVerificationQuotaReport } = await import(`../api/auth/upload.js?ts=${Date.now()}`);

    const report = refreshVerificationQuotaReport({
      source: "codex",
      entry,
      quotaPayload: undefined,
      reporterEmail: "reporter@example.com",
    });

    assert.equal(report.exhausted_until, null);
    assert.deepEqual(report.windows, { "5h": null, "1week": null });
    assert.deepEqual(report.usage_summary, { token_refresh: { status: "refreshed", source: "upload" } });
    assert.equal(report.reporter_name, "reporter@example.com");
    assert.equal(report.hostname, "upload");
  });
});

test("refreshVerificationQuotaReport drops windows the ingest gate would refuse", async () => {
  await withTempEnv(async () => {
    const { refreshVerificationQuotaReport } = await import(`../api/auth/upload.js?ts=${Date.now()}`);

    // An incomplete codex payload: ingestClientQuota ignores it, so this write must not carry its
    // windows in through the side door. BD@chuhuang landed two such rows on 2026-09-10.
    const report = refreshVerificationQuotaReport({
      source: "codex",
      entry,
      quotaPayload: {
        status: "ok",
        windows: { "5h": { remaining_percent: 0 }, "1week": { remaining_percent: 0 } },
      },
      reporterEmail: "reporter@example.com",
    });

    assert.deepEqual(report.windows, { "5h": null, "1week": null });
  });
});

test("refreshVerificationQuotaReport keeps windows the ingest gate accepts", async () => {
  await withTempEnv(async () => {
    const { refreshVerificationQuotaReport } = await import(`../api/auth/upload.js?ts=${Date.now()}`);

    const windows = {
      "5h": { remaining_percent: 90, reset_at: "2026-09-07T10:00:00Z" },
      "1week": { remaining_percent: 60, reset_at: "2026-09-13T10:00:00Z" },
    };
    const report = refreshVerificationQuotaReport({
      source: "codex",
      entry,
      quotaPayload: { status: "ok", windows },
      reporterEmail: "reporter@example.com",
    });

    assert.deepEqual(report.windows, windows);
  });
});
