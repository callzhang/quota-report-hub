#!/usr/bin/env node
// Who would the reporter gate refuse if it fired right now?
//
// The gate judges the client_version carried on the fetch-best request, so uptake must be read from
// auth_pool_user_fetch_stats -- token_usage_reporter_state only ever sees clients that report usage,
// which excludes exactly the population at risk.
//
//   node scripts/check_reporter_uptake.mjs
//
// Reads TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from the environment, falling back to .env.local.

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MIN_REPORTER_CLIENT_VERSION, PHASE_REPORTER_GATE_AT, clientNeedsUpgrade } from "../lib/premium-ratio.js";

const ACTIVE_DAYS = 7;

function loadEnv() {
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) return process.env;
  const path = fileURLToPath(new URL("../.env.local", import.meta.url));
  const parsed = Object.fromEntries(
    readFileSync(path, "utf8").split("\n")
      .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );
  return { ...parsed, ...process.env };
}

const env = loadEnv();
const client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const since = new Date(Date.now() - ACTIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();

const rows = (await client.execute({
  sql: `SELECT requester_email, client_version, last_fetched_at, fetch_count
        FROM auth_pool_user_fetch_stats
        WHERE last_fetched_at >= ?
        ORDER BY fetch_count DESC`,
  args: [since],
})).rows;

const blocked = rows.filter((row) => clientNeedsUpgrade(row.client_version));

console.log(`reporter gate fires ${PHASE_REPORTER_GATE_AT} (minimum client ${MIN_REPORTER_CLIENT_VERSION})`);
console.log(`active fetchers in the last ${ACTIVE_DAYS} days: ${rows.length}`);
console.log(`would be refused right now: ${blocked.length}\n`);

if (blocked.length) {
  console.table(blocked.map((row) => ({
    user: String(row.requester_email).replace(/@.*/, ""),
    version: row.client_version || "(none)",
    fetches: Number(row.fetch_count),
    last_fetch: String(row.last_fetched_at).slice(0, 16).replace("T", " "),
  })));
  console.log("\nEach of these needs quota_guard running so self_update_skill can pull the new client.");
} else {
  console.log("Every active fetcher is on a current client. The gate can fire safely.");
}

process.exitCode = blocked.length ? 1 : 0;
