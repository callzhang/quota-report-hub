# Quota Report Hub

Minimal Vercel app that accepts quota reports from local Codex reporter scripts and displays the latest status.

## Install The Skill

This repo also publishes the reusable `quota-reporter` skill.

Install it with:

```bash
npx skills add https://github.com/callzhang/quota-report-hub --skill quota-reporter -g -y
```

Skill files live under:

- `skills/quota-reporter/SKILL.md`
- `skills/quota-reporter/scripts/report_codex_quota.py`
- `skills/quota-reporter/scripts/install_hourly_reporter.py`

After install, teammates can either:

- send one report with `report_codex_quota.py`
- install hourly reporting with `install_hourly_reporter.py`

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
