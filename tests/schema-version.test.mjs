import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { Sqlite3Client } from "@libsql/client/sqlite3";

const tempDir = mkdtempSync(join(tmpdir(), "qrh-schema-version-"));
process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "schema.db")}`;
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
test.after(() => rmSync(tempDir, { recursive: true, force: true }));

// Every statement the module sends, one entry per round trip.
const sent = [];
let failNext = null;
for (const method of ["execute", "batch"]) {
  const original = Sqlite3Client.prototype[method];
  Sqlite3Client.prototype[method] = function spy(statement, ...rest) {
    const sql = JSON.stringify(statement);
    sent.push(sql);
    if (failNext && sql.includes(failNext)) {
      failNext = null;
      return Promise.reject(new Error("fetch failed"));
    }
    return original.call(this, statement, ...rest);
  };
}

const raw = createClient({ url: process.env.TURSO_DATABASE_URL });
let instances = 0;
// A cache-busted import is what a cold serverless instance is: same database, no module state.
const coldInstance = () => import(`../lib/db.js?instance=${instances++}`);

async function heartbeatColumns() {
  const result = await raw.execute("PRAGMA table_info(reporter_probe_heartbeats)");
  return result.rows.map((row) => row.name);
}

test("a failed migration statement fails the caller and is not recorded as done", async () => {
  const db = await coldInstance();
  failNext = "ADD COLUMN scheduler_json";
  await assert.rejects(db.ensureSchema(), /fetch failed/);

  await db.ensureSchema();
  assert.ok((await heartbeatColumns()).includes("scheduler_json"));
});

test("a cold instance on a migrated database costs one round trip", async () => {
  const db = await coldInstance();
  sent.length = 0;
  await db.ensureSchema();
  assert.equal(sent.length, 1);
});

test("a cold instance that skipped the migration can still write a pool entry twice", async () => {
  const db = await coldInstance();
  const claims = { email: "owner@example.com", name: "O", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } };
  const blob = (accessToken) => JSON.stringify({
    last_refresh: "2026-11-24T00:00:00Z",
    tokens: {
      account_id: "provider-uuid",
      id_token: `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`,
      access_token: accessToken,
      refresh_token: "rt",
    },
  });
  await db.upsertAuthPoolEntry({ source: "codex", auth_json: blob("first"), uploader_email: "owner@example.com" });
  await db.upsertAuthPoolEntry({ source: "codex", auth_json: blob("second"), uploader_email: "owner@example.com" });
  assert.equal((await db.authPoolEntrySummaries({ source: "codex" })).length, 1);
});

test("a database migrated by different code is migrated again", async () => {
  await raw.execute("UPDATE schema_version SET fingerprint = 'older-code'");
  await raw.execute("ALTER TABLE reporter_probe_heartbeats DROP COLUMN scheduler_json");

  const db = await coldInstance();
  await db.ensureSchema();
  assert.ok((await heartbeatColumns()).includes("scheduler_json"));
});
