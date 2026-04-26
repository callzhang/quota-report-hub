import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import {
  decryptAuthJson,
  deriveAuthPoolEntry,
  encryptAuthJson,
  pickBestAuthPoolCandidate,
  shouldReplaceAuthPoolEntry,
} from "./auth-pool.js";
import { normalizeEmail, opaqueToken, tokenHash } from "./company-auth.js";
import { mergeLatestReport, sanitizeReport } from "./reports.js";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let schemaReady;

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
          email TEXT,
          name TEXT,
          plan_name TEXT,
          auth_last_refresh TEXT,
          digest TEXT NOT NULL,
          uploader_email TEXT,
          reporter_name TEXT,
          hostname TEXT,
          uploaded_at TEXT NOT NULL,
          encrypted_auth_json TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          PRIMARY KEY (source, account_id)
        )
      `);
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
    })();
  }
  await schemaReady;
}

export async function upsertAuthPoolEntry(rawEntry) {
  await ensureSchema();
  const derived = deriveAuthPoolEntry(rawEntry.source, rawEntry.auth_json, rawEntry);
  const existingResult = await client.execute({
    sql: `
      SELECT
        source,
        account_id,
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
    `,
    args: [derived.source, derived.account_id],
  });
  const existingRow = existingResult.rows[0]
    ? {
        source: existingResult.rows[0].source,
        account_id: existingResult.rows[0].account_id,
        email: existingResult.rows[0].email,
        name: existingResult.rows[0].name,
        plan_name: existingResult.rows[0].plan_name,
        auth_last_refresh: existingResult.rows[0].auth_last_refresh,
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
      email: existingRow.email,
      name: existingRow.name,
      plan_name: existingRow.plan_name,
      auth_last_refresh: existingRow.auth_last_refresh,
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

  await client.execute({
    sql: `
      INSERT INTO auth_pool_entries (
        source, account_id, email, name, plan_name, auth_last_refresh, digest, uploader_email,
        reporter_name, hostname, uploaded_at, encrypted_auth_json, iv, auth_tag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, account_id) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        plan_name = excluded.plan_name,
        auth_last_refresh = excluded.auth_last_refresh,
        digest = excluded.digest,
        uploader_email = excluded.uploader_email,
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
      derived.email,
      derived.name,
      derived.plan_name,
      derived.auth_last_refresh,
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
    email: derived.email,
    name: derived.name,
    plan_name: derived.plan_name,
    auth_last_refresh: derived.auth_last_refresh,
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
    ORDER BY uploaded_at DESC
  `);
  return result.rows.map((row) => ({
    source: row.source,
    account_id: row.account_id,
    email: row.email,
    name: row.name,
    plan_name: row.plan_name,
      auth_last_refresh: row.auth_last_refresh,
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

export async function authPoolEntry(source, accountId) {
  await ensureSchema();
  const result = await client.execute({
    sql: `
      SELECT
        source,
        account_id,
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
    `,
    args: [source, accountId],
  });
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    source: row.source,
    account_id: row.account_id,
    email: row.email,
    name: row.name,
    plan_name: row.plan_name,
    auth_last_refresh: row.auth_last_refresh,
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

export async function bestAuthPoolEntry(options = {}) {
  const reports = await authPoolQuotaLatest();
  const pool = await authPoolEntries();
  const candidate = pickBestAuthPoolCandidate(reports, pool, options);
  if (!candidate) {
    return null;
  }
  return {
    ...candidate.entry,
    auth_json: decryptAuthJson(candidate.entry),
    report: candidate.report,
  };
}

export async function issueApiToken(email) {
  await ensureSchema();
  const normalizedEmail = normalizeEmail(email);
  const rawToken = opaqueToken("qrp");
  const createdAt = new Date().toISOString();

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

export async function authenticateApiToken(rawToken) {
  await ensureSchema();
  const hashed = tokenHash(rawToken);
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
