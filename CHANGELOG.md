# Changelog

## 2026-11-08

### Fixed
- An account whose ChatGPT workspace is deactivated (`402 deactivated_workspace`) is no longer lent
  out. The Codex probe names it `WORKSPACE_DEACTIVATED_ERROR` (`lib/auth-status.js`) and
  `isPoolIneligible` (`lib/auth-pool.js`) excludes it. It is not an auth invalidation (the refresh
  token is intact), and the owner's own `repair_returned` path is unchanged.

## 2026-11-07

### Changed
- The hub refreshes a pooled Codex refresh token only after the pooled access token has expired
  (`hubRefreshDue`, `lib/refresh-timing.js`). A Codex upload is stored without a hub refresh, the
  worker probes Codex with the refresh token stripped, `refresh_current` and the worker refresh only
  expired entries, and the id_token precautionary refresh is gone.

### Removed
- `auth_pool_entries.refresh_handoff_state`, the owner-only handoff completion route, and the
  `local_refresh_handoff_pending` worker skip. The hub ignores `defer_codex_refresh`, which the Python
  client still sends until the separate client plan ships.
- Superseded plan `docs/superpowers/plans/2026-11-06-release-expired-refresh-handoff.md`.
