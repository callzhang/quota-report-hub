---
name: quota-reporter
description: Install and run a local quota guard that checks current Codex and Claude quota every 15 minutes, syncs the current auth for each source to the shared encrypted auth pool only when it changes, fetches a better auth from the cloud when local quota is low, and stores the user's personal company-email access token locally. Use this whenever a teammate wants to join the shared auth pool, install the 15-minute guard, set up a company-email auth-pool token, or verify that local auth rotation is working.
---

# Quota Guard

This skill installs and runs the local quota guard for Codex and Claude.

## What it does

1. Tracks the current local auth state per source in `~/.agents/auth/known_auth.json`
2. Self-updates the installed skill from GitHub before each guard cycle
3. Reuploads the current auth for each source to keep the shared encrypted auth pool entry present even when the local digest has not changed
4. Probes the current local Codex quota and the current local Claude quota to decide whether the current machine should rotate
5. Publishes stable local quota snapshots back to the hub when available, with stricter completeness checks for Codex
6. When local quota is low, asks the cloud auth pool for a strictly better auth from the same source and installs it locally
7. Restarts the local Codex app-server after writing a new Codex `auth.json`, so new Codex sessions read the replaced account instead of a stale cached account
8. Installs a reboot-safe scheduler that runs every 15 minutes
9. Notifies the local user when any auth uploaded by that same token user is hard-invalidated, even if that auth is not the currently installed local auth
10. Stores the user's personal company-email auth-pool token locally so future runs can upload and fetch without prompting again

## Files

- Combined local guard: `scripts/quota_guard.py`
- Installer: `scripts/install_quota_guard.py`
- Claude statusline hook: `scripts/claude_statusline_probe.py`
- Internal shared helper library: `scripts/quota_reporters.py`
- Remote worker trigger/watch: `scripts/trigger_remote_probe.py`
- Archived legacy scripts: `archive/`
- Skill overview: `README.md`

## Required inputs

You need:

- the shared auth-pool URL, for example `https://quota-report-hub.vercel.app`
- a personal auth-pool user token issued by company email

That same personal token is also used to unlock the hosted dashboard.

## Mandatory Agent Verification

Whenever an agent installs this skill, repairs an existing installation, or discusses whether the local guard is working, it must verify the real local state before moving on.

The agent must do both checks:

1. Run one guard cycle actively.

```bash
python3 scripts/quota_guard.py --skip-self-update --no-toast
```

2. Check that the 15-minute scheduler is actually registered.

Use the platform-specific check:

- macOS: `launchctl print gui/$(id -u)/com.openai.quota-guard`
- Linux: `crontab -l | grep quota-guard-managed`
- Windows: `Get-ScheduledTask -TaskName com.openai.quota-guard`

Do not claim installation is complete, do not tell the user the guard is running, and do not move to the next setup step until both checks pass. If either check fails, inspect `~/.agents/auth/quota-guard.log` and `~/.agents/auth/quota-guard.error.log`, fix the environment, and rerun the failed check.

## Standard flow

### Install the 15-minute guard

Run:

```bash
python3 scripts/install_quota_guard.py \
  --auth-pool-url https://your-dashboard.vercel.app \
  --email your.name@stardust.ai
```

The installer:

- asks for a company email if one was not provided
- requests an emailed personal token from `/api/auth/issue-token`
- asks the user to paste the token back into the terminal
- writes the local config file under `~/.agents/auth/quota-reporter.json`
- installs the 15-minute scheduler
- writes Claude Code `statusLine` settings to `~/.claude/settings.json`
- verifies that the scheduler was registered
- runs one immediate `quota_guard.py --skip-self-update --no-toast` cycle and fails the install if the guard cannot run

Agent responsibility:

- Do not stop after copying the skill or writing config.
- Run `install_quota_guard.py` for the user, complete token setup, then still perform the mandatory agent verification above.
- If verification fails, inspect `~/.agents/auth/quota-guard.log` and `~/.agents/auth/quota-guard.error.log`, fix the local environment, and rerun the installer or `quota_guard.py` until one guard cycle succeeds.

Token rules:

