# Quota Report Hub

Minimal Vercel app that stores encrypted Codex auth snapshots, issues per-user access tokens by company email, and serves a dashboard plus auth-pool APIs for local quota guards.

## Use Case

This project is built for people who regularly switch between multiple coding agents and multiple accounts, and need a shared place to see remaining quota without manually checking each machine.

Typical examples:

- You switch between Codex, Claude, and other coding agents throughout the day
- You keep separate accounts on different laptops, desktops, or remote boxes
- You want one dashboard that normalizes each account to its latest known quota, even if multiple machines touch the same account
- You also want Claude CLI usage metadata in the same dashboard, even when Claude does not expose resettable remaining quota
- You want each machine to check quota automatically every 15 minutes instead of checking manually before switching agents
- You want reporting to resume automatically after a laptop reboot or a remote server restart

## Install The Skill

This repo also publishes the reusable `quota-reporter` skill.

Install it with:

```bash
npx skills add https://github.com/callzhang/quota-report-hub --skill quota-reporter -g -y
```

Skill files live under:

- `skills/quota-reporter/SKILL.md`
- `skills/quota-reporter/scripts/quota_guard.py`
- `skills/quota-reporter/scripts/install_quota_guard.py`
- `skills/quota-reporter/scripts/request_auth_pool_token.py`
- `skills/quota-reporter/scripts/sync_codex_auth_pool.py`
- `skills/quota-reporter/scripts/fetch_best_codex_auth.py`
- `skills/quota-reporter/archive/`

After install, teammates can either:

- run one local guard check with `quota_guard.py`
- install scheduled checking with `install_quota_guard.py`

## Recommended User Flow

The intended end-to-end flow inside Codex is:

1. The user asks Codex to install the skill and provides the GitHub repo URL.
2. Codex installs the `quota-reporter` skill.
3. Codex asks whether to:
   - use an existing hub URL
   - or deploy a new hub on Vercel
4. If the user wants a new hub, Codex runs `scripts/deploy_vercel.py` with:
   - `allowed domain`
   - `mailgun api key`
   - `sending email`
5. If the user provides an existing hub URL, Codex should verify that the hub supports:
   - `POST /api/auth/issue-token`
   - `POST /api/auth/upload`
   - `POST /api/auth/fetch-best`
6. Codex asks for the user's company email.
7. The installer requests a personal token by email and asks the user to paste it back into the terminal.
8. Codex writes:
   - `auth_pool_url`
   - `auth_pool_user_email`
   - `auth_pool_user_token`
   into `~/.agents/auth/quota-reporter.json`
9. Codex installs the 15-minute scheduler.
10. Every 15 minutes the guard:
   - archives current `~/.codex/auth.json`
   - syncs latest archived auth snapshots to the auth pool
   - checks local Codex and Claude quota
   - fetches and installs a better Codex auth when local quota is low

Important runtime notes:

- Claude quota requires one real interactive Claude request after install. Until that happens, the statusline snapshot may not contain `5h` or `1week`.
- Replacing `~/.codex/auth.json` does not hot-switch already running Codex sessions. New auth usually takes effect in the next new session.
- If the cloud has no better auth than the current one, the guard does nothing and keeps the current auth installed.
- `~/.agents/auth/quota-reporter.json` should stay private because it contains the user's personal auth-pool token.

The installer now also configures Claude Code's `statusLine` hook automatically:

- it writes `statusLine.command = python3 .../claude_statusline_probe.py` into `~/.claude/settings.json`
- Claude then writes the latest quota snapshot to `~/.claude/statusline-rate-limits.json`
- after install, each machine must complete at least one real interactive Claude request once so Claude starts populating the `rate_limits` snapshot
- until that first successful Claude request happens, macOS quota checks will skip Claude instead of treating it as a hard failure

Codex and Claude local-guard rules:

- each run archives the current live `~/.codex/auth.json`
- it probes the current local Codex auth and current local Claude statusline snapshot
- if Codex has less than `20%` remaining in the `5H` window, or its `1week` window is already `0%`, the machine asks the cloud auth pool for a better Codex auth
- if Claude has less than `20%` remaining in the `5H` window, or its `1week` window is already `0%`, the machine also asks the cloud auth pool for a better Codex auth
- the server-side auth pool picks the best usable Codex auth by `5H remaining` first, then `1week remaining`
- the guard only replaces local `~/.codex/auth.json` when the fetched auth is different from the currently installed auth
- old local reporter scripts now live under `skills/quota-reporter/archive/`

The dashboard handles the two sources differently:

