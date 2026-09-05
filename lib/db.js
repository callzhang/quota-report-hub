import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import { decryptAuthJson, deriveAuthPoolEntry, encryptAuthJson, pickBestAuthPoolCandidate, shouldReplaceAuthPoolEntry } from "./auth-pool.js";
import { authBlobKey, authBlobStorageConfigured, writeAuthBlob } from "./auth-blob-storage.js";
import { normalizeEmail, signTokenPayload, tokenHash, verifyTokenPayload } from "./company-auth.js";
import { mergeLatestReport, sanitizeReport } from "./reports.js";
import { accessTokenFingerprint, isStrippedRefreshToken, mergeStrippedAccessToken } from "./fetch-best.js";
import { isAuthInvalidationError } from "./auth-status.js";
import { MODEL_COST_SQL } from "./premium-ratio.js";
import {
  BURN_POINTS_SQL,
  SCARCITY_BURN_WINDOW_HOURS,
  SCARCITY_HORIZON_DAYS,
  UNLOCK_POINTS_SQL,
  projectScarcity,
} from "./pool-scarcity.js";
import { PREMIUM_MODEL_IDS } from "./model-tiers.js";
import {
  TOKEN_USAGE_BREAKDOWN_LIMIT,
  TOKEN_USAGE_COUNTERS,
  TOKEN_USAGE_TREND_LIMIT,
} from "./token-usage.js";

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
        has_refresh_token INTEGER,
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
        source, account_id, session_id, email, name, plan_name, auth_last_refresh, auth_expires_at, has_refresh_token, digest,
        uploader_email, reporter_name, hostname, checked_out_by, uploaded_at, encrypted_auth_json, iv, auth_tag, auth_blob_key
      )
      SELECT
        source, account_id, COALESCE(session_id, ''), email, name, plan_name, auth_last_refresh, auth_expires_at, has_refresh_token, digest,
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
    exhausted_until: payload.exhausted_until || null,
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

function canonicalEventTimestamp(value) {
  const timestampMs = Date.parse(String(value));
  if (!Number.isFinite(timestampMs)) throw new TypeError("reported_at must be a valid timestamp");
  return new Date(timestampMs).toISOString();
}

function isHardAuthInvalidationReport(report) {
  return (
    report.status === "error" &&
    isAuthInvalidationError(report.error)
  );
}

