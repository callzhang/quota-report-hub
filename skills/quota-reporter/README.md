# Quota Reporter Skill

This directory contains the reusable `quota-reporter` skill published from this repo.

## Purpose

The skill installs a local 15-minute quota guard that:

- tracks the current local Codex and Claude auth state
- self-updates the installed skill from GitHub before each guard cycle
- reuploads current auth snapshots to keep shared cloud auth pool entries present
- checks whether the current local source is low on quota
- can push stable local Codex and Claude quota snapshots to the hub when available
- fetches and installs a strictly better auth from the same source when needed
- restarts or stops the local Codex app-server after writing a new Codex `auth.json`, so new Codex sessions do not keep using the old cached account
- shows a desktop notification after a successful local auth replacement so the user knows to quit the current Codex or Claude Code session and start a new one
- opens one persistent system dialog when any auth uploaded by the current token user is hard-invalidated and needs a fresh login; each guard run checks for an existing dialog before opening another one
- keeps older uploaded auths in the cloud pool when the local machine switches to a different current auth
- preserves the first uploader as the owner for each shared account, so using a fetched auth does not transfer re-login responsibility
- can trigger a remote cloud-worker probe on demand

The guard is source-aware:

- Codex auths only compete with other Codex auths
- Claude auths only compete with other Claude auths
- Codex cloud identities are normalized to the lowercased email when available, so Team users do not collide on a shared provider-side UUID

## Main Scripts

- `scripts/install_quota_guard.py`
  - installs local config
  - requests an emailed personal token
  - writes the scheduler
  - configures Claude statusline capture
  - verifies scheduler registration
  - runs one immediate guard cycle and fails if it cannot run
- `scripts/quota_guard.py`
  - runs one full local guard cycle
  - prints a compact human-readable summary by default; use `--json` for the full probe, sync, replacement, notification, and timing payload
  - checks GitHub `main` and updates the installed skill before probing
  - reuploads current auths
  - probes current local quota in an isolated temporary Codex home, with provider/auth override environment variables stripped so API-key or custom-provider shells cannot be mislabeled as the copied ChatGPT auth
  - fetches and installs a better auth if the current source is below threshold
  - restarts managed Codex app-server after a Codex auth write, or stops unmanaged ephemeral app-server so the next Codex launch starts cleanly
- `scripts/trigger_remote_probe.py`
  - triggers the GitHub Actions cloud probe worker
  - optionally watches the run
  - returns compact per-auth results from the hub
- `scripts/claude_statusline_probe.py`
  - captures Claude statusline JSON into a local snapshot file
  - preserves previous unexpired `5H` and `7d` rate-limit windows when Claude Code sends a startup or failed-response statusline payload without `rate_limits`
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
3. Confirm the installer prints a successful `verification` block
4. Let the scheduled guard run every 15 minutes
5. Optionally run `quota_guard.py` manually after a login change
6. Optionally run `trigger_remote_probe.py` to force one cloud probe cycle

Agents installing this skill for a teammate must finish the setup end-to-end. Do not stop after copying files or writing `~/.agents/auth/quota-reporter.json`; the install is not complete until scheduler registration is verified and one immediate guard cycle succeeds. If verification fails, inspect `~/.agents/auth/quota-guard.log` and `~/.agents/auth/quota-guard.error.log`, fix the environment, and rerun the installer or guard.

If the hub returns a newer personal token during upload, quota report, or fetch, the helper library writes it back into `~/.agents/auth/quota-reporter.json` automatically. A deleted legacy opaque `qrp_...` token still needs one fresh email-token setup because the hub cannot identify its owner from the token string alone.

`fetch-best` may return `repair_auth` when one of the user's uploaded auths has been invalidated. The guard installs that repair auth so the owner can re-login and refresh their own account instead of receiving someone else's shared replacement.

Use `quota_guard.py --skip-self-update` only when debugging a local edit and you do not want the script to replace itself from GitHub first.

Use `quota_guard.py --json` when you need the full structured result for debugging or automation. Manual runs should normally use the default summary output.

## Help Output

Every user-facing script in `scripts/` supports `-h` and documents:

- what the script does
- what each argument controls
- the default value for each optional argument
