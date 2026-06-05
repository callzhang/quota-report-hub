import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import {
  decryptAuthJson,
  deriveAuthPoolEntry,
  encryptAuthJson,
  pickBestAuthPoolCandidate,
  shouldReplaceAuthPoolEntry,
} from "./auth-pool.js";
import { companyEmailAllowed, normalizeEmail, signTokenPayload, tokenHash, verifyTokenPayload } from "./company-auth.js";
import { mergeLatestReport, sanitizeReport } from "./reports.js";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let schemaReady;
let authPoolPkColumns = "source, account_id";

async function migrateAuthPoolEntriesPrimaryKey() {
  const pkResult = await client.execute(`PRAGMA table_info(auth_pool_entries)`);
  const pkCols = pkResult.rows
    .filter((row) => row.pk > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => row.name);

  if (pkCols.join(", ") === "source, account_id, session_id") {
    authPoolPkColumns = "source, account_id, session_id";
    return;
  }

  await client.batch([
    `ALTER TABLE auth_pool_entries RENAME TO auth_pool_entries_old_pk`,
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
        encrypted_auth_json TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        PRIMARY KEY (source, account_id, session_id)
      )
    `,
    `
      INSERT INTO auth_pool_entries (
        source, account_id, session_id, email, name, plan_name, auth_last_refresh, auth_expires_at, digest,
        uploader_email, reporter_name, hostname, checked_out_by, uploaded_at, encrypted_auth_json, iv, auth_tag
      )
      SELECT
        source, account_id, COALESCE(session_id, ''), email, name, plan_name, auth_last_refresh, auth_expires_at, digest,
        uploader_email, reporter_name, hostname, checked_out_by, uploaded_at, encrypted_auth_json, iv, auth_tag
      FROM auth_pool_entries_old_pk
    `,
    `DROP TABLE auth_pool_entries_old_pk`,
  ]);
  authPoolPkColumns = "source, account_id, session_id";
}

function rowToReport(row) {
  const payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  return {
    source: row.source,
    hostname: row.hostname,
    reporter_name: row.reporter_name,
    reported_at: row.reported_at,
    account_id: row.account_id,
    email: row.email,
    name: row.name,
    plan_name: row.plan_name,
    auth_path: row.auth_path,
    auth_last_refresh: row.auth_last_refresh,
    status: row.status,
    error: row.error,
    model_context_window: row.model_context_window,
    usage_summary: payload.usage_summary || null,
    report_origin: payload.report_origin || (payload.usage_summary?.probe_source === "github_actions_worker" ? "worker" : "unknown"),
    windows_stale: Boolean(payload.windows_stale),
    windows: {
      "5h": row.five_h_remaining_percent === null && row.five_h_reset_at === null && row.five_h_used_percent === null
        ? null
        : {
            used_percent: row.five_h_used_percent === null ? null : Number(row.five_h_used_percent),
            remaining_percent: row.five_h_remaining_percent === null ? null : Number(row.five_h_remaining_percent),
            reset_at: row.five_h_reset_at,
          },
      "1week": row.one_week_remaining_percent === null && row.one_week_reset_at === null && row.one_week_used_percent === null
        ? null
        : {
            used_percent: row.one_week_used_percent === null ? null : Number(row.one_week_used_percent),
            remaining_percent: row.one_week_remaining_percent === null ? null : Number(row.one_week_remaining_percent),
            reset_at: row.one_week_reset_at,
          },
    },
  };
}

function serializeReport(report) {
  const fiveHour = report.windows["5h"];
  const oneWeek = report.windows["1week"];

  return {
    args: [
      report.source,
      report.account_id,
      report.hostname,
      report.reporter_name,
      report.reported_at,
      report.email,
      report.name,
      report.plan_name,
      report.auth_path,
      report.auth_last_refresh,
      report.status,
      report.error,
      report.model_context_window,
      fiveHour?.used_percent ?? null,
      fiveHour?.remaining_percent ?? null,
      fiveHour?.reset_at ?? null,
      oneWeek?.used_percent ?? null,
      oneWeek?.remaining_percent ?? null,
      oneWeek?.reset_at ?? null,
      JSON.stringify(report),
    ],
    eventArgs: [
      crypto.randomUUID(),
      report.source,
      report.hostname,
      report.reporter_name,
      report.reported_at,
      report.account_id,
      report.email,
      report.name,
      report.plan_name,
      report.auth_path,
      report.auth_last_refresh,
      report.status,
      report.error,
      report.model_context_window,
      fiveHour?.used_percent ?? null,
      fiveHour?.remaining_percent ?? null,
      fiveHour?.reset_at ?? null,
      oneWeek?.used_percent ?? null,
      oneWeek?.remaining_percent ?? null,
      oneWeek?.reset_at ?? null,
      JSON.stringify(report),
    ],
  };
}

function isHardAuthInvalidationReport(report) {
  return (
    report.status === "error" &&
    (
      report.error === "auth invalidated (token_invalidated)" ||
      report.error === "auth failed (401 unauthorized)" ||
      report.error === "claude auth invalid (authentication_error)"
    )
  );
}

async function insertAuthPoolQuotaEvent(report) {
  const { eventArgs } = serializeReport(report);
  await client.execute({
    sql: `
      INSERT INTO auth_pool_quota_events (
        id, source, hostname, reporter_name, reported_at, account_id, email, name, plan_name, auth_path,
        auth_last_refresh, status, error, model_context_window,
        five_h_used_percent, five_h_remaining_percent, five_h_reset_at,
        one_week_used_percent, one_week_remaining_percent, one_week_reset_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: eventArgs,
  });
}

