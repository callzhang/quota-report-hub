import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import { sanitizeReport } from "./reports.js";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let schemaReady;

export function dbConfigured() {
  return Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
}

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS quota_report_events (
          event_id TEXT PRIMARY KEY,
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
      await client.execute(`DROP TABLE IF EXISTS quota_report_latest`);
      await client.execute(`
        CREATE TABLE quota_report_latest (
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
        INSERT INTO quota_report_latest (
          source, account_id, hostname, reporter_name, reported_at, email, name, plan_name, auth_path,
          auth_last_refresh, status, error, model_context_window,
          five_h_used_percent, five_h_remaining_percent, five_h_reset_at,
          one_week_used_percent, one_week_remaining_percent, one_week_reset_at, payload_json
        )
        SELECT
          source, account_id, hostname, reporter_name, reported_at, email, name, plan_name, auth_path,
          auth_last_refresh, status, error, model_context_window,
          five_h_used_percent, five_h_remaining_percent, five_h_reset_at,
          one_week_used_percent, one_week_remaining_percent, one_week_reset_at, payload_json
        FROM (
          SELECT
            source, account_id, hostname, reporter_name, reported_at, email, name, plan_name, auth_path,
            auth_last_refresh, status, error, model_context_window,
            five_h_used_percent, five_h_remaining_percent, five_h_reset_at,
            one_week_used_percent, one_week_remaining_percent, one_week_reset_at, payload_json,
            ROW_NUMBER() OVER (
              PARTITION BY source, account_id
              ORDER BY reported_at DESC, event_id DESC
            ) AS row_number
          FROM quota_report_events
        )
        WHERE row_number = 1
      `);
    })();
  }
  await schemaReady;
}

export async function insertReport(rawReport) {
  const report = sanitizeReport(rawReport);
  await ensureSchema();

  const fiveHour = report.windows["5h"];
  const oneWeek = report.windows["1week"];

  const args = [
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
  ];

  await client.execute({
    sql: `
      INSERT INTO quota_report_events (
        event_id, source, hostname, reporter_name, reported_at, account_id, email, name, plan_name,
        auth_path, auth_last_refresh, status, error, model_context_window,
        five_h_used_percent, five_h_remaining_percent, five_h_reset_at,
        one_week_used_percent, one_week_remaining_percent, one_week_reset_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [crypto.randomUUID(), report.source, report.hostname, report.reporter_name, report.reported_at, report.account_id, report.email, report.name, report.plan_name, report.auth_path, report.auth_last_refresh, report.status, report.error, report.model_context_window, fiveHour?.used_percent ?? null, fiveHour?.remaining_percent ?? null, fiveHour?.reset_at ?? null, oneWeek?.used_percent ?? null, oneWeek?.remaining_percent ?? null, oneWeek?.reset_at ?? null, JSON.stringify(report)],
  });

  await client.execute({
    sql: `
      INSERT INTO quota_report_latest (
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

  return report;
}

export async function latestReports() {
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
    FROM quota_report_latest
    ORDER BY reported_at DESC
  `);

  return result.rows.map((row) => {
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
  });
}