- Codex reports real `5H` and `1week` quota windows from archived auth snapshots under `~/.agents/auth/auth-*.json`
- The hub keeps the latest report metadata per account. Soft Codex probe failures such as missing quota details keep the last good windows and mark them as stale, while hard auth failures such as token invalidation clear the old windows immediately.
- Claude reports auth tier and cumulative usage statistics, and now reads Claude Code's official `statusLine` JSON snapshot for `rate_limits` instead of relying on unofficial OAuth usage probing.
- The included `claude_statusline_probe.py` script is wired into `~/.claude/settings.json` as a `statusLine` command. It stores the latest `rate_limits` payload under `~/.claude/statusline-rate-limits.json`, which the local guard reads.
- The Claude probe still hard-times out the extra `claude auth status` and `claude -p "/status"` commands so one slow local CLI process cannot block the 15-minute guard run.
- On macOS, if Claude does not currently have `5h` and `1week` windows from the statusline snapshot, the guard skips Claude instead of producing a noisy `n/a` state.
- The dashboard now keeps the last reported status visible instead of expiring it after one hour, shows how old the report is, and renders each reset time as a live countdown such as `reset in 3h 30m`. Once a reset time has passed, that window is shown in green as `ready now`.

Auth pool support:

- The hub can now store encrypted Codex `auth.json` snapshots in a server-side auth pool.
- Employees request a personal auth-pool token by company email through `/api/auth/issue-token`.
- Machines can upload their latest archived Codex auth snapshots to `/api/auth/upload`.
- A client can request the best currently usable Codex auth from `/api/auth/fetch-best`.
- The selection logic prefers the highest `5H remaining`, then `1week remaining`, and skips hard-invalidated auths.
- Soft probe failures such as missing quota details can still contribute stale-but-last-known-good windows; hard token invalidations clear the old windows.
- The auth pool requires server-side encryption plus Mailgun delivery for issuing personal user tokens.

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
- `AUTH_POOL_ENCRYPTION_KEY`
- `MAILGUN_API_KEY`
- `MAILGUN_DOMAIN`
- `MAILGUN_FROM`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

`AUTH_POOL_ENCRYPTION_KEY` must be either:

- 64 hex characters
- or base64 for exactly 32 raw bytes

## Vercel deploy script

Use the included deploy script to configure the auth-pool email settings on Vercel and trigger a production deploy:

```bash
python3 scripts/deploy_vercel.py \
  --allowed-domain stardust.ai \
  --mailgun-api-key YOUR_MAILGUN_API_KEY \
  --sending-email hello@friday.preseen.ai
```

What it does:

- sets `AUTH_ALLOWED_EMAIL_DOMAIN`
- sets `MAILGUN_API_KEY`
- derives `MAILGUN_DOMAIN` from the sending email domain
- sets `MAILGUN_FROM`
- generates `AUTH_POOL_ENCRYPTION_KEY` only if one does not already exist
- updates `production`, `preview`, and `development`
- runs `vercel deploy --prod --yes`

Important:

- the script preserves an existing `AUTH_POOL_ENCRYPTION_KEY` by default, because rotating it would make previously encrypted auth-pool rows unreadable
- use `--rotate-auth-pool-key` only when you intentionally want to invalidate existing encrypted auth-pool entries
- use `--skip-deploy` if you only want to update Vercel env values without deploying immediately

## Auth Pool Workflow

1. Install the local guard and request a personal auth-pool token by company email:

```bash
python3 skills/quota-reporter/scripts/install_quota_guard.py \
  --auth-pool-url https://quota-report-hub.vercel.app \
  --email your.name@stardust.ai
```

2. The installer emails a personal token to `your.name@stardust.ai` and prompts you to paste it locally.

3. Run one local check manually if you want to validate behavior immediately:

```bash
python3 skills/quota-reporter/scripts/quota_guard.py
```

4. The guard automatically:

- archives the current local Codex auth
- uploads the latest archived Codex auth snapshots to the cloud auth pool
- probes local Codex and Claude quota
- fetches a better Codex auth from `/api/auth/fetch-best` when local quota is low

5. If needed, you can still fetch the best currently usable auth from the pool without installing it:

```bash
python3 skills/quota-reporter/scripts/fetch_best_codex_auth.py \
  --auth-pool-url https://quota-report-hub.vercel.app \
  --auth-pool-user-token YOUR_PERSONAL_TOKEN \
  --print-only
```

6. Or fetch and install the best auth into `~/.codex/auth.json` directly:

```bash
python3 skills/quota-reporter/scripts/fetch_best_codex_auth.py \
  --auth-pool-url https://quota-report-hub.vercel.app \
  --auth-pool-user-token YOUR_PERSONAL_TOKEN \
  --archive-current
```

## Local test

```bash
npm install
npm test
```