async function continuousHardInvalidationSince({ source, accountId }) {
  const result = await client.execute({
    sql: `
      SELECT
        source,
        hostname,
        reporter_name,
        reported_at,
        account_id,
        email,
        name,
        plan_name,
        auth_path,
        auth_last_refresh,
        status,
        error,
        model_context_window,
        five_h_used_percent,
        five_h_remaining_percent,
        five_h_reset_at,
        one_week_used_percent,
        one_week_remaining_percent,
        one_week_reset_at,
        payload_json
      FROM auth_pool_quota_events
      WHERE source = ? AND account_id = ?
      ORDER BY reported_at DESC, id DESC
      LIMIT 1000
    `,
    args: [String(source), String(accountId)],
  });

  let firstInvalidatedAt = null;
  for (const row of result.rows) {
    const report = rowToReport(row);
    if (!isHardAuthInvalidationReport(report)) {
      break;
    }
    firstInvalidatedAt = report.reported_at;
  }
  return firstInvalidatedAt;
}

export async function upsertAuthPoolQuota(report) {
  await ensureSchema();
  const incoming = sanitizeReport(report);
  await insertAuthPoolQuotaEvent(incoming);
  const existingResult = await client.execute({
    sql: `
      SELECT
        source,
        hostname,
        reporter_name,
        reported_at,
        account_id,
        email,
        name,
        plan_name,
        auth_path,
        auth_last_refresh,
        status,
        error,
        model_context_window,
        five_h_used_percent,
        five_h_remaining_percent,
        five_h_reset_at,
        one_week_used_percent,
        one_week_remaining_percent,
        one_week_reset_at,
        payload_json
      FROM auth_pool_quota_latest
      WHERE source = ? AND account_id = ?
    `,
    args: [incoming.source, incoming.account_id],
  });
  const previous = existingResult.rows[0] ? rowToReport(existingResult.rows[0]) : null;
  const merged = mergeLatestReport(previous, incoming);
  const { args } = serializeReport(merged);
  await client.execute({
    sql: `
      INSERT INTO auth_pool_quota_latest (
        source, account_id, hostname, reporter_name, reported_at, email, name, plan_name, auth_path,
        auth_last_refresh, status, error, model_context_window,
        five_h_used_percent, five_h_remaining_percent, five_h_reset_at,
        one_week_used_percent, one_week_remaining_percent, one_week_reset_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, account_id) DO UPDATE SET
        hostname = excluded.hostname,
        reporter_name = excluded.reporter_name,
        reported_at = excluded.reported_at,
        email = excluded.email,
        name = excluded.name,
        plan_name = excluded.plan_name,
        auth_path = excluded.auth_path,
        auth_last_refresh = excluded.auth_last_refresh,
        status = excluded.status,
        error = excluded.error,
        model_context_window = excluded.model_context_window,
        five_h_used_percent = excluded.five_h_used_percent,
        five_h_remaining_percent = excluded.five_h_remaining_percent,
        five_h_reset_at = excluded.five_h_reset_at,
        one_week_used_percent = excluded.one_week_used_percent,
        one_week_remaining_percent = excluded.one_week_remaining_percent,
        one_week_reset_at = excluded.one_week_reset_at,
        payload_json = excluded.payload_json
    `,
    args,
  });
  if (isHardAuthInvalidationReport(incoming)) {
    const continuousSince = await continuousHardInvalidationSince({
      source: incoming.source,
      accountId: incoming.account_id,
    });
    await upsertInvalidatedAuthState({
      source: incoming.source,
      accountId: incoming.account_id,
      invalidatedAt: continuousSince || incoming.reported_at,
      error: incoming.error,
    });
  } else {
    await clearInvalidatedAuthState({ source: incoming.source, accountId: incoming.account_id });
  }
}

