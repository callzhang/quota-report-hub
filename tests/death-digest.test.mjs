import test from "node:test";
import assert from "node:assert/strict";

process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:quota-report-hub-test.db";
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "test-token";
const { buildDeathDigest, digestIsEmpty, idleHours, sendDeathDigest } = await import("../lib/death-digest.js");

const NOW = new Date("2026-09-24T17:15:00Z");
const SINCE = "2026-09-23T17:15:00.000Z";

function death(overrides = {}) {
  return {
    id: 1, source: "codex", event: "death", account_id: "derek@stardust.ai", plan_name: "Team",
    observed_at: "2026-09-24T02:00:00Z", hub_last_refresh_at: "2026-09-21T14:17:03.000Z",
    central_refresh_verdict: "rejected", refresh_error_code: "refresh_token_expired", ...overrides,
  };
}

test("idle time is the gap from the RT being minted to the death, and absent when unknowable", () => {
  assert.ok(Math.abs(idleHours(death({ observed_at: "2026-09-23T11:27:27Z" })) - 45.173) < 0.01);
  assert.equal(idleHours(death({ hub_last_refresh_at: null })), null);
  // A claude row has no rotation time; a death BEFORE the recorded mint is bad data, not a negative age.
  assert.equal(idleHours(death({ hub_last_refresh_at: "2026-09-25T00:00:00Z" })), null);
});

test("only deaths carrying a refusal code are listed; the rest are counted, not listed", () => {
  const digest = buildDeathDigest(
    [
      death(),
      death({ id: 2, account_id: "probe-only@stardust.ai", refresh_error_code: null, central_refresh_verdict: "not_attempted" }),
      death({ id: 3, event: "revival", refresh_error_code: null }),
      death({ id: 4, account_id: "old@stardust.ai", observed_at: "2026-09-20T00:00:00Z" }),
    ],
    { sinceIso: SINCE },
  );

  assert.deepEqual(digest.explained.map((d) => d.account_id), ["derek@stardust.ai"]);
  assert.equal(digest.explained[0].refresh_error_code, "refresh_token_expired");
  assert.equal(digest.unexplained, 1);
});

test("nothing is sent when nothing died with a refusal code", async () => {
  const sent = [];
  const result = await sendDeathDigest({
    now: NOW,
    eventsImpl: async () => [death({ refresh_error_code: null })],
    ownersImpl: async () => ["derek@stardust.ai"],
    sendImpl: async (mail) => sent.push(mail),
    mailConfigured: () => true,
  });

  assert.deepEqual(sent, []);
  assert.equal(result.sent, 0);
  assert.equal(result.reason, "no_deaths_with_a_refusal_code");
  assert.equal(digestIsEmpty(buildDeathDigest([], { sinceIso: SINCE })), true);
});

test("one email per owner carries the digest, and an unconfigured mailer sends nothing", async () => {
  const sent = [];
  const args = {
    now: NOW,
    eventsImpl: async () => [death()],
    ownersImpl: async () => ["derek@stardust.ai", "second-owner@stardust.ai"],
    sendImpl: async (mail) => sent.push(mail),
  };

  const unconfigured = await sendDeathDigest({ ...args, mailConfigured: () => false });
  assert.equal(unconfigured.ok, false);
  assert.deepEqual(sent, []);

  const result = await sendDeathDigest({ ...args, mailConfigured: () => true });
  assert.equal(result.sent, 2);
  assert.deepEqual(sent.map((mail) => mail.to), ["derek@stardust.ai", "second-owner@stardust.ai"]);
  assert.equal(sent[0].digest.explained[0].account_id, "derek@stardust.ai");
});

test("the email body escapes account ids, which come from users' own credentials", async () => {
  process.env.MAILGUN_API_KEY = "k";
  process.env.MAILGUN_DOMAIN = "mg.example.com";
  process.env.MAILGUN_FROM = "hub@example.com";
  const { sendDeathDigestEmail } = await import("../lib/company-auth.js");
  const forms = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    forms.push(options.body);
    return { ok: true, json: async () => ({ id: "x" }) };
  };
  try {
    await sendDeathDigestEmail({
      to: "derek@stardust.ai",
      digest: { sinceIso: SINCE, unexplained: 0, explained: [{ account_id: "<script>alert(1)</script>@x", plan_name: "Team", observed_at: "2026-09-23T11:27:27Z", refresh_error_code: "refresh_token_expired", idle_hours: 45.2 }] },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const html = forms[0].get("html");
  assert.ok(!html.includes("<script>"), "an account id must not reach the HTML body unescaped");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.match(forms[0].get("text"), /refresh_token_expired/);
  assert.match(forms[0].get("text"), /idle 45\.2 h/);
});

test("the digest rides on the existing daily cron: no thirteenth serverless function", async () => {
  const { readFile } = await import("node:fs/promises");
  const handler = await readFile(new URL("../api/cron/invalidated-auth-notifications.js", import.meta.url), "utf8");
  assert.match(handler, /sendDeathDigest\(\)/);
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(new URL("../api/cron/death-digest.js", import.meta.url)));
});
