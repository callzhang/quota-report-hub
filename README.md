# Quota Report Hub

Minimal Vercel app that stores encrypted Codex and Claude auth snapshots, issues per-user access tokens by company email, and serves a dashboard plus source-aware auth-pool APIs for local quota guards.

![Quota Report Hub dashboard](docs/hub-dashboard.png)

*The dashboard: one primary availability state per cloud auth entry, with quota and authentication evidence available on demand. Codex uses the weekly quota window; Claude requires both the 5-hour and weekly windows. (Accounts shown are anonymized demo data.)*

Chinese operations guidance: [README.zh-CN.md](README.zh-CN.md).

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
npx skills add https://github.com/callzhang/quota-report-hub --skill quota-reporter --agent codex -g -y
```

Keep `--agent codex` in the command. The generic global install target includes PromptScript, and PromptScript does not support global skill installation.

Skill files live under:

- `skills/quota-reporter/SKILL.md`
- `skills/quota-reporter/README.md`
- `skills/quota-reporter/scripts/quota_guard.py`
- `skills/quota-reporter/scripts/install_quota_guard.py`
- `skills/quota-reporter/scripts/trigger_remote_probe.py`
- `skills/quota-reporter/scripts/claude_statusline_probe.py`
- `skills/quota-reporter/scripts/quota_reporters.py`
- `skills/quota-reporter/archive/`

After install, teammates can either:

- run one local guard check with `quota_guard.py`
- install scheduled checking with `install_quota_guard.py`

## Local Frontend

Run the static dashboard frontend on the fixed local port:

```bash
npm run dev
```

The startup script listens on `127.0.0.1:6088` by default. If port `6088` is already occupied, startup fails with an error instead of switching to another port. Set `FRONTEND_PORT` only when you intentionally want a different fixed port:

```bash
FRONTEND_PORT=7000 npm run dev
```

This script serves the static dashboard files only. Use the deployed hub or `vercel dev` when you need local API routes.

## Recommended User Flow

The intended end-to-end flow inside Codex is:

1. The user asks Codex to install the skill and provides the GitHub repo URL.
2. Codex installs the `quota-reporter` skill.
3. Codex uses the default hosted hub at `https://quota-report-hub.vercel.app/` unless the user provides a different hub URL.
4. If the user wants a new hub, Codex runs `scripts/deploy_vercel.py` with:
   - `allowed domain`
   - `mailgun api key`
   - `sending email`
5. If the user provides a different hub URL, Codex should verify that the hub supports:
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
10. Codex verifies the scheduler registration and runs one immediate guard cycle. The install is not complete until this verification succeeds.
10. Every 15 minutes the guard:
   - checks GitHub for the latest `quota-reporter` skill code and updates the local installed skill when `main` has changed
   - reads current local auth state for each supported source
   - updates local `~/.agents/auth/known_auth.json`
   - reuploads the current auth to keep the cloud auth pool entry present even when the local digest has not changed
   - checks the current local Codex quota and Claude quota
   - reports stable local quota snapshots back to the hub when available; Codex client reports are accepted when the weekly window is complete or the local auth is hard-invalidated
   - if a local source is below threshold, sends `source + current account + current quota` to `/api/auth/fetch-best`
   - installs a better auth only when the server returns one for that same source
   - notifies the user only when an uploaded auth has a cloud-confirmed rejected refresh token; if local auto relogin is enabled, the guard opens the matching CLI login for that confirmed RT-rejected source

Important runtime notes:

- each run reads the current local auth for each supported source
- each run self-updates the installed skill from `https://github.com/callzhang/quota-report-hub` before probing, unless `--skip-self-update` is passed for debugging
- each machine stores only one local state file: `~/.agents/auth/known_auth.json`
- the local guard probes the current local Codex auth and Claude auth
- if Codex has less than `5%` remaining in the `1week` window, the machine asks the cloud auth pool for a better Codex auth; Codex `5H` is legacy metadata only and is not shown as live quota
- if Claude has less than `20%` remaining in the `5H` window, or less than `5%` remaining in the `1week` window, the machine asks the cloud auth pool for a better Claude auth
- the request to `/api/auth/fetch-best` includes:
  - `source`
  - the current local `account_id`
  - the current local `5H remaining percent` when the source still reports one
  - the current local `1week remaining percent`
  - a local `requester_id` such as `user@hostname`, so machines sharing the same hub token are still spread across different replacement auths
