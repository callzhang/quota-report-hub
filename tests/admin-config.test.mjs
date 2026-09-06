import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same single-instance rule as premium-ratio-handler.test.mjs: the handler binds to the one
// unqueried lib/db.js, so the database and env must be configured before the first import.
const tempDir = mkdtempSync(join(tmpdir(), "qrh-admin-config-test-"));
process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "admins.db")}`;
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
process.env.TOKEN_ISSUE_KEY = "test-token-issue-key-32-bytes!!!";
// The pre-database mechanism a live deployment carries into the seed.
process.env.ADMIN_EMAIL = "owner@stardust.ai, helper@stardust.ai";

const db = await import("../lib/db.js");
const { default: flagsHandler } = await import("../api/admin/flags.js");
const { createClient } = await import("@libsql/client");
const rawClient = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

test.after(() => rmSync(tempDir, { recursive: true, force: true }));

function request(token, method, body) {
  return {
    method,
    headers: { authorization: `Bearer ${token}` },
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

async function call(token, method, body) {
  const res = response();
  await flagsHandler(request(token, method, body), res);
  return { status: res.statusCode, payload: res.body ? JSON.parse(res.body) : null };
}

test("an empty table seeds from ADMIN_EMAIL, first listed becoming owner", async () => {
  const admins = await db.listAdmins();
  assert.deepEqual(
    admins.map((admin) => [admin.email, admin.role]),
    [["owner@stardust.ai", "owner"], ["helper@stardust.ai", "admin"]],
  );
  assert.equal(await db.adminRole("Owner@Stardust.ai "), "owner");
  assert.equal(await db.adminRole("helper@stardust.ai"), "admin");
  assert.equal(await db.adminRole("member@stardust.ai"), null);
});

test("the owner row survives removal attempts; admins do not", async () => {
  await db.removeAdmin("owner@stardust.ai");
  assert.equal(await db.adminRole("owner@stardust.ai"), "owner");
  await db.removeAdmin("helper@stardust.ai");
  assert.equal(await db.adminRole("helper@stardust.ai"), null);
  await db.addAdmin({ email: "Helper@stardust.ai", addedBy: "owner@stardust.ai" });
  assert.equal(await db.adminRole("helper@stardust.ai"), "admin");
});

test("owner alone may change the admin list; admins may still flip flags", async () => {
  const { token: ownerToken } = await db.issueApiToken("owner@stardust.ai");
  const { token: adminToken } = await db.issueApiToken("helper@stardust.ai");
  const { token: memberToken } = await db.issueApiToken("member@stardust.ai");

  // admins (owner included) see the list; a plain member sees neither list nor role
  const asAdmin = await call(adminToken, "GET");
  assert.equal(asAdmin.payload.admin_role, "admin");
  assert.ok(asAdmin.payload.admins.some((admin) => admin.role === "owner"));
  const asMember = await call(memberToken, "GET");
  assert.equal(asMember.payload.is_admin, false);
  assert.equal(asMember.payload.admins, undefined);

  // a member cannot change anything at all
  assert.equal((await call(memberToken, "POST", { disabled_refresh_token: true })).status, 403);

  // an admin can flip a flag, but not touch the list
  const flagFlip = await call(adminToken, "POST", { require_contribution: true });
  assert.equal(flagFlip.status, 200);
  assert.equal(flagFlip.payload.flags.require_contribution, true);
  await db.setFeatureFlag("require_contribution", false, "test");
  assert.equal((await call(adminToken, "POST", { add_admin: "friend@stardust.ai" })).status, 403);

  // the owner manages the list; the owner row itself is untouchable, and domain is enforced
  const added = await call(ownerToken, "POST", { add_admin: "Colleague@stardust.ai" });
  assert.equal(added.status, 200);
  assert.ok(added.payload.admins.some((admin) => admin.email === "colleague@stardust.ai" && admin.role === "admin"));
  const removed = await call(ownerToken, "POST", { remove_admin: "colleague@stardust.ai" });
  assert.equal(removed.status, 200);
  assert.ok(!removed.payload.admins.some((admin) => admin.email === "colleague@stardust.ai"));
  assert.equal((await call(ownerToken, "POST", { remove_admin: "owner@stardust.ai" })).status, 400);
  assert.equal((await call(ownerToken, "POST", { add_admin: "outsider@gmail.com" })).status, 400);
});

test("without ADMIN_EMAIL the earliest auth user seeds as owner", async () => {
  // Reset to the fresh-service shape: no admin rows, no env, users already issued above.
  await rawClient.execute(`DELETE FROM auth_admins`);
  delete process.env.ADMIN_EMAIL;

  const admins = await db.listAdmins();
  // owner@stardust.ai got the first token in the previous test, so setup credit lands there.
  assert.deepEqual(admins.map((admin) => [admin.email, admin.role]), [["owner@stardust.ai", "owner"]]);
});
