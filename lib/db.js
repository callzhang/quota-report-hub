import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import {
  decryptAuthJson,
  deriveAuthPoolEntry,
  encryptAuthJson,
  pickBestAuthPoolCandidate,
  shouldReplaceAuthPoolEntry,
} from "./auth-pool.js";
import { authBlobKey, authBlobStorageConfigured, writeAuthBlob } from "./auth-blob-storage.js";
import { allowedDomain, companyEmailAllowed, normalizeEmail, signTokenPayload, tokenHash, verifyTokenPayload } from "./company-auth.js";
import { mergeLatestReport, sanitizeReport } from "./reports.js";
import { isStrippedRefreshToken } from "./fetch-best.js";
import { isAuthInvalidationError } from "./auth-status.js";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let schemaReady;
let authPoolPkColumns = "source, account_id";

async function migrateAuthPoolEntriesTableShape() {
  const pkResult = await client.execute(`PRAGMA table_info(auth_pool_entries)`);
  const columns = new Map(pkResult.rows.map((row) => [row.name, row]));
  const pkCols = pkResult.rows
    .filter((row) => row.pk > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => row.name);

  const encryptedColumnsAreNullable = ["encrypted_auth_json", "iv", "auth_tag"].every(
    (name) => columns.has(name) && Number(columns.get(name).notnull || 0) === 0
  );
  if (
    pkCols.join(", ") === "source, account_id, session_id" &&
    columns.has("auth_blob_key") &&
    encryptedColumnsAreNullable
  ) {
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
        encrypted_auth_json TEXT,
        iv TEXT,
        auth_tag TEXT,
        auth_blob_key TEXT,
        PRIMARY KEY (source, account_id, session_id)
      )
    `,
    `
      INSERT INTO auth_pool_entries (
        source, account_id, session_id, email, name, plan_name, auth_last_refresh, auth_expires_at, digest,
        uploader_email, reporter_name, hostname, checked_out_by, uploaded_at, encrypted_auth_json, iv, auth_tag, auth_blob_key
      )
      SELECT
        source, account_id, COALESCE(session_id, ''), email, name, plan_name, auth_last_refresh, auth_expires_at, digest,
        uploader_email, reporter_name, hostname, checked_out_by, uploaded_at, encrypted_auth_json, iv, auth_tag, auth_blob_key
      FROM auth_pool_entries_old_pk
    `,
    `DROP TABLE auth_pool_entries_old_pk`,
  ]);
  authPoolPkColumns = "source, account_id, session_id";
}

function rowToReport(row) {
  const payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  const capturedAt = (windowName) => payload.windows?.[windowName]?.captured_at || row.reported_at;
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
            captured_at: capturedAt("5h"),
          },
      "1week": row.one_week_remaining_percent === null && row.one_week_reset_at === null && row.one_week_used_percent === null
        ? null
        : {
            used_percent: row.one_week_used_percent === null ? null : Number(row.one_week_used_percent),
            remaining_percent: row.one_week_remaining_percent === null ? null : Number(row.one_week_remaining_percent),
            reset_at: row.one_week_reset_at,
            captured_at: capturedAt("1week"),
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
    isAuthInvalidationError(report.error)
  );
}

function insertAuthPoolQuotaEventStatement(report) {
  const { eventArgs } = serializeReport(report);
  return {
    sql: `
      INSERT INTO auth_pool_quota_events (
        id, source, hostname, reporter_name, reported_at, account_id, email, name, plan_name, auth_path,
        auth_last_refresh, status, error, model_context_window,
        five_h_used_percent, five_h_remaining_percent, five_h_reset_at,
        one_week_used_percent, one_week_remaining_percent, one_week_reset_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: eventArgs,
  };
}

function assignmentKey(primary, secondary) {
  return String(primary || secondary || "").trim();
}

function dashboardRevisionUpdate(updatedAt = new Date().toISOString(), extraWhere = "", args = []) {
  return {
    sql: `UPDATE dashboard_revision
          SET revision = revision + 1, updated_at = ?
          WHERE singleton = 1${extraWhere}`,
    args: [String(updatedAt), ...args],
  };
}