- the server only returns a replacement when it is strictly better than the current local auth for that same source
- for Codex, the server only shares candidates whose `1week` remaining quota is at least `5%`, and ranks them by weekly quota plus load balancing
- for Claude, the server still requires candidates to have at least `20%` remaining in `5H` and at least `5%` remaining in `1week`
- replacement selection is weighted by remaining quota: the server uses requester-specific deterministic weighted sampling with a softened quota weight, plus a small active-assignment penalty, so high-quota accounts carry more load without taking nearly every request
- the server also tracks active assignments by each machine's latest fetch event; an auth already installed on many machines is treated as loaded even if those machines have not fetched again within the last 5 hours
- local quota reports are also used as active-assignment evidence: each reporter's latest Codex account contributes to that auth's load, which catches machines that keep using an auth without calling `fetch-best`
- local upload is idempotent: even when `known_auth.json` records the same uploaded `account_id`, `auth_last_refresh`, and digest, the guard reuploads the current auth so a missing cloud entry can be restored automatically
- uploading a new current auth does not delete older auths previously uploaded by the same user; the hub keeps monitoring all of them so invalidated-owner notifications still work
- if a fetched shared auth is later reuploaded by another machine, the hub preserves the first uploader for that `source + account_id`; using someone else's shared auth does not make that user responsible for re-login notifications
- if the same account is refreshed locally, the new `auth_last_refresh` will force a new upload and overwrite the old cloud copy
- Codex auth-pool identity is normalized to the lowercased account email when the email is available, so Team users who share a provider-side account UUID do not overwrite each other in the pool
- the guard only replaces local `~/.codex/auth.json` when the fetched auth is different from the currently installed auth
- replacing `~/.codex/auth.json` does not hot-switch already running Codex sessions. New auth usually takes effect in the next new session.
- if the cloud has no better auth than the current one, the guard does nothing and keeps the current auth installed.
- `~/.agents/auth/quota-reporter.json` should stay private because it contains the user's personal auth-pool token.
- the hub dashboard also uses the same personal token. Without a valid token, `/api/status` returns `401` and the page stays locked.
- if `/api/status` cannot read the backing database, it returns `503` with `hub_unavailable`; when the reason is `database_reads_blocked`, the token is not rejected and the Turso plan/quota must be restored before the dashboard can unlock.
- every time a user requests a new token by email, the old token is revoked. Only the latest token for that email remains valid, even if that latest token is then reused across multiple machines.
- when a request uses an invalid or expired hub-signed token, the hub returns `401` with `token_invalidated`. The local guard requests a new token email once for that invalid local token, then waits for the user to paste the latest token.
- deleted legacy opaque `qrp_...` tokens cannot be upgraded in-band because they do not carry a verifiable email; request a fresh token by email once on that machine.
- old local reporter scripts now live under `skills/quota-reporter/archive/`

The dashboard now reflects the cloud auth pool, not arbitrary client report rows:

