# Auth Blob Object Storage Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a migration path that moves existing inline encrypted auth JSON from Turso/SQLite rows into Tigris object storage without losing auth data or breaking cloud probes.

**Architecture:** The migration script reads only encrypted auth envelopes, writes each envelope to object storage, reads it back for byte-for-byte JSON field verification, then clears inline payload columns only after successful verification. The script supports local SQLite experiments through `--db`, remote Turso execution through existing `TURSO_*` environment variables, and three modes: `scan`, `write-only`, and `apply`.

**Tech Stack:** Node.js ESM, `@libsql/client`, `@tigrisdata/storage`, local `AUTH_BLOB_STORAGE_DIR` test storage, Tigris object storage in production, Node test runner.

---

## File Structure

- Create: `scripts/migrate_auth_blobs_to_object_storage.mjs`
  - CLI and reusable migration functions.
  - Owns schema preparation, row selection, object write/read verification, backup JSONL creation, and guarded DB updates.
- Create: `tests/auth-blob-migration.test.mjs`
  - Unit/integration tests against temp SQLite files and local object storage.
  - Covers old schema migration, object write verification, `write-only` non-mutating mode, and guarded `apply` updates.
- Modify: `.github/workflows/probe-auth-pool.yml`
  - Pass Tigris secrets to GitHub Actions worker before online rows are converted to `auth_blob_key`.
- Modify: `README.md`
  - Add migration runbook and explain DB structure optimization.
- Read only: `lib/auth-blob-storage.js`
  - Reuse `authBlobKey`, `writeAuthBlob`, and `readAuthBlob`.
- Read only: `lib/db.js`
  - Keep existing app schema contract; the migration script should not weaken production app behavior.

## Database Structure Decision

Keep `auth_pool_entries` as the canonical metadata table and optimize only the payload columns:

- `auth_blob_key TEXT` stores the object path.
- `encrypted_auth_json TEXT`, `iv TEXT`, and `auth_tag TEXT` become nullable.
- Migrated rows set those three inline payload columns to `NULL`.
- Existing inline rows remain readable until migrated.
- Do not drop inline columns in this implementation. Dropping them removes the rollback path and should wait until at least one full deploy/probe cycle succeeds after migration.
- Add `auth_pool_entries_uploaded_at_idx` for status/worker ordering.
- Add `auth_pool_entries_pending_blob_idx` as a partial migration index for rows that still have inline payloads.

## Task 1: Add GitHub Actions Tigris Environment

**Files:**
- Modify: `.github/workflows/probe-auth-pool.yml`
- Test: none; verify by YAML inspection and later workflow run.

- [ ] **Step 1: Patch the worker environment**

In `.github/workflows/probe-auth-pool.yml`, change the `Run cloud auth pool probe worker` env block to:

```yaml
        env:
          TURSO_DATABASE_URL: ${{ secrets.TURSO_DATABASE_URL }}
          TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}
          AUTH_POOL_ENCRYPTION_KEY: ${{ secrets.AUTH_POOL_ENCRYPTION_KEY }}
          TIGRIS_STORAGE_ACCESS_KEY_ID: ${{ secrets.TIGRIS_STORAGE_ACCESS_KEY_ID }}
          TIGRIS_STORAGE_SECRET_ACCESS_KEY: ${{ secrets.TIGRIS_STORAGE_SECRET_ACCESS_KEY }}
          TIGRIS_STORAGE_BUCKET: ${{ secrets.TIGRIS_STORAGE_BUCKET }}
```

- [ ] **Step 2: Verify the workflow file contains the new env values**

Run:

```bash
rg -n "TIGRIS_STORAGE_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET)" .github/workflows/probe-auth-pool.yml
```

Expected output includes all three lines:

```text
.github/workflows/probe-auth-pool.yml:31:          TIGRIS_STORAGE_ACCESS_KEY_ID: ${{ secrets.TIGRIS_STORAGE_ACCESS_KEY_ID }}
.github/workflows/probe-auth-pool.yml:32:          TIGRIS_STORAGE_SECRET_ACCESS_KEY: ${{ secrets.TIGRIS_STORAGE_SECRET_ACCESS_KEY }}
.github/workflows/probe-auth-pool.yml:33:          TIGRIS_STORAGE_BUCKET: ${{ secrets.TIGRIS_STORAGE_BUCKET }}
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/probe-auth-pool.yml
git commit -m "chore: pass tigris env to auth probe worker"
```

## Task 2: Write Migration Tests

**Files:**
- Create: `tests/auth-blob-migration.test.mjs`
- Create later in Task 3: `scripts/migrate_auth_blobs_to_object_storage.mjs`