export function dbConfigured() {
  return Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
}

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS auth_pool_entries (
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
      // Migrate existing tables that may not have session_id or checked_out_by
      for (const col of ['session_id', 'checked_out_by', 'auth_expires_at']) {
        await client.execute(`ALTER TABLE auth_pool_entries ADD COLUMN ${col} TEXT`)
          .catch(() => {}); // ignore if column already exists
      }
      // Backfill NULL session_id to '' for entries from before the column existed
      await client.execute(`UPDATE auth_pool_entries SET session_id = '' WHERE session_id IS NULL`)
        .catch(() => {});
      await migrateAuthPoolEntriesPrimaryKey();
      await client.execute(`
        CREATE TABLE IF NOT EXISTS auth_pool_quota_latest (
          source TEXT NOT NULL,
          account_id TEXT NOT NULL,
          hostname TEXT NOT NULL,
          reporter_name TEXT NOT NULL,
          reported_at TEXT NOT NULL,
          email TEXT,
          name TEXT,
          plan_name TEXT,
          auth_path TEXT,
          auth_last_refresh TEXT,
          status TEXT NOT NULL,
          error TEXT,
          model_context_window INTEGER,
          five_h_used_percent REAL,
          five_h_remaining_percent REAL,
          five_h_reset_at TEXT,
          one_week_used_percent REAL,
          one_week_remaining_percent REAL,
          one_week_reset_at TEXT,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (source, account_id)
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS auth_pool_quota_events (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          hostname TEXT NOT NULL,
          reporter_name TEXT NOT NULL,
          reported_at TEXT NOT NULL,
          account_id TEXT NOT NULL,
          email TEXT,
          name TEXT,
          plan_name TEXT,
          auth_path TEXT,
          auth_last_refresh TEXT,
          status TEXT NOT NULL,
          error TEXT,
          model_context_window INTEGER,
          five_h_used_percent REAL,
          five_h_remaining_percent REAL,
          five_h_reset_at TEXT,
          one_week_used_percent REAL,
          one_week_remaining_percent REAL,
          one_week_reset_at TEXT,
          payload_json TEXT NOT NULL
        )
      `);
      await client.execute(`
        CREATE INDEX IF NOT EXISTS auth_pool_quota_events_account_reported_at_idx
          ON auth_pool_quota_events (source, account_id, reported_at DESC)
      `);
      await client.execute(`
        CREATE INDEX IF NOT EXISTS auth_pool_quota_events_reported_at_idx
          ON auth_pool_quota_events (reported_at DESC)
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS auth_users (
          email TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          last_token_issued_at TEXT NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS auth_api_tokens (
          token_hash TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS auth_pool_fetch_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fetched_at TEXT NOT NULL,
          requester_email TEXT NOT NULL,
          requester_id TEXT,
          source TEXT NOT NULL,
          served_account_id TEXT,
          served_email TEXT,
          served_uploader_email TEXT,
          served_digest TEXT,
          current_account_id TEXT,
          current_five_h_remaining REAL,
          current_one_week_remaining REAL,
          reason TEXT NOT NULL
        )
      `);
      await client.execute(`
        CREATE INDEX IF NOT EXISTS auth_pool_fetch_log_fetched_at_idx
          ON auth_pool_fetch_log (fetched_at DESC)
      `);
      await client.execute(`ALTER TABLE auth_pool_fetch_log ADD COLUMN requester_id TEXT`)
        .catch(() => {});
      await client.execute(`
        CREATE TABLE IF NOT EXISTS auth_pool_invalidated_notifications (
          source TEXT NOT NULL,
          account_id TEXT NOT NULL,
          first_invalidated_at TEXT NOT NULL,
          last_notified_at TEXT,
          last_error TEXT,
          PRIMARY KEY (source, account_id)
        )
      `);
    })();
  }
  await schemaReady;
}

export async function upsertAuthPoolEntry(rawEntry) {
  await ensureSchema();
  const derived = deriveAuthPoolEntry(rawEntry.source, rawEntry.auth_json, rawEntry);
  const sessionId = String(derived.session_id || rawEntry.session_id || '');

  const existingResult = await client.execute({
    sql: `
      SELECT
        source,
        account_id,
        session_id,
        email,
        name,
        plan_name,
        auth_last_refresh,
        auth_expires_at,
        digest,
        uploader_email,
        reporter_name,
        hostname,
        uploaded_at,
        encrypted_auth_json,
        iv,
        auth_tag
      FROM auth_pool_entries
      WHERE source = ? AND account_id = ? AND session_id = ?
    `,
    args: [derived.source, derived.account_id, sessionId],
  });
  const existingRow = existingResult.rows[0]
    ? {
        source: existingResult.rows[0].source,
        account_id: existingResult.rows[0].account_id,
        session_id: existingResult.rows[0].session_id,
        email: existingResult.rows[0].email,
        name: existingResult.rows[0].name,
        plan_name: existingResult.rows[0].plan_name,
        auth_last_refresh: existingResult.rows[0].auth_last_refresh,
        auth_expires_at: existingResult.rows[0].auth_expires_at,
        digest: existingResult.rows[0].digest,
        uploader_email: existingResult.rows[0].uploader_email,
        reporter_name: existingResult.rows[0].reporter_name,
        hostname: existingResult.rows[0].hostname,
        uploaded_at: existingResult.rows[0].uploaded_at,
        encrypted_auth_json: existingResult.rows[0].encrypted_auth_json,
        iv: existingResult.rows[0].iv,
        auth_tag: existingResult.rows[0].auth_tag,
      }
    : null;
  if (!shouldReplaceAuthPoolEntry(existingRow, derived)) {
    return {
      source: existingRow.source,
      account_id: existingRow.account_id,
      session_id: existingRow.session_id,
      email: existingRow.email,
      name: existingRow.name,
      plan_name: existingRow.plan_name,
      auth_last_refresh: existingRow.auth_last_refresh,
      auth_expires_at: existingRow.auth_expires_at,
      digest: existingRow.digest,
      uploader_email: existingRow.uploader_email,
      reporter_name: existingRow.reporter_name,
      hostname: existingRow.hostname,
      uploaded_at: existingRow.uploaded_at,
      deduplicated: true,
    };
  }
  const encrypted = encryptAuthJson(derived.auth_json);
  const uploadedAt = new Date().toISOString();

  // Purge stale entries for the same email with a different account_id (e.g. old UUID-based
  // entries from before canonicalCodexAccountId switched to email-based account_ids).
  if (derived.email && derived.source === "codex") {
    await client.execute({
      sql: `DELETE FROM auth_pool_entries WHERE source = ? AND email = ? AND account_id != ?`,
      args: [derived.source, derived.email, derived.account_id],
    });
    await client.execute({
      sql: `DELETE FROM auth_pool_quota_latest WHERE source = ? AND email = ? AND account_id != ?`,
      args: [derived.source, derived.email, derived.account_id],
    });
  }

  await client.execute({
    sql: `
      INSERT INTO auth_pool_entries (
        source, account_id, session_id, email, name, plan_name, auth_last_refresh, auth_expires_at, digest, uploader_email,
        reporter_name, hostname, uploaded_at, encrypted_auth_json, iv, auth_tag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(${authPoolPkColumns}) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        plan_name = excluded.plan_name,
        auth_last_refresh = excluded.auth_last_refresh,
        auth_expires_at = excluded.auth_expires_at,
        digest = excluded.digest,
        reporter_name = excluded.reporter_name,
        hostname = excluded.hostname,
        uploaded_at = excluded.uploaded_at,
        encrypted_auth_json = excluded.encrypted_auth_json,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag
    `,
    args: [
      derived.source,
      derived.account_id,
      sessionId,
      derived.email,
      derived.name,
      derived.plan_name,
      derived.auth_last_refresh,
      derived.auth_expires_at,
      derived.digest,
      rawEntry.uploader_email ? normalizeEmail(rawEntry.uploader_email) : null,
      derived.reporter_name,
      derived.hostname,
      uploadedAt,
      encrypted.encrypted_auth_json,
      encrypted.iv,
      encrypted.auth_tag,
    ],
  });

  return {
    source: derived.source,
    account_id: derived.account_id,
    session_id: sessionId,
    email: derived.email,
    name: derived.name,
    plan_name: derived.plan_name,
    auth_last_refresh: derived.auth_last_refresh,
    auth_expires_at: derived.auth_expires_at,
    digest: derived.digest,
    uploader_email: rawEntry.uploader_email ? normalizeEmail(rawEntry.uploader_email) : null,
    reporter_name: derived.reporter_name,
    hostname: derived.hostname,
    uploaded_at: uploadedAt,
    deduplicated: false,
  };
}

