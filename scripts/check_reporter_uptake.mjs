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

// A null version means one of two very different things, and conflating them turns a healthy
// rollout into a false alarm: the client really is too old, OR the user simply has not fetched
// since RECORDING_SINCE, when the hub started storing the version at all. Only the first is a
// problem. Everyone still unseen resolves itself on their next fetch.
const RECORDING_SINCE = "2026-08-20T16:18:00.000Z";

const describe = (row) => ({
  user: String(row.requester_email).replace(/@.*/, ""),
  version: row.client_version || "(none)",
  fetches: Number(row.fetch_count),
  last_fetch: String(row.last_fetched_at).slice(0, 16).replace("T", " "),
});

const seen = rows.filter((row) => String(row.last_fetched_at) >= RECORDING_SINCE);
const unseen = rows.filter((row) => String(row.last_fetched_at) < RECORDING_SINCE);
const blocked = seen.filter((row) => clientNeedsUpgrade(row.client_version));

console.log(`reporter gate fires ${PHASE_REPORTER_GATE_AT} (minimum client ${MIN_REPORTER_CLIENT_VERSION})`);
console.log(`active fetchers in the last ${ACTIVE_DAYS} days: ${rows.length}`);
console.log(`  checked in since the hub started recording versions: ${seen.length}`);
console.log(`  of those, still on an old or absent client: ${blocked.length}`);
console.log(`  not seen since recording started (verdict pending): ${unseen.length}\n`);

if (blocked.length) {
  console.log("STILL ON AN OLD CLIENT -- these are refused when the gate fires:");
  console.table(blocked.map(describe));
  console.log("Each needs quota_guard running so self_update_skill can pull the new client.\n");
} else if (seen.length) {
  console.log("Every client seen since recording started is current.\n");
}

if (unseen.length) {
  console.log("NOT SEEN YET -- no verdict until each fetches once more:");
  console.table(unseen.map(describe));
}

// Only a confirmed-old client is a failure. A pending verdict is not.
process.exitCode = blocked.length ? 1 : 0;
