---
name: quota-reporter
description: Install and run a local quota guard that checks Codex and Claude quota every 15 minutes, syncs both auth sources to the shared encrypted auth pool, fetches a better same-source auth when quota is low, and stores the user's personal company-email access token locally.
---

# Quota Guard

This skill installs and runs the local Codex and Claude quota guard.

## What it does

1. Tracks the current local auth state for Codex and Claude
2. Self-updates the installed skill from GitHub before each guard cycle
3. Reuploads the current auth for each source to keep its shared encrypted auth-pool entry present
4. Probes current Codex and Claude quota to decide whether either source should rotate
5. Publishes stable local quota snapshots back to the hub
6. When quota is low, asks the cloud auth pool for a strictly better auth from the same source and installs it locally
7. After writing Codex auth, requests an official managed-daemon restart; unmanaged and desktop app-server processes are never terminated
8. Installs a reboot-safe scheduler that runs every 15 minutes
9. Notifies the local user when any auth uploaded by that same token user has a refresh token rejected by the cloud worker, even if that auth is not the currently installed local auth
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

- logs the user in through the browser by default: it starts a one-shot `127.0.0.1` callback server, opens `<hub>/login.html`, and waits. On the page the user enters their company email, receives a one-time token by email, pastes it in, and the browser hands the token back to the localhost callback (guarded by a `state` nonce; the page only ever redirects to a loopback address).
- falls back automatically to the email + terminal-paste flow when no browser is available (headless/SSH/CI), or when `--no-browser` is passed: it requests an emailed token from `/api/auth/issue-token` and asks the user to paste it into the terminal
- accepts an existing token directly via `--auth-pool-user-token` (email is decoded from the token when not given)
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
3. then complete the browser login (or paste the emailed token in the terminal fallback)
4. then let the scheduled guard handle the rest

### Run one manual guard cycle

```bash
python3 scripts/quota_guard.py
```

The default output is a short human-readable summary. Use `--json` when you need the full probe, sync, replacement, notification, and timing payload for debugging:

```bash
python3 scripts/quota_guard.py --json
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
- falls back to GitHub's branch Atom feed when the commits API is rate limited, and reports any remaining self-update failure explicitly instead of masquerading as `Self update: ok`
- updates Codex and Claude entries in `~/.agents/auth/known_auth.json`
- reuploads current auths so a missing cloud entry can recover automatically
- probes current live Codex and Claude auth and quota
- if Codex is below `5%` in `1week`, calls `/api/auth/fetch-best` for a strictly better Codex auth; legacy Codex `5H` does not trigger rotation
- resolves the Claude CLI binary from common non-interactive locations such as `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` before relying on `PATH`
- may push stable local Claude quota snapshots back to the hub when available
- for Claude, the local probe reads the statusline snapshot first, then falls back to the OAuth usage API when the statusline has no quota windows; successful usage windows are cached during the endpoint polling backoff and reused only until their provider reset time, so alternating guard runs do not fall back to `n/a`
- Claude Code only sends statusline `rate_limits` after the first successful API response in a session. The statusline capture preserves previous unexpired `5H` or `7d` windows when a startup or failed-response statusline payload has no quota fields.
- if Claude is below `20%` in `5H` or below `5%` in `1week`, calls `/api/auth/fetch-best` with `source + current local account + current local quota`
- ordinary probe errors and unavailable quota snapshots do not trigger auth replacement; replacement requires a real low-quota window or a hard auth invalidation
- only accepts a server response when it contains a strictly better replacement from that same source
- for Claude, the server only shares candidate auths that still have at least `20%` remaining in `5H` and at least `5%` remaining in `1week`
- if the server returns `repair_auth`, the guard installs that auth instead of a shared replacement so the uploader can re-login and refresh their own invalidated auth
- only replaces local source credentials when the fetched auth is different from what is already installed
- after a Codex write, or when a manual login makes `auth.json` newer than the running app-server, invokes only `codex app-server daemon restart`; an unmanaged app-server returns `unmanaged_app_server_not_restarted` and is left running
- shows a desktop notification after a successful local replacement
- opens Claude CLI login only when a Claude auth uploaded by the current token user has a cloud-confirmed `refresh_token_rejected` result and `auto_relogin_owner_auth` is enabled; Codex login is never launched
- does nothing when the cloud cannot provide a better auth than the current one
- relies on the cloud auth pool to deduplicate repeated uploads for the same `account_id`, even when raw files differ
- preserves the first uploader as the owner for each `source + account_id`, so a fetched shared auth does not become owned by the machine that happened to reupload it
- if the same account is refreshed locally, the changed `auth_last_refresh` is enough to trigger a new upload
- does not delete older auths previously uploaded by the same token user when the local machine switches to a different current auth

Operational notes:

- replacing `~/.codex/auth.json` affects new Codex sessions; an already-open session may need to be reopened
- the guard never sends signals to Codex or app-server processes and never launches `codex login`
- the local config file contains a personal token and should stay private
- the cloud dashboard shows the latest effective quota for each auth entry
- Codex rows may be refreshed by either the cloud worker or a stable local client report; a complete weekly window is enough for a local client report because Codex no longer has a live 5H window. It may replace stale worker-preserved windows, and a newer worker soft failure does not replace an existing good local Codex quota snapshot
- Claude rows may come from the cloud worker or from a stable local client snapshot, depending on whether the current Claude environment can be replayed reliably on the worker. If `~/.claude/settings.json` injects `ANTHROPIC_*` provider credentials, the skill skips Claude cloud uploads for that machine.

## Output expectations

- After installation, show the scheduler type, config path, Claude statusline settings path, and verification result.
- After a manual guard run, show the compact summary by default. If deeper debugging is needed, rerun with `--json` and include the Codex and Claude probe, quota report, and replacement sections.
- If token request, auth upload, or best-auth fetch fails, include the HTTP status and response body.
