#!/usr/bin/env node
// Ask the provider WHY each already-refused pooled refresh token is dead.
//
// The hub used to keep only "refresh http 401", so "unused too long" (refresh_token_expired),
// "someone else spent it" (refresh_token_reused) and "the session was ended"
// (refresh_token_invalidated) were indistinguishable. providerRefreshErrorCode now reads the answer
// going forward; this reads it for the tokens that are already dead, without waiting for new deaths.
//
// It has to run where the blob-store secret exists. Vercel marks TIGRIS_STORAGE_SECRET_ACCESS_KEY as a
// sensitive variable, so `vercel env pull` hands back an empty string and every blob read from a laptop
// fails with "the request signature we calculated does not match". The GitHub Actions worker has the
// real secret; the manual-only workflow .github/workflows/refresh-refusal-codes.yml runs this there.
//
// Safety: it presents ONLY tokens the hub has already had refused (central_refresh.auth_rejected), one
// attempt each, so nothing that is still live can be spent. It prints codes and ages, never tokens, and
// persists nothing except one auth_pool_refresh_attempts row per token (path "diagnostic"). If any token
// unexpectedly succeeds it stops at once: that means the hub's verdict was wrong and the rotated token
// exists nowhere but in this process's memory.
import { pathToFileURL } from "node:url";
import { authPoolEntry, authPoolQuotaLatest, recordAuthPoolRefreshAttempt } from "../lib/db.js";
import { decryptAuthJson } from "../lib/auth-pool.js";
import { refreshCodexToken, refreshTokenFromAuthBlob } from "../lib/token-refresh.js";
import { refreshTokenAgeSeconds } from "../lib/auth-pool-refresh.js";

const PLACEHOLDER_RT_PREFIX = "rt.1.";

// Entries whose latest report records a refused central refresh. Pure, so it can be tested without a
// database: the report is where the hub wrote down that the provider already said no.
export function refusedAccountIds(latestReports) {
  return latestReports
    .filter((report) => report?.source === "codex" && report?.usage_summary?.central_refresh?.auth_rejected === true)
    .map((report) => report.account_id);
}

export function isRealRefreshToken(refreshToken) {
  return Boolean(refreshToken) && !String(refreshToken).startsWith(PLACEHOLDER_RT_PREFIX);
}

export function summarise(rows) {
  const tally = {};
  for (const row of rows) {
    const key = row.code || "(no code in body)";
    tally[key] = (tally[key] || 0) + 1;
  }
  return tally;
}

async function main() {
  const accountIds = refusedAccountIds(await authPoolQuotaLatest({ source: "codex" }));
  console.log(`codex accounts whose refresh token the hub has already had refused: ${accountIds.length}`);
  const rows = [];
  for (const accountId of accountIds) {
    const entry = await authPoolEntry("codex", accountId);
    if (!entry) {
      console.log(`  ${accountId}: no pooled credential any more, skipped`);
      continue;
    }
    const authJson = await decryptAuthJson(entry);
    const refreshToken = refreshTokenFromAuthBlob(authJson, "codex");
    if (!isRealRefreshToken(refreshToken)) {
      console.log(`  ${accountId}: no real refresh token (empty or the AT-only placeholder), skipped`);
      continue;
    }
    const attemptedAt = new Date().toISOString();
    const rtAgeSeconds = refreshTokenAgeSeconds(authJson, "codex", Date.now());
    const result = await refreshCodexToken(refreshToken);
    await recordAuthPoolRefreshAttempt({ source: "codex", accountId, path: "diagnostic", attemptedAt, rtAgeSeconds, result });
    if (result.ok) {
      console.error(`!!! ${accountId}: the provider ACCEPTED a token the hub had recorded as refused. Stopping.`);
      process.exitCode = 2;
      return;
    }
    const row = { accountId, plan: entry.plan_name, ageDays: rtAgeSeconds === null ? null : rtAgeSeconds / 86400, status: result.status, code: result.provider_error_code };
    rows.push(row);
    console.log(
      `  ${accountId.padEnd(28)} ${String(row.plan).padEnd(9)} idle ${row.ageDays === null ? "?" : row.ageDays.toFixed(1)}d  HTTP ${row.status}  ${row.code || "(no code in body)"}`,
    );
  }
  console.log(`\ncodes: ${JSON.stringify(summarise(rows))}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error?.message || error).slice(0, 300));
    process.exitCode = 1;
  });
}
