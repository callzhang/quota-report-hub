# Quota Report Hub

Minimal Vercel app that accepts quota reports from local Codex and Claude CLI reporter scripts and displays the latest status.

## Use Case

This project is built for people who regularly switch between multiple coding agents and multiple accounts, and need a shared place to see remaining quota without manually checking each machine.

Typical examples:

- You switch between Codex, Claude, and other coding agents throughout the day
- You keep separate accounts on different laptops, desktops, or remote boxes
- You want one dashboard that shows the latest 5H and 1week windows from each machine
- You also want Claude CLI usage metadata in the same dashboard, even when Claude does not expose resettable remaining quota
- You want each machine to report quota automatically every hour instead of checking manually before switching agents
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
- install hourly reporting with `install_hourly_reporter.py`

The dashboard handles the two sources differently:

- Codex reports real `5H` and `1week` quota windows, including reset timestamps
- Claude reports auth tier and usage statistics because Claude CLI does not currently expose remaining quota percentages in its local CLI output

The installer is reboot-safe:

- macOS uses `launchd` with `RunAtLoad`
- Linux uses `crontab` with both `@reboot` and hourly entries

## Endpoints

- `POST /api/report`
  - Requires `Authorization: Bearer <REPORT_INGEST_TOKEN>`
  - Appends an event row and updates the latest row per `source + hostname + account_id`
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
