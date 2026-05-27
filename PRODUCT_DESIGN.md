# Product Design

## Overview

Quota Report Hub solves a practical multi-machine, multi-account problem:

- users switch between several Codex and Claude accounts across laptops and servers
- each account has rolling quota windows such as `5H` and `1week`
- the currently active local `~/.codex/auth.json` can run out at any time
- manually checking quota on every machine is slow and error-prone

The system is designed to:

- store reusable Codex and Claude auth snapshots securely
- let a machine fetch a better auth when the current one is nearly exhausted
- keep company-only access for the auth pool

The product has two layers:

- `quota-report-hub`
  the Vercel + Turso service that stores reports, renders the dashboard, stores encrypted auth snapshots, and issues per-user auth-pool tokens
- `quota-reporter`
  the local skill and scripts that run on each machine, track the current auth for each source, upload it to the hub when it changes, and fetch a better auth when needed

## Problem Statement

The original local-only model had three weaknesses:

1. each machine had to probe quota locally
2. local `n/a` or partial probe failures could overwrite good dashboard state
3. auth switching logic depended on whatever snapshots happened to be present on the current machine

The auth-pool design fixes this by introducing a shared server-side store of encrypted auth snapshots plus a source-aware selection surface.

## Goals

- allow multiple company machines to contribute Codex and Claude auth snapshots
- keep auth snapshots encrypted at rest on the server
- allow only company users to access the auth pool
- avoid one shared global secret for all employees
- support CLI and cron usage without interactive web login
- allow local setup entirely from Codex chat
- preserve the dashboard for human visibility, but make auth selection work even without the dashboard UI

## Non-Goals

- full enterprise identity management
- browser-first login flows
- cross-company sharing
- long-lived human session cookies
- replacing Codex auth semantics themselves

## System Components

### Auth Pool

The auth pool adds a new server-side storage layer:

- `auth_pool_entries`
  one latest encrypted auth snapshot per `source + account_id`
- `auth_pool_quota_latest`
  one latest known quota snapshot per `source + account_id`
- `auth_pool_quota_events`
  append-only probe history; every cloud or client quota probe is recorded before the latest row is updated or an unusable auth is deleted from the active pool

Each entry stores:

- account identity metadata
- latest auth refresh timestamp
- uploader email
- encrypted `auth.json`
- IV and auth tag for AES-256-GCM

The auth pool is now the primary product surface:

- auth pool answers “which auth file can be handed back to a machine”
- dashboard should answer “what does the current cloud auth pool look like”
- dashboard rows should be cloud auth entries, not raw client report rows

### Company Auth

Company access is based on:

- company email suffix whitelist
- Mailgun-delivered personal API tokens

The default hosted hub for the project is:

- `https://quota-report-hub.vercel.app/`

Instead of using one shared `AUTH_POOL_TOKEN` for all employees, the system issues a separate personal token per user.

This matches the real operating mode:

- local scripts are non-interactive
- cron jobs need a stable bearer token
- users can install and configure from a terminal conversation

## Trust Model

### Why Personal Tokens

Shared tokens are operationally simple, but weak:

- impossible to audit who uploaded or downloaded which auth
- one leak compromises the whole company auth pool
- no individual revocation

Personal tokens improve this:

- every upload is associated with an employee email
- every fetch request is attributable to one user
- the hub dashboard can require the same token for read access
- reissuing a token revokes the old one immediately

### Why Email Delivery

The product avoids returning a fresh token directly to the caller after only receiving an email string.

That would allow anyone to claim another employee’s email address and receive their token in-band.

Instead:

1. Codex asks the user for their company email
2. the local script calls the server
3. the server verifies the email suffix
4. the server generates a personal token
5. Mailgun sends the token to the mailbox
6. the real mailbox owner pastes the token back into Codex

This proves mailbox control without adding a browser login dependency.

Only the latest token for an email is valid. A user can reuse that latest token on multiple machines, but asking for a new token revokes the previous one everywhere.

If a request presents an older hub-signed token, the server can verify the embedded email and return a newly issued latest token in the same authenticated response. Local scripts and the dashboard store that replacement token automatically. This is not possible for a deleted legacy opaque `qrp_...` token because the token string itself does not contain a verifiable email; that case must request a fresh token by email.

## Server-Side API Design

### New Auth APIs

- `POST /api/auth/issue-token`
  input:
  - `email`
  behavior:
  - only allows `@stardust.ai`
  - generates a personal auth-pool token
  - emails it through Mailgun
  output:
  - success acknowledgement only

- `POST /api/auth/upload`
  auth:
  - personal bearer token
  input:
  - `source`
  - `auth_json`
  behavior:
  - derives metadata from the source-specific auth
  - encrypts the auth
  - stores it in `auth_pool_entries`
  - records uploader email