- each account has one primary state: `AVAILABLE`, `LOW QUOTA`, `WAITING FOR NEW QUOTA`, `QUOTA UNKNOWN`, or `UNAVAILABLE`; this is the answer to "can the pool use this account now?", not a restatement of the last probe result
- `AVAILABLE` means the required source-specific quota windows are current and above the rotation thresholds; `LOW QUOTA` means current evidence exists but is below a threshold
- `WAITING FOR NEW QUOTA` means the prior window reset and no post-reset snapshot has arrived; `QUOTA UNKNOWN` means current quota evidence is missing, stale, partial, or from a failed probe; `UNAVAILABLE` means the credential itself is rejected, invalidated, expired without recovery, or ineligible
- hover the state with a pointer, focus it with the keyboard, or tap it to open account details. The popover shows the probe, token upload, access expiry, refresh verification, latest quota snapshot, and a 24-hour chart. Escape, the close button, or an outside press closes it
- a gray quota value is historical evidence only. `Captured` is when that individual quota window was observed; `Reset` is the provider's reset boundary for that window. A historical value must not be treated as current quota, even when the latest probe says `ok`
- after the initial full status load, a visible dashboard checks only the singleton revision once per minute and on visibility regain; it reloads full status only when that revision changes
- revision checks use a 12-hour, HMAC-signed `qrr.` ticket issued by an authenticated full-status response. The ticket is scoped to revision metadata and cannot call the full dashboard or auth-pool APIs, so routine checks do not read or update API-token rows
- quota history is not part of `/api/status`: it is fetched for one exact `source + account_id` only when that account's details open, is bounded to 24 hours and 96 points, and is cached in that browser login session for five minutes; concurrent opens reuse the same in-flight request
- a valid dashboard session is restored from the saved browser cookie; opening `login.html` reuses that session instead of asking the user to log in again
- transient network and service errors keep the last dashboard data visible and retry automatically; only a missing token or an explicit `401` response shows the login panel
- refresh-token state is shown as `verified`, `rejected`, or `not tested`; uploads carrying a real RT perform an immediate refresh verification and persist the rotated credential, while AT-only uploads remain unverified
- each visible row should correspond to one cloud-stored auth entry
- quota metadata is shown as the latest effective quota associated with that cloud auth entry
- hard-invalidated auths should not remain selectable
- stale windows may still be shown for soft probe failures, but only as metadata attached to the cloud auth entry
- the dashboard marks expired access tokens explicitly and treats their quota as unavailable until the auth is refreshed
- if a successful probe is newer than the stored `auth_expires_at`, the dashboard treats that expiry as stale metadata and keeps the fresh quota visible
- hard-invalidated or Free-plan rows never infer a fresh `100%` quota just because an old reset time passed
- soft probe failures with old quota windows are shown as unavailable after the last known reset time passes, instead of `ready now`
- successful but stale quota snapshots whose reset time has already passed are shown as expired snapshots, not as ready quota
- a newer partial worker quota report is allowed to replace an old complete client snapshot after the client's known reset windows have passed
- Codex rows can be refreshed by either the cloud worker or a stable local client report; a complete Codex client report means a fresh weekly window, because Codex no longer has a live 5H window. After a stable local client report is accepted, the cloud worker skips probing that same auth for 1 hour when the report matches the auth refresh time. A newer worker soft failure does not overwrite an existing good local Codex quota snapshot
- Claude rows can be refreshed by the cloud worker for direct Claude subscriptions, or by stable local client reports when Claude is running in an environment that the worker cannot replay reliably. Local Claude reporting reads the statusline snapshot first, then falls back to the OAuth usage API when the statusline has no quota windows; a 429 response with `Retry-After` is reported as a zero-remaining `5H` window until that reset time. Claude Code only sends `rate_limits` after the first successful API response in a session, so the statusline capture preserves any previous unexpired `5H` or `7d` window instead of overwriting it with a startup snapshot that has no quota.

Auth pool support:

