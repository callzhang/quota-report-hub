---
name: quota-reporter
description: Install and run a local quota guard that checks Codex and Claude quota every 15 minutes, syncs the current Codex auth to the shared encrypted auth pool only when it changes, fetches a better Codex auth from the cloud when local quota is low, and stores the user's personal company-email access token locally. Use this whenever a teammate wants to join the shared quota system, install the 15-minute guard, set up a company-email auth-pool token, or verify that local auth rotation is working.
---

# Quota Guard

This skill installs and runs the local quota guard for Codex and Claude.

## What it does

1. Tracks the local `~/.codex/auth.json` in `~/.agents/auth/known_auth.json`
2. Uploads the current Codex auth to the shared encrypted auth pool only when its digest changes
4. Probes local Codex quota plus the latest Claude Code `statusLine` snapshot for official Claude `rate_limits`
5. When local quota is low, asks the cloud auth pool for the best currently usable Codex auth and installs it into `~/.codex/auth.json`
6. Installs a reboot-safe scheduler that runs every 15 minutes
7. Stores the user's personal company-email auth-pool token locally so future runs can upload and fetch without prompting again

On macOS, the Claude probe only acts on the statusline snapshot when it contains both `5h` and `1week` windows. If Claude has not produced those windows yet, the guard skips Claude and still manages Codex.

## Files

- Combined local guard: `scripts/quota_guard.py`
- Installer: `scripts/install_quota_guard.py`
- Claude statusline hook: `scripts/claude_statusline_probe.py`
- Auth pool token request: `scripts/request_auth_pool_token.py`
- Auth pool sync: `scripts/sync_codex_auth_pool.py`
- Auth pool fetch/install: `scripts/fetch_best_codex_auth.py`
- Archived legacy scripts: `archive/`

## Required inputs

You need:

- the shared auth-pool URL, for example `https://quota-report-hub.vercel.app`
- a personal auth-pool user token issued by company email

That same personal token is also used to unlock the hosted dashboard.

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

Token rules:

- only the latest token for an email remains valid
- requesting a new token revokes the old one
- the latest token can still be reused on multiple machines

After install, each machine needs one real interactive Claude request to seed the first quota snapshot. Until that happens, macOS Claude reports are skipped instead of sending `n/a`.

If the user is not already using a compatible hub, the correct order is:

1. either deploy a new hub with `scripts/deploy_vercel.py` or confirm an existing hub already supports the auth-pool APIs
2. then run `install_quota_guard.py`
3. then paste the emailed token
4. then let the scheduled guard handle the rest

### Run one manual check

```bash
python3 scripts/quota_guard.py
```

The guard then:

- updates `~/.agents/auth/known_auth.json`
- uploads the current auth to the auth pool only when needed
- probes the current live Codex auth
- probes Claude from the local statusline snapshot
- if local Codex is below `20%` in `5H` or has `1week = 0`, fetches a better Codex auth from the cloud
- if local Claude is below `20%` in `5H` or has `1week = 0`, also fetches a better Codex auth from the cloud
- only replaces local `~/.codex/auth.json` when the fetched auth is different from what is already installed
- does nothing when the cloud cannot provide a better auth than the current one
- relies on the cloud auth pool to deduplicate repeated uploads for the same `account_id`, even when raw files differ

Operational notes:

- replacing `~/.codex/auth.json` does not hot-switch already running Codex sessions
- the next new Codex session is the one that should pick up the new auth
- the local config file contains a personal token and should stay private

## Output expectations

- After installation, show the scheduler type, config path, and Claude statusline settings path.
- After a manual guard run, show the current Codex and Claude probe payloads plus whether an auth replacement happened.
- If token request, auth upload, or best-auth fetch fails, include the HTTP status and response body.
