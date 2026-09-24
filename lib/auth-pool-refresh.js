import { randomUUID } from "node:crypto";
import { refreshTokenFingerprint, refreshTokenFromAuthBlob } from "./token-refresh.js";

// All server-side rotation routes arrive here. A provider accepts an RT exactly once, therefore a
// per-account lease alone is not enough: after claiming it, re-read the canonical blob and require
// the same keyed RT fingerprint before presenting anything upstream. A stale request then becomes a
// harmless no-op instead of replaying a spent token and invalidating the whole token family.
export async function refreshSerializedAuthPoolEntry({
  source,
  accountId,
  authJson,
  refreshAuthBlob,
  persistRefreshedAuth,
  loadCurrentAuthJson = null,
  claimLease,
  releaseLease,
  leaseId = randomUUID(),
  // Optional, injected so this stays free of the database: called once per refresh that actually
  // reached the provider, with everything needed to read a later death against it.
  recordAttempt = null,
  path = null,
  now = () => Date.now(),
}) {
  const refreshToken = refreshTokenFromAuthBlob(authJson, source);
  const refreshTokenFingerprint = refreshTokenFingerprintForLease(source, refreshToken);
  if (!refreshTokenFingerprint) {
    return { ok: false, attempted: false, reason: "no_refresh_token" };
  }
  const lease = await claimLease({ source, accountId, refreshTokenFingerprint, leaseId });
  if (!lease.claimed) {
    return { ok: false, attempted: false, reason: lease.reason || "refresh_in_progress" };
  }
  try {
    if (loadCurrentAuthJson) {
      const currentAuthJson = await loadCurrentAuthJson();
      const currentFingerprint = refreshTokenFingerprintForLease(
        source,
        refreshTokenFromAuthBlob(currentAuthJson, source),
      );
      if (currentFingerprint !== refreshTokenFingerprint) {
        return { ok: false, attempted: false, reason: "refresh_superseded" };
      }
    }
    const refreshed = await refreshAuthBlob(authJson, source);
    if (refreshed.attempted !== false && recordAttempt) {
      await recordAttemptSafely(recordAttempt, {
        source,
        accountId,
        path,
        attemptedAt: new Date(now()).toISOString(),
        rtAgeSeconds: refreshTokenAgeSeconds(authJson, source, now()),
        result: refreshed,
      });
    }
    if (!refreshed.ok) return refreshed;
    await persistRefreshedAuth(refreshed.auth_json);
    return refreshed;
  } finally {
    await releaseLease({ source, accountId, leaseId });
  }
}

// How long the refresh token about to be spent has been sitting since it was issued. Only codex can
// say: its blob's `last_refresh` is the moment the current RT was minted (a login or a rotation).
// Claude's `auth_last_refresh` mirrors the access token's EXPIRY -- a future time -- so reading it
// as an age would produce a negative number that looks like data; null is the honest answer there.
export function refreshTokenAgeSeconds(authJson, source, nowMs) {
  if (source !== "codex") {
    return null;
  }
  let issuedMs;
  try {
    issuedMs = Date.parse(JSON.parse(authJson)?.last_refresh || "");
  } catch {
    return null;
  }
  if (!Number.isFinite(issuedMs) || issuedMs > nowMs) {
    return null;
  }
  return Math.round((nowMs - issuedMs) / 1000);
}

// Telemetry must never be able to fail a rotation: the provider has already accepted this RT, so an
// error here that skipped persisting the rotated blob would strand the pool on a spent token.
async function recordAttemptSafely(recordAttempt, attempt) {
  try {
    await recordAttempt(attempt);
  } catch (error) {
    console.error(JSON.stringify({ event: "refresh_attempt_record_failed", error: String(error?.message || error).slice(0, 200) }));
  }
}

function refreshTokenFingerprintForLease(source, refreshToken) {
  return refreshToken ? refreshTokenFingerprint(source, refreshToken) : null;
}