function upsertReporterAssignmentStatement(report) {
  const reporterKey = assignmentKey(report.reporter_name, report.hostname);
  if (!reporterKey) {
    return null;
  }
  return {
    sql: `
      INSERT INTO auth_pool_reporter_assignments (
        source, reporter_key, hostname, reporter_name, reported_at, account_id
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, reporter_key) DO UPDATE SET
        hostname = excluded.hostname,
        reporter_name = excluded.reporter_name,
        reported_at = excluded.reported_at,
        account_id = excluded.account_id
      WHERE excluded.reported_at >= auth_pool_reporter_assignments.reported_at
    `,
    args: [
      report.source,
      reporterKey,
      report.hostname,
      report.reporter_name,
      report.reported_at,
      report.account_id,
    ],
  };
}

export async function upsertAuthPoolQuota(report) {
  await ensureSchema();
  const incoming = sanitizeReport(report);
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
  const reporterAssignment = upsertReporterAssignmentStatement(incoming);
  const invalidationStatement = isHardAuthInvalidationReport(incoming)
    ? {
        sql: `
          INSERT INTO auth_pool_invalidated_notifications (
            source, account_id, first_invalidated_at, last_notified_at, last_error
          ) VALUES (?, ?, ?, NULL, ?)
          ON CONFLICT(source, account_id) DO UPDATE SET last_error = excluded.last_error
        `,
        args: [incoming.source, incoming.account_id, incoming.reported_at, incoming.error],
      }
    : {
        sql: `DELETE FROM auth_pool_invalidated_notifications WHERE source = ? AND account_id = ?`,
        args: [incoming.source, incoming.account_id],
      };
  await client.batch([
    insertAuthPoolQuotaEventStatement(incoming),
    ...(reporterAssignment ? [reporterAssignment] : []),
    {
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
    },
    invalidationStatement,
    dashboardRevisionUpdate(incoming.reported_at),
  ]);
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
          encrypted_auth_json TEXT,
          iv TEXT,
          auth_tag TEXT,
          auth_blob_key TEXT,
          PRIMARY KEY (source, account_id, session_id)
        )
      `);
      // Migrate existing tables that may not have session_id or checked_out_by
      for (const col of ['session_id', 'checked_out_by', 'auth_expires_at', 'auth_blob_key']) {
        await client.execute(`ALTER TABLE auth_pool_entries ADD COLUMN ${col} TEXT`)
          .catch(() => {}); // ignore if column already exists
      }
      // Backfill NULL session_id to '' for entries from before the column existed
      await client.execute(`UPDATE auth_pool_entries SET session_id = '' WHERE session_id IS NULL`)
        .catch(() => {});
      await migrateAuthPoolEntriesTableShape();
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
        CREATE INDEX IF NOT EXISTS auth_pool_quota_latest_source_reported_at_idx
          ON auth_pool_quota_latest (source, reported_at DESC)
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
        CREATE INDEX IF NOT EXISTS auth_pool_entries_source_uploader_idx
          ON auth_pool_entries (source, uploader_email, uploaded_at DESC)
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS auth_pool_requester_assignments (
          source TEXT NOT NULL,
          requester_key TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          requester_email TEXT NOT NULL,
          requester_id TEXT,
          served_account_id TEXT,
          served_email TEXT,
          served_uploader_email TEXT,
          served_digest TEXT,
          current_account_id TEXT,
          current_five_h_remaining REAL,
          current_one_week_remaining REAL,
          active_account_id TEXT,
          reason TEXT NOT NULL,
          PRIMARY KEY (source, requester_key)
        )
      `);
      await client.execute(`
        CREATE INDEX IF NOT EXISTS auth_pool_requester_assignments_active_idx
          ON auth_pool_requester_assignments (source, fetched_at DESC, active_account_id)
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS auth_pool_reporter_assignments (
          source TEXT NOT NULL,
          reporter_key TEXT NOT NULL,
          hostname TEXT NOT NULL,
          reporter_name TEXT NOT NULL,
          reported_at TEXT NOT NULL,
          account_id TEXT NOT NULL,
          PRIMARY KEY (source, reporter_key)
        )
      `);
      await client.execute(`
        CREATE INDEX IF NOT EXISTS auth_pool_reporter_assignments_active_idx
          ON auth_pool_reporter_assignments (source, reported_at DESC, account_id)
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS auth_pool_user_fetch_stats (
          requester_email TEXT PRIMARY KEY,
          fetch_count INTEGER NOT NULL,
          last_fetched_at TEXT NOT NULL
        )
      `);
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
      await client.execute(`
        CREATE TABLE IF NOT EXISTS feature_flags (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT,
          updated_by TEXT
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS pool_health_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          captured_at TEXT NOT NULL,
          source TEXT NOT NULL,
          total INTEGER NOT NULL,
          ok_count INTEGER NOT NULL,
          hard_dead_count INTEGER NOT NULL,
          other_err_count INTEGER NOT NULL,
          central_refresh_attempted INTEGER NOT NULL DEFAULT 0,
          central_refresh_ok INTEGER NOT NULL DEFAULT 0,
          central_refresh_rejected INTEGER NOT NULL DEFAULT 0
        )
      `);
      await client.execute(`
        CREATE INDEX IF NOT EXISTS idx_pool_health_captured_at
        ON pool_health_snapshots (captured_at DESC)
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS dashboard_revision (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      await client.execute(`
        INSERT OR IGNORE INTO dashboard_revision (singleton, revision, updated_at)
        VALUES (1, 0, '')
      `);
    })();
  }
  await schemaReady;
}

export async function dashboardRevision() {
  await ensureSchema();
  const result = await client.execute({
    sql: "SELECT revision, updated_at FROM dashboard_revision WHERE singleton = 1",
    args: [],
  });
  return {
    revision: Number(result.rows[0]?.revision || 0),
    updated_at: result.rows[0]?.updated_at || null,
  };
}

export async function bumpDashboardRevision(updatedAt = new Date().toISOString()) {
  await ensureSchema();
  await client.execute(dashboardRevisionUpdate(updatedAt));
  return dashboardRevision();
}

export async function getFeatureFlag(key, fallback = false) {
  await ensureSchema();
  const result = await client.execute({
    sql: `SELECT value FROM feature_flags WHERE key = ?`,
    args: [String(key)],
  });
  const row = result.rows[0];
  if (!row) {
    return fallback;
  }
  return row.value === "true" || row.value === "1";
}

export async function setFeatureFlag(key, value, updatedBy = null) {
  await ensureSchema();
  const normalizedKey = String(key);
  const normalizedValue = value ? "true" : "false";
  const updatedAt = new Date().toISOString();
  await client.batch([{
    sql: `
      INSERT INTO feature_flags (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
      WHERE feature_flags.value IS NOT excluded.value
    `,
    args: [normalizedKey, normalizedValue, updatedAt, updatedBy],
  }, dashboardRevisionUpdate(updatedAt, " AND changes() > 0")]);
  return { key: normalizedKey, value: Boolean(value) };
}

export async function allFeatureFlags() {
  await ensureSchema();
  const result = await client.execute(`SELECT key, value, updated_at, updated_by FROM feature_flags`);
  const flags = {};
  for (const row of result.rows) {
    flags[row.key] = row.value === "true" || row.value === "1";
  }
  return flags;
}

export async function recordPoolHealthSnapshot(snapshot) {
  await ensureSchema();
  const capturedAt = snapshot.captured_at || new Date().toISOString();
  await client.batch([{
    sql: `
      INSERT INTO pool_health_snapshots (
        captured_at, source, total, ok_count, hard_dead_count, other_err_count,
        central_refresh_attempted, central_refresh_ok, central_refresh_rejected
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      capturedAt,
      String(snapshot.source),
      Number(snapshot.total || 0),
      Number(snapshot.ok_count || 0),
      Number(snapshot.hard_dead_count || 0),
      Number(snapshot.other_err_count || 0),
      Number(snapshot.central_refresh_attempted || 0),
      Number(snapshot.central_refresh_ok || 0),
      Number(snapshot.central_refresh_rejected || 0),
    ],
  }, dashboardRevisionUpdate(capturedAt)]);
}

