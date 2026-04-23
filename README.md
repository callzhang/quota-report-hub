# Quota Report Hub

Minimal Vercel app that stores encrypted Codex and Claude auth snapshots, issues per-user access tokens by company email, and serves a dashboard plus source-aware auth-pool APIs for local quota guards.

## Use Case

This project is built for people who regularly switch between multiple coding agents and multiple accounts, and need a shared place to see remaining quota without manually checking each machine.

The default shared hub URL for this project is:

- [quota-report-hub.vercel.app](https://quota-report-hub.vercel.app)

That hub now requires a valid personal access token to read dashboard data. Publishing the repo does not expose the live hub data by itself.

Typical examples:

- You switch between multiple Codex and Claude accounts across laptops, desktops, and servers
- You keep separate accounts on different laptops, desktops, or remote boxes
- You want one dashboard that shows the current cloud auth pool and the latest known quota attached to each cloud auth entry
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
   - reads current local auth state for each supported source
   - updates local `~/.agents/auth/known_auth.json`
   - uploads current auth to the auth pool only when the current `source`, `account_id`, `auth_last_refresh`, and digest represent a new version
   - checks the current local Codex quota and Claude quota
   - if a local source is below threshold, sends `source + current account + current quota` to `/api/auth/fetch-best`
   - installs a better auth only when the server returns one for that same source

Important runtime notes:

- each run reads the current local auth for each supported source
- each machine stores only one local state file: `~/.agents/auth/known_auth.json`
- the local guard probes the current local Codex auth and Claude auth
- if Codex has less than `20%` remaining in the `5H` window, or its `1week` window is already `0%`, the machine asks the cloud auth pool for a better Codex auth
- if Claude has less than `20%` remaining in the `5H` window, or its `1week` window is already `0%`, the machine asks the cloud auth pool for a better Claude auth
- Claude also sends its latest stable local statusline-based quota to the hub every 15 minutes from the same guard run
- the request to `/api/auth/fetch-best` includes:
  - `source`
  - the current local `account_id`
  - the current local `5H remaining percent`
  - the current local `1week remaining percent`
- the server only returns a replacement when it is strictly better than the current local auth for that same source
- local upload is skipped only when `known_auth.json` records the same uploaded `account_id`, the same uploaded `auth_last_refresh`, and the same uploaded digest
- if the same account is refreshed locally, the new `auth_last_refresh` will force a new upload and overwrite the old cloud copy
- the guard only replaces local `~/.codex/auth.json` when the fetched auth is different from the currently installed auth
- replacing `~/.codex/auth.json` does not hot-switch already running Codex sessions. New auth usually takes effect in the next new session.
- if the cloud has no better auth than the current one, the guard does nothing and keeps the current auth installed.
- `~/.agents/auth/quota-reporter.json` should stay private because it contains the user's personal auth-pool token.
- the hub dashboard also uses the same personal token. Without a valid token, `/api/status` returns `401` and the page stays locked.
- every time a user requests a new token by email, the old token is revoked. Only the latest token for that email remains valid, even if that latest token is then reused across multiple machines.
- old local reporter scripts now live under `skills/quota-reporter/archive/`

The dashboard now reflects the cloud auth pool, not arbitrary client report rows:

- each visible row should correspond to one cloud-stored auth entry
- quota metadata is shown as the latest cloud worker probe associated with that cloud auth entry
- hard-invalidated auths should not remain selectable
- stale windows may still be shown for soft probe failures, but only as metadata attached to the cloud auth entry
- Codex rows are refreshed by the cloud worker
- Claude rows are refreshed by local client reports from the 15-minute guard

Auth pool support:

- The hub can now store encrypted Codex and Claude auth snapshots in a server-side auth pool.
- Employees request a personal auth-pool token by company email through `/api/auth/issue-token`.
- Each email can have only one active token at a time; a newly issued token revokes all older tokens for that email.
- Machines upload only their current auth to `/api/auth/upload` with an explicit `source`.
- GitHub Actions refreshes the Codex portion of the auth pool every 15 minutes by running `scripts/probe_auth_pool_worker.mjs`.
- Claude does not use the cloud worker because its reliable quota source is the local CLI statusline snapshot.
- A client can request the best currently usable auth from `/api/auth/fetch-best`, but it must send the same explicit `source`.
- The dashboard API at `/api/status` also requires the same personal bearer token.
- The selection logic only compares candidates within the same source, prefers the highest `5H remaining`, then `1week remaining`, and skips hard-invalidated auths.
- Soft probe failures such as missing quota details can still contribute stale-but-last-known-good windows; hard token invalidations clear the old windows.
- The auth pool requires server-side encryption plus Mailgun delivery for issuing personal user tokens.
- The auth pool deduplicates by stable `source + account_id`, and only replaces an existing entry when the incoming `auth_last_refresh` is newer. If two machines upload different files for the same account without a newer refresh time, the cloud keeps the existing entry.

The installer is reboot-safe and runs every 15 minutes:

- macOS uses `launchd` with `RunAtLoad`
- Linux uses `crontab` with both `@reboot` and `*/15 * * * *` entries

## Endpoints

- `GET /api/status`
  - Requires a personal bearer token
  - Returns the current dashboard dataset
- `POST /api/auth/quota`
  - Requires a personal bearer token
  - Accepts source-aware client quota updates

## Required environment variables

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

## Scheduler

The hosted hub uses GitHub Actions, not Vercel cron, for the 15-minute Codex server probe loop.

- workflow file: `.github/workflows/probe-auth-pool.yml`
- required GitHub secrets:
  - `TURSO_DATABASE_URL`
  - `TURSO_AUTH_TOKEN`
  - `AUTH_POOL_ENCRYPTION_KEY`

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

- updates local `known_auth.json`
- uploads the current local auth for each source to the cloud auth pool only when the auth changed
- probes local Codex and Claude quota
- posts Claude quota to the hub every 15 minutes when it has a stable email-backed identity
- when a local source is low, sends `source + current account + current quota` to `/api/auth/fetch-best`
- installs a replacement only when the server returns a strictly better auth for that same source

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
```

## Local test

```bash
npm install
npm test
```
