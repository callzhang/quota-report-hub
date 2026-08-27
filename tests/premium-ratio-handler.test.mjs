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
process.env.POOL_COOLDOWN_AT = "2000-01-01T00:00:00.000Z";

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

// Supplying the pool: one account, uploaded by this user, healthy enough to lend.
async function seedContribution(email, accountId) {
  const claims = { email: accountId, name: "Pool Account", "https://api.openai.com/auth": { chatgpt_plan_type: "team" } };
  await db.upsertAuthPoolEntry({
    source: "codex",
    auth_json: JSON.stringify({
      last_refresh: new Date().toISOString(),
      tokens: {
        account_id: `provider-${accountId}`,
        id_token: `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`,
        // No dots: an access token that splits like a JWT is decoded like one.
        access_token: `access-${accountId.replace(/\W/g, "-")}`,
        refresh_token: `rt.1.REAL-${accountId.replace(/\W/g, "-")}`,
      },
    }),
    uploader_email: email,
    reporter_name: `${email}@mac`,
    hostname: "mac",
  });
  await db.upsertAuthPoolQuota({
    source: "codex",
    hostname: "github-actions",
    reporter_name: "worker",
    reported_at: new Date().toISOString(),
    account_id: accountId,
    email: accountId,
    plan_name: "Team",
    status: "ok",
    windows: {
      "5h": { used_percent: 10, remaining_percent: 90, reset_at: "2099-05-06T07:00:00Z" },
      "1week": { used_percent: 5, remaining_percent: 95, reset_at: "2099-05-13T02:00:00Z" },
    },
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

test("an empty pool says so, instead of claiming the caller may not borrow", async () => {
  // Nothing lendable exists for this caller yet. The old copy on this path said uploading was a
  // precondition for borrowing; it is not one, and it was sent in a field the client never reads.
  const email = "empty-pool@stardust.ai";
  const { token } = await db.issueApiToken(email);
  await seedScarcePool(false);
  const payload = await call(token);

  assert.equal(payload.replacement, null);
  assert.equal(payload.reason, "pool_empty_no_contribution");
  assert.ok(!JSON.stringify(payload).includes("before you can fetch"));
  const notice = payload.notices.find((item) => item.code === "pool_empty");
  assert.ok(notice, "the caller is told nothing about why they got no account");
  assert.ok(notice.repeat_seconds > 0, "a notice with no repeat interval toasts every 15 minutes");
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

test("a reporting client that is inside its share and supplies the pool is told nothing", async () => {
  const email = "light@stardust.ai";
  const { token } = await db.issueApiToken(email);
  await seedUsage(email, "gpt-5.5", "batch-light");
  await seedContribution(email, "light-pool@example.com");
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

test("a non-contributor is warned while the pool is healthy, and still served", async () => {
  const email = "borrower@stardust.ai";
  const { token } = await db.issueApiToken(email);
  await seedUsage(email, "gpt-5.5", "batch-borrower");
  await seedContribution("supplier@stardust.ai", "supplier-pool@example.com");
  await seedScarcePool(false);

  const payload = await call(token);
  assert.ok(payload.replacement, "a healthy pool serves a non-contributor like anybody else");
  assert.ok(
    payload.notices.some((notice) => notice.code === "contribution_warning"),
    "somebody drawing on a pool they do not supply should hear about it before it costs them",
  );
});

test("a scarce pool rate-limits a non-contributor, and supplying it lifts that", async () => {
  const email = "borrower2@stardust.ai";
  const { token } = await db.issueApiToken(email);
  await seedUsage(email, "gpt-5.5", "batch-borrower2");
  await seedServe(email);
  await seedScarcePool(true);

  const held = await call(token);
  assert.equal(held.reason, "contribution_cooldown");
  assert.equal(held.replacement, null);
  assert.ok(held.retry_after_seconds > 0);
  // Inside their fair share: only the supply rule can be holding them.
  assert.ok(held.demand_share < 0.2, "this must not be the demand-share rule wearing another name");

  await seedContribution(email, "borrower2-pool@example.com");
  const after = await call(token);
  assert.notEqual(after.reason, "contribution_cooldown");
  assert.ok(!after.notices.some((notice) => notice.code.startsWith("contribution")));
});

test("the kill switch stops the contribution cooldown too, without silencing it", async () => {
  const email = "borrower3@stardust.ai";
  const { token } = await db.issueApiToken(email);
  await seedUsage(email, "gpt-5.5", "batch-borrower3");
  await seedServe(email);
  await seedScarcePool(true);
  await db.setFeatureFlag("premium_ratio_enforcement", false, "test");
  try {
    const payload = await call(token);
    assert.notEqual(payload.reason, "contribution_cooldown");
    assert.ok(payload.notices.some((notice) => notice.code === "contribution_cooldown"));
  } finally {
    await db.setFeatureFlag("premium_ratio_enforcement", true, "test");
  }
});