export async function authPoolEntries() {
  await ensureSchema();
  const result = await client.execute(`
    SELECT
      source,
      account_id,
      session_id,
      email,
      name,
      plan_name,
      auth_last_refresh,
      auth_expires_at,
      digest,
      uploader_email,
      reporter_name,
      hostname,
      uploaded_at,
      encrypted_auth_json,
      iv,
      auth_tag
    FROM auth_pool_entries
    ORDER BY uploaded_at DESC
  `);
  return result.rows.map((row) => ({
    source: row.source,
    account_id: row.account_id,
    session_id: row.session_id || "",
    email: row.email,
    name: row.name,
    plan_name: row.plan_name,
    auth_last_refresh: row.auth_last_refresh,
    auth_expires_at: row.auth_expires_at,
    digest: row.digest,
    uploader_email: row.uploader_email,
    reporter_name: row.reporter_name,
    hostname: row.hostname,
    uploaded_at: row.uploaded_at,
    encrypted_auth_json: row.encrypted_auth_json,
    iv: row.iv,
    auth_tag: row.auth_tag,
  }));
}

export async function authPoolEntry(source, accountId, sessionId = null) {
  await ensureSchema();
  const result = await client.execute({
    sql: sessionId
      ? `
      SELECT
        source,
        account_id,
        session_id,
        email,
        name,
        plan_name,
        auth_last_refresh,
        digest,
        uploader_email,
        reporter_name,
        hostname,
        uploaded_at,
        encrypted_auth_json,
        iv,
        auth_tag
      FROM auth_pool_entries
      WHERE source = ? AND account_id = ? AND session_id = ?
    `
      : `
      SELECT
        source,
        account_id,
        session_id,
        email,
        name,
        plan_name,
        auth_last_refresh,
        digest,
        uploader_email,
        reporter_name,
        hostname,
        uploaded_at,
        encrypted_auth_json,
        iv,
        auth_tag
      FROM auth_pool_entries
      WHERE source = ? AND account_id = ?
      ORDER BY uploaded_at DESC
      LIMIT 1
    `,
    args: sessionId ? [source, accountId, sessionId] : [source, accountId],
  });
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    source: row.source,
    account_id: row.account_id,
    session_id: row.session_id || "",
    email: row.email,
    name: row.name,
    plan_name: row.plan_name,
    auth_last_refresh: row.auth_last_refresh,
    auth_expires_at: row.auth_expires_at,
    digest: row.digest,
    uploader_email: row.uploader_email,
    reporter_name: row.reporter_name,
    hostname: row.hostname,
    uploaded_at: row.uploaded_at,
    encrypted_auth_json: row.encrypted_auth_json,
    iv: row.iv,
    auth_tag: row.auth_tag,
  };
}