- `POST /api/auth/fetch-best`
  auth:
  - personal bearer token
  input:
  - `source`
  - `current_account_id`
  - `current_quota`
    - `five_h_remaining_percent`
    - `one_week_remaining_percent`
  - `requester_id`, normally `user@hostname`, so shared access tokens do not collapse all machines into one requester identity
  behavior:
  - looks at stored auth pool entries plus their latest effective quota metadata
  - allows fetching when the requester has uploaded at least one healthy auth in any supported source
  - if the requester owns an invalidated auth, returns that auth as `repair_auth` so the owner can re-login and refresh it
  - records every returned `repair_auth` as `repair_auth_returned` in `auth_pool_fetch_log`
  - does not treat `repair_auth` as a usable replacement candidate
  - only compares candidates from the same source
  - excludes the current local account
  - excludes hard-invalidated accounts
  - excludes accounts with `5H <= 0` or `1week <= 0`
  - only considers candidates whose `5H` is strictly better than the current local `5H`
  - only considers candidates whose `1week` is still above `0`
  - weights selection by remaining quota using requester-specific deterministic weighted sampling with a softened quota weight, plus a small active-assignment penalty, then returns the lowest projected load
  - treats each machine's latest fetch result as an active assignment, so a shared auth remains load-bearing until that machine fetches a different auth
  - also treats each machine's latest quota report as active-assignment evidence, so machines that keep using an auth without fetching again still count against that auth's load
  - returns either:
    - a decrypted better auth plus latest effective quota metadata
    - or `replacement: null`
  - may also return `repair_auth` when the requester has an invalidated upload that needs repair

- `GET /api/status`
  auth:
  - personal bearer token
  behavior:
  - returns dashboard data only to authenticated users

- `scripts/probe_auth_pool_worker.mjs`
  behavior:
  - GitHub Actions runs this every 15 minutes
  - reads encrypted auth pool entries directly from Turso
  - decrypts every stored auth snapshot
  - probes Codex on the worker via the Codex CLI
  - probes Claude on the worker via a headless Claude CLI session plus statusline snapshot
  - only uploads Claude auths from machines that are using a direct Claude subscription; clients configured with custom `ANTHROPIC_*` provider settings are excluded from the cloud Claude pool because their active login path cannot be replayed reliably on the worker
  - the Claude worker uses a short statusline refresh interval so the snapshot is produced within the probe timeout instead of lagging behind the CLI session
  - writes every raw probe result to `auth_pool_quota_events`
  - writes worker probe results into the same latest-quota merge path used by client reports
  - removes Codex auths from the active pool after consecutive `auth failed (401 unauthorized)` worker probes

- `GET /api/cron/invalidated-auth-notifications`
  auth:
  - Vercel cron bearer token from `CRON_SECRET`
  behavior:
  - runs on Vercel, where the Mailgun environment variables live
  - reads auth pool entries plus latest cloud probe results from Turso
  - records the first time each `source + account_id` becomes continuously hard-invalidated, using `auth_pool_quota_events` instead of only the latest row
  - emails the auth uploader after a hard invalidation remains unresolved for more than 24 hours
  - repeats that reminder at most once per 24 hours until a later successful/non-invalidated probe clears the notification state

## Local Skill Flow

### Installation Flow

The intended Codex interaction is:

1. user asks Codex to install the skill
2. Codex installs local scripts
3. Codex uses the default hosted hub unless the user provides a different hub URL
4. if the user wants a new hub, Codex runs `scripts/deploy_vercel.py`
5. if the user provides a different hub URL, Codex verifies the auth-pool APIs exist
6. Codex asks the user for company email
7. Codex runs `install_quota_guard.py`
8. server emails a personal token to the mailbox
9. user pastes the token back into Codex
10. Codex writes the token into local config
11. Codex installs or updates the 15-minute scheduler
   - macOS uses `launchd`
   - Linux uses `crontab`
   - Windows uses Task Scheduler
12. Codex verifies scheduler registration and runs one immediate guard cycle
13. Codex only reports installation complete after the verification succeeds

If verification fails, Codex must inspect `~/.agents/auth/quota-guard.log` and `~/.agents/auth/quota-guard.error.log`, fix the local scheduler, Python, PATH, hub-token, Codex, or Claude environment issue, and rerun the installer or guard. Copying the skill and writing config alone is not a completed installation.

### Local Config

The local config file is:

- `~/.agents/auth/quota-reporter.json`

It may contain:

- `auth_pool_url`
- `auth_pool_user_email`
- `auth_pool_user_token`

### Ongoing Machine Behavior

After setup, the local machine does three jobs:

1. track the current auth for each source in `~/.agents/auth/known_auth.json`
2. upload the current auth to the shared auth pool only when the last uploaded `source`, `account_id`, `auth_last_refresh`, and `digest` do not already match
3. probe local quota and fetch and install a better auth from the same source when local quota is low
4. send stable local quota snapshots to the hub every 15 minutes when a usable local snapshot exists

Additional source-specific rules:

- Codex local quota probes can also update the hub, because the current local auth is often the most accurate signal for that exact account.
- The server accepts Codex client quota only when both windows are complete or the local auth is hard-invalidated, so partial client probes cannot overwrite good hub data.
- When Codex reaches a usage limit and one window is missing from the token event, the local guard first uses structured reset metadata to build a complete `0%` snapshot; this prevents the hub from keeping an older positive quota such as `23%`.
- A newer worker soft failure does not replace an existing good client Codex quota snapshot.
- Claude can still supplement the hub with stable local quota snapshots because some Claude environments cannot be replayed reliably by the worker.
- Codex auth identity is normalized to the lowercased account email when one is available, instead of relying on the raw provider account UUID, because Team accounts can share provider-side identifiers across multiple humans.

Additional operational constraints:

- Replacing `~/.codex/auth.json` does not retroactively update already running Codex sessions; new sessions pick up the new auth.
- If the cloud has no better auth than the currently installed one, the machine does nothing.
- The local config file must remain private because it stores a personal bearer token.
- The local machine does not keep a rolling archive of auth snapshots anymore; the cloud auth pool is the durable store.
- `known_auth.json` is only a local upload filter. It records the last uploaded state separately for each source.
- If the same account is refreshed locally, the changed `auth_last_refresh` is enough to trigger a new upload and overwrite the old cloud copy for that source.

## Cloud Quota Freshness

The product now runs a server-side 15-minute probe loop.

- the cloud auth pool stores encrypted auth snapshots plus the latest effective quota for each `source + account_id`
- the cloud auth pool stores encrypted auth snapshots plus the latest effective quota for each `source + account_id`
- the dashboard probe time advances when the GitHub Actions worker refreshes the auth pool
- dashboard freshness can be driven by either a fresh local client quota snapshot or the GitHub Actions worker

## Rotation Logic

### Local Rotation Trigger

The local rotation condition is:

- rotate only when the current live auth for that source is unhealthy

Currently “unhealthy” means:

- current `5H remaining` is below `20%`
- or current `1week remaining` is below `5%`
- or current auth is hard-invalidated

When the trigger fires, the machine calls `/api/auth/fetch-best` with:

- `source`
- `current_account_id`
- `current_quota.five_h_remaining_percent`
- `current_quota.one_week_remaining_percent`

The server returns:

- a better auth when one exists
- otherwise `replacement: null`

- `5H < 20%`
- or `1week == 0`

But rotation only proceeds when the candidate is truly better:

- candidate `5H > current 5H`
- candidate `5H > 0`
- candidate `1week > 0`

This prevents useless swaps where weekly quota is exhausted or 5H would regress.

### Cloud Selection Rule

Cloud fetch selection compares against the caller's current local quota:

- exclude hard-invalidated accounts
- exclude unusable accounts
- only keep candidates whose `5H` is strictly higher than the current local `5H`
- require candidate `1week > 0`
- among the remaining candidates, pick highest `5H`, then highest `1week`

### Cloud Deduplication Rule

The cloud auth pool deduplicates by stable identity, not raw file bytes:

- primary identity is `source + account_id`
- if a new upload arrives for the same account but does not have a newer `auth_last_refresh`, it is treated as a duplicate and ignored
- this holds even if the file digest differs
- only a strictly newer refresh replaces the current stored auth for that account

This prevents multiple computers from thrashing the same account entry when they upload equivalent auth files with machine-specific differences.

## Security Design

### Encryption at Rest

Stored auth snapshots are encrypted using:

- AES-256-GCM

Server environment variable:

- `AUTH_POOL_ENCRYPTION_KEY`

Accepted formats:

- 64 hex characters
- base64 encoding of 32 raw bytes

### Secrets Separation

The design keeps secrets separated by function:

- personal auth-pool user token
  protects auth upload and fetch for one employee
- `AUTH_POOL_ENCRYPTION_KEY`
  only for server-side encryption and decryption
- `MAILGUN_API_KEY`
  only for sending user tokens by email

### Current Limitation

Per-user revocation is not fully implemented yet, even though the schema is ready for individual tokens.

That means:

- issuance is per-user
- usage is attributable
- but future work should still add explicit revoke and reissue endpoints

## Environment Variables

### Required for Auth Pool

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `AUTH_POOL_ENCRYPTION_KEY`

### Required for Email Token Delivery

- `MAILGUN_API_KEY`
- `MAILGUN_DOMAIN`
- `MAILGUN_FROM`
- optional `MAILGUN_BASE_URL`

### Optional

- `AUTH_ALLOWED_EMAIL_DOMAIN`
  defaults to `stardust.ai`

## Usage Examples

### Install Local Guard And Request Personal Token

```bash
python3 skills/quota-reporter/scripts/install_quota_guard.py \
  --auth-pool-url https://quota-report-hub.vercel.app \
  --email your.name@stardust.ai
```

### Run One Local Guard Cycle

```bash
python3 skills/quota-reporter/scripts/quota_guard.py
```

### Trigger One Remote Cloud Probe

```bash
python3 skills/quota-reporter/scripts/trigger_remote_probe.py
```

## Future Work

- add revoke-token endpoint
- add list-my-tokens endpoint
- add token rotation UI or CLI flow
- add audit view for upload/download history
- optionally add team or org-level sharing controls instead of one global company pool