- [ ] **Step 1: Create the failing test file**

Create `tests/auth-blob-migration.test.mjs` with:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/auth-blob-migration.test.mjs
```

Expected: FAIL with a module import error for `scripts/migrate_auth_blobs_to_object_storage.mjs`.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/auth-blob-migration.test.mjs
git commit -m "test: cover auth blob migration script"
```

## Task 3: Implement the Migration Script

**Files:**
- Create: `scripts/migrate_auth_blobs_to_object_storage.mjs`
- Test: `tests/auth-blob-migration.test.mjs`

- [ ] **Step 1: Create the migration script**

Create `scripts/migrate_auth_blobs_to_object_storage.mjs` with:

```js
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { authBlobKey, writeAuthBlob, readAuthBlob } from "../lib/auth-blob-storage.js";

const VALID_MODES = new Set(["scan", "write-only", "apply"]);

function normalizeLimit(value) {
  const limit = Number(value ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("--limit must be an integer from 1 to 1000");
  }
  return limit;
}

function parseArgs(argv) {
  const options = {
    databaseUrl: process.env.TURSO_DATABASE_URL || "",
    authToken: process.env.TURSO_AUTH_TOKEN || "",
    mode: "scan",
    limit: 50,
    backupPath: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") {
      options.databaseUrl = `file:${argv[index + 1]}`;
      options.authToken = "local-db";
      index += 1;
    } else if (arg === "--remote") {
      options.databaseUrl = process.env.TURSO_DATABASE_URL || "";
      options.authToken = process.env.TURSO_AUTH_TOKEN || "";
    } else if (arg === "--mode") {
      options.mode = argv[index + 1];
      index += 1;
    } else if (arg === "--limit") {
      options.limit = normalizeLimit(argv[index + 1]);
      index += 1;
    } else if (arg === "--backup-path") {
      options.backupPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!VALID_MODES.has(options.mode)) {
    throw new Error("--mode must be scan, write-only, or apply");
  }
  if (!options.databaseUrl) {
    throw new Error("database URL is required; pass --db PATH or --remote with TURSO_DATABASE_URL");
  }
  if (!options.authToken) {
    throw new Error("database auth token is required; pass --db PATH or set TURSO_AUTH_TOKEN");
  }
  return options;
}

async function tableColumns(client) {
  const result = await client.execute("PRAGMA table_info(auth_pool_entries)");
  if (result.rows.length === 0) {
    throw new Error("auth_pool_entries table does not exist");
  }
  return new Map(result.rows.map((row) => [row.name, row]));
}

async function ensureMigrationSchema(client) {
  let columns = await tableColumns(client);
  if (!columns.has("auth_blob_key")) {
    await client.execute("ALTER TABLE auth_pool_entries ADD COLUMN auth_blob_key TEXT");
    columns = await tableColumns(client);
  }
  const inlineColumnsAreNullable = ["encrypted_auth_json", "iv", "auth_tag"].every(
    (name) => columns.has(name) && Number(columns.get(name).notnull || 0) === 0
  );
  if (!inlineColumnsAreNullable) {
    await client.batch([
      "ALTER TABLE auth_pool_entries RENAME TO auth_pool_entries_before_blob_migration",
      `
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
          encrypted_auth_json TEXT,
          iv TEXT,
          auth_tag TEXT,
          auth_blob_key TEXT,
          PRIMARY KEY (source, account_id, session_id)
        )
      `,
      `
        INSERT INTO auth_pool_entries (
          source, account_id, session_id, email, name, plan_name, auth_last_refresh,
          auth_expires_at, digest, uploader_email, reporter_name, hostname,
          checked_out_by, uploaded_at, encrypted_auth_json, iv, auth_tag, auth_blob_key
        )
        SELECT
          source, account_id, COALESCE(session_id, ''), email, name, plan_name, auth_last_refresh,
          auth_expires_at, digest, uploader_email, reporter_name, hostname,
          checked_out_by, uploaded_at, encrypted_auth_json, iv, auth_tag, auth_blob_key
        FROM auth_pool_entries_before_blob_migration
      `,
      "DROP TABLE auth_pool_entries_before_blob_migration",
    ]);
  }
  await client.execute("CREATE INDEX IF NOT EXISTS auth_pool_entries_uploaded_at_idx ON auth_pool_entries(uploaded_at DESC)");
  await client.execute(`
    CREATE INDEX IF NOT EXISTS auth_pool_entries_pending_blob_idx
    ON auth_pool_entries(uploaded_at DESC)
    WHERE auth_blob_key IS NULL AND encrypted_auth_json IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL
  `);
}

async function candidateRows(client, limit) {
  const result = await client.execute({
    sql: `
      SELECT
        source, account_id, session_id, digest, encrypted_auth_json, iv, auth_tag
      FROM auth_pool_entries
      WHERE auth_blob_key IS NULL
        AND encrypted_auth_json IS NOT NULL
        AND iv IS NOT NULL
        AND auth_tag IS NOT NULL
      ORDER BY uploaded_at ASC
      LIMIT ?
    `,
    args: [limit],
  });
  return result.rows.map((row) => ({
    source: String(row.source),
    account_id: String(row.account_id),
    session_id: row.session_id ? String(row.session_id) : "",
    digest: String(row.digest),
    encrypted_auth_json: String(row.encrypted_auth_json),
    iv: String(row.iv),
    auth_tag: String(row.auth_tag),
  }));
}

function envelopeFor(row) {
  return {
    encrypted_auth_json: row.encrypted_auth_json,
    iv: row.iv,
    auth_tag: row.auth_tag,
  };
}

function assertEnvelopeEqual(actual, expected, key) {
  for (const name of ["encrypted_auth_json", "iv", "auth_tag"]) {
    if (actual?.[name] !== expected[name]) {
      throw new Error(`object verification failed for ${key}: ${name} mismatch`);
    }
  }
}

async function writeBackup(rows, backupPath) {
  if (!backupPath || rows.length === 0) {
    return null;
  }
  await mkdir(dirname(backupPath), { recursive: true });
  const body = rows.map((row) => JSON.stringify({ ...row, backed_up_at: new Date().toISOString() })).join("\n") + "\n";
  await appendFile(backupPath, body, "utf8");
  return backupPath;
}

async function updateRow(client, row, key) {
  const result = await client.execute({
    sql: `
      UPDATE auth_pool_entries
      SET auth_blob_key = ?, encrypted_auth_json = NULL, iv = NULL, auth_tag = NULL
      WHERE source = ?
        AND account_id = ?
        AND session_id = ?
        AND digest = ?
        AND auth_blob_key IS NULL
        AND encrypted_auth_json = ?
        AND iv = ?
        AND auth_tag = ?
    `,
    args: [
      key,
      row.source,
      row.account_id,
      row.session_id,
      row.digest,
      row.encrypted_auth_json,
      row.iv,
      row.auth_tag,
    ],
  });
  const rowsAffected = Number(result.rowsAffected || 0);
  if (rowsAffected !== 1) {
    throw new Error(`guarded update changed ${rowsAffected} rows for ${row.source}/${row.account_id}/${row.session_id || "default"}`);
  }
  return rowsAffected;
}

export async function migrateAuthBlobs({ databaseUrl, authToken, mode = "scan", limit = 50, backupPath = "" }) {
  if (!VALID_MODES.has(mode)) {
    throw new Error("mode must be scan, write-only, or apply");
  }
  const client = createClient({ url: databaseUrl, authToken });
  await ensureMigrationSchema(client);
  const rows = await candidateRows(client, normalizeLimit(limit));
  const summary = {
    ok: true,
    mode,
    candidates: rows.length,
    written: 0,
    updated: 0,
    backup_path: null,
    failures: [],
  };
  if (mode === "scan") {
    return summary;
  }
  if (mode === "apply") {
    summary.backup_path = await writeBackup(rows, backupPath);
  }
  for (const row of rows) {
    const key = authBlobKey({
      source: row.source,
      accountId: row.account_id,
      sessionId: row.session_id,
      digest: row.digest,
    });
    try {
      const envelope = envelopeFor(row);
      await writeAuthBlob(key, envelope);
      assertEnvelopeEqual(await readAuthBlob(key), envelope, key);
      summary.written += 1;
      if (mode === "apply") {
        summary.updated += await updateRow(client, row, key);
      }
    } catch (error) {
      summary.failures.push({
        source: row.source,
        account_id: row.account_id,
        session_id: row.session_id,
        error: String(error?.message || error),
      });
    }
  }
  summary.ok = summary.failures.length === 0;
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await migrateAuthBlobs(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Run the focused migration tests**

Run:

```bash
npm test -- tests/auth-blob-migration.test.mjs
```

Expected: PASS with 2 tests.

- [ ] **Step 3: Run the full JavaScript test suite**

Run:

```bash
npm test
```

Expected: PASS with all existing tests plus the new migration tests.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate_auth_blobs_to_object_storage.mjs tests/auth-blob-migration.test.mjs
git commit -m "feat: add auth blob object storage migration script"
```

