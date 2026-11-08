// When the hub may spend a pooled refresh token.
//
// Codex: only after the pooled access token has expired. A machine that holds the RT renews it about
// hourly (the Codex CLI times its refresh off the ~1h id_token) and its guard re-uploads every 15
// minutes, so the pooled blob is replaced long before the ~10-day AT expires. An AT that does expire
// means the holder is gone. Refreshing earlier would rotate an RT that a live holder still presents,
// and the provider revokes the whole token family on that reuse.
//
// Claude keeps the caller's proactive window: its refresh is not shared with a local CLI that
// renews on its own schedule.
//
// `msLeft` is null when the expiry is unknown; every source refreshes then.
export function hubRefreshDue(source, msLeft, proactiveThresholdMs) {
  if (msLeft === null) {
    return true;
  }
  return msLeft <= (source === "codex" ? 0 : proactiveThresholdMs);
}
