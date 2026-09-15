// A full RT can be safely stored before every local holder has stopped, but it cannot be safely
// *used*: a successful refresh would revoke the ATs those holders are using. This state therefore
// blocks every hub refresh path until the local guard has observed a fresh idle window and has
// retired the old app-server.
export const REFRESH_HANDOFF_PENDING = "pending";

export function isRefreshHandoffPending(entry) {
  return entry?.refresh_handoff_state === REFRESH_HANDOFF_PENDING;
}

export function requestedRefreshHandoffState({ source, deferCodexRefresh = false } = {}) {
  return source === "codex" && deferCodexRefresh ? REFRESH_HANDOFF_PENDING : null;
}