## Task 4: Validate Against Local `database-beige-bell.db`

**Files:**
- No source changes.
- Uses local ignored file: `database-beige-bell.db`

- [ ] **Step 1: Copy the local DB before mutation**

Run:

```bash
cp database-beige-bell.db /tmp/database-beige-bell-auth-blob-migration.db
```

Expected: `/tmp/database-beige-bell-auth-blob-migration.db` exists and is about 48 MB.

- [ ] **Step 2: Scan the copied local DB**

Run:

```bash
AUTH_BLOB_STORAGE_DIR=/tmp/quota-auth-blob-local-test \
node scripts/migrate_auth_blobs_to_object_storage.mjs \
  --db /tmp/database-beige-bell-auth-blob-migration.db \
  --mode scan \
  --limit 100
```

Expected JSON shape:

```json
{
  "ok": true,
  "mode": "scan",
  "candidates": 44,
  "written": 0,
  "updated": 0,
  "backup_path": null,
  "failures": []
}
```

- [ ] **Step 3: Write objects without changing the copied DB**

Run:

```bash
AUTH_BLOB_STORAGE_DIR=/tmp/quota-auth-blob-local-test \
node scripts/migrate_auth_blobs_to_object_storage.mjs \
  --db /tmp/database-beige-bell-auth-blob-migration.db \
  --mode write-only \
  --limit 100
```

