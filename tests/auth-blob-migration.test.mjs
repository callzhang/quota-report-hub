import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

async function createOldAuthPoolDb(dbPath) {
  const client = createClient({ url: `file:${dbPath}`, authToken: "test-token" });
  await client.execute(`
    CREATE TABLE auth_pool_entries (
      source TEXT NOT NULL,
      account_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      email TEXT,
      name TEXT,
      plan_name TEXT,
      auth_last_refresh TEXT,
      auth_expires_at TEXT,
      digest TEXT NOT NULL,
      uploader_email TEXT,
      reporter_name TEXT,
      hostname TEXT,
      checked_out_by TEXT,
      uploaded_at TEXT NOT NULL,
      encrypted_auth_json TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      PRIMARY KEY (source, account_id, session_id)
    )
  `);
  await client.execute({
    sql: `
      INSERT INTO auth_pool_entries (
        source, account_id, session_id, email, name, plan_name, auth_last_refresh,
        auth_expires_at, digest, uploader_email, reporter_name, hostname,
        checked_out_by, uploaded_at, encrypted_auth_json, iv, auth_tag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      "codex",
      "owner@stardust.ai",
      "",
      "owner@stardust.ai",
      "Owner",
      "Team",
      "2026-06-09T00:00:00Z",
      null,
      "digest-1",
      "owner@stardust.ai",
      "owner@mac",
      "mac",
      null,
      "2026-06-09T01:00:00Z",
      "ciphertext-1",
      "iv-1",
      "tag-1",
    ],
  });
  return client;
}

function withLocalStorage(storageDir) {
  const previous = process.env.AUTH_BLOB_STORAGE_DIR;
  process.env.AUTH_BLOB_STORAGE_DIR = storageDir;
  return () => {
    if (previous === undefined) {
      delete process.env.AUTH_BLOB_STORAGE_DIR;
    } else {
      process.env.AUTH_BLOB_STORAGE_DIR = previous;
    }
  };
}

test("migrateAuthBlobs converts old inline rows to object-backed rows", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-auth-blob-migration-"));
  const restoreStorage = withLocalStorage(join(tempDir, "objects"));
  try {
    const dbPath = join(tempDir, "old.db");
    const client = await createOldAuthPoolDb(dbPath);
    const { migrateAuthBlobs } = await import(`../scripts/migrate_auth_blobs_to_object_storage.mjs?ts=${Date.now()}`);

    const result = await migrateAuthBlobs({
      databaseUrl: `file:${dbPath}`,
      authToken: "test-token",
      mode: "apply",
      limit: 10,
      backupPath: join(tempDir, "backup.jsonl"),
    });

    assert.equal(result.mode, "apply");
    assert.equal(result.candidates, 1);
    assert.equal(result.written, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.failures.length, 0);

    const rows = (await client.execute(`
      SELECT encrypted_auth_json, iv, auth_tag, auth_blob_key
      FROM auth_pool_entries
    `)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].encrypted_auth_json, null);
    assert.equal(rows[0].iv, null);
    assert.equal(rows[0].auth_tag, null);
    assert.equal(rows[0].auth_blob_key, "auth-pool/codex/owner%40stardust.ai/default/digest-1.json");

    const objectJson = JSON.parse(readFileSync(join(tempDir, "objects", rows[0].auth_blob_key), "utf8"));
    assert.deepEqual(objectJson, {
      encrypted_auth_json: "ciphertext-1",
      iv: "iv-1",
      auth_tag: "tag-1",
    });
    assert.match(readFileSync(join(tempDir, "backup.jsonl"), "utf8"), /"account_id":"owner@stardust.ai"/);
  } finally {
    restoreStorage();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateAuthBlobs write-only mode verifies objects without mutating rows", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-auth-blob-write-only-"));
  const restoreStorage = withLocalStorage(join(tempDir, "objects"));
  try {
    const dbPath = join(tempDir, "old.db");
    const client = await createOldAuthPoolDb(dbPath);
    const { migrateAuthBlobs } = await import(`../scripts/migrate_auth_blobs_to_object_storage.mjs?ts=${Date.now()}`);

    const result = await migrateAuthBlobs({
      databaseUrl: `file:${dbPath}`,
      authToken: "test-token",
      mode: "write-only",
      limit: 10,
    });

    assert.equal(result.mode, "write-only");
    assert.equal(result.candidates, 1);
    assert.equal(result.written, 1);
    assert.equal(result.updated, 0);

    const row = (await client.execute(`
      SELECT encrypted_auth_json, iv, auth_tag, auth_blob_key
      FROM auth_pool_entries
    `)).rows[0];
    assert.equal(row.encrypted_auth_json, "ciphertext-1");
    assert.equal(row.iv, "iv-1");
    assert.equal(row.auth_tag, "tag-1");
    assert.equal(row.auth_blob_key, null);
  } finally {
    restoreStorage();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