- The hub can now store encrypted Codex and Claude auth snapshots in a server-side auth pool.
- Employees request a personal auth-pool token by company email through `/api/auth/issue-token`.
- Each email can have only one active token at a time; a newly issued token revokes all older tokens for that email.
- Machines upload only their current auth to `/api/auth/upload` with an explicit `source`.
- Codex uploads are keyed by normalized email when available, not by the raw provider account UUID, so different Team users do not collide in the pool.
- GitHub Actions refreshes the cloud auth pool every 15 minutes by running `scripts/probe_auth_pool_worker.mjs`.
- Local machines may also post stable quota snapshots to `/api/auth/quota`. For Codex, the server accepts a complete weekly window or a hard invalidation so missing legacy 5H data cannot poison the hub or block fresh quota. A complete client report can replace stale effective windows that were previously preserved from worker data.
- A fresh accepted client quota report backs off the GitHub Actions cloud probe for that same auth for 1 hour, as long as the report's `auth_last_refresh` still matches the auth pool entry.
- Turso stores auth-pool metadata, quota snapshots, and audit events. `/api/status` and `/api/auth/fetch-best` candidate selection read metadata only; they do not read encrypted auth JSON for every account.
- `fetch-best` keeps read volume bounded by reading only the requested source and by using compact current-state assignment tables. It does not scan the full fetch log or quota event history to calculate active machine/account load.
- The users/audit page reads `auth_pool_user_fetch_stats`, which is updated when fetch events are written, instead of counting the full fetch audit log on each page load.
- The dashboard loads `/api/status` after unlock, then polls only `/api/status-revision` once per minute while visible. Hidden tabs do not poll, and unchanged revisions avoid full-status database reads.
- In production, configure Tigris object storage so encrypted auth JSON is written to object storage and Turso keeps only `auth_blob_key`. Existing inline Turso rows remain readable and are moved to object storage when that auth is refreshed and uploaded again.
- Every probe result is appended to `auth_pool_quota_events` before the latest row is updated or an unusable auth is removed, so audit views can be reconstructed from Turso instead of GitHub Actions logs. The continuous invalidation window is maintained in `auth_pool_invalidated_notifications` as current state, so quota ingestion does not rescan event history.
- During the Codex CLI probe, if the temporary auth blob is refreshed to a newer same-account auth, the worker writes that refreshed auth back into the cloud auth pool before finishing the run.
- Codex `missing quota details` probe failures are recorded as quota errors but do not delete the auth entry, because the saved refresh token may still be valid and should be available for later central refresh or a successful probe.
- Codex auths are removed from the active pool after consecutive `auth failed (401 unauthorized)` worker probes, because repeated 401 means the saved token cannot be reused by the pool.
- A Vercel cron endpoint checks the cloud probe results daily. If a cloud auth stays hard-invalidated for more than 24 hours, Vercel emails the uploader and asks them to log in again. It sends at most one reminder per account per 24 hours until the auth recovers.
- The local guard also checks `/api/status` every run and warns about auths uploaded by the current token user only after the cloud worker confirms `refresh_token_rejected`. If `auto_relogin_owner_auth` is enabled, it opens the matching local CLI login for that confirmed RT-rejected source; ordinary auth probe errors and stale quota snapshots do not launch login.
- Claude quota is probed in the worker by launching Claude CLI headlessly, restoring the saved CLI state, and reading the statusline snapshot after a minimal real request.
- Claude auth snapshots are uploaded to the cloud pool only when the local machine is using a direct Claude subscription. Machines that inject `ANTHROPIC_*` credentials through `~/.claude/settings.json` are skipped because their active provider is not the worker's official Claude login path.
- The Claude worker uses a short statusline refresh interval during probing so the snapshot is emitted before the worker timeout expires.
- A client can request the best currently usable auth from `/api/auth/fetch-best`, but it must send the same explicit `source`.
- Fetch access is gated by contribution at the user level: once a user has uploaded at least one healthy Codex or Claude auth, they may fetch any supported source. Candidate selection still stays source-specific, so Codex never receives Claude auth and Claude never receives Codex auth.
- The dashboard API at `/api/status` also requires the same personal bearer token.
- The selection logic only compares candidates within the same source and skips hard-invalidated auths. Codex selection is weekly-quota-first; Claude selection still uses both `5H` and `1week`.
- Soft probe failures such as missing quota details can still contribute stale-but-last-known-good windows; hard token invalidations clear the old windows.
- The auth pool requires server-side encryption plus Mailgun delivery for issuing personal user tokens.
- The auth pool deduplicates by stable `source + account_id`, preserves the first uploader as the account owner, and only replaces an existing entry when the incoming `auth_last_refresh` is newer. If two machines upload different files for the same account without a newer refresh time, the cloud keeps the existing entry.

The installer is reboot-safe and runs every 15 minutes:

- macOS uses `launchd` with `RunAtLoad`
- Linux uses `crontab` with both `@reboot` and `*/15 * * * *` entries
- Windows uses Task Scheduler with an `AtStartup` trigger plus a 15-minute repeating trigger

The installer also performs a post-install verification by default:

- confirms the scheduler is registered with `launchd`, `crontab`, or Task Scheduler
- runs `quota_guard.py --skip-self-update --no-toast` once immediately
- exits with an error if the guard cannot run, so the installing agent must inspect `~/.agents/auth/quota-guard.log` and `~/.agents/auth/quota-guard.error.log` and fix the local environment before considering setup complete