Expected: `written` equals `candidates`, `updated` equals `0`, and `failures` is `[]`.

- [ ] **Step 4: Apply migration to the copied DB**

Run:

```bash
AUTH_BLOB_STORAGE_DIR=/tmp/quota-auth-blob-local-test \
node scripts/migrate_auth_blobs_to_object_storage.mjs \
  --db /tmp/database-beige-bell-auth-blob-migration.db \
  --mode apply \
  --limit 100 \
  --backup-path /tmp/quota-auth-blob-local-backup.jsonl
```

Expected: `written` equals `44`, `updated` equals `44`, `failures` is `[]`, and `backup_path` is `/tmp/quota-auth-blob-local-backup.jsonl`.

- [ ] **Step 5: Verify the copied DB no longer has inline auth payloads**

Run:

```bash
sqlite3 /tmp/database-beige-bell-auth-blob-migration.db "
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN auth_blob_key IS NOT NULL THEN 1 ELSE 0 END) AS object_backed,
    SUM(CASE WHEN encrypted_auth_json IS NOT NULL OR iv IS NOT NULL OR auth_tag IS NOT NULL THEN 1 ELSE 0 END) AS inline_payloads
  FROM auth_pool_entries;
"
```

Expected:

```text
44|44|0
```

- [ ] **Step 6: Commit no source changes**

Run:

```bash
git status --short
```

Expected: no source changes from this task.

## Task 5: Document the Migration Runbook

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a runbook section**

Add this section after the existing Tigris environment variable paragraph:

```markdown
## Auth blob migration

Use `scripts/migrate_auth_blobs_to_object_storage.mjs` to move existing inline encrypted auth payloads out of Turso rows and into object storage.

Modes:

- `scan`: prepares schema and counts rows that still have inline encrypted auth payloads. It does not write objects or update rows.
- `write-only`: writes each encrypted payload envelope to object storage and reads it back for verification. It does not update rows.
- `apply`: writes and verifies each object, writes a JSONL backup of the encrypted envelopes, then clears the inline columns and stores `auth_blob_key`.

Local rehearsal:

```bash
cp database-beige-bell.db /tmp/database-beige-bell-auth-blob-migration.db

AUTH_BLOB_STORAGE_DIR=/tmp/quota-auth-blob-local-test \
node scripts/migrate_auth_blobs_to_object_storage.mjs \
  --db /tmp/database-beige-bell-auth-blob-migration.db \
  --mode scan \
  --limit 100

AUTH_BLOB_STORAGE_DIR=/tmp/quota-auth-blob-local-test \
node scripts/migrate_auth_blobs_to_object_storage.mjs \
  --db /tmp/database-beige-bell-auth-blob-migration.db \
  --mode write-only \
  --limit 100

AUTH_BLOB_STORAGE_DIR=/tmp/quota-auth-blob-local-test \
node scripts/migrate_auth_blobs_to_object_storage.mjs \
  --db /tmp/database-beige-bell-auth-blob-migration.db \
  --mode apply \
  --limit 100 \
  --backup-path /tmp/quota-auth-blob-local-backup.jsonl
