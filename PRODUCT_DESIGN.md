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

The auth-pool design fixes this by introducing a shared server-side store of encrypted auth snapshots plus a single cloud-side selection surface.

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

- `https://quota-report-hub.vercel.app`

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
  - optional `quota_payload`
  behavior:
  - derives metadata from the source-specific auth
  - encrypts the auth
  - stores it in `auth_pool_entries`
  - stores the latest known quota in `auth_pool_quota_latest`
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
  behavior:
  - looks at stored auth pool entries plus their latest known quota metadata
  - only compares candidates from the same source
  - excludes the current local account
  - excludes hard-invalidated accounts
  - excludes accounts with `5H <= 0` or `1week <= 0`
  - only considers candidates whose `5H` is strictly better than the current local `5H`
  - only considers candidates whose `1week` is strictly better than the current local `1week`
  - returns either:
    - a decrypted better auth plus latest known quota metadata
    - or `replacement: null`

- `GET /api/status`
  auth:
  - personal bearer token
  behavior:
  - returns dashboard data only to authenticated users

## Local Skill Flow

### Installation Flow

The intended Codex interaction is:

1. user asks Codex to install the skill
2. Codex installs local scripts
3. Codex asks whether the user wants to:
   - use an existing hub URL
   - or deploy a new hub
4. if the user wants a new hub, Codex runs `scripts/deploy_vercel.py`
5. if the user provides an existing hub URL, Codex verifies the auth-pool APIs exist
6. Codex asks the user for company email
7. Codex runs `install_quota_guard.py`
8. server emails a personal token to the mailbox
9. user pastes the token back into Codex
10. Codex writes the token into local config
11. Codex installs or updates the 15-minute scheduler

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

Additional operational constraints:

- Replacing `~/.codex/auth.json` does not retroactively update already running Codex sessions; new sessions pick up the new auth.
- If the cloud has no better auth than the currently installed one, the machine does nothing.
- The local config file must remain private because it stores a personal bearer token.
- The local machine does not keep a rolling archive of auth snapshots anymore; the cloud auth pool is the durable store.
- `known_auth.json` is only a local upload filter. It records the last uploaded state separately for each source.
- If the same account is refreshed locally, the changed `auth_last_refresh` is enough to trigger a new upload and overwrite the old cloud copy for that source.

## Rotation Logic

### Local Rotation Trigger

The local rotation condition is:

- rotate only when the current live auth for that source is unhealthy

Currently “unhealthy” means:

- current `5H remaining` is below `20%`
- or current `1week remaining` is `0%`
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

Cloud fetch selection is simpler:

- exclude hard-invalidated accounts
- exclude unusable accounts
- pick highest `5H`, then highest `1week`

This is intentional because cloud selection is not comparing against one specific local account yet; it is just returning the best known usable auth.

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
