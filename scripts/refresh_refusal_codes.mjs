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
// Safety: it presents ONLY tokens the hub has already had refused AFTER the current blob was stored and
// that are not pending (isKnownRefused), one attempt each, so nothing that is still live can be spent. It prints codes and ages, never tokens, and
// persists nothing except one auth_pool_refresh_attempts row per token (path "diagnostic"). If any token
// unexpectedly succeeds it stops at once: that means the hub's verdict was wrong and the rotated token
// exists nowhere but in this process's memory.
import { pathToFileURL } from "node:url";
import { authPoolEntry, authPoolQuotaLatest, recordAuthPoolRefreshAttempt } from "../lib/db.js";
import { decryptAuthJson } from "../lib/auth-pool.js";
import { isStrippedRefreshToken } from "../lib/fetch-best.js";
import { refreshCodexToken, refreshTokenFromAuthBlob } from "../lib/token-refresh.js";
import { refreshTokenAgeSeconds } from "../lib/auth-pool-refresh.js";

// Whether the CURRENT stored refresh token is one the provider is known to have refused. The report's
// central_refresh verdict alone is not enough: mergeLatestReport keeps a rejection sticky, so it
// outlives the token it was about. An owner who re-logs in and uploads leaves a fresh, live refresh
// token beside a report that still says "refused" — hr@stardust.ai and projects@stardust.ai were
// exactly that when this was written, both `pending`. Presenting such a token would rotate it and
// lose the new one, destroying a working credential to answer a diagnostic question. So:
//   - a `pending` entry is never selected (its RT has not been presented since the upload), and
//   - the refusal must have been reported AFTER the current blob was stored.
export function isKnownRefused(report, entry) {
  if (report?.source !== "codex" || report?.usage_summary?.central_refresh?.auth_rejected !== true) {
    return false;
  }
  if (!entry || entry.refresh_handoff_state === "pending") {
    return false;
  }
  const refusedAt = Date.parse(report.reported_at || "");
  const storedAt = Date.parse(entry.uploaded_at || "");
  return Number.isFinite(refusedAt) && Number.isFinite(storedAt) && refusedAt > storedAt;
}

// Delegates to the repo's own detector instead of guessing at the shape. A real Codex refresh token
// ALSO begins "rt.1." (that is the format's version prefix, which is why the hub's placeholder borrows
// it), so a prefix test classifies every real token as a placeholder. This script's first run did
// exactly that: it skipped all five accounts as "no real refresh token" and tested nothing.
export function hasRealRefreshToken(authJson) {
  return !isStrippedRefreshToken(authJson, "codex");
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
  const reports = (await authPoolQuotaLatest({ source: "codex" })).filter(
    (report) => report?.usage_summary?.central_refresh?.auth_rejected === true,
  );
  console.log(`codex accounts whose latest report records a refused central refresh: ${reports.length}`);
  const rows = [];
  for (const report of reports) {
    const accountId = report.account_id;
    const entry = await authPoolEntry("codex", accountId);
    if (!isKnownRefused(report, entry)) {
      const why = !entry ? "no pooled credential" : entry.refresh_handoff_state === "pending" ? "pending (its RT has not been presented since upload; the refusal on record is older)" : "refusal not newer than the stored blob";
      console.log(`  ${accountId}: skipped, ${why}`);
      continue;
    }
    const authJson = await decryptAuthJson(entry);
    const refreshToken = refreshTokenFromAuthBlob(authJson, "codex");
    if (!hasRealRefreshToken(authJson)) {
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
