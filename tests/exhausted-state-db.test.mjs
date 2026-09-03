import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const DB_FILE = "quota-report-hub-exhausted-state-test.db";
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.TURSO_AUTH_TOKEN = "test-token";
// upsertAuthPoolEntry (second test) encrypts the auth blob; other DB-backed tests set a dummy
// key the same way (see tests/data-api-router.test.mjs).
process.env.AUTH_POOL_ENCRYPTION_KEY ||= "0".repeat(64);

const { upsertAuthPoolQuota, authPoolQuotaLatestForEntry, fetchPolicyInputs, upsertAuthPoolEntry } =
  await import("../lib/db.js");

test.after(() => {
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

// NOTE: codex pool entries derive account_id from the id_token EMAIL (deriveCodexAuthPoolEntry),
// and the healthy-upload query joins e.account_id = q.account_id — so the quota rows below use the
// email as account_id to match the entry written in the second test.
test("exhausted_until survives the quota-latest roundtrip", async () => {
  await upsertAuthPoolQuota({
    source: "codex",
    account_id: "exhausted@example.com",
    email: "exhausted@example.com",
    plan_name: "Pro",
    reported_at: "2026-09-03T21:45:21Z",
    status: "ok",
    exhausted_until: "2026-09-07T05:26:08Z",
    windows: { "5h": null, "1week": null },
  });
  const report = await authPoolQuotaLatestForEntry({ source: "codex", accountId: "exhausted@example.com" });
  assert.equal(report.exhausted_until, "2026-09-07T05:26:08.000Z");
});

test("an exhausted upload with no windows still counts as a healthy contribution", async () => {
  // Being drained is what a shared account is for (db.js HEALTHY_POOL_ENTRY_SQL comment). An
  // exhaustion report carries no windows, so without the exhausted_until clause the uploader
  // would lose contribution credit at the exact moment their account was drained by the pool.
  await upsertAuthPoolEntry({
    source: "codex",
    auth_json: JSON.stringify({
      tokens: {
        account_id: "provider-acct-1",
        access_token: "x.e30.y",
        refresh_token: "rt.1.REALFIXTURETOKEN",
        id_token: `x.${Buffer.from(JSON.stringify({
          email: "exhausted@example.com",
          "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
        })).toString("base64url")}.y`,
      },
      last_refresh: "2026-09-03T00:00:00Z",
    }),
    uploader_email: "exhausted@example.com",
    reporter_name: "test@host",
    hostname: "host",
  });
  const inputs = await fetchPolicyInputs({
    email: "exhausted@example.com",
    since: "2026-08-01T00:00:00Z",
  });
  assert.equal(inputs.hasHealthyUpload, true);
});