- only the latest token for an email remains valid
- requesting a new token revokes the old one
- the latest token can still be reused on multiple machines
- if a request uses an older hub-signed token, the hub can return a new latest token and the local scripts store it automatically
- deleted legacy opaque `qrp_...` tokens cannot be upgraded in-band because they do not include a verifiable email

If the user is not already using a compatible hub, the correct order is:

1. either deploy a new hub with `scripts/deploy_vercel.py` or confirm an existing hub already supports the auth-pool APIs
2. then run `install_quota_guard.py`
3. then paste the emailed token
4. then let the scheduled guard handle the rest

### Run one manual guard cycle

```bash
python3 scripts/quota_guard.py
```

### Trigger one remote cloud probe

```bash
python3 scripts/trigger_remote_probe.py
```

This script:

- triggers the GitHub Actions workflow `probe-auth-pool.yml`
- waits for the newly created `workflow_dispatch` run on `main`
- prints the run id as JSON
- watches the run until it finishes
- then fetches the hub status and returns a compact result row for each auth

If you only want the run id and do not want to attach to the live log:

```bash
python3 scripts/trigger_remote_probe.py --no-watch
```

The guard then:

- checks GitHub `main` for a newer `quota-reporter` skill and updates the installed skill unless `--skip-self-update` is passed
- updates `~/.agents/auth/known_auth.json`
- reuploads the current auth to the auth pool so a missing cloud entry can recover automatically
- probes the current live Codex auth and Claude auth
- Codex probes run in an isolated temporary `CODEX_HOME` and strip provider/auth override environment variables such as `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `CODEX_ACCESS_TOKEN`; otherwise a teammate's shell config can produce quota for a different provider while labeling it as the copied `auth.json` account
- may push stable local quota snapshots back to the hub when available
- for Codex, only complete windows or hard invalidations are uploaded, so partial local probes do not overwrite good hub data
- if a local source is below `20%` in `5H` or below `5%` in `1week`, calls `/api/auth/fetch-best` with `source + current local account + current local quota`
- only accepts a server response when it contains a strictly better replacement from that same source
- if the server returns `repair_auth`, the guard installs that auth instead of a shared replacement so the uploader can re-login and refresh their own invalidated auth
- only replaces local source credentials when the fetched auth is different from what is already installed
- after Codex `auth.json` is replaced or refreshed, restarts the local Codex app-server; if the app-server is an unmanaged ephemeral process, the guard stops it so the next Codex launch starts a fresh one
- shows a desktop notification after a successful local replacement so the user knows to quit the current Codex or Claude Code session and start a new one
- shows a desktop notification when any auth uploaded by the current token user is hard-invalidated in the hub
- does nothing when the cloud cannot provide a better auth than the current one
- relies on the cloud auth pool to deduplicate repeated uploads for the same `account_id`, even when raw files differ
- if the same account is refreshed locally, the changed `auth_last_refresh` is enough to trigger a new upload
- does not delete older auths previously uploaded by the same token user when the local machine switches to a different current auth
- for Codex, the cloud `account_id` is normalized to the lowercased email when available so Team users do not collide on a shared provider-side UUID

Operational notes:

- replacing `~/.codex/auth.json` does not hot-switch already running Codex TUI sessions
- the guard restarts or stops the local Codex app-server after a Codex auth write, but any already-open TUI still needs to be reopened to attach to the fresh backend
- the local config file contains a personal token and should stay private
- the cloud dashboard shows the latest effective quota for each auth entry
- Codex rows may be refreshed by either the cloud worker or a stable local client report; a newer worker soft failure does not replace an existing good local Codex quota snapshot
- Claude rows may come from the cloud worker or from a stable local client snapshot, depending on whether the current Claude environment can be replayed reliably on the worker. If `~/.claude/settings.json` injects `ANTHROPIC_*` provider credentials, the skill skips Claude cloud uploads for that machine.

## Output expectations

- After installation, show the scheduler type, config path, Claude statusline settings path, and verification result.
- After a manual guard run, show the current Codex and Claude probe payloads plus whether a replacement happened for each source.
- If token request, auth upload, or best-auth fetch fails, include the HTTP status and response body.
