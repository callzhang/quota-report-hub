import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same single-instance rule as admin-config.test.mjs: the handlers bind to the one lib/db.js, so the
// database and env must be configured before the first import.
const tempDir = mkdtempSync(join(tmpdir(), "qrh-user-disable-test-"));
process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "users.db")}`;
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
process.env.TOKEN_ISSUE_KEY = "test-token-issue-key-32-bytes!!!";
process.env.ADMIN_EMAIL = "owner@stardust.ai, helper@stardust.ai";
process.env.MAILGUN_API_KEY = "test";
process.env.MAILGUN_DOMAIN = "mail.example";
process.env.MAILGUN_FROM = "hub@mail.example";

const db = await import("../lib/db.js");
const { default: usersHandler } = await import("../api/users.js");
const { default: issueTokenHandler } = await import("../api/auth/issue-token.js");

test.after(() => rmSync(tempDir, { recursive: true, force: true }));

function request(token, method, body) {
  return {
    method,
    url: "/api/users",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    async on() {},
    [Symbol.asyncIterator]: async function* iterator() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), "utf8");
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

async function call(handler, token, method, body) {
  const res = response();
  await handler(request(token, method, body), res);
  return { status: res.statusCode, payload: res.body ? JSON.parse(res.body) : null };
}

const ownerToken = (await db.issueApiToken("owner@stardust.ai")).token;
const adminToken = (await db.issueApiToken("helper@stardust.ai")).token;
const leaverToken = (await db.issueApiToken("leaver@stardust.ai")).token;
const memberToken = (await db.issueApiToken("member@stardust.ai")).token;

test("a disabled person's existing tokens stop authenticating, and re-enabling restores them", async () => {
  assert.equal((await db.authenticateApiToken(leaverToken))?.email, "leaver@stardust.ai");

  const disabled = await call(usersHandler, adminToken, "POST", { email: "Leaver@stardust.ai", disabled: true });
  assert.equal(disabled.status, 200);
  assert.equal(await db.authenticateApiToken(leaverToken), null);
  assert.equal((await call(usersHandler, leaverToken, "GET")).status, 401);

  const enabled = await call(usersHandler, adminToken, "POST", { email: "leaver@stardust.ai", disabled: false });
  assert.equal(enabled.status, 200);
  assert.equal((await db.authenticateApiToken(leaverToken))?.email, "leaver@stardust.ai");
});

test("a disabled person cannot email themselves a fresh token", async () => {
  await call(usersHandler, adminToken, "POST", { email: "leaver@stardust.ai", disabled: true });
  const realFetch = globalThis.fetch;
  let mailSent = false;
  globalThis.fetch = async () => { mailSent = true; return new Response("{}", { status: 200 }); };
  try {
    const refused = await call(issueTokenHandler, null, "POST", { email: "leaver@stardust.ai" });
    assert.equal(refused.status, 403);
    assert.equal(mailSent, false);
    const served = await call(issueTokenHandler, null, "POST", { email: "member@stardust.ai" });
    assert.equal(served.status, 200);
    assert.equal(mailSent, true);
  } finally {
    globalThis.fetch = realFetch;
    await call(usersHandler, adminToken, "POST", { email: "leaver@stardust.ai", disabled: false });
  }
});

test("a disabled person's token use is not recorded as activity", async () => {
  await call(usersHandler, adminToken, "POST", { email: "leaver@stardust.ai", disabled: true });
  const spendSince = new Date(0).toISOString();
  const before = (await db.authUsersList({ spendSince })).find((user) => user.email === "leaver@stardust.ai");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await db.authenticateApiToken(leaverToken);
  const after = (await db.authUsersList({ spendSince })).find((user) => user.email === "leaver@stardust.ai");
  assert.equal(after.token_last_used_at, before.token_last_used_at);
  assert.ok(after.disabled_at);
  assert.equal(after.disabled_by, "helper@stardust.ai");
  await call(usersHandler, adminToken, "POST", { email: "leaver@stardust.ai", disabled: false });
});

test("only admins may disable, admins themselves cannot be disabled, and unknown users are reported", async () => {
  assert.equal((await call(usersHandler, memberToken, "POST", { email: "leaver@stardust.ai", disabled: true })).status, 403);
  assert.equal((await call(usersHandler, ownerToken, "POST", { email: "helper@stardust.ai", disabled: true })).status, 400);
  assert.equal((await call(usersHandler, adminToken, "POST", { email: "owner@stardust.ai", disabled: true })).status, 400);
  assert.equal((await call(usersHandler, adminToken, "POST", { email: "ghost@stardust.ai", disabled: true })).status, 404);
  assert.equal((await call(usersHandler, adminToken, "POST", { email: "leaver@stardust.ai", disabled: "yes" })).status, 400);
  assert.equal(await db.authenticateApiToken(leaverToken) !== null, true);
});

test("per-row admin roles reach admin viewers only", async () => {
  const asAdmin = await call(usersHandler, adminToken, "GET");
  assert.equal(asAdmin.payload.viewer_admin_role, "admin");
  const roles = Object.fromEntries(asAdmin.payload.users.map((user) => [user.email, user.admin_role]));
  assert.equal(roles["owner@stardust.ai"], "owner");
  assert.equal(roles["member@stardust.ai"], null);

  const asMember = await call(usersHandler, memberToken, "GET");
  assert.equal(asMember.payload.viewer_admin_role, null);
  assert.ok(asMember.payload.users.every((user) => !("admin_role" in user)));
});