function insertAuthPoolQuotaEventStatement(report) {
  const { eventArgs } = serializeReport(report);
  eventArgs[4] = canonicalEventTimestamp(report.reported_at);
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
  // The invalidation clock follows the MERGED verdict, not the report that just arrived.
  //
  // A central-refresh rejection is sticky by design (mergeLatestReport): a client's own healthy
  // probe says nothing about the pooled credential, so it cannot lift the verdict. Deciding this
  // statement from `incoming` re-opened exactly that hole one layer down — every unrelated "ok"
  // DELETED the invalidation record, and the next rejection recreated it with a fresh timestamp.
  // The 48h archive clock and the 24h owner-notification clock both restarted on every such flip,
  // so a credential that had been dead for weeks stayed "just invalidated" forever and its owner
  // was never told. Measured on claude-qpt0311@uw.edu: record created 21:32, deleted 21:46,
  // recreated minutes later, for ten days.
  const invalidationStatement = isHardAuthInvalidationReport(merged)
    ? {
        sql: `
          INSERT INTO auth_pool_invalidated_notifications (
            source, account_id, first_invalidated_at, last_notified_at, last_error
          ) VALUES (?, ?, ?, NULL, ?)
          ON CONFLICT(source, account_id) DO UPDATE SET last_error = excluded.last_error
        `,
        args: [merged.source, merged.account_id, merged.reported_at, merged.error],
      }
    : {
        sql: `DELETE FROM auth_pool_invalidated_notifications WHERE source = ? AND account_id = ?`,
        args: [merged.source, merged.account_id],
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
          has_refresh_token INTEGER,
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
      await client.execute(`ALTER TABLE auth_pool_entries ADD COLUMN has_refresh_token INTEGER`)
        .catch(() => {});
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
        CREATE TABLE IF NOT EXISTS token_usage_batch_receipts (
          hub_user_email TEXT NOT NULL,
          installation_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          received_at TEXT NOT NULL,
          applied_at TEXT,
          apply_marker TEXT,
          PRIMARY KEY (hub_user_email, installation_id, batch_id)
        )
      `);
      await client.execute(`
        CREATE INDEX IF NOT EXISTS token_usage_batch_receipts_received_idx
          ON token_usage_batch_receipts (received_at)
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS token_usage_15m (
          hub_user_email TEXT NOT NULL,
          provider TEXT NOT NULL,
          model_account_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          bucket_start TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          cache_write_tokens INTEGER NOT NULL,
          reasoning_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (hub_user_email, provider, model_account_id, model_id, bucket_start)
        )
      `);
      await client.execute(`
        CREATE INDEX IF NOT EXISTS token_usage_15m_time_idx
          ON token_usage_15m (bucket_start, hub_user_email, provider, model_account_id, model_id)
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS token_usage_daily (
          hub_user_email TEXT NOT NULL,
          provider TEXT NOT NULL,
          model_account_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          day_start TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          cache_write_tokens INTEGER NOT NULL,
          reasoning_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (hub_user_email, provider, model_account_id, model_id, day_start)
        )
      `);
      await client.execute(`
        CREATE INDEX IF NOT EXISTS token_usage_daily_time_idx
          ON token_usage_daily (day_start, hub_user_email, provider, model_account_id, model_id)
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS token_usage_reporter_state (
          hub_user_email TEXT PRIMARY KEY,
          last_reported_at TEXT NOT NULL
        )
      `);
      await client.execute(`ALTER TABLE token_usage_reporter_state ADD COLUMN client_version TEXT`)
        .catch(() => {});
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
      await client.execute(`ALTER TABLE auth_pool_user_fetch_stats ADD COLUMN last_served_at TEXT`)
        .catch(() => {});
      // The version the FETCH request carried, which is what the reporter gate judges. Recording it
      // only from usage batches would leave every non-reporting client invisible -- exactly the
      // population the gate exists for, and the one an uptake check needs to see before it fires.
      await client.execute(`ALTER TABLE auth_pool_user_fetch_stats ADD COLUMN client_version TEXT`)
        .catch(() => {});
      // Separate from last_served_at, which also advances on refresh. The reporting-debt clock must
      // start only when the pool hands over NEW capacity; charging refreshes would run up a debt on
      // an idle user who cannot repay it without working.
      await client.execute(`ALTER TABLE auth_pool_user_fetch_stats ADD COLUMN last_new_account_at TEXT`)
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
        CREATE TABLE IF NOT EXISTS pool_scarcity_state (
          source TEXT PRIMARY KEY,
          computed_at TEXT NOT NULL,
          burn_points_per_day REAL NOT NULL,
          available_points REAL NOT NULL,
          demand_points REAL NOT NULL,
          runway_days REAL,
          horizon_days INTEGER NOT NULL,
          scarce INTEGER NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS reporter_probe_heartbeats (
          source TEXT NOT NULL,
          reporter_key TEXT NOT NULL,
          hostname TEXT,
          reporter_name TEXT,
          hub_user_email TEXT,
          last_run_at TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          account_id TEXT,
          client_version TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          last_ok_at TEXT,
          PRIMARY KEY (source, reporter_key)
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS auth_pool_token_fingerprints (
          source TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          account_id TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          PRIMARY KEY (source, fingerprint)
        )
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

function tokenUsagePayloadDigest({ installationId, batchId, rows }) {
  const canonicalRows = rows
    .map((row) => ({
      bucket_start: row.bucket_start,
      provider: row.provider,
      model_account_id: row.model_account_id,
      model_id: row.model_id,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_write_tokens: row.cache_write_tokens,
      reasoning_tokens: row.reasoning_tokens,
      total_tokens: row.total_tokens,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return crypto.createHash("sha256").update(JSON.stringify({
    installation_id: installationId,
    batch_id: batchId,
    rows: canonicalRows,
  })).digest("hex");
}

export async function ingestTokenUsageBatch({
  hubUserEmail,
  installationId,
  batchId,
  rows,
  clientVersion = null,
  receivedAt = new Date().toISOString(),
}) {
  await ensureSchema();
  const normalizedEmail = normalizeEmail(hubUserEmail);
  const normalizedInstallationId = String(installationId);
  const normalizedBatchId = String(batchId);
  const normalizedRows = Array.from(rows || []);
  const payloadDigest = tokenUsagePayloadDigest({
    installationId: normalizedInstallationId,
    batchId: normalizedBatchId,
    rows: normalizedRows,
  });
  const attemptMarker = crypto.randomUUID();
  const identityArgs = [normalizedEmail, normalizedInstallationId, normalizedBatchId];
  const receiptGuardArgs = [...identityArgs, payloadDigest];
  const statements = [{
    sql: `
      INSERT INTO token_usage_batch_receipts (
        hub_user_email, installation_id, batch_id, payload_digest,
        received_at, applied_at, apply_marker
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(hub_user_email, installation_id, batch_id) DO NOTHING
    `,
    args: [...identityArgs, payloadDigest, receivedAt],
  }];

  for (const row of normalizedRows) {
    statements.push({
      sql: `
        INSERT INTO token_usage_15m (
          hub_user_email, provider, model_account_id, model_id, bucket_start,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, total_tokens, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM token_usage_batch_receipts
          WHERE hub_user_email = ? AND installation_id = ? AND batch_id = ?
            AND payload_digest = ? AND applied_at IS NULL
        )
        ON CONFLICT(hub_user_email, provider, model_account_id, model_id, bucket_start)
        DO UPDATE SET
          input_tokens = token_usage_15m.input_tokens + excluded.input_tokens,
          output_tokens = token_usage_15m.output_tokens + excluded.output_tokens,
          cache_read_tokens = token_usage_15m.cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = token_usage_15m.cache_write_tokens + excluded.cache_write_tokens,
          reasoning_tokens = token_usage_15m.reasoning_tokens + excluded.reasoning_tokens,
          total_tokens = token_usage_15m.total_tokens + excluded.total_tokens,
          updated_at = excluded.updated_at
      `,
      args: [
        normalizedEmail,
        row.provider,
        row.model_account_id,
        row.model_id,
        row.bucket_start,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_write_tokens,
        row.reasoning_tokens,
        row.total_tokens,
        receivedAt,
        ...receiptGuardArgs,
      ],
    });
  }

  statements.push({
    sql: `
      INSERT INTO token_usage_reporter_state (hub_user_email, last_reported_at, client_version)
      SELECT ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM token_usage_batch_receipts
        WHERE hub_user_email = ? AND installation_id = ? AND batch_id = ?
          AND payload_digest = ? AND applied_at IS NULL
      )
      ON CONFLICT(hub_user_email) DO UPDATE SET
        last_reported_at = CASE
          WHEN excluded.last_reported_at > token_usage_reporter_state.last_reported_at
            THEN excluded.last_reported_at
          ELSE token_usage_reporter_state.last_reported_at
        END,
        client_version = COALESCE(excluded.client_version, token_usage_reporter_state.client_version)
    `,
    args: [normalizedEmail, receivedAt, clientVersion ? String(clientVersion) : null, ...receiptGuardArgs],
  });
  statements.push({
    sql: `
      UPDATE token_usage_batch_receipts
      SET applied_at = ?, apply_marker = ?
      WHERE hub_user_email = ? AND installation_id = ? AND batch_id = ?
        AND payload_digest = ? AND applied_at IS NULL
    `,
    args: [receivedAt, attemptMarker, ...receiptGuardArgs],
  });
  statements.push({
    sql: `
      SELECT payload_digest, received_at, applied_at, apply_marker
      FROM token_usage_batch_receipts
      WHERE hub_user_email = ? AND installation_id = ? AND batch_id = ?
    `,
    args: identityArgs,
  });

  const results = await client.batch(statements, "write");
  const receipt = results.at(-1)?.rows?.[0];
  if (!receipt || receipt.payload_digest !== payloadDigest) {
    const error = new Error("token usage batch identity already has another payload");
    error.code = "token_usage_batch_conflict";
    throw error;
  }
  return {
    applied: receipt.apply_marker === attemptMarker,
    received_at: receipt.received_at,
    applied_at: receipt.applied_at,
  };
}

function numericTokenUsageRow(row, extraKeys = []) {
  const normalized = {};
  for (const key of extraKeys) normalized[key] = row[key] ?? null;
  for (const counter of TOKEN_USAGE_COUNTERS) normalized[counter] = Number(row[counter] || 0);
  return normalized;
}

export async function queryTokenUsage({
  start,
  end,
  granularity,
  groupBy,
  metric,
  hubUsers = [],
  providers = [],
  modelAccounts = [],
  models = [],
}) {
  const bucketExpression = {
    "15m": "bucket_start",
    hour: "substr(bucket_start, 1, 13) || ':00:00.000Z'",
    day: "substr(bucket_start, 1, 10) || 'T00:00:00.000Z'",
  }[granularity];
  const groupColumn = {
    hub_user: "hub_user_email",
    provider: "provider",
    model_account: "model_account_id",
    model: "model_id",
  }[groupBy];
  if (!bucketExpression || !groupColumn || !metric) {
    throw new TypeError("token usage query must be validated before database access");
  }

  const filterDefinitions = [
    ["hub_user_email", hubUsers],
    ["provider", providers],
    ["model_account_id", modelAccounts],
    ["model_id", models],
  ];
  const buildRange = (timeColumn) => {
    const clauses = [`${timeColumn} >= ?`, `${timeColumn} < ?`];
    const args = [start, end];
    for (const [column, values] of filterDefinitions) {
      if (!values.length) continue;
      clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
      args.push(...values);
    }
    return { clauses: clauses.join(" AND "), args };
  };
  const detailRange = buildRange("bucket_start");
  const selectedColumns = `
    hub_user_email, provider, model_account_id, model_id, bucket_start,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    reasoning_tokens, total_tokens
  `;
  let usageSource;
  let usageArgs;
  if (granularity === "day") {
    const dailyRange = buildRange("day_start");
    usageSource = `
      SELECT
        hub_user_email, provider, model_account_id, model_id, day_start AS bucket_start,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens
      FROM token_usage_daily
      WHERE ${dailyRange.clauses}
      UNION ALL
      SELECT ${selectedColumns}
      FROM token_usage_15m
      WHERE ${detailRange.clauses}
    `;
    usageArgs = [...dailyRange.args, ...detailRange.args];
  } else {
    usageSource = `
      SELECT ${selectedColumns}
      FROM token_usage_15m
      WHERE ${detailRange.clauses}
    `;
    usageArgs = detailRange.args;
  }
  const counterSums = TOKEN_USAGE_COUNTERS
    .map((counter) => `COALESCE(SUM(${counter}), 0) AS ${counter}`)
    .join(",\n");

  const results = await client.batch([{
    sql: `
      WITH usage AS (${usageSource})
      SELECT ${counterSums}
      FROM usage
    `,
    args: usageArgs,
  }, {
    sql: `
      WITH usage AS (${usageSource})
      SELECT
        ${bucketExpression} AS bucket_start,
        ${groupColumn} AS group_value,
        ${counterSums}
      FROM usage
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
      LIMIT ?
    `,
    args: [...usageArgs, TOKEN_USAGE_TREND_LIMIT + 1],
  }, {
    sql: `
      WITH usage AS (${usageSource})
      SELECT
        hub_user_email, provider, model_account_id, model_id,
        ${counterSums}
      FROM usage
      GROUP BY hub_user_email, provider, model_account_id, model_id
      ORDER BY total_tokens DESC, hub_user_email ASC, provider ASC, model_account_id ASC, model_id ASC
      LIMIT ?
    `,
    args: [...usageArgs, TOKEN_USAGE_BREAKDOWN_LIMIT + 1],
  }, {
    sql: `
      SELECT users.email AS hub_user_email, state.last_reported_at
      FROM auth_users AS users
      LEFT JOIN token_usage_reporter_state AS state
        ON state.hub_user_email = users.email
      ORDER BY users.email ASC
    `,
    args: [],
  }], "read");

  const trendRows = results[1].rows;
  const breakdownRows = results[2].rows;
  if (trendRows.length > TOKEN_USAGE_TREND_LIMIT || breakdownRows.length > TOKEN_USAGE_BREAKDOWN_LIMIT) {
    const error = new Error("token usage query result is too broad");
    error.code = "query_too_broad";
    throw error;
  }
  return {
    totals: numericTokenUsageRow(results[0].rows[0] || {}),
    trend: trendRows.map((row) => numericTokenUsageRow(row, ["bucket_start", "group_value"])),
    breakdown: breakdownRows.map((row) => numericTokenUsageRow(row, [
      "hub_user_email",
      "provider",
      "model_account_id",
      "model_id",
    ])),
    reporters: results[3].rows.map((row) => ({
      hub_user_email: row.hub_user_email,
      last_reported_at: row.last_reported_at || null,
    })),
  };
}

export async function compactTokenUsage({
  before,
  maxDays = 7,
  receiptBefore = before,
}) {
  await ensureSchema();
  const boundedMaxDays = Math.max(1, Math.min(Number(maxDays) || 7, 7));
  const selected = await client.execute({
    sql: `
      SELECT DISTINCT substr(bucket_start, 1, 10) AS day
      FROM token_usage_15m
      WHERE bucket_start < ?
      ORDER BY day ASC
      LIMIT ?
    `,
    args: [before, boundedMaxDays],
  });
  const days = selected.rows.map((row) => String(row.day));
  let detailRowsRemoved = 0;
  let dailyRowsAffected = 0;

  for (const day of days) {
    const dayStart = `${day}T00:00:00.000Z`;
    const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();
    const updatedAt = new Date().toISOString();
    const results = await client.batch([{
      sql: `
        INSERT INTO token_usage_daily (
          hub_user_email, provider, model_account_id, model_id, day_start,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, total_tokens, updated_at
        )
        SELECT
          hub_user_email, provider, model_account_id, model_id,
          substr(bucket_start, 1, 10) || 'T00:00:00.000Z',
          SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
          SUM(reasoning_tokens), SUM(total_tokens), ?
        FROM token_usage_15m
        WHERE bucket_start >= ? AND bucket_start < ? AND bucket_start < ?
        GROUP BY hub_user_email, provider, model_account_id, model_id, substr(bucket_start, 1, 10)
        ON CONFLICT(hub_user_email, provider, model_account_id, model_id, day_start)
        DO UPDATE SET
          input_tokens = token_usage_daily.input_tokens + excluded.input_tokens,
          output_tokens = token_usage_daily.output_tokens + excluded.output_tokens,
          cache_read_tokens = token_usage_daily.cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = token_usage_daily.cache_write_tokens + excluded.cache_write_tokens,
          reasoning_tokens = token_usage_daily.reasoning_tokens + excluded.reasoning_tokens,
          total_tokens = token_usage_daily.total_tokens + excluded.total_tokens,
          updated_at = excluded.updated_at
      `,
      args: [updatedAt, dayStart, dayEnd, before],
    }, {
      sql: `
        DELETE FROM token_usage_15m
        WHERE bucket_start >= ? AND bucket_start < ? AND bucket_start < ?
      `,
      args: [dayStart, dayEnd, before],
    }], "write");
    dailyRowsAffected += Number(results[0].rowsAffected || 0);
    detailRowsRemoved += Number(results[1].rowsAffected || 0);
  }

  const receiptResult = await client.execute({
    sql: `
      DELETE FROM token_usage_batch_receipts
      WHERE rowid IN (
        SELECT rowid FROM token_usage_batch_receipts
        WHERE received_at < ?
        ORDER BY received_at ASC
        LIMIT 1000
      )
    `,
    args: [receiptBefore],
  });
  return {
    days,
    detail_rows_removed: detailRowsRemoved,
    daily_rows_affected: dailyRowsAffected,
    receipts_removed: Number(receiptResult.rowsAffected || 0),
  };
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

// One row per (source, reporter) recording the outcome of that machine's last guard run. Written on
// EVERY run, including the runs whose quota payload is unreportable -- that is the entire point: it
// is what separates "machine is offline" from "guard is running but the probe keeps failing".
export async function upsertReporterProbeHeartbeat(heartbeat) {
  await ensureSchema();
  const source = String(heartbeat.source);
  const reporterKey = assignmentKey(heartbeat.reporter_name, heartbeat.hostname);
  if (!reporterKey) {
    return { ok: false, reason: "missing_reporter_key" };
  }
  const lastRunAt = heartbeat.last_run_at || new Date().toISOString();
  const failed = heartbeat.status === "error";
  // Only a change the dashboard actually renders bumps the revision. Every reporter heartbeats every
  // 15 minutes; bumping on each one would force every open dashboard to refetch for a row whose
  // visible state did not move. Transitions (ok -> error, account switch, first-ever heartbeat) do
  // bump, so a machine that starts failing shows up without waiting for anything else to change.
  const revisionGuard = dashboardRevisionUpdate(
    lastRunAt,
    ` AND (
        EXISTS (
          SELECT 1 FROM reporter_probe_heartbeats
          WHERE source = ? AND reporter_key = ?
            AND (status IS NOT ? OR account_id IS NOT ?)
        )
        OR NOT EXISTS (
          SELECT 1 FROM reporter_probe_heartbeats WHERE source = ? AND reporter_key = ?
        )
      )`,
    [source, reporterKey, String(heartbeat.status), heartbeat.account_id || null, source, reporterKey],
  );
  await client.batch([revisionGuard, {
    sql: `
      INSERT INTO reporter_probe_heartbeats (
        source, reporter_key, hostname, reporter_name, hub_user_email, last_run_at,
        status, error, account_id, client_version, consecutive_failures, last_ok_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, reporter_key) DO UPDATE SET
        hostname = excluded.hostname,
        reporter_name = excluded.reporter_name,
        hub_user_email = excluded.hub_user_email,
        last_run_at = excluded.last_run_at,
        status = excluded.status,
        error = excluded.error,
        account_id = excluded.account_id,
        client_version = excluded.client_version,
        consecutive_failures = CASE
          WHEN excluded.status = 'error' THEN reporter_probe_heartbeats.consecutive_failures + 1
          ELSE 0
        END,
        last_ok_at = CASE
          WHEN excluded.status = 'error' THEN reporter_probe_heartbeats.last_ok_at
          ELSE excluded.last_run_at
        END
      WHERE excluded.last_run_at >= reporter_probe_heartbeats.last_run_at
    `,
    args: [
      source,
      reporterKey,
      heartbeat.hostname || null,
      heartbeat.reporter_name || null,
      heartbeat.hub_user_email || null,
      lastRunAt,
      String(heartbeat.status),
      heartbeat.error || null,
      heartbeat.account_id || null,
      heartbeat.client_version || null,
      failed ? 1 : 0,
      failed ? null : lastRunAt,
    ],
  }]);
  return { ok: true, source, reporter_key: reporterKey };
}

export async function reporterProbeHeartbeats({ limit = 200 } = {}) {
  await ensureSchema();
  const result = await client.execute({
    sql: `
      SELECT source, reporter_key, hostname, reporter_name, hub_user_email, last_run_at,
             status, error, account_id, client_version, consecutive_failures, last_ok_at
      FROM reporter_probe_heartbeats
      ORDER BY last_run_at DESC
      LIMIT ?
    `,
    args: [Number(limit)],
  });
  return result.rows.map((row) => ({
    source: row.source,
    reporter_key: row.reporter_key,
    hostname: row.hostname,
    reporter_name: row.reporter_name,
    hub_user_email: row.hub_user_email,
    last_run_at: row.last_run_at,
    status: row.status,
    error: row.error,
    account_id: row.account_id,
    client_version: row.client_version,
    consecutive_failures: Number(row.consecutive_failures || 0),
    last_ok_at: row.last_ok_at,
  }));
}

// Every access token the hub has ever held, keyed to the account it belongs to. A token belongs to
// exactly one account for its whole life, so the first record wins and nothing is ever deleted: an
// older token stays in circulation on borrowers' machines long after the pool has rotated past it,
// and a report from one of them must still resolve.
export async function recordAuthPoolTokenFingerprint(source, authJson, accountId) {
  await ensureSchema();
  const fingerprint = accessTokenFingerprint(authJson, source);
  if (!fingerprint) {
    return;
  }
  await client.execute({
    sql: `
      INSERT INTO auth_pool_token_fingerprints (source, fingerprint, account_id, recorded_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source, fingerprint) DO NOTHING
    `,
    args: [String(source), fingerprint, String(accountId), new Date().toISOString()],
  });
}

export async function authPoolTokenOwner(source, fingerprint) {
  await ensureSchema();
  const result = await client.execute({
    sql: `SELECT account_id FROM auth_pool_token_fingerprints WHERE source = ? AND fingerprint = ?`,
    args: [String(source), String(fingerprint)],
  });
  return result.rows[0] ? { account_id: result.rows[0].account_id } : null;
}

// Resolve an access-token-only upload against the entry the pool already holds for that account.
// Returns the pooled blob carrying the newer access token, or the reason it was not taken.
async function mergeStrippedUploadIntoPooledEntry(rawEntry) {
  const source = String(rawEntry.source);
  // deriveAuthPoolEntry validates by throwing. A stripped blob that is not even a well-formed pool
  // blob has nothing to merge and is refused the way every stripped blob used to be.
  let incoming;
  try {
    incoming = deriveAuthPoolEntry(source, rawEntry.auth_json, rawEntry);
  } catch {
    return { auth_json: null, reason: "stripped_refresh_token" };
  }
  const existing = await authPoolEntry(source, incoming.account_id);
  if (!existing) {
    return { auth_json: null, reason: "stripped_refresh_token" };
  }
  const storedAuthJson = await decryptAuthJson(existing);
  const mergedAuthJson = mergeStrippedAccessToken(storedAuthJson, rawEntry.auth_json, source);
  if (!mergedAuthJson) {
    return { auth_json: null, reason: "stripped_access_token_not_newer" };
  }
  return { auth_json: mergedAuthJson, reason: null, entry: existing };
}

export async function upsertAuthPoolEntry(rawEntry) {
  await ensureSchema();
  // Never let a stripped (placeholder-RT) blob overwrite a real shared refresh token: a
  // borrower running in disabled_refresh_token mode would otherwise upload its AT-only copy
  // and poison the pool entry (the hub would lose the RT it needs to refresh centrally).
  // Reject it outright; the existing real-RT entry stays untouched.
  if (isStrippedRefreshToken(rawEntry.auth_json, rawEntry.source)) {
    // An access-token-only blob is still supply when its token outlives the pooled one: a borrower
    // or an AT-only owner whose desktop re-minted a fresh 30-day token holds the only live copy of
    // an account whose pooled RT may be dead. Merge that token into the stored blob and keep the
    // stored refresh token exactly as it is -- the wipe this guard was built against (4b9b49f) came
    // from letting a placeholder RT reach the RT field, and the merge never writes that field.
    const merged = await mergeStrippedUploadIntoPooledEntry(rawEntry);
    if (!merged.auth_json) {
      return { rejected: true, reason: merged.reason, deduplicated: true };
    }
    // A token top-up, not a new upload: whoever sent it (a borrower, as often as not) does not become
    // the account's uploader, and the owner's machine stays on the entry -- the same rule the hub's
    // own refresh_current write-back follows.
    rawEntry = {
      ...rawEntry,
      auth_json: merged.auth_json,
      uploader_email: merged.entry.uploader_email || null,
      reporter_name: merged.entry.reporter_name || null,
      hostname: merged.entry.hostname || null,
    };
  }
  const derived = deriveAuthPoolEntry(rawEntry.source, rawEntry.auth_json, rawEntry);
  // Record the token before deciding whether this blob replaces the stored entry: "token T belongs
  // to account X" is true either way. This single hook covers every token the hub can hand out --
  // uploads, the worker's central refresh and fetch-best's refresh_current all land here, and what
  // fetch-best serves is the stored blob with only the refresh token stripped, access token intact.
  await recordAuthPoolTokenFingerprint(derived.source, rawEntry.auth_json, derived.account_id);
  const sessionId = String(derived.session_id || rawEntry.session_id || '');
  const incomingUploaderEmail = rawEntry.uploader_email ? normalizeEmail(rawEntry.uploader_email) : null;

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
  // `uploader_email` means the authenticated Hub user who most recently uploaded
  // this credential. Internal refresh writes do not carry an uploader and retain the
  // last real uploader instead of inventing one from the provider account identity.
  const accountUploaderEmail = incomingUploaderEmail || accountOwnerResult.rows[0]?.uploader_email || null;

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
        has_refresh_token,
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
        has_refresh_token: existingResult.rows[0].has_refresh_token === null ? null : Boolean(existingResult.rows[0].has_refresh_token),
        digest: existingResult.rows[0].digest,
        uploader_email: existingResult.rows[0].uploader_email,
        reporter_name: existingResult.rows[0].reporter_name,
        hostname: existingResult.rows[0].hostname,
        uploaded_at: existingResult.rows[0].uploaded_at,
      }
    : null;
  if (!shouldReplaceAuthPoolEntry(existingRow, derived)) {
    const uploaderChanged = incomingUploaderEmail !== null && incomingUploaderEmail !== existingRow.uploader_email;
    const reporterChanged = derived.reporter_name !== null && derived.reporter_name !== existingRow.reporter_name;
    const hostnameChanged = derived.hostname !== null && derived.hostname !== existingRow.hostname;
    const refreshCapabilityChanged = existingRow.has_refresh_token === null;
    if (uploaderChanged || reporterChanged || hostnameChanged || refreshCapabilityChanged) {
      const repairedAt = new Date().toISOString();
      const nextUploader = incomingUploaderEmail || existingRow.uploader_email;
      const nextReporter = derived.reporter_name || existingRow.reporter_name;
      const nextHostname = derived.hostname || existingRow.hostname;
      await client.batch([
        dashboardRevisionUpdate(
          repairedAt,
          ` AND EXISTS (
              SELECT 1 FROM auth_pool_entries
              WHERE source = ? AND account_id = ? AND session_id = ?
                AND (has_refresh_token IS NULL OR uploader_email IS NOT ? OR reporter_name IS NOT ? OR hostname IS NOT ?)
            )`,
          [existingRow.source, existingRow.account_id, existingRow.session_id, nextUploader, nextReporter, nextHostname],
        ), {
        sql: `UPDATE auth_pool_entries
              SET has_refresh_token = COALESCE(has_refresh_token, ?),
                  uploader_email = ?, reporter_name = ?, hostname = ?, uploaded_at = ?
              WHERE source = ? AND account_id = ? AND session_id = ?
                AND (has_refresh_token IS NULL OR uploader_email IS NOT ? OR reporter_name IS NOT ? OR hostname IS NOT ?)`,
        args: [
          derived.has_refresh_token ? 1 : 0,
          nextUploader,
          nextReporter,
          nextHostname,
          repairedAt,
          existingRow.source,
          existingRow.account_id,
          existingRow.session_id,
          nextUploader,
          nextReporter,
          nextHostname,
        ],
      }]);
      existingRow.has_refresh_token = derived.has_refresh_token;
      existingRow.uploader_email = nextUploader;
      existingRow.reporter_name = nextReporter;
      existingRow.hostname = nextHostname;
      existingRow.uploaded_at = repairedAt;
    }
    return {
      source: existingRow.source,
      account_id: existingRow.account_id,
      session_id: existingRow.session_id,
      email: existingRow.email,
      name: existingRow.name,
      plan_name: existingRow.plan_name,
      auth_last_refresh: existingRow.auth_last_refresh,
      auth_expires_at: existingRow.auth_expires_at,
      has_refresh_token: existingRow.has_refresh_token,
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
        source, account_id, session_id, email, name, plan_name, auth_last_refresh, auth_expires_at, has_refresh_token, digest, uploader_email,
        reporter_name, hostname, uploaded_at, encrypted_auth_json, iv, auth_tag, auth_blob_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(${authPoolPkColumns}) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        plan_name = excluded.plan_name,
        auth_last_refresh = excluded.auth_last_refresh,
        auth_expires_at = excluded.auth_expires_at,
        has_refresh_token = excluded.has_refresh_token,
        digest = excluded.digest,
        uploader_email = excluded.uploader_email,
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
      derived.has_refresh_token ? 1 : 0,
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
    has_refresh_token: derived.has_refresh_token,
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
      has_refresh_token,
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
    has_refresh_token: row.has_refresh_token === null ? null : Boolean(row.has_refresh_token),
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
      has_refresh_token,
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
    has_refresh_token: row.has_refresh_token === null ? null : Boolean(row.has_refresh_token),
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

function rowToQuotaHistoryEvent(row) {
  return {
    source: row.source,
    account_id: row.account_id,
    reported_at: row.reported_at,
    status: row.status,
    error: row.error,
    windows: {
      "5h": row.five_h_remaining_percent === null && row.five_h_reset_at === null
        ? null
        : {
            remaining_percent: row.five_h_remaining_percent === null ? null : Number(row.five_h_remaining_percent),
            reset_at: row.five_h_reset_at,
          },
      "1week": row.one_week_remaining_percent === null && row.one_week_reset_at === null
        ? null
        : {
            remaining_percent: row.one_week_remaining_percent === null ? null : Number(row.one_week_remaining_percent),
            reset_at: row.one_week_reset_at,
          },
    },
  };
}

// Quota events are a rolling record, not an archive: the dashboard reads the last 24h and every
// verdict lives in auth_pool_quota_latest. Twenty-six accounts probed every 20 minutes is ~1.9k rows
// a day; without a cut-off the table only grows.
export async function pruneAuthPoolQuotaEvents({ before }) {
  await ensureSchema();
  const cutoff = String(before || "").trim();
  if (!Number.isFinite(Date.parse(cutoff))) {
    throw new TypeError("before must be a valid timestamp");
  }
  const result = await client.execute({
    sql: `DELETE FROM auth_pool_quota_events WHERE reported_at < ?`,
    args: [cutoff],
  });
  return { deleted: Number(result.rowsAffected || 0), before: cutoff };
}

export async function authPoolQuotaEvents({ source, accountId, since, until, limit = 96 } = {}) {
  await ensureSchema();
  const exactSource = String(source || "").trim();
  const exactAccountId = String(accountId || "").trim();
  const rawSince = String(since || "").trim();
  const rawUntil = String(until || "").trim();
  if (!exactSource || !exactAccountId || !rawSince || !rawUntil) {
    throw new TypeError("source, accountId, since, and until are required");
  }
  const exactSince = canonicalEventTimestamp(rawSince);
  const exactUntil = canonicalEventTimestamp(rawUntil);
  const requestedLimit = Number(limit);
  const boundedLimit = Math.min(Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 96, 96);
  const result = await client.execute({
    sql: `
      SELECT
        source,
        reported_at,
        account_id,
        status,
        error,
        five_h_remaining_percent,
        five_h_reset_at,
        one_week_remaining_percent,
        one_week_reset_at
      FROM auth_pool_quota_events
      WHERE source = ? AND account_id = ? AND reported_at >= ? AND reported_at <= ?
      ORDER BY reported_at DESC
      LIMIT ?
    `,
    args: [exactSource, exactAccountId, exactSince, exactUntil, boundedLimit],
  });
  return result.rows.map((row) => rowToQuotaHistoryEvent(row)).reverse();
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

// What counts as supplying the pool. An account is still a contribution while its quota is low --
// being drained is what a shared account is for -- so only credentials the pool cannot use at all are
// excluded: a dead login, or a Free plan with nothing to lend.
const HEALTHY_POOL_ENTRY_SQL = `
  NOT (
    (q.status = 'error' AND (
      q.error = 'auth invalidated (token_invalidated)'
      OR q.error = 'auth failed (401 unauthorized)'
      OR q.error = 'refresh_token_rejected'
      OR q.error = 'claude auth email unavailable'
    ))
    OR q.plan_name = 'Free'
  )
  -- An exhaustion report carries no windows. json_extract instead of a dedicated column:
  -- payload_json is the full sanitized report, and this is the only SQL consumer of the field.
  AND (
    q.five_h_remaining_percent IS NOT NULL
    OR q.one_week_remaining_percent IS NOT NULL
    OR json_extract(q.payload_json, '$.exhausted_until') IS NOT NULL
  )
`;

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
  clientVersion = null,
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
        requester_email, fetch_count, last_fetched_at, last_served_at, client_version, last_new_account_at
      ) VALUES (?, 1, ?, ?, ?, ?)
      ON CONFLICT(requester_email) DO UPDATE SET
        fetch_count = auth_pool_user_fetch_stats.fetch_count + 1,
        last_fetched_at = excluded.last_fetched_at,
        last_served_at = COALESCE(excluded.last_served_at, auth_pool_user_fetch_stats.last_served_at),
        client_version = excluded.client_version,
        last_new_account_at = COALESCE(excluded.last_new_account_at, auth_pool_user_fetch_stats.last_new_account_at)
      WHERE excluded.last_fetched_at >= auth_pool_user_fetch_stats.last_fetched_at
    `,
    args: [
      normalizedRequesterEmail,
      fetchedAt,
      SERVE_REASONS.has(String(reason)) ? fetchedAt : null,
      clientVersion ? String(clientVersion) : null,
      String(reason) === NEW_ACCOUNT_REASON ? fetchedAt : null,
    ],
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
  const verified = verifyTokenPayload(rawToken);
  if (String(rawToken || "").startsWith("qrp.") && !verified) {
    return null;
  }
  const hashed = tokenHash(rawToken);
  // Signed tokens and legacy opaque tokens both remain revocable in the DB.
  // Keep the lookup and last-used touch in one network batch so every
  // authenticated read pays one database round trip instead of two.
  const usedAt = new Date().toISOString();
  const results = await client.batch([{
    sql: `
      SELECT token_hash, email, created_at, last_used_at
      FROM auth_api_tokens
      WHERE token_hash = ?
    `,
    args: [hashed],
  }, {
    sql: `UPDATE auth_api_tokens SET last_used_at = ? WHERE token_hash = ?`,
    args: [usedAt, hashed],
  }], "write");
  const row = results[0].rows[0];
  if (!row) {
    return null;
  }
  return {
    email: row.email,
    created_at: row.created_at,
    last_used_at: usedAt,
  };
}

// Reasons that mean the pool actually handed an auth over. Only these start the cooldown clock —
// a request refused by the gate must not push the user's next allowed attempt further away.
const SERVE_REASONS = new Set(["served", "refreshed_current"]);

// The pool handing over a different account, as opposed to keeping the current one alive.
const NEW_ACCOUNT_REASON = "served";

// One round trip for everything the fetch gate needs: reporter freshness, reporter version, the
// last real serve, and the weighted premium split over the rolling window. Every subselect is a
// primary-key seek or an index seek on the token_usage_15m PK prefix, so this stays cheap enough
// to run on every fetch-best call.
export async function fetchPolicyInputs({ email, since }) {
  await ensureSchema();
  const normalizedEmail = normalizeEmail(email);
  const windowStart = String(since);
  const premiumPlaceholders = PREMIUM_MODEL_IDS.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `
      SELECT
        (SELECT last_reported_at FROM token_usage_reporter_state WHERE hub_user_email = ?1) AS last_reported_at,
        (SELECT client_version FROM token_usage_reporter_state WHERE hub_user_email = ?1) AS client_version,
        (SELECT last_served_at FROM auth_pool_user_fetch_stats WHERE requester_email = ?1) AS last_served_at,
        (SELECT client_version FROM auth_pool_user_fetch_stats WHERE requester_email = ?1) AS fetch_client_version,
        (SELECT last_new_account_at FROM auth_pool_user_fetch_stats WHERE requester_email = ?1) AS last_new_account_at,
        (
          SELECT COALESCE(SUM(${MODEL_COST_SQL}), 0)
          FROM token_usage_15m
          WHERE hub_user_email = ?1 AND bucket_start >= ?2
        ) AS total_cost,
        (
          SELECT COALESCE(SUM(${MODEL_COST_SQL}), 0)
          FROM token_usage_15m
          WHERE hub_user_email = ?1 AND bucket_start >= ?2
            AND model_id IN (${premiumPlaceholders})
        ) AS premium_cost,
        (
          SELECT COALESCE(SUM(${MODEL_COST_SQL}), 0)
          FROM token_usage_15m WHERE bucket_start >= ?2
        ) AS team_cost,
        -- Only users who actually drew on the pool in the window divide the fair share. Counting
        -- everyone registered would shrink each share toward zero and refuse people for consuming
        -- a normal amount alongside colleagues who consumed nothing.
        (
          SELECT COUNT(*) FROM (
            SELECT hub_user_email FROM token_usage_15m
            WHERE bucket_start >= ?2
            GROUP BY hub_user_email
            HAVING SUM(${MODEL_COST_SQL}) > 0
          )
        ) AS active_users,
        (
          SELECT EXISTS (
            SELECT 1
            FROM auth_pool_entries e
            INNER JOIN auth_pool_quota_latest q
              ON e.source = q.source AND e.account_id = q.account_id
            WHERE e.uploader_email = ?1 AND ${HEALTHY_POOL_ENTRY_SQL}
          )
        ) AS has_healthy_upload
    `,
    args: [normalizedEmail, windowStart, ...PREMIUM_MODEL_IDS],
  });
  const row = result.rows[0] || {};
  return {
    lastReportAt: row.last_reported_at || null,
    clientVersion: row.client_version || null,
    lastServedAt: row.last_served_at || null,
    fetchClientVersion: row.fetch_client_version || null,
    lastNewAccountAt: row.last_new_account_at || null,
    totalCost: Number(row.total_cost || 0),
    premiumCost: Number(row.premium_cost || 0),
    teamCost: Number(row.team_cost || 0),
    activeUsers: Number(row.active_users || 0),
    hasHealthyUpload: Boolean(Number(row.has_healthy_upload || 0)),
  };
}

