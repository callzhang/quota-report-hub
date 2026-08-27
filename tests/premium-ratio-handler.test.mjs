import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// api/auth/fetch-best.js imports lib/db.js without a cache-busting query, so the handler always
// binds to the ONE unqueried lib/db.js instance — the one created the first time anything loads it.
// Seeding through a separately cache-busted copy would write to a different database than the
// handler reads. So: one database, one env, configured before the first import, shared by both.
const tempDir = mkdtempSync(join(tmpdir(), "qrh-premium-gate-test-"));
process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "gate.db")}`;
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
process.env.TOKEN_ISSUE_KEY = "test-token-issue-key-32-bytes!!!";
// Both enforcing phases are pulled into the past; the pre-enforcement phases are covered by the
// pure policy tests in premium-ratio.test.mjs, which need no database at all.
process.env.PREMIUM_RATIO_REPORTER_GATE_AT = "2000-01-01T00:00:00.000Z";
process.env.PREMIUM_RATIO_COOLDOWN_AT = "2000-01-01T00:00:00.000Z";

const db = await import("../lib/db.js");
const { default: handler } = await import("../api/auth/fetch-best.js");
const { createClient } = await import("@libsql/client");
const scarcityClient = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

test.after(() => rmSync(tempDir, { recursive: true, force: true }));

function request(token, body = { source: "codex", client_version: "2.0.0" }) {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    async on() {},
    [Symbol.asyncIterator]: async function* iterator() {
      yield Buffer.from(JSON.stringify(body), "utf8");
    },
  };
}

function response() {
  return {
    statusCode: 200, headers: {}, body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value || ""; },
  };
}

async function call(token, body) {
  const res = response();
  await handler(request(token, body), res);
  assert.equal(res.statusCode, 200, `handler returned ${res.statusCode}: ${res.body}`);
  return JSON.parse(res.body);
}

function usageRow(bucketStart, modelId) {
  return {
    bucket_start: bucketStart,
    provider: "codex",
    model_account_id: "pool@example.com",
    model_id: modelId,
    input_tokens: 30_000_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 10_000_000,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 31_000_000,
  };
}

function quarterHoursAgo(count) {
  const ms = Date.now() - count * 15 * 60 * 1000;
  return new Date(Math.floor(ms / (15 * 60 * 1000)) * 15 * 60 * 1000).toISOString();
}

async function seedUsage(email, modelId, batchId, { heavy = false } = {}) {
  await db.ingestTokenUsageBatch({
    hubUserEmail: email,
    installationId: "install-1",
    batchId,
    clientVersion: "2.0.0",
    rows: Array.from({ length: heavy ? 40 : 1 }, (_, index) => usageRow(quarterHoursAgo(index + 1), modelId)),
    receivedAt: new Date().toISOString(),
  });
}

// The cooldown is a rationing rule, so it only bites while there is something to ration. These
// tests have to put the pool in that state deliberately.
async function seedScarcePool(scarce) {
  await scarcityClient.execute({
    sql: `INSERT INTO pool_scarcity_state (
            source, computed_at, burn_points_per_day, available_points,
            demand_points, runway_days, horizon_days, scarce
          ) VALUES ('codex', ?, 400, 100, 2800, 0.25, 7, ?)
          ON CONFLICT(source) DO UPDATE SET
            computed_at = excluded.computed_at, scarce = excluded.scarce`,
    args: [new Date().toISOString(), scarce ? 1 : 0],
  });
}

async function seedServe(email) {
  await db.recordAuthPoolFetch({
    requesterEmail: email,
    source: "codex",
    servedEntry: { source: "codex", account_id: "pool@example.com", email: "pool@example.com" },
    reason: "served",
  });
}

// Fair share presupposes a team. Without colleagues in the window the rule stands down, so these
// tests seed a realistic set of small consumers once, up front.
test("seed a team of ordinary consumers", async () => {
  for (let index = 0; index < 6; index += 1) {
    await seedUsage(`colleague${index}@stardust.ai`, "gpt-5.5", `batch-colleague-${index}`);
  }
});

test("reporter gate refuses an outdated client and names the fix", async () => {
  const { token } = await db.issueApiToken("silent@stardust.ai");
  const payload = await call(token, { source: "codex", client_version: "1.0.0" });
  assert.equal(payload.reason, "reporter_upgrade_required");
  assert.equal(payload.replacement, null);
  assert.match(payload.message, /升级|上报/);
});

test("a fresh install with no usage yet is served rather than deadlocked", async () => {
  // Its first act is to fetch auth; it cannot have reported usage yet, and without auth it never
  // could. Gating on the version the request carries is what keeps this from being a trap.
  const { token } = await db.issueApiToken("newcomer@stardust.ai");
  const payload = await call(token);
  assert.notEqual(payload.reason, "reporter_upgrade_required");
});

test("a reporting client below the share threshold passes both gates", async () => {
  const email = "light@stardust.ai";
  const { token } = await db.issueApiToken(email);
  await seedUsage(email, "gpt-5.5", "batch-light");
  const payload = await call(token);
  assert.notEqual(payload.reason, "reporter_upgrade_required");
  assert.notEqual(payload.reason, "demand_share_cooldown");
  assert.deepEqual(payload.notices, []);
});

test("cooldown holds a user driving a shortage, and a refused attempt does not extend the wait", async () => {
  const email = "heavy@stardust.ai";
  const { token } = await db.issueApiToken(email);
  await seedUsage(email, "gpt-5.6-sol", "batch-heavy", { heavy: true });
  await seedServe(email);
  await seedScarcePool(true);

  const first = await call(token);
  assert.equal(first.reason, "demand_share_cooldown");
  assert.equal(first.replacement, null);
  assert.ok(first.retry_after_seconds > 0);
  assert.ok(first.demand_share > 0.25, "this user is the entire team's spend");

  const second = await call(token);
  assert.ok(
    second.retry_after_seconds <= first.retry_after_seconds,
    "being refused must not push the next allowed attempt further away",
  );
});

test("the kill switch stops refusals without silencing the warning", async () => {
  const email = "heavy2@stardust.ai";
  const { token } = await db.issueApiToken(email);
  await seedUsage(email, "gpt-5.6-sol", "batch-heavy2", { heavy: true });
  await seedServe(email);
  await seedScarcePool(true);
  await db.setFeatureFlag("premium_ratio_enforcement", false, "test");
  try {
    const payload = await call(token);
    assert.notEqual(payload.reason, "demand_share_cooldown");
    assert.ok(
      payload.notices.some((notice) => notice.code === "demand_share_cooldown"),
      "disabling enforcement must not also disable the warning",
    );
  } finally {
    await db.setFeatureFlag("premium_ratio_enforcement", true, "test");
  }
});

test("an over-share user is only warned while the pool has room to spare", async () => {
  const email = "heavy3@stardust.ai";
  const { token } = await db.issueApiToken(email);
  await seedUsage(email, "gpt-5.6-sol", "batch-heavy3", { heavy: true });
  await seedServe(email);
  await seedScarcePool(false);

  const payload = await call(token);
  assert.notEqual(payload.reason, "demand_share_cooldown", "abundance must not throttle anyone");
  assert.ok(
    payload.notices.some((notice) => notice.code === "demand_share_warning"),
    "the warning still goes out, so habits can change before the pool tightens",
  );
});