## Endpoints

- `GET /api/status`
  - Requires a personal bearer token
  - Returns the current dashboard dataset, derived account availability, `dashboard_revision`, and a scoped revision ticket
- `GET /api/status-revision`
  - Requires the scoped `qrr.` revision ticket returned by `/api/status`
  - Returns only the singleton revision and its update time; it cannot authorize full dashboard or auth-pool reads
- `GET /api/quota-history?source=<source>&account_id=<account-id>`
  - Requires a personal bearer token and exactly one non-empty value for each parameter
  - Returns at most 96 chronological, safe quota points from the preceding 24 hours; it returns no auth blob, access token, refresh token, or token hash

## Dashboard troubleshooting: Probe versus Quota

`Probe` answers whether the most recent attempt to contact the provider succeeded. `Quota` answers whether the hub has a complete, fresh quota snapshot whose reset time is still in the future. They are different evidence.

For example, a probe can be `ok` while availability is `QUOTA UNKNOWN` when the successful response did not include every required quota window, or when the report is older than the one-hour freshness boundary. It can be `WAITING FOR NEW QUOTA` when the last known window has reset but no new snapshot has arrived. Open the availability details and compare the exact probe time, each window's `Captured` time, and its `Reset` time. Do not diagnose this as a login failure unless the primary state is `UNAVAILABLE` and the detail identifies rejected or invalidated authentication.

## Required environment variables

- `AUTH_POOL_ENCRYPTION_KEY`
- `MAILGUN_API_KEY`
- `MAILGUN_DOMAIN`
- `MAILGUN_FROM`
- `CRON_SECRET`
- `GITHUB_WORKFLOW_DISPATCH_TOKEN`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `TIGRIS_STORAGE_ACCESS_KEY_ID`
- `TIGRIS_STORAGE_SECRET_ACCESS_KEY`
- `TIGRIS_STORAGE_BUCKET`

`AUTH_POOL_ENCRYPTION_KEY` must be either:

- 64 hex characters
- or base64 for exactly 32 raw bytes

The Tigris variables are read automatically by `@tigrisdata/storage`. They are required for production auth-pool uploads if auth JSON should stay out of Turso read paths.

## Auth blob migration

Use `scripts/migrate_auth_blobs_to_object_storage.mjs` to move existing inline encrypted auth payloads out of Turso rows and into object storage.

Modes:

- `scan`: prepares schema and counts rows that still have inline encrypted auth payloads. It does not write objects or update rows.
- `write-only`: writes each encrypted payload envelope to object storage and reads it back for verification. It does not update rows.
- `apply`: writes and verifies each object, writes a JSONL backup of the encrypted envelopes, then clears the inline columns and stores `auth_blob_key`.

Local rehearsal:

```bash
cp database-beige-bell.db /tmp/database-beige-bell-auth-blob-migration.db

AUTH_BLOB_STORAGE_DIR=/tmp/quota-auth-blob-local-test \
node scripts/migrate_auth_blobs_to_object_storage.mjs \
  --db /tmp/database-beige-bell-auth-blob-migration.db \
  --mode scan \
  --limit 100

AUTH_BLOB_STORAGE_DIR=/tmp/quota-auth-blob-local-test \
node scripts/migrate_auth_blobs_to_object_storage.mjs \
  --db /tmp/database-beige-bell-auth-blob-migration.db \
  --mode write-only \
  --limit 100

AUTH_BLOB_STORAGE_DIR=/tmp/quota-auth-blob-local-test \
node scripts/migrate_auth_blobs_to_object_storage.mjs \
  --db /tmp/database-beige-bell-auth-blob-migration.db \
  --mode apply \
  --limit 100 \
  --backup-path /tmp/quota-auth-blob-local-backup.jsonl
```

Remote execution:

```bash
node scripts/migrate_auth_blobs_to_object_storage.mjs --remote --mode scan --limit 10
node scripts/migrate_auth_blobs_to_object_storage.mjs --remote --mode write-only --limit 10
node scripts/migrate_auth_blobs_to_object_storage.mjs --remote --mode apply --limit 10 --backup-path /tmp/quota-auth-blob-remote-backup.jsonl
node scripts/migrate_auth_blobs_to_object_storage.mjs --remote --mode apply --limit 1000 --backup-path /tmp/quota-auth-blob-remote-backup.jsonl
```

Before remote `apply`, confirm these variables are available to the process:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `TIGRIS_STORAGE_ACCESS_KEY_ID`
- `TIGRIS_STORAGE_SECRET_ACCESS_KEY`
- `TIGRIS_STORAGE_BUCKET`

Before remote rows are migrated, also configure the same three Tigris values as GitHub Actions secrets, because the scheduled probe worker reads object-backed auth rows.

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

The hosted hub uses GitHub Actions for the Codex and Claude server probe loop, because the worker needs CLI tooling that does not belong in a Vercel function. Vercel Hobby projects cannot run 15-minute cron jobs, and GitHub scheduled workflows can start hours late, so the scheduled GitHub workflow starts once per hour and runs twelve probe cycles in the same runner, with a 12-minute wait between cycles. That keeps dashboard rows fresh without relying on high-frequency platform cron.

- workflow file: `.github/workflows/probe-auth-pool.yml`
- scheduled behavior: hourly trigger at minute `7`, `PROBE_CYCLES=12`, `PROBE_INTERVAL_SECONDS=720`
- required GitHub secrets:
  - `TURSO_DATABASE_URL`
  - `TURSO_AUTH_TOKEN`
  - `AUTH_POOL_ENCRYPTION_KEY`
- Vercel manual/external backup trigger:
  - path: `/api/cron/probe-auth-pool`
  - auth: `CRON_SECRET`
  - required env: `GITHUB_WORKFLOW_DISPATCH_TOKEN`
  - optional env: `GITHUB_WORKFLOW_DISPATCH_REPO`, `GITHUB_WORKFLOW_DISPATCH_WORKFLOW`, `GITHUB_WORKFLOW_DISPATCH_REF`, `AUTH_POOL_PROBE_MIN_INTERVAL_SECONDS`

## Auth Pool Workflow

1. Install the local guard and request a personal auth-pool token by company email:

```bash
python3 skills/quota-reporter/scripts/install_quota_guard.py \
  --email your.name@stardust.ai
```

If you want to use a different hub URL, pass `--auth-pool-url`. The default is `https://quota-report-hub.vercel.app/`.

2. The installer emails a personal token to `your.name@stardust.ai` and prompts you to paste it locally.

3. The installer validates behavior immediately. It verifies scheduler registration and runs one guard cycle before it exits successfully.

```bash
python3 skills/quota-reporter/scripts/quota_guard.py
```

By default this prints a compact human-readable summary. Use `--json` only when you need the full probe, sync, replacement, notification, and timing payload:

```bash
python3 skills/quota-reporter/scripts/quota_guard.py --json
```

You can still run one local check manually after login changes:

```bash
python3 skills/quota-reporter/scripts/quota_guard.py
```

4. The guard automatically:

- updates local `known_auth.json`
- reuploads the current local auth for each source to the cloud auth pool so a missing entry can recover automatically
- probes local Codex and Claude quota
- pushes stable local quota snapshots to the hub when available
- for Codex, only complete windows or hard invalidations are sent, so local partial probes never overwrite good hub data
- if Codex reports a usage-limit hit with one missing window, the guard derives a complete `0%` snapshot from structured reset metadata before posting to the hub
- when a local source is low, sends `source + current account + current quota` to `/api/auth/fetch-best`
- installs a replacement only when the server returns a strictly better auth for that same source
- if the uploader has an invalidated auth, the server returns it as `repair_auth` without a shared replacement, and the local guard installs it so the owner can re-login/refresh their own auth
- each `repair_auth` return is also written to the audit log as `repair_auth_returned` and appears in the Users & Audit page

5. If needed, trigger one immediate cloud probe cycle and watch the GitHub worker:

```bash
python3 skills/quota-reporter/scripts/trigger_remote_probe.py
```

## Local test

```bash
npm install
npm test
```
