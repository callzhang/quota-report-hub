# Quota Reporter Skill

This directory contains the reusable `quota-reporter` skill published from this repo.

## Purpose

The skill installs a local 15-minute quota guard that:

- tracks the current local Codex and Claude auth state
- uploads only changed auth snapshots to the shared cloud auth pool
- checks whether the current local source is low on quota
- fetches and installs a strictly better auth from the same source when needed
- can trigger a remote cloud-worker probe on demand

The guard is source-aware:

- Codex auths only compete with other Codex auths
- Claude auths only compete with other Claude auths

## Main Scripts

- `scripts/install_quota_guard.py`
  - installs local config
  - requests an emailed personal token
  - writes the scheduler
  - configures Claude statusline capture
- `scripts/quota_guard.py`
  - runs one full local guard cycle
  - uploads changed auths
  - probes current local quota
  - fetches and installs a better auth if the current source is below threshold
- `scripts/trigger_remote_probe.py`
  - triggers the GitHub Actions cloud probe worker
  - optionally watches the run
  - returns compact per-auth results from the hub
- `scripts/claude_statusline_probe.py`
  - captures Claude statusline JSON into a local snapshot file
- `scripts/quota_reporters.py`
  - shared helper library used by the scripts above
  - not intended as the main user entrypoint

## Removed Legacy Wrappers

The old single-purpose wrappers were removed because the install and guard flows now cover the active product path:

- `request_auth_pool_token.py`
- `sync_codex_auth_pool.py`
- `fetch_best_codex_auth.py`

Older report-oriented scripts remain under `archive/` only for reference.

## Typical Flow

1. Run `install_quota_guard.py`
2. Paste the emailed personal token
3. Let the scheduled guard run every 15 minutes
4. Optionally run `quota_guard.py` manually after a login change
5. Optionally run `trigger_remote_probe.py` to force one cloud probe cycle

## Help Output

Every user-facing script in `scripts/` supports `-h` and documents:

- what the script does
- what each argument controls
- the default value for each optional argument
