---
name: quota-reporter
description: Install and run a local quota reporter that archives Codex auth snapshots, probes the latest archived Codex quota windows plus Claude CLI usage metadata, posts normalized account-level status to a shared dashboard, and sets up an hourly scheduled run. Use this whenever a teammate wants to join the shared quota dashboard, report their own Codex or Claude usage, install the hourly reporter, or verify that reports are reaching the shared service. Trigger on requests about Codex quota, Claude CLI usage, token usage, usage monitoring, hourly usage reporting, shared quota dashboards, Vercel quota dashboards, or Turso-backed quota collection.
---

# Quota Reporter

This skill installs and runs local reporters for archived Codex auth snapshots and Claude CLI usage.

## What it does

1. Archives the local `~/.codex/auth.json` into `~/.agents/auth/` when Codex is present
2. Scans archived Codex auth snapshots and keeps the newest snapshot per account
3. Probes each archived Codex account's `5H` and `1week` quota windows
4. Reads local Claude CLI auth and usage metadata when Claude is present, and reads the latest Claude Code `statusLine` snapshot for official `rate_limits` data
5. Posts signed reports to the shared dashboard service
6. Installs a reboot-safe scheduler that reports every 15 minutes
7. Rotates `~/.codex/auth.json` to the highest-quota archived snapshot when the current live auth drops below `20%` remaining in the `5H` window

On macOS, the Claude reporter only posts when the statusline snapshot currently contains both `5h` and `1week` windows. If Claude detection fails there, it skips the Claude report instead of sending `n/a`.

## Files

- Combined reporter: `scripts/report_all_usage.py`
- Codex reporter: `scripts/report_codex_quota.py`
- Claude reporter: `scripts/report_claude_usage.py`
- Claude statusline hook: `scripts/claude_statusline_probe.py`
- Installer: `scripts/install_hourly_reporter.py`
- Auth pool token request: `scripts/request_auth_pool_token.py`
- Auth pool sync: `scripts/sync_codex_auth_pool.py`
- Auth pool fetch/install: `scripts/fetch_best_codex_auth.py`

## Required inputs

You need:

- the shared dashboard URL, for example `https://quota-report-hub.vercel.app`
- the ingest token for `POST /api/report`
- optionally, a personal auth-pool user token for encrypted Codex auth upload/download

## Standard flow

### One-off report

Run:

```bash
python3 scripts/report_all_usage.py \
  --server-url https://your-dashboard.vercel.app \
  --ingest-token YOUR_TOKEN
```

If you only want one source:

```bash
python3 scripts/report_codex_quota.py --server-url https://your-dashboard.vercel.app --ingest-token YOUR_TOKEN
python3 scripts/report_claude_usage.py --server-url https://your-dashboard.vercel.app --ingest-token YOUR_TOKEN
```

### Install hourly reporting

Run:

```bash
python3 scripts/install_hourly_reporter.py \
  --server-url https://your-dashboard.vercel.app \
  --ingest-token YOUR_TOKEN
```

The installer writes a local config file under `~/.agents/auth/` and installs the local scheduler.
On macOS it installs a `launchd` agent with `RunAtLoad`.
On Linux it installs `crontab` entries for both `@reboot` and 15-minute reporting, so the reporter comes back automatically after a restart.
The installer also writes Claude Code `statusLine` settings to `~/.claude/settings.json` so Claude can produce `~/.claude/statusline-rate-limits.json` automatically.
If `--auth-pool-url` and `--auth-pool-user-token` are provided, the same config file also lets each 15-minute run upload the latest archived Codex auth snapshots to the shared auth pool automatically.

After install, each machine needs one real interactive Claude request to seed the first quota snapshot. Until that happens, macOS Claude reports are skipped instead of sending `n/a`.

For Codex, the combined reporter normalizes by account:

- it archives the current live auth if needed
- it scans `~/.agents/auth/auth-*.json`
- it only probes the newest snapshot for each `account_id`
- it posts Codex accounts even when a snapshot no longer returns quota windows, so stale old values on the hub get overwritten by the current unavailable state
- if the current live Codex auth is below `20%` remaining in the `5H` window, or its `1week` window is already `0%`, it copies the best usable archived snapshot back to `~/.codex/auth.json`
- usable rotation targets must have both `5H > 0` and `1week > 0`
- rotation only happens when that target also has strictly more `5H` remaining than the current live auth
- the hub keeps the latest report per `source + account_id`

For cloud-hosted auth rotation:

- `request_auth_pool_token.py` asks the server to email a personal auth-pool token to a company address such as `name@stardust.ai`
- `sync_codex_auth_pool.py` uploads the latest archived Codex auth snapshot for each account to the server-side encrypted auth pool
- `fetch_best_codex_auth.py` requests the best currently usable Codex auth from the pool and can install it into `~/.codex/auth.json`
- best-auth selection prefers the highest `5H remaining`, then `1week remaining`
- hard invalidations such as `token_invalidated` are excluded from server-side fetches

## Output expectations

- After a one-off report, show the returned status and the dashboard URL.
- After installation, show the scheduler type and the config path.
- If the report fails, include the HTTP status and response body.
