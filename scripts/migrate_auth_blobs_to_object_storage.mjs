import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { authBlobKey, writeAuthBlob, readAuthBlob } from "../lib/auth-blob-storage.js";

const VALID_MODES = new Set(["scan", "write-only", "apply"]);
const INLINE_COLUMNS = ["encrypted_auth_json", "iv", "auth_tag"];

function normalizeLimit(value) {
  const limit = Number(value ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("--limit must be an integer from 1 to 1000");
  }
  return limit;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    databaseUrl: "",
    authToken: "",
    mode: "scan",
    limit: 50,
    backupPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") {
      options.databaseUrl = `file:${requireValue(argv, index, "--db")}`;
      options.authToken = "local-db";
      index += 1;
    } else if (arg === "--remote") {
      options.databaseUrl = process.env.TURSO_DATABASE_URL || "";
      options.authToken = process.env.TURSO_AUTH_TOKEN || "";
    } else if (arg === "--mode") {
      options.mode = requireValue(argv, index, "--mode");
      index += 1;
    } else if (arg === "--limit") {
      options.limit = normalizeLimit(requireValue(argv, index, "--limit"));
      index += 1;
    } else if (arg === "--backup-path") {
      options.backupPath = requireValue(argv, index, "--backup-path");
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  validateOptions(options);
  return options;
}

function validateOptions({ databaseUrl, authToken, mode, limit }) {
  if (!VALID_MODES.has(mode)) {
    throw new Error("--mode must be scan, write-only, or apply");
  }
  normalizeLimit(limit);
  if (!databaseUrl) {
    throw new Error("database URL is required; pass --db PATH or --remote with TURSO_DATABASE_URL");
  }
  if (!authToken) {
    throw new Error("database auth token is required; pass --db PATH or set TURSO_AUTH_TOKEN");
  }
}

async function authPoolColumns(client) {
  const result = await client.execute("PRAGMA table_info(auth_pool_entries)");
  if (result.rows.length === 0) {
    throw new Error("auth_pool_entries table does not exist");
  }
  return new Map(result.rows.map((row) => [row.name, row]));
}

async function ensureMigrationSchema(client) {
  let columns = await authPoolColumns(client);
  if (!columns.has("auth_blob_key")) {
    await client.execute("ALTER TABLE auth_pool_entries ADD COLUMN auth_blob_key TEXT");
    columns = await authPoolColumns(client);
  }

  const inlineColumnsAreNullable = INLINE_COLUMNS.every(
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
    WHERE auth_blob_key IS NULL
      AND encrypted_auth_json IS NOT NULL
      AND iv IS NOT NULL
      AND auth_tag IS NOT NULL
  `);
}

async function candidateRows(client, limit) {
  const result = await client.execute({
    sql: `
      SELECT
        source,
        account_id,
        session_id,
        digest,
        encrypted_auth_json,
        iv,
        auth_tag
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
  for (const name of INLINE_COLUMNS) {
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
  const backedUpAt = new Date().toISOString();
  const body = rows.map((row) => JSON.stringify({ ...row, backed_up_at: backedUpAt })).join("\n") + "\n";
  await appendFile(backupPath, body, "utf8");
  return backupPath;
}

async function updateRow(client, row, key) {
  const result = await client.execute({
    sql: `
      UPDATE auth_pool_entries
      SET auth_blob_key = ?,
          encrypted_auth_json = NULL,
          iv = NULL,
          auth_tag = NULL
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
  const normalizedLimit = normalizeLimit(limit);
  if (!VALID_MODES.has(mode)) {
    throw new Error("mode must be scan, write-only, or apply");
  }
  if (!databaseUrl || !authToken) {
    throw new Error("databaseUrl and authToken are required");
  }

  const client = createClient({ url: databaseUrl, authToken });
  await ensureMigrationSchema(client);
  const rows = await candidateRows(client, normalizedLimit);
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
  return result;
}

function errorSummary(error) {
  return {
    ok: false,
    mode: null,
    candidates: 0,
    written: 0,
    updated: 0,
    backup_path: null,
    failures: [{ error: String(error?.message || error) }],
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((error) => {
    console.error(JSON.stringify(errorSummary(error), null, 2));
    process.exit(1);
  });
}