export async function deleteAuthPoolEntry({ source, accountId, sessionId = null }) {
  await ensureSchema();
  const normalizedSource = String(source);
  const normalizedAccountId = String(accountId);
  const normalizedSessionId = sessionId ? String(sessionId) : null;
  const existing = await authPoolEntry(normalizedSource, normalizedAccountId, normalizedSessionId);
  const entryWhere = normalizedSessionId
    ? { sql: `DELETE FROM auth_pool_entries WHERE source = ? AND account_id = ? AND session_id = ?`,
        args: [normalizedSource, normalizedAccountId, normalizedSessionId] }
    : { sql: `DELETE FROM auth_pool_entries WHERE source = ? AND account_id = ?`,
        args: [normalizedSource, normalizedAccountId] };
  await client.batch([
    entryWhere,
    {
      sql: `DELETE FROM auth_pool_quota_latest WHERE source = ? AND account_id = ?`,
      args: [normalizedSource, normalizedAccountId],
    },
    {
      sql: `DELETE FROM auth_pool_invalidated_notifications WHERE source = ? AND account_id = ?`,
      args: [normalizedSource, normalizedAccountId],
    },
  ]);
  return {
    deleted: Boolean(existing),
    source: normalizedSource,
    account_id: normalizedAccountId,
    session_id: normalizedSessionId,
    entry: existing,
  };
}

export async function authPoolQuotaLatest() {
  await ensureSchema();
  const result = await client.execute(`
    SELECT
      source,
      hostname,
      reporter_name,
      reported_at,
      account_id,
      email,
      name,
      plan_name,
      auth_path,
      auth_last_refresh,
      status,
      error,
      model_context_window,
      five_h_used_percent,
      five_h_remaining_percent,
      five_h_reset_at,
      one_week_used_percent,
      one_week_remaining_percent,
      one_week_reset_at,
      payload_json
    FROM auth_pool_quota_latest
    ORDER BY reported_at DESC
  `);
  return result.rows.map((row) => rowToReport(row));
}

export async function authPoolQuotaLatestForEntry({ source, accountId }) {
  await ensureSchema();
  const result = await client.execute({
    sql: `
      SELECT
        source,
        hostname,
        reporter_name,
        reported_at,
        account_id,
        email,
        name,
        plan_name,
        auth_path,
        auth_last_refresh,
        status,
        error,
        model_context_window,
        five_h_used_percent,
        five_h_remaining_percent,
        five_h_reset_at,
        one_week_used_percent,
        one_week_remaining_percent,
        one_week_reset_at,
        payload_json
      FROM auth_pool_quota_latest
      WHERE source = ? AND account_id = ?
    `,
    args: [String(source), String(accountId)],
  });
  return result.rows[0] ? rowToReport(result.rows[0]) : null;
}

export async function authPoolQuotaEvents({ source = null, accountId = null, limit = 200 } = {}) {
  await ensureSchema();
  const filters = [];
  const args = [];
  if (source) {
    filters.push("source = ?");
    args.push(String(source));
  }
  if (accountId) {
    filters.push("account_id = ?");
    args.push(String(accountId));
  }
  args.push(Number(limit) || 200);
  const result = await client.execute({
    sql: `
      SELECT
        source,
        hostname,
        reporter_name,
        reported_at,
        account_id,
        email,
        name,
        plan_name,
        auth_path,
        auth_last_refresh,
        status,
        error,
        model_context_window,
        five_h_used_percent,
        five_h_remaining_percent,
        five_h_reset_at,
        one_week_used_percent,
        one_week_remaining_percent,
        one_week_reset_at,
        payload_json
      FROM auth_pool_quota_events
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY reported_at DESC
      LIMIT ?
    `,
    args,
  });
  return result.rows.map((row) => rowToReport(row));
}

export async function bestAuthPoolEntry(options = {}) {
  const reports = await authPoolQuotaLatest();
  const pool = await authPoolEntries();
  const activeAssignmentWindowSeconds = Number(options.active_assignment_window_seconds ?? 7 * 24 * 60 * 60);
  const activeSince = Number.isFinite(activeAssignmentWindowSeconds) && activeAssignmentWindowSeconds > 0
    ? new Date(Date.now() - activeAssignmentWindowSeconds * 1000).toISOString()
    : null;
  const activeAssignmentCounts = await authPoolActiveAssignmentCounts({
    source: options.source || "codex",
    since: activeSince,
  });
  const activeReporterCounts = await authPoolActiveReporterCounts({
    source: options.source || "codex",
    since: activeSince,
  });
  const activeCounts = { ...activeAssignmentCounts };
  for (const [accountId, count] of Object.entries(activeReporterCounts)) {
    activeCounts[accountId] = Math.max(Number(activeCounts[accountId] || 0), Number(count || 0));
  }
  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    ...options,
    selection_key: options.selection_key || options.requester_email || null,
    recent_served_counts: {
      ...activeCounts,
      ...(options.recent_served_counts || {}),
    },
  });
  if (!candidate) {
    return null;
  }
  return {
    ...candidate.entry,
    auth_json: decryptAuthJson(candidate.entry),
    report: candidate.report,
  };
}

