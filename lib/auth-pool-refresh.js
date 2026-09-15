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
    if (!refreshed.ok) return refreshed;
    await persistRefreshedAuth(refreshed.auth_json);
    return refreshed;
  } finally {
    await releaseLease({ source, accountId, leaseId });
  }
}

function refreshTokenFingerprintForLease(source, refreshToken) {
  return refreshToken ? refreshTokenFingerprint(source, refreshToken) : null;
}
