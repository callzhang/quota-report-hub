# Product Design

## Overview

Quota Report Hub solves a practical multi-machine, multi-account problem:

- users switch between several Codex accounts across laptops and servers
- each account has rolling quota windows such as `5H` and `1week`
- the currently active local `~/.codex/auth.json` can run out at any time
- manually checking quota on every machine is slow and error-prone

The system is designed to:

- observe account quota centrally
- store reusable Codex auth snapshots securely
- let a machine fetch a better auth when the current one is nearly exhausted
- keep company-only access for the auth pool

The product has two layers:

- `quota-report-hub`
  the Vercel + Turso service that stores reports, renders the dashboard, stores encrypted auth snapshots, and issues per-user auth-pool tokens
- `quota-reporter`
  the local skill and scripts that run on each machine, archive `auth.json`, report usage, upload auth snapshots to the hub, and fetch a better auth when needed

## Problem Statement

The original local-only model had three weaknesses:

1. each machine had to probe quota locally
2. local `n/a` or partial probe failures could overwrite good dashboard state
3. auth switching logic depended on whatever snapshots happened to be present on the current machine

The auth-pool design fixes this by introducing a shared server-side store of encrypted auth snapshots plus a single cloud-side selection surface.

## Goals

- allow multiple company machines to contribute Codex auth snapshots
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

### Dashboard Reports

The existing dashboard stores:

- `quota_report_events`
  append-only history of all reports
- `quota_report_latest`
  merged latest state per `source + account_id`

The latest-state logic intentionally distinguishes:

- soft failures
  such as `token_count event was present but missing quota details`
  keep the last known good windows and mark them as stale
- hard failures
  such as `auth invalidated (token_invalidated)`
  clear the old windows immediately

This prevents the dashboard from showing fake `n/a` regressions while also avoiding fake “healthy” windows for invalidated auths.

### Auth Pool

The auth pool adds a new server-side storage layer:

- `auth_pool_entries`
  one latest encrypted auth snapshot per `source + account_id`

Each entry stores:

- account identity metadata
- latest auth refresh timestamp
- uploader email
- encrypted `auth.json`
- IV and auth tag for AES-256-GCM

The auth pool is intentionally separate from dashboard reports:

- reports answer “what is the latest known quota status”
- auth pool answers “which auth file can be handed back to a machine”

### Company Auth

Company access is based on:

- company email suffix whitelist
- Mailgun-delivered personal API tokens

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
- a token can be reissued or revoked per user later

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

## Server-Side API Design

### Existing APIs

- `POST /api/report`
  ingest dashboard reports
- `GET /api/status`
  read latest merged dashboard state

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
  - `auth_json`
  behavior:
  - derives metadata from the Codex auth
  - encrypts the auth
  - stores it in `auth_pool_entries`
  - records uploader email

- `POST /api/auth/fetch-best`
  auth:
  - personal bearer token
  input:
  - optional `exclude_account_ids`
  behavior:
  - looks at latest dashboard reports plus stored auth pool entries
  - excludes hard-invalidated accounts
  - excludes accounts with `5H <= 0` or `1week <= 0`
  - ranks by highest `5H remaining`, then highest `1week remaining`
  - returns the decrypted best auth plus the latest report metadata

## Local Skill Flow

### Installation Flow

The intended Codex interaction is:

1. user asks Codex to install the skill
2. Codex installs local scripts
3. Codex asks the user for company email
4. Codex runs `request_auth_pool_token.py`
5. server emails a personal token to the mailbox
6. user pastes the token back into Codex
7. Codex writes the token into local config
8. Codex installs or updates the 15-minute scheduler

### Local Config

The local config file is:

- `~/.agents/auth/quota-reporter.json`

It may contain:

- `server_url`
- `ingest_token`
- `auth_pool_url`
- `auth_pool_user_token`

### Ongoing Machine Behavior

After setup, the local machine does three jobs:

1. archive the current `~/.codex/auth.json`
2. upload the latest archived auth snapshots to the shared auth pool
3. continue reporting dashboard status if dashboard visibility is desired

Separately, the machine can run:

- `fetch_best_codex_auth.py`

to replace local `~/.codex/auth.json` with the best cloud-selected auth.

## Rotation Logic

### Local Rotation Trigger

The local rotation condition remains:

- rotate when current live auth is unhealthy

Currently “unhealthy” means:

- `5H < 20%`
- or `1week == 0`

But rotation only proceeds when the candidate is truly better:

- candidate `5H > current 5H`
- candidate `5H > 0`
- candidate `1week > 0`

This prevents useless swaps where weekly quota is exhausted or 5H would regress.

### Cloud Selection Rule

Cloud fetch selection is simpler:

- exclude hard-invalidated accounts
- exclude unusable accounts
- pick highest `5H`, then highest `1week`

This is intentional because cloud selection is not comparing against one specific local account yet; it is just returning the best known usable auth.

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

- `REPORT_INGEST_TOKEN`
  protects dashboard report ingestion
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

### Required for Existing Dashboard

- `REPORT_INGEST_TOKEN`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

### Required for Auth Pool

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

### Request Personal Token

```bash
python3 skills/quota-reporter/scripts/request_auth_pool_token.py \
  --auth-pool-url https://quota-report-hub.vercel.app \
  --email your.name@stardust.ai
```

### Upload Local Auth Snapshots

```bash
python3 skills/quota-reporter/scripts/sync_codex_auth_pool.py \
  --auth-pool-url https://quota-report-hub.vercel.app \
  --auth-pool-user-token YOUR_PERSONAL_TOKEN
```

### Fetch Best Auth Without Installing

```bash
python3 skills/quota-reporter/scripts/fetch_best_codex_auth.py \
  --auth-pool-url https://quota-report-hub.vercel.app \
  --auth-pool-user-token YOUR_PERSONAL_TOKEN \
  --print-only
```

### Fetch Best Auth And Install It

```bash
python3 skills/quota-reporter/scripts/fetch_best_codex_auth.py \
  --auth-pool-url https://quota-report-hub.vercel.app \
  --auth-pool-user-token YOUR_PERSONAL_TOKEN \
  --archive-current
```

## Future Work

- add revoke-token endpoint
- add list-my-tokens endpoint
- add token rotation UI or CLI flow
- add audit view for upload/download history
- optionally reduce local dashboard reporting and let cloud-side probing become the primary truth
- optionally add team or org-level sharing controls instead of one global company pool
