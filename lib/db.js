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
      await client.execute(`
        CREATE TABLE IF NOT EXISTS quota_report_latest (
          source TEXT NOT NULL,
          hostname TEXT NOT NULL,
          account_id TEXT NOT NULL,
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
          PRIMARY KEY (source, hostname, account_id)
        )
      `);
    })();
  }
  await schemaReady;
}

export async function insertReport(rawReport) {
  const report = sanitizeReport(rawReport);
  await ensureSchema();

  const args = [
    report.source,
    report.hostname,
    report.account_id,
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
    report.windows["5h"].used_percent,
    report.windows["5h"].remaining_percent,
    report.windows["5h"].reset_at,
    report.windows["1week"].used_percent,
    report.windows["1week"].remaining_percent,
    report.windows["1week"].reset_at,
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
    args: [crypto.randomUUID(), report.source, report.hostname, report.reporter_name, report.reported_at, report.account_id, report.email, report.name, report.plan_name, report.auth_path, report.auth_last_refresh, report.status, report.error, report.model_context_window, report.windows["5h"].used_percent, report.windows["5h"].remaining_percent, report.windows["5h"].reset_at, report.windows["1week"].used_percent, report.windows["1week"].remaining_percent, report.windows["1week"].reset_at, JSON.stringify(report)],
  });

  await client.execute({
    sql: `
      INSERT INTO quota_report_latest (
        source, hostname, account_id, reporter_name, reported_at, email, name, plan_name,
        auth_path, auth_last_refresh, status, error, model_context_window,
        five_h_used_percent, five_h_remaining_percent, five_h_reset_at,
        one_week_used_percent, one_week_remaining_percent, one_week_reset_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, hostname, account_id) DO UPDATE SET
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
      one_week_reset_at
    FROM quota_report_latest
    ORDER BY reported_at DESC
  `);

  return result.rows.map((row) => ({
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
    windows: {
      "5h": {
        used_percent: Number(row.five_h_used_percent),
        remaining_percent: Number(row.five_h_remaining_percent),
        reset_at: row.five_h_reset_at,
      },
      "1week": {
        used_percent: Number(row.one_week_used_percent),
        remaining_percent: Number(row.one_week_remaining_percent),
        reset_at: row.one_week_reset_at,
      },
    },
  }));
}
