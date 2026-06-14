#!/usr/bin/env node
// Health-trend assessment for the disabled_refresh_token mechanism.
//
// Reads pool_health_snapshots and reports, per source, whether the hard-dead count (auths whose
// refresh token is gone and need an owner re-login) is CLIMBING / flat / falling over a window.
// The death spiral is "closed" when hard-dead stops climbing. Usage:
//   node scripts/assess_health.mjs [windowHours=4]
// Exit code: 0 = contained (flat/falling), 1 = still climbing for at least one source, 2 = no creds.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Credentials: prefer the environment (CI / scheduled runs), else fall back to local .env.local.
if (!process.env.TURSO_DATABASE_URL) {
  const envPath = join(root, ".env.local");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
if (!process.env.TURSO_DATABASE_URL) {
  console.error("assess_health: no TURSO_DATABASE_URL (set env vars or provide .env.local)");
  process.exit(2);
}

const windowHours = Number(process.argv[2] || 4);
const db = await import(join(root, "lib/db.js"));

const { isAbuseClassError } = await import(join(root, "lib/abuse-errors.js"));
const latestForAbuse = await db.authPoolQuotaLatest();
const abuseHits = latestForAbuse.filter((r) => r.status === "error" && isAbuseClassError(r.error));
if (abuseHits.length) {
  console.log(`\n🚨 ABUSE/BAN-CLASS ERRORS DETECTED (${abuseHits.length}) — possible pushback on shared access tokens:`);
  for (const r of abuseHits) console.log(`  ${r.source} ${r.account_id} | ${r.error}`);
  console.log("VERDICT: ABUSE_SUSPECTED — investigate; consider turning disabled_refresh_token OFF.");
  process.exit(3);
}

const snaps = await db.poolHealthSnapshots({ limit: 400 }); // oldest-first

if (!snaps.length) {
  console.log("No health snapshots recorded yet — the worker hasn't written any. Re-check after a worker run (~15 min).");
  process.exit(0);
}

const bySource = {};
for (const s of snaps) (bySource[s.source] = bySource[s.source] || []).push(s);

const newest = snaps[snaps.length - 1].captured_at;
console.log(`Pool health over last ~${windowHours}h (newest snapshot ${newest}):`);

let anyClimbing = false;
for (const [source, series] of Object.entries(bySource)) {
  const latest = series[series.length - 1];
  const targetMs = Date.parse(latest.captured_at) - windowHours * 3600_000;
  let past = series[0];
  for (const s of series) {
    if (Date.parse(s.captured_at) <= targetMs) past = s;
    else break;
  }
  const delta = latest.hard_dead_count - past.hard_dead_count;
  const trend = delta > 0 ? "CLIMBING" : delta < 0 ? "falling" : "flat";
  if (delta > 0) anyClimbing = true;
  const crOk = series.reduce((a, s) => a + s.central_refresh_ok, 0);
  const crRej = series.reduce((a, s) => a + s.central_refresh_rejected, 0);
  console.log(
    `  ${source}: ${latest.ok_count}/${latest.total} healthy · ` +
      `hard-dead ${latest.hard_dead_count} (${delta >= 0 ? "+" : ""}${delta} over ~${windowHours}h, ${trend}) · ` +
      `central-refresh ${crOk} ok / ${crRej} dead-RT (window)`
  );
}

console.log(
  anyClimbing
    ? "VERDICT: hard-dead is still CLIMBING for at least one source — new auths may still be dying; investigate."
    : "VERDICT: hard-dead flat or falling — death spiral appears contained."
);
process.exit(anyClimbing ? 1 : 0);
