# Quota Report Hub

Minimal Vercel app that stores encrypted Codex and Claude auth snapshots, issues per-user access tokens by company email, and serves a dashboard plus source-aware auth-pool APIs for local quota guards.

## Documentation

- **[SYSTEM_DESIGN.md](SYSTEM_DESIGN.md)** — how the whole system works, component by component, with the reasoning behind each load-bearing decision. **The reference for any change to this repo.**
- [PRODUCT_DESIGN.md](PRODUCT_DESIGN.md) — what it is for and why it behaves this way.
- [AUTH_TOKENS.md](AUTH_TOKENS.md) — how Codex and Claude credentials are stored, refreshed, rotated, and how they die.
- [AGENTS.md](AGENTS.md) — working rules for anyone (human or agent) writing code here.

## Team token usage analytics

The Hub has an independent `token-usage.html` page for authenticated team members. It defaults to the previous seven days, hourly buckets, grouping by Hub user, and the Total counter. Queries can filter by time, Hub user, provider (`codex` or `claude`), model account, and the raw provider model name, then group by Hub user, provider, model account, or model. Per-user totals are shown in Breakdown rather than a duplicate side panel. The page uses only `GET /api/token-usage-query` and caches each exact query for five minutes per login session.

The Token Usage Trend is a same-scale line chart by the selected group; missing collection buckets remain visible gaps. Breakdown is browser-paginated in 20-row pages and does not issue another query when you change pages.

Every quota guard cycle also scans usage records with a 10-second budget. A new installation starts from a fixed 72-hour cutoff; later cycles read only new bytes after the last acknowledged file position. Codex cumulative `token_count` records are converted to positive deltas and copied history is deduplicated. Claude final assistant-message counters are updated by message ID. Automatic quota-guard switches use the recorded pre-write boundary; manual switches use the account observed at report time, so a small interval of manual-switch attribution error is intentional.

Counters retain provider meaning. `Total` is the provider-reported total. Input and Output are components. Cache Read, Cache Write, and Codex Reasoning are displayed as subsets and must not be added to Total. Claude Total includes input, output, cache read, and cache creation/write according to the provider record. Raw model names such as future GPT or Claude variants are stored and rendered without a fixed allowlist.

Privacy boundary: the collector uploads numeric quarter-hour aggregates only—Hub user is derived from authentication, with provider, model account, raw model, bucket, and six counters. It never uploads prompts, responses, project names, conversation titles, tool content, local paths, session IDs, message IDs, record fingerprints, or file positions. Local checkpoints live in `~/.agents/auth/token-usage.sqlite3` with owner-only permissions. Pending batches are retried idempotently; a rejected invalid batch advances once so it cannot loop forever.

`POST /api/token-usage` ingests a bounded idempotent batch. `GET /api/token-usage-query` returns totals, bounded trend points, bounded four-dimension breakdown rows, and per-Hub-user reporter state. Fifteen-minute detail is accepted and queryable for 90 days. The protected daily `/api/cron/token-usage-retention` job compacts at most seven old UTC days per run into daily rollups and removes old receipts. Token usage tables are not read by the Accounts dashboard, revision polling, quota ingestion/history, or fetch-best paths.

Vercel Functions are pinned to `pdx1`, matching the Turso database's AWS `us-west-2` location. This keeps database-backed requests in one region while static pages continue to use Vercel's CDN.

Token analytics reads never run schema migrations during a serverless cold start. Authentication lookup/touch is one database batch, followed by one bounded analytics batch.

Reference sizing from the approved design benchmark was 95 files and about 2.9 GB of history: a full parse took 44.97 seconds and about 54 MB peak memory. Normal scheduled work is substantially smaller because it resumes from byte positions and stops at the per-cycle budget.

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
   - reads current local Codex and Claude auth and quota state
   - updates local `~/.agents/auth/known_auth.json`
   - reuploads current auths to keep their cloud auth-pool entries present
   - reports stable local quota snapshots to the hub
   - when either source is below its threshold, asks `/api/auth/fetch-best` for a strictly better same-source auth and installs it
   - notifies the user after a successful local replacement

Important runtime notes:

- each run reads current local Codex and Claude auth
- each run self-updates the installed skill from `https://github.com/callzhang/quota-report-hub` before probing, unless `--skip-self-update` is passed for debugging
- each machine stores only one local state file: `~/.agents/auth/known_auth.json`
- the local guard probes current local Codex and Claude auth and quota
- if Codex or Claude has less than `20%` remaining in the `5H` window, or less than `5%` remaining in the `1week` window, the machine asks the cloud auth pool for a better auth of that source; each rule applies only to a window the probe actually reported — Plus-tier Codex accounts still meter a `5H` window, while Codex tiers without a 5-hour limit report none and rotate on `1week` alone
- the request to `/api/auth/fetch-best` includes:
  - `source`
  - the current local `account_id`
  - the current local `5H remaining percent` when the source still reports one
  - the current local `1week remaining percent`
  - a local `requester_id` such as `user@hostname`, so machines sharing the same hub token are still spread across different replacement auths
- the server only returns a replacement when it is strictly better than the current local auth for that same source
- the server requires candidates to have at least `20%` remaining in `5H` and at least `5%` remaining in `1week`; a Codex candidate without a `5H` window is held to the `1week` threshold only
- replacement selection is weighted by remaining quota: the server uses requester-specific deterministic weighted sampling with a softened quota weight, plus a small active-assignment penalty, so high-quota accounts carry more load without taking nearly every request
- the server also tracks active assignments by each machine's latest fetch event; an auth already installed on many machines is treated as loaded even if those machines have not fetched again within the last 5 hours
- local upload is idempotent: even when `known_auth.json` records the same uploaded `account_id`, auth refresh time, and digest, the guard reuploads the current auth so a missing cloud entry can be restored automatically
- uploading a new current auth does not delete older auths previously uploaded by the same user; the hub keeps monitoring all of them so invalidated-owner notifications still work
- `uploader_email` records the Hub account authenticated on the most recent client upload. Re-uploading an account moves subsequent re-login notifications and “my uploaded auth” behavior to that latest uploader; internal worker refreshes retain the last client uploader.
- if the same account is refreshed locally, the new auth refresh time forces a new upload and overwrites the old cloud copy
- `~/.agents/auth/quota-reporter.json` should stay private because it contains the user's personal auth-pool token.
- after the guard writes `~/.codex/auth.json`, it requests only `codex app-server daemon restart`; unmanaged and desktop app-server processes are never terminated. An already-open Codex session may need to be reopened to use the replacement. The guard never launches `codex login`.
- the hub dashboard also uses the same personal token. Without a valid token, `/api/status` returns `401` and the page stays locked.
- if `/api/status` cannot read the backing database, it returns `503` with `hub_unavailable`; when the reason is `database_reads_blocked`, the token is not rejected and the Turso plan/quota must be restored before the dashboard can unlock.
- every time a user requests a new token by email, the old token is revoked. Only the latest token for that email remains valid, even if that latest token is then reused across multiple machines.
- when a request uses an invalid or expired hub-signed token, the hub returns `401` with `token_invalidated`. The local guard requests a new token email once for that invalid local token, then waits for the user to paste the latest token.
- deleted legacy opaque `qrp_...` tokens cannot be upgraded in-band because they do not carry a verifiable email; request a fresh token by email once on that machine.
- old local reporter scripts now live under `skills/quota-reporter/archive/`

The dashboard now reflects the cloud auth pool, not arbitrary client report rows:

- each account has one primary state: `AVAILABLE`, `LOW QUOTA`, `WAITING FOR NEW QUOTA`, `QUOTA UNKNOWN`, or `UNAVAILABLE`; this is the answer to "can the pool use this account now?", not a restatement of the last probe result
- `AVAILABLE` means the required source-specific quota windows are current and above the rotation thresholds; `LOW QUOTA` means current evidence exists but is below a threshold
- `WAITING FOR NEW QUOTA` means the prior window reset and no post-reset snapshot has arrived; `QUOTA UNKNOWN` means current quota evidence is missing, stale, partial, from a failed probe, or a migrated auth has not yet recorded refresh capability; `UNAVAILABLE` means the credential itself is rejected, invalidated, explicitly AT-only and expired, or ineligible. The pool stores only a true/false/unknown capability marker, never the refresh token itself. Re-uploading an identical legacy auth repairs an unknown marker without replacing the credential
- the collapsed state includes current remaining quota and reset countdown, or the expired-window age and next automatic check. Hover or focus opens account details; Enter, Space, or Arrow Down moves keyboard focus into the dialog. Escape, the close button, or an outside press closes it
- a gray quota value is historical evidence only. `Captured` is when that individual quota window was observed; `Reset` is the provider's reset boundary for that window. A historical value must not be treated as current quota, even when the latest probe says `ok`
- after the initial full status load, a visible dashboard checks only the singleton revision once per minute and on visibility regain. It reloads full status when that revision changes or at the next server-supplied time boundary (report freshness, quota reset, or access expiry), so a state cannot remain current merely because no database write occurred
- revision checks use a 12-hour, HMAC-signed `qrr.` ticket issued by an authenticated full-status response. The ticket is scoped to revision metadata and cannot call the full dashboard or auth-pool APIs, so routine checks do not read or update API-token rows
- quota history is not part of `/api/status`: it is fetched for one exact `source + account_id` only when that account's details open, is bounded to 24 hours and 96 points, and is cached in that browser login session for five minutes; concurrent opens reuse the same in-flight request
- quota-event timestamps are validated and stored as canonical UTC with millisecond precision, so the indexed 24-hour range treats equivalent offsets consistently; chart paths break across missing/failed samples, reset changes, and observation gaps longer than 20 minutes
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
- The local guard reloads Codex authentication through the official managed-daemon restart after it writes auth, or when a manual login makes `auth.json` newer than the running app-server. It never signals an unmanaged app-server.
- Claude rows can be refreshed by the cloud worker for direct Claude subscriptions, or by stable local client reports when Claude is running in an environment that the worker cannot replay reliably. Local Claude reporting reads the statusline snapshot first, then falls back to the OAuth usage API when the statusline has no quota windows. Successful OAuth usage windows are cached during endpoint polling backoff and reused only until their provider reset time, preventing alternating guard runs from reporting `n/a`. Claude Code only sends `rate_limits` after the first successful API response in a session, so the statusline capture preserves any previous unexpired `5H` or `7d` window instead of overwriting it with a startup snapshot that has no quota.

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
- The local guard also checks `/api/status` every run and warns about managed auths uploaded by the current token user only after the cloud worker confirms `refresh_token_rejected`. If `auto_relogin_owner_auth` is enabled, it opens the matching local CLI login for that confirmed RT-rejected source; sources disabled with `manage_<source>_auth: false`, ordinary auth probe errors, and stale quota snapshots do not launch login.
- Claude quota is probed in the worker by launching Claude CLI headlessly, restoring the saved CLI state, and reading the statusline snapshot after a minimal real request.
- Claude auth snapshots are uploaded to the cloud pool only when the local machine is using a direct Claude subscription. Machines that inject `ANTHROPIC_*` credentials through `~/.claude/settings.json` are skipped because their active provider is not the worker's official Claude login path.
- The Claude worker uses a short statusline refresh interval during probing so the snapshot is emitted before the worker timeout expires.
- A client can request the best currently usable auth from `/api/auth/fetch-best`, but it must send the same explicit `source`.
- Contribution sets priority, not access. Anyone may fetch any supported source; a user with no healthy auth of their own in the pool is warned, and once the pool is projected to run dry they are rate-limited to one fetch per cooldown until they supply one. Candidate selection still stays source-specific, so Codex never receives Claude auth and Claude never receives Codex auth.
- The dashboard API at `/api/status` also requires the same personal bearer token.
- The selection logic only compares candidates within the same source and skips hard-invalidated auths. Both sources are selected on `5H` and `1week` together; a Codex account without a `5H` window is judged on `1week` alone, and Codex ties break weekly-first.
- Soft probe failures such as missing quota details can still contribute stale-but-last-known-good windows; hard token invalidations clear the old windows.
- The auth pool requires server-side encryption plus Mailgun delivery for issuing personal user tokens.
- The auth pool deduplicates by stable `source + account_id` and records the authenticated Hub account from the latest client upload in `uploader_email`. A newer `auth_last_refresh` replaces the stored auth; an identical auth still updates changed uploader/machine metadata without replacing the encrypted credential.

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
- for Codex, a complete weekly window or hard invalidation is sent; the retired 5H window is not required, while incomplete weekly probes still cannot overwrite good hub data
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