// Recomputes each source's runway from observed burn and stores the verdict. Run from the probe
// worker, right after fresh quota snapshots land: the window function over 24h of quota events is
// far too heavy to run on every fetch, so the gate reads a single stored row instead.
export async function recomputePoolScarcity({ now = new Date(), horizonDays = SCARCITY_HORIZON_DAYS } = {}) {
  await ensureSchema();
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const burnSince = new Date(nowMs - SCARCITY_BURN_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const horizonEnd = new Date(nowMs + horizonDays * 24 * 60 * 60 * 1000).toISOString();
  const computedAt = new Date(nowMs).toISOString();

  const burnRows = (await client.execute({
    sql: `
      WITH s AS (
        SELECT source, one_week_remaining_percent AS wk,
          LAG(one_week_remaining_percent) OVER (
            PARTITION BY source, account_id ORDER BY reported_at
          ) AS prev
        FROM auth_pool_quota_events
        WHERE reported_at >= ? AND one_week_remaining_percent IS NOT NULL
      )
      SELECT source, ${BURN_POINTS_SQL} AS burn
      FROM s WHERE prev IS NOT NULL GROUP BY source
    `,
    args: [burnSince],
  })).rows;

  // Only accounts the pool would actually hand out count as supply. Counting dead or Free entries
  // would inflate the runway and quietly switch enforcement off exactly when it is needed.
  const supplyRows = (await client.execute({
    sql: `
      SELECT q.source,
        SUM(COALESCE(q.one_week_remaining_percent, 0)) AS supply_now,
        ${UNLOCK_POINTS_SQL.replace("one_week_reset_at", "q.one_week_reset_at")} AS unlock
      FROM auth_pool_quota_latest q
      INNER JOIN auth_pool_entries e ON e.source = q.source AND e.account_id = q.account_id
      WHERE q.plan_name <> 'Free' AND q.status = 'ok'
      GROUP BY q.source
    `,
    args: [horizonEnd],
  })).rows;

  const burnBySource = new Map(burnRows.map((row) => [String(row.source), Number(row.burn || 0)]));
  const results = [];
  const statements = [];
  for (const row of supplyRows) {
    const source = String(row.source);
    const projection = projectScarcity({
      burnPoints24h: burnBySource.get(source) || 0,
      supplyNowPoints: Number(row.supply_now || 0),
      unlockPoints: Number(row.unlock || 0),
      horizonDays,
    });
    results.push({ source, computed_at: computedAt, ...projection });
    statements.push({
      sql: `
        INSERT INTO pool_scarcity_state (
          source, computed_at, burn_points_per_day, available_points,
          demand_points, runway_days, horizon_days, scarce
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET
          computed_at = excluded.computed_at,
          burn_points_per_day = excluded.burn_points_per_day,
          available_points = excluded.available_points,
          demand_points = excluded.demand_points,
          runway_days = excluded.runway_days,
          horizon_days = excluded.horizon_days,
          scarce = excluded.scarce
      `,
      args: [
        source,
        computedAt,
        projection.burn_points_per_day,
        projection.available_points,
        projection.demand_points,
        Number.isFinite(projection.runway_days) ? projection.runway_days : null,
        projection.horizon_days,
        projection.scarce ? 1 : 0,
      ],
    });
  }
  if (statements.length) {
    await client.batch(statements);
  }
  return results;
}

export async function poolScarcityState(source) {
  await ensureSchema();
  const result = await client.execute({
    sql: `SELECT * FROM pool_scarcity_state WHERE source = ?`,
    args: [String(source)],
  });
  const row = result.rows[0];
  return row ? { ...row, scarce: Boolean(Number(row.scarce)) } : null;
}