export async function hasUploadedAuth({ source, uploaderEmail }) {
  await ensureSchema();
  const result = await client.execute({
    sql: `
      SELECT 1
      FROM auth_pool_entries e
      INNER JOIN auth_pool_quota_latest q
        ON e.source = q.source AND e.account_id = q.account_id
      WHERE e.source = ?
        AND e.uploader_email = ?
        AND NOT (
          (q.status = 'error' AND (
            q.error = 'auth invalidated (token_invalidated)'
            OR q.error = 'auth failed (401 unauthorized)'
            OR q.error = 'claude auth email unavailable'
          ))
          OR q.plan_name = 'Free'
        )
        AND (q.five_h_remaining_percent IS NOT NULL OR q.one_week_remaining_percent IS NOT NULL)
      LIMIT 1
    `,
    args: [String(source), normalizeEmail(uploaderEmail)],
  });
  return result.rows.length > 0;
}

export async function hasUploadedAnyHealthyAuth({ uploaderEmail }) {
  await ensureSchema();
  const result = await client.execute({
    sql: `
      SELECT 1
      FROM auth_pool_entries e
      INNER JOIN auth_pool_quota_latest q
        ON e.source = q.source AND e.account_id = q.account_id
      WHERE e.uploader_email = ?
        AND NOT (
          (q.status = 'error' AND (
            q.error = 'auth invalidated (token_invalidated)'
            OR q.error = 'auth failed (401 unauthorized)'
            OR q.error = 'claude auth email unavailable'
          ))
          OR q.plan_name = 'Free'
        )
        AND (q.five_h_remaining_percent IS NOT NULL OR q.one_week_remaining_percent IS NOT NULL)
      LIMIT 1
    `,
    args: [normalizeEmail(uploaderEmail)],
  });
  return result.rows.length > 0;
}

export async function getInvalidatedUploaderEntry({ source, uploaderEmail, accountId = null }) {
  await ensureSchema();
  if (!accountId) {
    return null;
  }
  const result = await client.execute({
    sql: `
      SELECT
        e.source,
        e.account_id,
        e.session_id,
        e.email,
        e.name,
        e.plan_name,
        e.auth_last_refresh,
        e.auth_expires_at,
        e.digest,
        e.uploader_email,
        e.reporter_name,
        e.hostname,
        e.uploaded_at,
        e.encrypted_auth_json,
        e.iv,
        e.auth_tag
      FROM auth_pool_entries e
      INNER JOIN auth_pool_quota_latest q
        ON e.source = q.source AND e.account_id = q.account_id
      WHERE e.source = ?
        AND e.uploader_email = ?
        AND e.account_id = ?
        AND (
          (q.status = 'error' AND (
            q.error = 'auth invalidated (token_invalidated)'
            OR q.error = 'auth failed (401 unauthorized)'
            OR q.error = 'claude auth email unavailable'
          ))
          OR q.plan_name = 'Free'
        )
      ORDER BY e.uploaded_at DESC
      LIMIT 1
    `,
    args: [String(source), normalizeEmail(uploaderEmail), String(accountId)],
  });

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const entry = {
    source: row.source,
    account_id: row.account_id,
    session_id: row.session_id || "",
    email: row.email,
    name: row.name,
    plan_name: row.plan_name,
    auth_last_refresh: row.auth_last_refresh,
    auth_expires_at: row.auth_expires_at,
    digest: row.digest,
    uploader_email: row.uploader_email,
    reporter_name: row.reporter_name,
    hostname: row.hostname,
    uploaded_at: row.uploaded_at,
    encrypted_auth_json: row.encrypted_auth_json,
    iv: row.iv,
    auth_tag: row.auth_tag,
  };

  return {
    ...entry,
    auth_json: decryptAuthJson(entry),
  };
}

export async function issueApiToken(email) {
  await ensureSchema();
  const normalizedEmail = normalizeEmail(email);
  const { token: rawToken, created_at: createdAt } = signTokenPayload(normalizedEmail);

  await client.execute({
    sql: `
      INSERT INTO auth_users (email, created_at, last_token_issued_at)
      VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        last_token_issued_at = excluded.last_token_issued_at
    `,
    args: [normalizedEmail, createdAt, createdAt],
  });

  await client.execute({
    sql: `DELETE FROM auth_api_tokens WHERE email = ?`,
    args: [normalizedEmail],
  });

  await client.execute({
    sql: `
      INSERT INTO auth_api_tokens (token_hash, email, created_at, last_used_at)
      VALUES (?, ?, ?, ?)
    `,
    args: [tokenHash(rawToken), normalizedEmail, createdAt, createdAt],
  });

  return {
    token: rawToken,
    email: normalizedEmail,
    created_at: createdAt,
  };
}

export async function authenticateOrUpgradeApiToken(rawToken) {
  const authContext = await authenticateApiToken(rawToken);
  if (authContext) {
    if (String(rawToken || "").startsWith("qrp_")) {
      const token = await issueApiToken(authContext.email);
      return {
        ...authContext,
        token_upgrade: {
          auth_pool_user_token: token.token,
          email: token.email,
          created_at: token.created_at,
          reason: "legacy_token_upgraded",
        },
      };
    }
    return authContext;
  }

  const verified = verifyTokenPayload(rawToken);
  if (!verified || !companyEmailAllowed(verified.email)) {
    return null;
  }

  const token = await issueApiToken(verified.email);
  return {
    email: token.email,
    created_at: token.created_at,
    last_used_at: token.created_at,
    token_upgrade: {
      auth_pool_user_token: token.token,
      email: token.email,
      created_at: token.created_at,
      reason: "signed_token_reissued",
    },
  };
}

