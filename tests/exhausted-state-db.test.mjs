import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A temp dir (not a repo-root file) so a killed run can't leave a stale db behind to mask a
// future regression (same pattern as tests/premium-ratio-db.test.mjs).
const tempDir = mkdtempSync(join(tmpdir(), "qrh-exhausted-state-test-"));
const DB_FILE = join(tempDir, "exhausted-state.db");
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.TURSO_AUTH_TOKEN = "test-token";
// upsertAuthPoolEntry (second test) encrypts the auth blob; other DB-backed tests set a dummy
// key the same way (see tests/data-api-router.test.mjs).
process.env.AUTH_POOL_ENCRYPTION_KEY ||= "0".repeat(64);

const { upsertAuthPoolQuota, authPoolQuotaLatestForEntry, fetchPolicyInputs, upsertAuthPoolEntry } =
  await import("../lib/db.js");

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// NOTE: codex pool entries derive account_id from the id_token EMAIL (deriveCodexAuthPoolEntry),
// and the healthy-upload query joins e.account_id = q.account_id — so the quota row below uses the
// email as account_id to match the entry written by upsertAuthPoolEntry.
//
// upsertAuthPoolQuota is an upsert (ON CONFLICT DO UPDATE), so writing this row is idempotent —
// each test seeds it independently rather than relying on test-run order.
async function seedExhaustedQuota() {
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
}

test("exhausted_until survives the quota-latest roundtrip", async () => {
  await seedExhaustedQuota();
  const report = await authPoolQuotaLatestForEntry({ source: "codex", accountId: "exhausted@example.com" });
  assert.equal(report.exhausted_until, "2026-09-07T05:26:08.000Z");
});

test("an exhausted upload with no windows still counts as a healthy contribution", async () => {
  // Being drained is what a shared account is for (db.js HEALTHY_POOL_ENTRY_SQL comment). An
  // exhaustion report carries no windows, so without the exhausted_until clause the uploader
  // would lose contribution credit at the exact moment their account was drained by the pool.
  await seedExhaustedQuota();
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