```

Remote execution:

```bash
node scripts/migrate_auth_blobs_to_object_storage.mjs --remote --mode scan --limit 10
node scripts/migrate_auth_blobs_to_object_storage.mjs --remote --mode write-only --limit 10
node scripts/migrate_auth_blobs_to_object_storage.mjs --remote --mode apply --limit 10 --backup-path /tmp/quota-auth-blob-remote-backup.jsonl
node scripts/migrate_auth_blobs_to_object_storage.mjs --remote --mode apply --limit 1000 --backup-path /tmp/quota-auth-blob-remote-backup.jsonl
```

Before remote `apply`, confirm these variables are available to the process:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `TIGRIS_STORAGE_ACCESS_KEY_ID`
- `TIGRIS_STORAGE_SECRET_ACCESS_KEY`
- `TIGRIS_STORAGE_BUCKET`

Before remote rows are migrated, also configure the same three Tigris values as GitHub Actions secrets, because the scheduled probe worker reads object-backed auth rows.
```

- [ ] **Step 2: Verify README contains the runbook**

Run:

```bash
rg -n "Auth blob migration|write-only|quota-auth-blob-remote-backup" README.md
```

Expected: output includes all three terms.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add auth blob migration runbook"
```

## Task 6: Online Migration Execution Checklist

**Files:**
- No source changes.
- Requires deployed code from Tasks 1 through 5.

- [ ] **Step 1: Push the implementation branch**

Run:

```bash
git push
```

Expected: GitHub receives the commits and Vercel starts a deployment from `main` or the selected deployment branch.

- [ ] **Step 2: Confirm GitHub Actions secrets exist**

In GitHub repository settings, confirm these secrets exist before running remote `apply`:

```text
TIGRIS_STORAGE_ACCESS_KEY_ID
TIGRIS_STORAGE_SECRET_ACCESS_KEY
TIGRIS_STORAGE_BUCKET
```

Expected: all three names are present.

- [ ] **Step 3: Run remote scan**

Run from a shell that has Turso and Tigris env values:

```bash
node scripts/migrate_auth_blobs_to_object_storage.mjs --remote --mode scan --limit 10
```

Expected: JSON output has `"ok": true`, `"mode": "scan"`, and `"failures": []`.

- [ ] **Step 4: Run remote object write verification without DB mutation**

Run:

```bash
node scripts/migrate_auth_blobs_to_object_storage.mjs --remote --mode write-only --limit 10
```

Expected: JSON output has `"ok": true`, `"written"` equal to `"candidates"`, `"updated": 0`, and `"failures": []`.

- [ ] **Step 5: Run remote small-batch apply**

Run:

```bash
node scripts/migrate_auth_blobs_to_object_storage.mjs \
  --remote \
  --mode apply \
  --limit 10 \
  --backup-path /tmp/quota-auth-blob-remote-backup.jsonl
```

Expected: JSON output has `"ok": true`, `"written"` equal to `"updated"`, and `"failures": []`.

- [ ] **Step 6: Verify app and worker behavior after the small batch**

Run:

```bash
npm test
```

Expected: PASS.

Trigger the `Probe Auth Pool` GitHub workflow manually. Expected: workflow finishes successfully and prints JSON with `"ok": true`.

- [ ] **Step 7: Run the remaining remote apply**

Run:

```bash
node scripts/migrate_auth_blobs_to_object_storage.mjs \
  --remote \
  --mode apply \
  --limit 1000 \
  --backup-path /tmp/quota-auth-blob-remote-backup.jsonl
```

Expected: JSON output has `"ok": true`, `"failures": []`, and all remaining candidates are updated.

- [ ] **Step 8: Verify no inline payloads remain online**

Run:

```bash
node scripts/migrate_auth_blobs_to_object_storage.mjs --remote --mode scan --limit 1000
```

Expected:

```json
{
  "ok": true,
  "mode": "scan",
  "candidates": 0,
  "written": 0,
  "updated": 0,
  "backup_path": null,
  "failures": []
}
```

## Self-Review

Spec coverage:

- Local DB experiment is covered in Task 4 using `database-beige-bell.db`.
- Object storage extraction and verification is covered in Tasks 2, 3, 4, and 6.
- SQLite/Turso table structure optimization is covered in the Database Structure Decision and Task 3.
- Online migration is covered in Task 6.
- GitHub worker object-read readiness is covered in Task 1 and Task 6.

Placeholder scan:

- The plan uses exact file paths, exact commands, concrete expected output, and complete code for new tests and the migration script.
- No unresolved implementation placeholders remain.

Type consistency:

- `migrateAuthBlobs` is introduced in Task 3 and imported by the tests from Task 2.
- The migration modes are consistently `scan`, `write-only`, and `apply`.
- The payload fields remain `encrypted_auth_json`, `iv`, `auth_tag`, and `auth_blob_key` across tests, script, DB checks, and docs.