export async function recordAuthPoolFetch({
  requesterEmail,
  requesterId = null,
  source,
  servedEntry = null,
  reason,
  currentAccountId = null,
  currentQuota = null,
}) {
  await ensureSchema();
  const fetchedAt = new Date().toISOString();
  await client.execute({
    sql: `
      INSERT INTO auth_pool_fetch_log (
        fetched_at, requester_email, requester_id, source,
        served_account_id, served_email, served_uploader_email, served_digest,
        current_account_id, current_five_h_remaining, current_one_week_remaining, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      fetchedAt,
      normalizeEmail(requesterEmail),
      requesterId ? String(requesterId) : null,
      String(source),
      servedEntry?.account_id ?? null,
      servedEntry?.email ?? null,
      servedEntry?.uploader_email ?? null,
      servedEntry?.digest ?? null,
      currentAccountId ? String(currentAccountId) : null,
      Number.isFinite(currentQuota?.five_h_remaining_percent)
        ? Number(currentQuota.five_h_remaining_percent)
        : null,
      Number.isFinite(currentQuota?.one_week_remaining_percent)
        ? Number(currentQuota.one_week_remaining_percent)
        : null,
      String(reason),
    ],
  });
}

export async function authPoolActiveAssignmentCounts({ source, since = null } = {}) {
  await ensureSchema();
  const filters = [];
  const args = [];
  if (source) {
    filters.push("source = ?");
    args.push(String(source));
  }
  if (since) {
    filters.push("fetched_at >= ?");
    args.push(String(since));
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await client.execute({
    sql: `
      SELECT active_account_id, COUNT(*) AS active_count
      FROM (
        SELECT
          COALESCE(served_account_id, current_account_id) AS active_account_id,
          ROW_NUMBER() OVER (
            PARTITION BY source, COALESCE(NULLIF(requester_id, ''), requester_email)
            ORDER BY fetched_at DESC, id DESC
          ) AS rn
        FROM auth_pool_fetch_log
        ${where}
      )
      WHERE rn = 1
        AND active_account_id IS NOT NULL
      GROUP BY active_account_id
    `,
    args,
  });
  return Object.fromEntries(
    result.rows.map((row) => [String(row.active_account_id), Number(row.active_count)])
  );
}

export async function authPoolActiveReporterCounts({ source, since = null } = {}) {
  await ensureSchema();
  const filters = [];
  const args = [];
  if (source) {
    filters.push("source = ?");
    args.push(String(source));
  }
  if (since) {
    filters.push("reported_at >= ?");
    args.push(String(since));
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await client.execute({
    sql: `
      SELECT account_id, COUNT(*) AS active_count
      FROM (
        SELECT
          account_id,
          ROW_NUMBER() OVER (
            PARTITION BY source, COALESCE(NULLIF(reporter_name, ''), hostname)
            ORDER BY reported_at DESC
          ) AS rn
        FROM auth_pool_quota_events
        ${where}
      )
      WHERE rn = 1
        AND account_id IS NOT NULL
      GROUP BY account_id
    `,
    args,
  });
  return Object.fromEntries(
    result.rows.map((row) => [String(row.account_id), Number(row.active_count)])
  );
}

export async function authPoolRecentServedCounts({ source, since = null } = {}) {
  await ensureSchema();
  const filters = ["reason = 'served'", "served_account_id IS NOT NULL"];
  const args = [];
  if (source) {
    filters.push("source = ?");
    args.push(String(source));
  }
  if (since) {
    filters.push("fetched_at >= ?");
    args.push(String(since));
  }
  const result = await client.execute({
    sql: `
      SELECT served_account_id, COUNT(*) AS served_count
      FROM auth_pool_fetch_log
      WHERE ${filters.join(" AND ")}
      GROUP BY served_account_id
    `,
    args,
  });
  return Object.fromEntries(
    result.rows.map((row) => [String(row.served_account_id), Number(row.served_count)])
  );
}

export async function authPoolFetchLog({ limit = 200, dedupe = true } = {}) {
  await ensureSchema();
  const sql = dedupe
    ? `
      SELECT id, fetched_at, requester_email, source,
        requester_id, served_account_id, served_email, served_uploader_email, served_digest,
        current_account_id, current_five_h_remaining, current_one_week_remaining, reason
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY source, COALESCE(NULLIF(requester_id, ''), requester_email)
            ORDER BY fetched_at DESC, id DESC
          ) AS rn
        FROM auth_pool_fetch_log
      )
      WHERE rn = 1
      ORDER BY fetched_at DESC
      LIMIT ?
    `
    : `
      SELECT id, fetched_at, requester_email, source,
        requester_id, served_account_id, served_email, served_uploader_email, served_digest,
        current_account_id, current_five_h_remaining, current_one_week_remaining, reason
      FROM auth_pool_fetch_log
      ORDER BY fetched_at DESC
      LIMIT ?
    `;
  const result = await client.execute({
    sql,
    args: [Number(limit) || 200],
  });
  return result.rows.map((row) => ({
    id: Number(row.id),
    fetched_at: row.fetched_at,
    requester_email: row.requester_email,
    requester_id: row.requester_id,
    source: row.source,
    served_account_id: row.served_account_id,
    served_email: row.served_email,
    served_uploader_email: row.served_uploader_email,
    served_digest: row.served_digest,
    current_account_id: row.current_account_id,
    current_five_h_remaining: row.current_five_h_remaining === null ? null : Number(row.current_five_h_remaining),
    current_one_week_remaining: row.current_one_week_remaining === null ? null : Number(row.current_one_week_remaining),
    reason: row.reason,
  }));
}

export async function upsertInvalidatedAuthState({ source, accountId, invalidatedAt, error = null }) {
  await ensureSchema();
  const normalizedSource = String(source);
  const normalizedAccountId = String(accountId);
  const firstInvalidatedAt = String(invalidatedAt);
  await client.execute({
    sql: `
      INSERT INTO auth_pool_invalidated_notifications (
        source, account_id, first_invalidated_at, last_notified_at, last_error
      ) VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(source, account_id) DO UPDATE SET
        last_error = excluded.last_error
    `,
    args: [normalizedSource, normalizedAccountId, firstInvalidatedAt, error],
  });
  const result = await client.execute({
    sql: `
      SELECT source, account_id, first_invalidated_at, last_notified_at, last_error
      FROM auth_pool_invalidated_notifications
      WHERE source = ? AND account_id = ?
    `,
    args: [normalizedSource, normalizedAccountId],
  });
  return result.rows[0]
    ? {
        source: result.rows[0].source,
        account_id: result.rows[0].account_id,
        first_invalidated_at: result.rows[0].first_invalidated_at,
        last_notified_at: result.rows[0].last_notified_at,
        last_error: result.rows[0].last_error,
      }
    : null;
}

export async function markInvalidatedAuthNotified({ source, accountId, notifiedAt }) {
  await ensureSchema();
  await client.execute({
    sql: `
      UPDATE auth_pool_invalidated_notifications
      SET last_notified_at = ?
      WHERE source = ? AND account_id = ?
    `,
    args: [String(notifiedAt), String(source), String(accountId)],
  });
}

export async function clearInvalidatedAuthState({ source, accountId }) {
  await ensureSchema();
  await client.execute({
    sql: `
      DELETE FROM auth_pool_invalidated_notifications
      WHERE source = ? AND account_id = ?
    `,
    args: [String(source), String(accountId)],
  });
}

export async function authPoolInvalidatedNotifications() {
  await ensureSchema();
  const result = await client.execute(`
    SELECT source, account_id, first_invalidated_at, last_notified_at, last_error
    FROM auth_pool_invalidated_notifications
  `);
  return result.rows.map((row) => ({
    source: row.source,
    account_id: row.account_id,
    first_invalidated_at: row.first_invalidated_at,
    last_notified_at: row.last_notified_at,
    last_error: row.last_error,
  }));
}

export async function authUsersList() {
  await ensureSchema();
  const result = await client.execute(`
    SELECT
      u.email,
      u.created_at,
      u.last_token_issued_at,
      t.token_created_at,
      t.token_last_used_at,
      (
        SELECT COUNT(*) FROM auth_pool_fetch_log f
        WHERE f.requester_email = u.email
      ) AS fetch_count,
      (
        SELECT MAX(f.fetched_at) FROM auth_pool_fetch_log f
        WHERE f.requester_email = u.email
      ) AS last_fetched_at
    FROM auth_users u
    LEFT JOIN (
      SELECT
        email,
        MAX(created_at) AS token_created_at,
        MAX(last_used_at) AS token_last_used_at
      FROM auth_api_tokens
      GROUP BY email
    ) t ON t.email = u.email
    ORDER BY u.last_token_issued_at DESC
  `);
  return result.rows.map((row) => ({
    email: row.email,
    created_at: row.created_at,
    last_token_issued_at: row.last_token_issued_at,
    has_active_token: Boolean(row.token_created_at),
    token_created_at: row.token_created_at,
    token_last_used_at: row.token_last_used_at,
    fetch_count: Number(row.fetch_count || 0),
    last_fetched_at: row.last_fetched_at,
  }));
}

export async function authenticateApiToken(rawToken) {
  await ensureSchema();
  // Verify HMAC signature for new-style tokens first.
  const verified = verifyTokenPayload(rawToken);
  const hashed = tokenHash(rawToken);
  if (verified) {
    // New-style HMAC-signed token — verify presence in DB (for revocation
    // support) and update last_used_at.
    const result = await client.execute({
      sql: `
        SELECT token_hash, email, created_at, last_used_at
        FROM auth_api_tokens
        WHERE token_hash = ?
      `,
      args: [hashed],
    });
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const usedAt = new Date().toISOString();
    await client.execute({
      sql: `UPDATE auth_api_tokens SET last_used_at = ? WHERE token_hash = ?`,
      args: [usedAt, hashed],
    });
    return {
      email: row.email,
      created_at: row.created_at,
      last_used_at: usedAt,
    };
  }
  // Fallback: old-style opaque tokens (DB lookup only).
  const result = await client.execute({
    sql: `
      SELECT token_hash, email, created_at, last_used_at
      FROM auth_api_tokens
      WHERE token_hash = ?
    `,
    args: [hashed],
  });
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const usedAt = new Date().toISOString();
  await client.execute({
    sql: `UPDATE auth_api_tokens SET last_used_at = ? WHERE token_hash = ?`,
    args: [usedAt, hashed],
  });
  return {
    email: row.email,
    created_at: row.created_at,
    last_used_at: usedAt,
  };
}
