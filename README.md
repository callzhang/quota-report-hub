# Quota Report Hub

Minimal Vercel app that accepts quota reports from archived Codex auth snapshots plus Claude CLI reporter scripts and displays the latest status.

## Use Case

This project is built for people who regularly switch between multiple coding agents and multiple accounts, and need a shared place to see remaining quota without manually checking each machine.

Typical examples:

- You switch between Codex, Claude, and other coding agents throughout the day
- You keep separate accounts on different laptops, desktops, or remote boxes
- You want one dashboard that normalizes each account to its latest report, even if multiple machines report the same account
- You also want Claude CLI usage metadata in the same dashboard, even when Claude does not expose resettable remaining quota
- You want each machine to report quota automatically every 15 minutes instead of checking manually before switching agents
- You want reporting to resume automatically after a laptop reboot or a remote server restart

## Install The Skill

This repo also publishes the reusable `quota-reporter` skill.

Install it with:

```bash
npx skills add https://github.com/callzhang/quota-report-hub --skill quota-reporter -g -y
```

Skill files live under:

- `skills/quota-reporter/SKILL.md`
- `skills/quota-reporter/scripts/report_all_usage.py`
- `skills/quota-reporter/scripts/report_codex_quota.py`
- `skills/quota-reporter/scripts/report_claude_usage.py`
- `skills/quota-reporter/scripts/install_hourly_reporter.py`

After install, teammates can either:

- send one report with `report_all_usage.py`
- install scheduled reporting with `install_hourly_reporter.py`

The installer now also configures Claude Code's `statusLine` hook automatically:

- it writes `statusLine.command = python3 .../claude_statusline_probe.py` into `~/.claude/settings.json`
- Claude then writes the latest quota snapshot to `~/.claude/statusline-rate-limits.json`
- after install, each machine must complete at least one real interactive Claude request once so Claude starts populating the `rate_limits` snapshot
- until that first successful Claude request happens, macOS reporters will skip Claude instead of sending `n/a`

Codex rotation rules:

- each run archives the current live `~/.codex/auth.json`
- if the current live Codex auth has less than `20%` remaining in the `5H` window, or its `1week` window is already `0%`
- only archived Codex auths with both `5H > 0` and `1week > 0` are considered usable rotation targets
- rotation only happens when a usable archived auth also has strictly more `5H` remaining than the current live auth
- the reporter picks the usable archived auth with the highest remaining quota
- ranking is by `5H remaining` first, then `1week remaining`
- the reporter then copies that best archived snapshot back to `~/.codex/auth.json`

The dashboard handles the two sources differently:

- Codex reports real `5H` and `1week` quota windows from archived auth snapshots under `~/.agents/auth/auth-*.json`
- Codex reports are only posted when both `5H` and `1week` windows are present. If Codex returns an auth that lacks quota details, the reporter skips that auth instead of sending a noisy error row to the hub.
- Claude reports auth tier and cumulative usage statistics, and now reads Claude Code's official `statusLine` JSON snapshot for `rate_limits` instead of relying on unofficial OAuth usage probing.
- The included `claude_statusline_probe.py` script can be wired into `~/.claude/settings.json` as a `statusLine` command. It stores the latest `rate_limits` payload under `~/.claude/statusline-rate-limits.json`, which the hourly reporter reads.
- The Claude reporter still hard-times out the extra `claude auth status` and `claude -p "/status"` commands so one slow local CLI process cannot block the hourly report.
- On macOS, if Claude does not currently have `5h` and `1week` windows from the statusline snapshot, the reporter skips posting Claude entirely instead of sending a noisy `n/a` row to the hub.
- The dashboard now keeps the last reported status visible instead of expiring it after one hour, shows how old the report is, and renders each reset time as a live countdown such as `reset in 3h 30m`. Once a reset time has passed, that window is shown in green as `ready now`.

Codex collection rules:

- The reporter first archives the current `~/.codex/auth.json` into `~/.agents/auth/` if it has not been seen before
- It then scans archived auth snapshots and keeps only the newest snapshot per `account_id`
- The hub normalizes Codex and Claude reports by `source + account_id`, so the latest machine report wins for the account

The installer is reboot-safe and runs every 15 minutes:

- macOS uses `launchd` with `RunAtLoad`
- Linux uses `crontab` with both `@reboot` and `*/15 * * * *` entries

## Endpoints

- `POST /api/report`
  - Requires `Authorization: Bearer <REPORT_INGEST_TOKEN>`
  - Appends an event row and updates the latest row per `source + account_id`
- `GET /api/status`
  - Returns the current merged dataset

## Required environment variables

- `REPORT_INGEST_TOKEN`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

## Local test

```bash
npm install
npm test
```
