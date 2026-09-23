import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// api/auth/upload.js binds lib/db.js once per process, so every test in this file shares one
// database and keeps to its own account.
const tempDir = mkdtempSync(join(tmpdir(), "qrh-upload-codex-handoff-verdict-"));
process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "upload.db")}`;
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
process.env.TOKEN_ISSUE_KEY = "test-token-issue-key-32-bytes!!!";
test.after(() => rmSync(tempDir, { recursive: true, force: true }));

const db = await import("../lib/db.js");
const { default: handler } = await import("../api/auth/upload.js");
const { refreshValidityFromReport } = await import("../lib/auth-status.js");

function codexAuthJson({ accountId, email, accessToken, refreshToken }) {
  const claims = { email, name: "BD", "https://api.openai.com/auth": { chatgpt_plan_type: "team" } };
  return JSON.stringify({
    last_refresh: "2026-09-22T21:25:47Z",
    tokens: {
      account_id: accountId,
      id_token: `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`,
      access_token: accessToken,
      refresh_token: refreshToken,
    },
  });
}

async function upload(body) {
  const token = (await db.issueApiToken("derek@stardust.ai")).token;
  const req = {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    async on() {},
    [Symbol.asyncIterator]: async function* iterator() {
      yield Buffer.from(JSON.stringify(body), "utf8");
    },
  };
  const res = { statusCode: 200, body: "", setHeader() {}, end(value) { this.body = value || ""; } };
  await handler(req, res);
  return res;
}

async function openVerdict(accountId) {
  return (await db.authPoolInvalidatedNotifications()).some((row) => row.account_id === accountId);
}

// 2026-09-22, bd@stardust.ai (codex, Team): the hub was refused refreshing the pooled RT on 09-14.
// The owner re-logged in and the guard uploaded the new credential as a deferred custody upload, with
// a bundled probe showing 5h 96% / week 69% on that very access token. The dashboard still read
// "refresh token rejected - usable until <new AT expiry>": a deferred upload is never refreshed, and
// only the claude path knew how to let a new refresh-token generation end the old one's verdict.
async function seedRejectedCodexAccount(accountId) {
  await db.upsertAuthPoolEntry({
    source: "codex",
    auth_json: codexAuthJson({ accountId, email: accountId, accessToken: "at-OLD", refreshToken: "rt.1.OLD" }),
    uploader_email: "derek@stardust.ai",
    reporter_name: "derek@mac",
    hostname: "mac",
  });
  await db.upsertAuthPoolQuota({
    source: "codex",
    account_id: accountId,
    email: accountId,
    status: "ok",
    windows: { "5h": null, "1week": null },
    usage_summary: { central_refresh: { attempted: true, ok: false, auth_rejected: true, status: 401 } },
    report_origin: "worker",
    reporter_name: "worker",
    hostname: "worker",
    reported_at: "2026-09-22T18:54:47Z",
  });
  assert.equal(await openVerdict(accountId), true, "seed: the verdict is open");
}

const HEALTHY_PROBE = {
  status: "ok",
  windows: {
    "5h": { remaining_percent: 96, used_percent: 4, reset_at: "2026-09-23T02:00:00Z" },
    "1week": { remaining_percent: 69, used_percent: 31, reset_at: "2026-09-27T00:00:00Z" },
  },
  usage_summary: { meter: { limit_id: "codex", limit_name: null, individual_limit: null } },
};

// The shape quota_reporters.py reports when the provider answered with rate limits but the
// workspace's credit bucket is empty: an error for rotation, a metered (authenticated) token.
const OUT_OF_CREDITS_PROBE = {
  status: "error",
  error: "codex workspace out of credits",
  windows: { "5h": null, "1week": null },
  usage_summary: {
    meter: { limit_id: "codex", limit_name: null, individual_limit: null },
    credits: { has_credits: false },
  },
};

function deferredUpload({ accountId, accessToken, refreshToken, probedAccessToken, probe = HEALTHY_PROBE }) {
  return {
    source: "codex",
    auth_json: codexAuthJson({ accountId, email: accountId, accessToken, refreshToken }),
    defer_codex_refresh: true,
    reporter_name: "derek@mac",
    hostname: "mac",
    quota_payload: {
      ...probe,
      source: "codex",
      account_id: accountId,
      email: accountId,
      access_token_fingerprint: createHash("sha256").update(probedAccessToken, "utf8").digest("hex"),
      reporter_name: "derek@mac",
      hostname: "mac",
    },
  };
}

test("a deferred codex upload of a new refresh token ends the replaced token's verdict", async () => {
  const accountId = "new-generation@stardust.ai";
  await seedRejectedCodexAccount(accountId);

  const res = await upload(deferredUpload({
    accountId, accessToken: "at-NEW", refreshToken: "rt.1.NEW", probedAccessToken: "at-NEW",
  }));

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).refresh_handoff_state, "pending", "custody stays deferred");
  const latest = await db.authPoolQuotaLatestForEntry({ source: "codex", accountId });
  assert.equal(refreshValidityFromReport(latest), "unverified", "nobody refreshed the new token; the report does not claim it");
  assert.equal(await openVerdict(accountId), false, "the owner is no longer told to re-login");
  // The uploaded token is now the pool's current generation, so a later 401 on at-OLD is recognised
  // as a superseded token (lib/quota-ingest.js reportsOnSupersededToken), not a death.
  assert.equal(
    await db.authPoolCurrentTokenFingerprint("codex", accountId),
    createHash("sha256").update("at-NEW", "utf8").digest("hex"),
  );
});

test("a deferred codex upload whose probe ran on another access token leaves the verdict", async () => {
  const accountId = "rotated-before-upload@stardust.ai";
  await seedRejectedCodexAccount(accountId);

  // The CLI rotated auth.json between the guard's probe and its upload: the probe vouches for a
  // token that is not the one arriving, so it is no witness for this upload.
  const res = await upload(deferredUpload({
    accountId, accessToken: "at-NEW", refreshToken: "rt.1.NEW", probedAccessToken: "at-OTHER",
  }));

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await openVerdict(accountId), true);
});

test("a deferred codex re-upload of the refused refresh token leaves the verdict", async () => {
  const accountId = "same-generation@stardust.ai";
  await seedRejectedCodexAccount(accountId);

  const res = await upload(deferredUpload({
    accountId, accessToken: "at-NEW", refreshToken: "rt.1.OLD", probedAccessToken: "at-NEW",
  }));

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await openVerdict(accountId), true);
});

// 2026-09-22, hr@stardust.ai: re-logged in and uploaded at 22:11Z, but the probe answered "workspace
// out of credits". The provider metered that token, so it was live; the verdict stayed anyway, and
// the owner's guard kept printing "repair required -> hr@stardust.ai" instead of rotating away.
test("a deferred codex upload whose probe was metered but out of credits ends the verdict", async () => {
  const accountId = "out-of-credits@stardust.ai";
  await seedRejectedCodexAccount(accountId);

  const res = await upload(deferredUpload({
    accountId, accessToken: "at-NEW", refreshToken: "rt.1.NEW", probedAccessToken: "at-NEW", probe: OUT_OF_CREDITS_PROBE,
  }));

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await openVerdict(accountId), false);
  const latest = await db.authPoolQuotaLatestForEntry({ source: "codex", accountId });
  assert.deepEqual(latest.windows, { "5h": null, "1week": null }, "a credit failure is still never written as 0% quota");
});

test("a deferred codex upload whose probe was refused before any meter leaves the verdict", async () => {
  const accountId = "refused-token@stardust.ai";
  await seedRejectedCodexAccount(accountId);

  const res = await upload(deferredUpload({
    accountId, accessToken: "at-NEW", refreshToken: "rt.1.NEW", probedAccessToken: "at-NEW",
    probe: { status: "error", error: "codex exec failed", windows: { "5h": null, "1week": null }, usage_summary: null },
  }));

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await openVerdict(accountId), true);
});
