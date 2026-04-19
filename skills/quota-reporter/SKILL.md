---
name: quota-reporter
description: Install and run a local quota reporter that probes Codex account usage, posts the latest 5H and 1week windows to a shared dashboard, and sets up an hourly scheduled run. Use this whenever a teammate wants to join the shared quota dashboard, report their own Codex quota, install the hourly reporter, or verify that quota reports are reaching the shared service. Trigger on requests about Codex quota, token usage, usage monitoring, hourly usage reporting, shared quota dashboards, Vercel quota dashboards, or Turso-backed quota collection.
---

# Quota Reporter

This skill installs and runs a local reporter for Codex quota usage.

## What it does

1. Reads the local `~/.codex/auth.json`
2. Probes the current Codex quota windows
3. Posts a signed report to the shared dashboard service
4. Installs a reboot-safe scheduler that reports every hour

## Files

- Reporter: `scripts/report_codex_quota.py`
- Installer: `scripts/install_hourly_reporter.py`

## Required inputs

You need:

- the shared dashboard URL, for example `https://quota-report-hub.vercel.app`
- the ingest token for `POST /api/report`

## Standard flow

### One-off report

Run:

```bash
python3 scripts/report_codex_quota.py \
  --server-url https://your-dashboard.vercel.app \
  --ingest-token YOUR_TOKEN
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
On Linux it installs `crontab` entries for both `@reboot` and hourly reporting, so the reporter comes back automatically after a restart.

## Output expectations

- After a one-off report, show the returned status and the dashboard URL.
- After installation, show the scheduler type and the config path.
- If the report fails, include the HTTP status and response body.