export async function poolHealthSnapshots({ limit = 96 } = {}) {
  await ensureSchema();
  const result = await client.execute({
    sql: `
      SELECT captured_at, source, total, ok_count, hard_dead_count, other_err_count,
             central_refresh_attempted, central_refresh_ok, central_refresh_rejected
      FROM pool_health_snapshots
      ORDER BY captured_at DESC
      LIMIT ?
    `,
    args: [Number(limit)],
  });
  return result.rows
    .map((row) => ({
      captured_at: row.captured_at,
      source: row.source,
      total: Number(row.total),
      ok_count: Number(row.ok_count),
      hard_dead_count: Number(row.hard_dead_count),
      other_err_count: Number(row.other_err_count),
      central_refresh_attempted: Number(row.central_refresh_attempted),
      central_refresh_ok: Number(row.central_refresh_ok),
      central_refresh_rejected: Number(row.central_refresh_rejected),
    }))
    .reverse();
}

export async function upsertAuthPoolEntry(rawEntry) {
  await ensureSchema();
  // Never let a stripped (placeholder-RT) blob overwrite a real shared refresh token: a
  // borrower running in disabled_refresh_token mode would otherwise upload its AT-only copy
  // and poison the pool entry (the hub would lose the RT it needs to refresh centrally).
  // Reject it outright; the existing real-RT entry stays untouched.
  if (isStrippedRefreshToken(rawEntry.auth_json, rawEntry.source)) {
    return { rejected: true, reason: "stripped_refresh_token", deduplicated: true };
  }
  const derived = deriveAuthPoolEntry(rawEntry.source, rawEntry.auth_json, rawEntry);
  const sessionId = String(derived.session_id || rawEntry.session_id || '');
  const incomingUploaderEmail = rawEntry.uploader_email ? normalizeEmail(rawEntry.uploader_email) : null;

  const identityEmail = normalizeEmail(derived.email || derived.account_id);
  const candidateOwnerEmails = [identityEmail];
  const identityLocalPart = identityEmail.includes("@") ? identityEmail.split("@")[0] : null;
  const mappedCompanyEmail = identityLocalPart ? `${identityLocalPart}@${allowedDomain()}` : null;
  if (mappedCompanyEmail && mappedCompanyEmail !== identityEmail) {
    candidateOwnerEmails.push(mappedCompanyEmail);
  }

  let identityOwnerEmail = null;
  for (const candidateEmail of candidateOwnerEmails) {
    const ownerResult = await client.execute({
      sql: `SELECT email FROM auth_users WHERE email = ? LIMIT 1`,
      args: [candidateEmail],
    });
    if (ownerResult.rows[0]?.email) {
      identityOwnerEmail = normalizeEmail(ownerResult.rows[0].email);
      break;
    }
  }

  const accountOwnerResult = await client.execute({
    sql: `
      SELECT uploader_email
      FROM auth_pool_entries
      WHERE source = ? AND account_id = ? AND uploader_email IS NOT NULL AND uploader_email != ''
      ORDER BY uploaded_at ASC
      LIMIT 1
    `,
    args: [derived.source, derived.account_id],
  });
  const accountUploaderEmail = identityOwnerEmail || accountOwnerResult.rows[0]?.uploader_email || incomingUploaderEmail;

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
        uploaded_at
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
      uploader_email: existingRow.uploader_email || accountUploaderEmail,
      reporter_name: existingRow.reporter_name,
      hostname: existingRow.hostname,
      uploaded_at: existingRow.uploaded_at,
      deduplicated: true,
    };
  }
  const encrypted = encryptAuthJson(derived.auth_json);
  let encryptedAuthJson = encrypted.encrypted_auth_json;
  let iv = encrypted.iv;
  let authTag = encrypted.auth_tag;
  let blobKey = null;
  if (authBlobStorageConfigured()) {
    blobKey = authBlobKey({
      source: derived.source,
      accountId: derived.account_id,
      sessionId,
      digest: derived.digest,
    });
    await writeAuthBlob(blobKey, encrypted);
    encryptedAuthJson = null;
    iv = null;
    authTag = null;
  }
  const uploadedAt = new Date().toISOString();

  // Collapse each account to a single entry. Same account = same (source, account_id) regardless
  // of session_id; quota is account-level so extra sessions add no value, only stale rows that
  // pollute `latest` and make refresh_current ambiguous. Also purge legacy same-email/diff-account
  // rows (old UUID-based account_ids). Done before INSERT so the fresh row survives.
  const cleanupStatements = [{
    sql: `DELETE FROM auth_pool_entries WHERE source = ? AND account_id = ? AND session_id IS NOT ?`,
    args: [derived.source, derived.account_id, sessionId],
  }];
  if (derived.email) {
    cleanupStatements.push({
      sql: `DELETE FROM auth_pool_entries WHERE source = ? AND email = ? AND account_id != ?`,
      args: [derived.source, derived.email, derived.account_id],
    });
    cleanupStatements.push({
      sql: `DELETE FROM auth_pool_quota_latest WHERE source = ? AND email = ? AND account_id != ?`,
      args: [derived.source, derived.email, derived.account_id],
    });
  }

  await client.batch([...cleanupStatements, {
    sql: `
      INSERT INTO auth_pool_entries (
        source, account_id, session_id, email, name, plan_name, auth_last_refresh, auth_expires_at, digest, uploader_email,
        reporter_name, hostname, uploaded_at, encrypted_auth_json, iv, auth_tag, auth_blob_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        auth_tag = excluded.auth_tag,
        auth_blob_key = excluded.auth_blob_key
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
      accountUploaderEmail,
      derived.reporter_name,
      derived.hostname,
      uploadedAt,
      encryptedAuthJson,
      iv,
      authTag,
      blobKey,
    ],
  }, dashboardRevisionUpdate(uploadedAt)]);

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
    uploader_email: accountUploaderEmail,
    reporter_name: derived.reporter_name,
    hostname: derived.hostname,
    uploaded_at: uploadedAt,
    deduplicated: false,
  };
}

// One-shot cleanup for already-accumulated multi-session rows: keep only the newest uploaded_at
// per (source, account_id), delete the rest. Returns the number of rows removed.
export async function collapseAuthPoolSessions() {
  await ensureSchema();
  const duplicateRows = `
    SELECT rowid FROM (
      SELECT rowid,
             ROW_NUMBER() OVER (PARTITION BY source, account_id ORDER BY uploaded_at DESC, rowid DESC) AS rn
      FROM auth_pool_entries
    ) WHERE rn > 1
  `;
  const results = await client.batch([
    dashboardRevisionUpdate(new Date().toISOString(), ` AND EXISTS (${duplicateRows})`),
    `DELETE FROM auth_pool_entries WHERE rowid IN (${duplicateRows})`,
  ]);
  const result = results[1];
  return Number(result.rowsAffected || 0);
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
      auth_tag,
      auth_blob_key
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
    auth_blob_key: row.auth_blob_key,
  }));
}

export async function authPoolEntrySummaries({ source = null } = {}) {
  await ensureSchema();
  const sql = `
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
      uploaded_at
    FROM auth_pool_entries
    ${source ? "WHERE source = ?" : ""}
    ORDER BY uploaded_at DESC
  `;
  const result = source
    ? await client.execute({ sql, args: [String(source)] })
    : await client.execute(sql);
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
        auth_tag,
        auth_blob_key
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
        auth_tag,
        auth_blob_key
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
    auth_blob_key: row.auth_blob_key,
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
    dashboardRevisionUpdate(new Date().toISOString(), ` AND (
      EXISTS (SELECT 1 FROM auth_pool_entries WHERE source = ? AND account_id = ?)
      OR EXISTS (SELECT 1 FROM auth_pool_quota_latest WHERE source = ? AND account_id = ?)
      OR EXISTS (SELECT 1 FROM auth_pool_invalidated_notifications WHERE source = ? AND account_id = ?)
    )`, [
      normalizedSource, normalizedAccountId,
      normalizedSource, normalizedAccountId,
      normalizedSource, normalizedAccountId,
    ]),
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

// Remove a single auth_pool_entries row (one session) WITHOUT the account-level cascade that
// deleteAuthPoolEntry performs. Used to prune stale duplicate sessions of an account whose
// canonical session is being kept: deleting the duplicate must not touch the account's shared
// quota_latest / invalidated-notification state (those are keyed by account, not session).
export async function deleteAuthPoolEntryRow({ source, accountId, sessionId = "" }) {
  await ensureSchema();
  const normalizedSource = String(source);
  const normalizedAccountId = String(accountId);
  const normalizedSessionId = String(sessionId ?? "");
  const results = await client.batch([
    dashboardRevisionUpdate(new Date().toISOString(), ` AND EXISTS (
      SELECT 1 FROM auth_pool_entries WHERE source = ? AND account_id = ? AND session_id = ?
    )`, [normalizedSource, normalizedAccountId, normalizedSessionId]),
    {
    sql: `DELETE FROM auth_pool_entries WHERE source = ? AND account_id = ? AND session_id = ?`,
    args: [normalizedSource, normalizedAccountId, normalizedSessionId],
    },
  ]);
  const result = results[1];
  return {
    deleted: Number(result.rowsAffected || 0) > 0,
    source: normalizedSource,
    account_id: normalizedAccountId,
    session_id: normalizedSessionId,
  };
}

export async function authPoolQuotaLatest({ source = null } = {}) {
  await ensureSchema();
  const sql = `
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
    ${source ? "WHERE source = ?" : ""}
    ORDER BY reported_at DESC
  `;
  const result = source
    ? await client.execute({ sql, args: [String(source)] })
    : await client.execute(sql);
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
  const source = options.source || "codex";
  const reports = await authPoolQuotaLatest({ source });
  const pool = await authPoolEntrySummaries({ source });
  const activeAssignmentWindowSeconds = Number(options.active_assignment_window_seconds ?? 7 * 24 * 60 * 60);
  const activeSince = Number.isFinite(activeAssignmentWindowSeconds) && activeAssignmentWindowSeconds > 0
    ? new Date(Date.now() - activeAssignmentWindowSeconds * 1000).toISOString()
    : null;
  const activeAssignmentCounts = await authPoolActiveAssignmentCounts({
    source,
    since: activeSince,
  });
  const activeReporterCounts = await authPoolActiveReporterCounts({
    source,
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
  const selectedEntry = await authPoolEntry(
    candidate.entry.source,
    candidate.entry.account_id,
    candidate.entry.session_id || null
  );
  if (!selectedEntry) {
    return null;
  }
  return {
    ...selectedEntry,
    auth_json: await decryptAuthJson(selectedEntry),
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
            OR q.error = 'refresh_token_rejected'
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
            OR q.error = 'refresh_token_rejected'
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
  // Return an invalidated auth the requester themselves uploaded so it can be handed
  // back to them for re-login. We no longer require it to be their *current* auth: if
  // the owner has any dead auth, return it (preferring the one matching accountId).
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
        e.auth_tag,
        e.auth_blob_key
      FROM auth_pool_entries e
      INNER JOIN auth_pool_quota_latest q
        ON e.source = q.source AND e.account_id = q.account_id
      WHERE e.source = ?
        AND e.uploader_email = ?
        AND (
          (q.status = 'error' AND (
            q.error = 'auth invalidated (token_invalidated)'
            OR q.error = 'auth failed (401 unauthorized)'
            OR q.error = 'refresh_token_rejected'
            OR q.error = 'claude auth email unavailable'
          ))
          OR q.plan_name = 'Free'
        )
      ORDER BY (e.account_id = ?) DESC, e.uploaded_at DESC
      LIMIT 1
    `,
    args: [String(source), normalizeEmail(uploaderEmail), String(accountId || "")],
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
    auth_blob_key: row.auth_blob_key,
  };

  return {
    ...entry,
    auth_json: await decryptAuthJson(entry),
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

  // Tokens for an email COEXIST — issuing a new one does not evict the others, and neither does using
  // one. A person legitimately has several clients under one identity (guard, browser dashboard, a
  // second machine); auto-eviction made them knock each other out (ping-pong) and also locked owners
  // out when a reissue was emailed but never pasted. Each client keeps its own token until an explicit
  // revoke. (Revocation/cleanup is a separate, deliberate action — not a side effect of issue or use.)
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
  return null;
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
  const normalizedRequesterEmail = normalizeEmail(requesterEmail);
  const normalizedSource = String(source);
  const normalizedRequesterId = requesterId ? String(requesterId) : null;
  const requesterKey = assignmentKey(normalizedRequesterId, normalizedRequesterEmail);
  const servedAccountId = servedEntry?.account_id ?? null;
  const currentAccount = currentAccountId ? String(currentAccountId) : null;
  const currentFiveHour = Number.isFinite(currentQuota?.five_h_remaining_percent)
    ? Number(currentQuota.five_h_remaining_percent)
    : null;
  const currentWeekly = Number.isFinite(currentQuota?.one_week_remaining_percent)
    ? Number(currentQuota.one_week_remaining_percent)
    : null;
  const activeAccountId = servedAccountId ?? currentAccount;
  await client.batch([{
    sql: `
      INSERT INTO auth_pool_fetch_log (
        fetched_at, requester_email, requester_id, source,
        served_account_id, served_email, served_uploader_email, served_digest,
        current_account_id, current_five_h_remaining, current_one_week_remaining, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      fetchedAt,
      normalizedRequesterEmail,
      normalizedRequesterId,
      normalizedSource,
      servedAccountId,
      servedEntry?.email ?? null,
      servedEntry?.uploader_email ?? null,
      servedEntry?.digest ?? null,
      currentAccount,
      currentFiveHour,
      currentWeekly,
      String(reason),
    ],
  }, {
    sql: `
      INSERT INTO auth_pool_requester_assignments (
        source, requester_key, fetched_at, requester_email, requester_id,
        served_account_id, served_email, served_uploader_email, served_digest,
        current_account_id, current_five_h_remaining, current_one_week_remaining,
        active_account_id, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, requester_key) DO UPDATE SET
        fetched_at = excluded.fetched_at,
        requester_email = excluded.requester_email,
        requester_id = excluded.requester_id,
        served_account_id = excluded.served_account_id,
        served_email = excluded.served_email,
        served_uploader_email = excluded.served_uploader_email,
        served_digest = excluded.served_digest,
        current_account_id = excluded.current_account_id,
        current_five_h_remaining = excluded.current_five_h_remaining,
        current_one_week_remaining = excluded.current_one_week_remaining,
        active_account_id = excluded.active_account_id,
        reason = excluded.reason
      WHERE excluded.fetched_at >= auth_pool_requester_assignments.fetched_at
    `,
    args: [
      normalizedSource,
      requesterKey,
      fetchedAt,
      normalizedRequesterEmail,
      normalizedRequesterId,
      servedAccountId,
      servedEntry?.email ?? null,
      servedEntry?.uploader_email ?? null,
      servedEntry?.digest ?? null,
      currentAccount,
      currentFiveHour,
      currentWeekly,
      activeAccountId,
      String(reason),
    ],
  }, {
    sql: `
      INSERT INTO auth_pool_user_fetch_stats (
        requester_email, fetch_count, last_fetched_at
      ) VALUES (?, 1, ?)
      ON CONFLICT(requester_email) DO UPDATE SET
        fetch_count = auth_pool_user_fetch_stats.fetch_count + 1,
        last_fetched_at = excluded.last_fetched_at
      WHERE excluded.last_fetched_at >= auth_pool_user_fetch_stats.last_fetched_at
    `,
    args: [normalizedRequesterEmail, fetchedAt],
  }, dashboardRevisionUpdate(fetchedAt)]);
}

export async function authPoolActiveAssignmentCounts({ source, since = null } = {}) {
  await ensureSchema();
  const filters = ["active_account_id IS NOT NULL"];
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
      FROM auth_pool_requester_assignments
      ${where}
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
  const filters = ["account_id IS NOT NULL"];
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
      FROM auth_pool_reporter_assignments
      ${where}
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
        SELECT NULL AS id, fetched_at, requester_email, source,
          requester_id, served_account_id, served_email, served_uploader_email, served_digest,
          current_account_id, current_five_h_remaining, current_one_week_remaining, reason
        FROM auth_pool_requester_assignments
      )
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
  await client.batch([{
    sql: `
      INSERT INTO auth_pool_invalidated_notifications (
        source, account_id, first_invalidated_at, last_notified_at, last_error
      ) VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(source, account_id) DO UPDATE SET
        last_error = excluded.last_error
      WHERE auth_pool_invalidated_notifications.last_error IS NOT excluded.last_error
    `,
    args: [normalizedSource, normalizedAccountId, firstInvalidatedAt, error],
  }, dashboardRevisionUpdate(firstInvalidatedAt, " AND changes() > 0")]);
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
  const normalizedNotifiedAt = String(notifiedAt);
  await client.batch([{
    sql: `
      UPDATE auth_pool_invalidated_notifications
      SET last_notified_at = ?
      WHERE source = ? AND account_id = ?
        AND last_notified_at IS NOT ?
    `,
    args: [normalizedNotifiedAt, String(source), String(accountId), normalizedNotifiedAt],
  }, dashboardRevisionUpdate(normalizedNotifiedAt, " AND changes() > 0")]);
}

export async function clearInvalidatedAuthState({ source, accountId }) {
  await ensureSchema();
  await client.batch([{
    sql: `
      DELETE FROM auth_pool_invalidated_notifications
      WHERE source = ? AND account_id = ?
    `,
    args: [String(source), String(accountId)],
  }, dashboardRevisionUpdate(new Date().toISOString(), " AND changes() > 0")]);
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
      COALESCE(s.fetch_count, 0) AS fetch_count,
      s.last_fetched_at
    FROM auth_users u
    LEFT JOIN (
      SELECT
        email,
        MAX(created_at) AS token_created_at,
        MAX(last_used_at) AS token_last_used_at
      FROM auth_api_tokens
      GROUP BY email
    ) t ON t.email = u.email
    LEFT JOIN auth_pool_user_fetch_stats s
      ON s.requester_email = u.email
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
