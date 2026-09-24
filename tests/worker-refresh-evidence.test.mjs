import test from "node:test";
import assert from "node:assert/strict";

// What the worker leaves behind about a refresh: the provider's stated reason, one attempt-log call,
// and — for a rotation that happens INSIDE a probe — a boolean that used to be dropped on the floor.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-report-hub-test.db";
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";
process.env.AUTH_POOL_ENCRYPTION_KEY = process.env.AUTH_POOL_ENCRYPTION_KEY || "0".repeat(64);
const { processAuthPoolEntry } = await import(`../scripts/probe_auth_pool_worker.mjs?ts=${Date.now()}`);

function jwt(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

const NOW = new Date("2026-09-23T11:27:27Z");
// An access token with ten minutes left, so the worker's central refresh is due.
function blob({ lastRefresh = "2026-09-21T14:17:03.000Z" } = {}) {
  return JSON.stringify({
    tokens: {
      account_id: "acct",
      access_token: jwt({ exp: Math.floor(NOW.getTime() / 1000) + 600 }),
      refresh_token: "rt-real-value",
      id_token: jwt({ email: "derek@stardust.ai" }),
    },
    last_refresh: lastRefresh,
  });
}

const ENTRY = { source: "codex", account_id: "derek@stardust.ai", uploader_email: "derek@stardust.ai" };

function okProbe(extra = {}) {
  return () => ({
    source: "codex",
    account_id: "derek@stardust.ai",
    status: "ok",
    error: null,
    windows: { "5h": { remaining_percent: 80 }, "1week": { remaining_percent: 70 } },
    ...extra,
  });
}

async function run({ refresh, probe = okProbe(), recorded = [] }) {
  const stored = [];
  const result = await processAuthPoolEntry(ENTRY, {
    decryptAuthJsonImpl: () => blob(),
    probeCodexAuthJsonImpl: probe,
    upsertAuthPoolQuotaImpl: async (report) => stored.push(report),
    upsertAuthPoolEntryImpl: async () => ({ deduplicated: false }),
    authPoolQuotaLatestForEntryImpl: async () => null,
    recordTokenFingerprintImpl: async () => {},
    recordAttemptImpl: async (attempt) => recorded.push(attempt),
    refreshCodexTokenImpl: refresh,
    atOnlyMode: true,
    nowImpl: () => NOW,
  });
  return { result, stored, recorded };
}

test("a refused central refresh carries the provider's reason into the report and the attempt log", async () => {
  const { result, stored, recorded } = await run({
    refresh: async () => ({ ok: false, auth_rejected: true, status: 401, provider_error_code: "refresh_token_expired" }),
  });

  assert.equal(result.central_refresh.provider_error_code, "refresh_token_expired");
  assert.equal(stored.at(-1).usage_summary.central_refresh.provider_error_code, "refresh_token_expired");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].path, "worker");
  assert.equal(recorded[0].accountId, "derek@stardust.ai");
  // 2026-09-21T14:17:03Z -> 2026-09-23T11:27:27Z, the exact interval the derek@ case turned on.
  assert.equal(recorded[0].rtAgeSeconds, 45 * 3600 + 10 * 60 + 24);
});

test("a rotation inside the probe is surfaced instead of being dropped by sanitisation", async () => {
  const { stored } = await run({
    refresh: async () => ({ ok: true, access_token: "at2", refresh_token: "rt2", expires_in: 864000, id_token: "id2" }),
    probe: okProbe({ refresh_capture: { delta: { refreshed: true }, refreshed_auth_json: blob() } }),
  });

  assert.deepEqual(stored.at(-1).usage_summary.codex_probe_refresh, { refreshed: true });
});

test("a probe that did not rotate says so explicitly, so silence is not mistaken for a missing instrument", async () => {
  const { stored } = await run({
    refresh: async () => ({ ok: true, access_token: "at2", refresh_token: "rt2", expires_in: 864000, id_token: "id2" }),
    probe: okProbe({ refresh_capture: { delta: { refreshed: false } } }),
  });

  assert.deepEqual(stored.at(-1).usage_summary.codex_probe_refresh, { refreshed: false });
});
