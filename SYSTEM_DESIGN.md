# System Design — quota-report-hub

> **Scope.** This document is the technical "how it's built" companion to [`PRODUCT_DESIGN.md`](PRODUCT_DESIGN.md) (the "why/what"). It is derived from a line-by-line read of the codebase as of 2026-06-14 and cites `file:line` for the load-bearing claims. Where behavior is subtle or surprising, it is called out explicitly (see [§14 Sharp Edges](#14-sharp-edges--known-issues)).

---

## 1. What the system is

`quota-report-hub` runs a **shared, encrypted pool of OpenAI Codex + Anthropic Claude subscription credentials** for a team. Members install a local "quota guard" that, every 15 minutes, measures each source's remaining quota and — when a member's own auth is throttled or dead — borrows a healthier credential from the pool. The hub stores credentials encrypted, reports per-account quota for a dashboard, and (in `disabled_refresh_token` mode) acts as the **sole refresher** of OAuth refresh tokens to stop a multi-machine "refresh-token death spiral."

### Token usage read model

Token analytics is an isolated read model, not part of auth selection or quota availability. Each local installation owns a private SQLite checkpoint database at `~/.agents/auth/token-usage.sqlite3` (`0600`). The first collector run fixes a 72-hour backfill cutoff. Subsequent runs discover only changed JSONL files and resume at acknowledged byte positions, with a 10-second cycle budget and a maximum of 400 aggregate rows per batch. A pending upload and its proposed file/counter/fingerprint checkpoint are committed locally only after server acknowledgement; retries reuse the same batch.

Vercel Functions run in `pdx1` (AWS `us-west-2`) so database-backed requests execute in the same cloud region as the Turso primary. Static HTML remains CDN-served near the browser; keeping compute and data together avoids a cross-country database round trip on every dashboard query.

Codex parsing uses structural `session_meta`, `turn_context`, and cumulative `token_count` fields. Canonical numeric fingerprints remove copied parent history, and counter resets start a new non-negative epoch. Claude parsing uses assistant message ID, raw model, timestamp, and final usage counters; repeated records update only the positive difference. No parser output contains conversation content.

Account attribution has two cases. An automatic guard switch inserts a prepared boundary before credential installation, reads the installed target back, then finalizes or cancels that boundary. Collector events are split at finalized boundaries. A manual switch has no exact boundary, so events read in that cycle use the account observed during the report. This is intentionally approximate and is not a billing ledger.

The authenticated ingestion API writes a receipt-gated `token_usage_15m` aggregate and reporter state in one batch. The query API reads indexed time ranges from 15-minute detail and, for daily queries, `token_usage_daily`. It returns only totals, trend, breakdown, and reporter freshness; trend and breakdown are capped. No token usage query selects installation IDs, batch IDs, payload digests, file paths, logical record IDs, or fingerprints. Existing status, revision, quota, history, and auth-selection paths do not join token usage.

The independent page defaults to seven days/hour/Hub-user/Total and lazily makes one authenticated query. Exact query plus auth-generation results are cached for five minutes and concurrent requests are deduplicated. Token rotation moves the successful result to the new auth generation. A stale old-token response cannot clear a newer login. Charts preserve missing-bucket gaps and expose exact values by keyboard and text; breakdown rows drill into Hub user, provider, model account, and raw model.

Detail ingestion and hourly queries are bounded to 90 days. The daily protected retention cron compacts at most seven old UTC dates atomically per run, deletes the compacted detail, and prunes old receipts. Reference full-scan sizing was 95 files/about 2.9 GB, 44.97 seconds, and about 54 MB peak memory; scheduled incremental work is byte-positioned and budgeted.

It is a four-tier system:

| Tier | Runtime | Code | Role |
|---|---|---|---|
| **Local client** ("quota guard") | Python, cron/launchd, per machine | `skills/quota-reporter/scripts/` | Probe local quota, sync auth to pool, borrow better auth, rotate |
| **Serverless API** | Node, Vercel functions | `api/**`, `lib/**` | Auth, pool read/write, quota ingest, selection, flags, email |
| **Data layer** | Turso (libsql/SQLite) + Tigris (S3-compatible) | `lib/db.js`, `lib/auth-blob-storage.js` | Metadata + pointers in DB; encrypted blobs in object storage |
| **Worker** | Node + Python, GitHub Actions cron (~15 min) | `scripts/probe_auth_pool_worker.mjs` + `scripts/probe_*_auth_blob.py` | Cloud-probe every pooled account, central refresh, health snapshots |
| **Dashboard** | Static HTML/JS | `index.html`, `users.html`, `login.html` | Read-only observability + admin flag toggle |

```
                       ┌─────────────────────────────────────────────┐
                       │            Vercel serverless API             │
   ┌──────────┐  HTTPS │  /auth/{fetch-best,upload,quota,delete,...}  │
   │  Local   │◄──────►│  /admin/flags  /status  /users  /cron/...    │
   │  guard   │ Bearer │                                              │
   │ (Python) │        └───────┬───────────────────────────┬─────────┘
   └──────────┘                │ lib/db.js                 │ lib/auth-blob-storage.js
        ▲                      ▼                           ▼
        │ rotate         ┌───────────┐               ┌──────────────┐
        │ local auth     │  Turso    │  auth_blob_key│   Tigris     │
        │                │ (libsql)  │──────pointer─►│ object store │
        │                │ metadata+ │               │ encrypted    │
        │                │ quota+log │               │ auth blobs   │
        │                └─────┬─────┘               └──────┬───────┘
        │                      ▲                            │
   ┌────┴───────┐  decrypt &   │ snapshots / quota / prune  │ read blob
   │ Dashboard  │  probe       │                            ▼
   │ (static)   │        ┌─────┴──────────────────────────────────┐
   └────────────┘        │  GitHub Actions worker (cron ~15 min)   │
                         │  probe_auth_pool_worker.mjs             │
                         │   ├─ probe_codex_auth_blob.py (refresh) │
                         │   └─ probe_claude_auth_blob.py (scrape) │
                         └─────────────────────────────────────────┘
```

---

## 2. Glossary

- **Source** — `codex` or `claude`. Every credential, probe, and pool entry is scoped to one source.
- **Pool entry** — one encrypted auth blob + metadata for one account, keyed `(source, account_id)` (see [§4](#4-data-model)).
- **Uploader** — the Hub member authenticated on the most recent client upload. Tracked in `uploader_email`; internal worker refreshes retain it.
- **Borrower** — a member whose local quota is low and who fetches a replacement auth from the pool.
- **AT / RT** — OAuth **access token** (short-lived, used for API calls) / **refresh token** (long-lived, mints new ATs; rotates on use).
- **Refresh-token death spiral** — when N machines share one full credential, each refresh rotates the RT and invalidates the others' copies, cascading the whole token family to death. The motivating problem (see [§9](#9-the-disabled_refresh_token-mechanism)).
- **`disabled_refresh_token`** — the admin kill-switch flag. When ON: borrowers receive **access-token-only** blobs (RT stripped to a placeholder) and the hub becomes the **sole** RT custodian/refresher.
- **Hard-dead / hard invalidation** — an account whose RT is rejected: errors `auth invalidated (token_invalidated)`, `auth failed (401 unauthorized)`, `claude auth invalid (authentication_error)`, `claude auth email unavailable`. The latest uploader must re-login. (`lib/db.js:174-183`, `lib/auth-pool.js:202-212`)
- **Abuse-class error** — provider pushback on a *shared AT*: 429 / 403 / rate-limit / suspend / ban / abuse. Categorically distinct from RT death (`lib/abuse-errors.js`).

---

## 3. Component: Local client ("quota guard")

Code: `skills/quota-reporter/scripts/{quota_guard.py, quota_reporters.py, install_quota_guard.py, claude_statusline_probe.py, trigger_remote_probe.py}`.

### 3.1 Install & scheduling (`install_quota_guard.py`)
- Label `com.openai.quota-guard`, interval **900 s** (`install_quota_guard.py:27-28`).
- **macOS** → launchd LaunchAgent (`StartInterval=900`, `RunAtLoad`) (`:71-95`); **Linux** → two managed cron lines `@reboot` + `*/15 * * * *` tagged `# quota-guard-managed` (`:107-128`); **Windows** → Task Scheduler with 15-min repetition (`:145-226`).
- Config at `~/.agents/auth/quota-reporter.json`: `auth_pool_url`, `auth_pool_user_email`, `auth_pool_user_token` (`:40-53`).
- Installs a Claude **statusline hook** into `~/.claude/settings.json` running `claude_statusline_probe.py` every 60 s (`:56-68`).
- **Login**: browser loopback flow against `<hub>/login.html?callback=&state=` validated by a `state` nonce and a `127.0.0.1` callback (`:348-435`); falls back to emailed-token paste when headless (`:438-466`).

### 3.2 The guard cycle (`quota_guard.py` `run_guard` `:1471-1642`)
Each step is wrapped so one failure doesn't abort the cycle (`:305-318`). Order:
1. **Self-update** from GitHub `main` unless disabled (`:1645-1664`).
2. **Scheduler self-heal** — re-register launchd/cron if missing (`ensure_scheduler_registration` `:511-564`).
3. **Probe Codex** — `probe_codex(..., capture_refreshed_auth=True)`, persist any CLI-refreshed `auth.json` back atomically, then strip the sensitive `refreshed_auth_json` from the payload (`:1463-1468`).
4. **Probe Claude** — `probe_claude` (or a synthetic error if a custom ANTHROPIC provider is active).
5. **Sync to pool** (only if configured) — `sync_current_{codex,claude}_auth_pool` (digest-gated upload) + `report_current_quota_to_auth_pool` (`:1516-1557`).
6. **Rotate** — `maybe_replace_{codex,claude}_auth` (`:1559-1588`).
7. **Codex app-server restart** if auth changed (`:1589-1609`).
8. **Notifications** (toasts) unless `--no-toast`.

### 3.3 Reading/writing local auth (`quota_reporters.py`)
- **Codex**: `~/.codex/auth.json`. Account id is **canonicalized to the lowercased email** (`canonical_codex_account_id` `:175-179`) so Team users sharing a provider UUID don't collide. Probe runs `codex exec` in an isolated temp `CODEX_HOME` with an **env blocklist** (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_ACCESS_TOKEN`, …) so an ambient key can't mislabel another provider's quota (`:396-424`).
- **Claude**: modern macOS Claude Code stores the active OAuth credential in Claude's encrypted `oauth:tokenCacheV2`; older builds may still use the direct `"Claude Code-credentials"` keychain item, and non-darwin uses `~/.claude/.credentials.json`. `read_claude_oauth_credentials` prefers tokenCacheV2 on macOS so stale files or MCP-only keychain entries cannot shadow the live credential. Writes go back to the same source when possible. Claude account id = `claude-<email-lowercased>` — **this is where the `claude-` prefix originates** (the server derive takes `account_id` as-is).
- Quota source order for Claude: statusline snapshot first, live `/api/oauth/usage` only as fallback after a 429 backoff (`:1420-1432`).

### 3.4 Rotation decision (`source_needs_replacement` `:186-197`)
Replace when the source is hard-invalidated or status≠ok. For Codex, quota-based replacement uses `1week_remaining < 5%` only; `5h` is display/legacy metadata because Codex no longer has a meaningful 5-hour rotation limit. For Claude, quota-based replacement still uses `5h_remaining < 20%` or `1week_remaining < 5%`. `maybe_replace_*` then calls `/api/auth/fetch-best`. Two outcomes:
- **`repair_auth`** — the hub hands the dead auth back to its latest uploader so they re-login (state `repair_auth_from_auth_pool`).
- **`replacement`** — install the better auth. If it's the same account it's an `auth_refreshed` (state `fetched_from_auth_pool`), else a true switch.

### 3.5 `disabled_refresh_token` client behavior (Phase-4 strip)
- Placeholder RTs: codex `"rt.1."+"A"*32`, claude `"disabled-by-hub-refresh-token"` (`quota_reporters.py:43-47`).
- `auth_json_is_stripped` short-circuits `sync_current_*` so AT-only auths are **never re-uploaded** (`:2000-2012, 2134-2174`).
- After a successful upload whose response says `disabled_refresh_token:true`, the client calls `strip_local_{codex,claude}_refresh_token` to overwrite its own local RT with the placeholder and records state `fetched_from_auth_pool` (`:2146-2192`). From then on it behaves like a borrower: it relies on the hub for fresh ATs.
- Claude strip writes the placeholder to every local store that can later shadow the hub (macOS tokenCacheV2/tokenCache, keychain, and an existing `.credentials.json`; file/keychain on non-macOS). If the active Claude auth is already AT-only, the guard still runs this backup-store cleanup while continuing to skip uploads.
- **Proactive same-account refresh**: `fetched_auth_near_expiry` returns true when state is `fetched_from_auth_pool` and the local AT is within `AT_NEAR_EXPIRY_SKEW_SECONDS = 20 min` of expiry; the guard then calls `fetch-best` with `refresh_current=True` to mint a fresh AT for the *same* account before the dead placeholder RT is ever needed (`:2017-2060`).

### 3.6 Token handling
- One personal **auth-pool user token** (issued per company email) is the Bearer for all hub calls and also unlocks the dashboard.
- **In-band token upgrade**: every hub response is run through `persist_auth_pool_token_upgrade` — if the body carries a new `auth_pool_user_token`, it's written back to config (0600) and redacted from memory (`:1638-1672`).
- On a `token_invalidated` body, `request_auth_pool_token_email_once` re-issues an emailed token at most once per (email, token-digest) (`:1675-1766`).

---

## 4. Data model

### 4.1 Turso (libsql/SQLite), `lib/db.js`
Single module-load client (`lib/db.js:15-18`); schema created lazily + memoized (`ensureSchema` `:328-498`).

| Table | Key | Purpose |
|---|---|---|
| `auth_pool_entries` | PK `(source, account_id, session_id)` | The encrypted credential pool. One row per account in practice (see collapse, [§5.2](#52-single-entry-per-account)). Holds metadata + either inline ciphertext **or** an `auth_blob_key` pointer. (`:331-353`) |
| `auth_pool_quota_latest` | PK `(source, account_id)` | Newest merged quota report per account (dashboard + selection). (`:363-387`) |
| `auth_pool_quota_events` | PK `id` (uuid) | Append-only quota history; used for audit and continuous-invalidation windows. Not on the normal selection hot path. (`:388-420`) |
| `auth_users` | PK `email` | Known members. (`:421-427`) |
| `auth_api_tokens` | PK `token_hash` | Issued tokens, **hash only**, one active per email. (`:428-435`) |
| `auth_pool_fetch_log` | PK autoinc | Audit of every pool fetch (served / repair / no-match) + requester quota. (`:436-456`) |
| `auth_pool_requester_assignments` | PK `(source, requester_key)` | Latest fetch/current-account state per requester. Used for active assignment counts and dashboard fetch summaries without scanning `auth_pool_fetch_log`. |
| `auth_pool_reporter_assignments` | PK `(source, reporter_key)` | Latest quota-account state per reporting machine. Used for active reporter counts without scanning `auth_pool_quota_events`. |
| `auth_pool_invalidated_notifications` | PK `(source, account_id)` | Since-when an account is hard-dead + last email sent. (`:459-468`) |
| `feature_flags` | PK `key` | `disabled_refresh_token` (stored as `"true"`/`"false"`). (`:469-476`) |
| `pool_health_snapshots` | PK autoinc | Observability time series: ok/hard-dead/other + central-refresh outcomes per source per worker run. (`:477-494`) |
| `dashboard_revision` | Singleton row (`singleton = 1`) | Monotonic change marker for dashboard-visible writes. The browser reads this one row instead of rebuilding full status every minute. |

**PK evolution** (`migrateAuthPoolEntriesTableShape` `:23-81`): older deployments are rebuilt to the canonical `(source, account_id, session_id)` PK with **nullable** encryption columns + `auth_blob_key`. The active PK column list lives in a mutable global `authPoolPkColumns` used to build `ON CONFLICT(...)` (`:21, 80, 734`).

### 4.2 Tigris object storage, `lib/auth-blob-storage.js`
- Configured when the Tigris triplet (or a local `AUTH_BLOB_STORAGE_DIR`) is set (`:8-18`).
- Key layout: `auth-pool/<source>/<accountId>/<sessionId|default>/<digest>.json`, each part URL-encoded (`:24-32`).
- Stores the same `{encrypted_auth_json, iv, auth_tag}` GCM envelope the DB would have held inline.

**Live state (2026-06-14):** 28/28 entries are on object storage, 0 inline — migration complete (see `scripts/migrate_auth_blobs_to_object_storage.mjs`, [§8.3](#83-blob-migration)). The DB row keeps only metadata + `auth_blob_key`; the worker fetches+decrypts the blob only at the moment it actually probes/refreshes, so **storage location is orthogonal to the probe/refresh logic**.

---

## 5. Encryption & storage layering

### 5.1 Encryption (`lib/auth-pool.js:49-156`)
- **AES-256-GCM**, random **12-byte IV** per blob, GCM auth tag captured; ciphertext/iv/tag all base64 (`:125-135`).
- Key = `AUTH_POOL_ENCRYPTION_KEY` directly (no KDF): either 64 hex chars or base64 decoding to exactly 32 bytes (`encryptionKey` `:49-62`).
- `decryptAuthJson(entry)` branches: if `entry.auth_blob_key` is set, fetch the envelope from object storage then decrypt; else decrypt the inline columns (`:151-156`). This is the **only** abstraction that hides inline-vs-object storage from callers.

### 5.2 Single-entry-per-account
On upsert (`upsertAuthPoolEntry` `lib/db.js:589-786`), before INSERT:
1. **Delete other sessions** of the same account: `DELETE … WHERE source=? AND account_id=? AND session_id IS NOT ?` (`:713-716`).
2. **Purge same-email / different-account** legacy rows from both `auth_pool_entries` and `auth_pool_quota_latest` (`:717-726`).
3. **Encrypt** → if object storage configured, write blob + null the inline columns; else store inline (`:690-706`).

`collapseAuthPoolSessions()` (`:790-803`) is the one-shot retroactive version (keep newest `uploaded_at` per account). The worker also dedupes per-run before processing ([§7](#7-component-worker)).

### 5.3 What is plaintext vs encrypted
Only the auth JSON (the actual tokens) is encrypted. Plaintext in the DB: `email`, `name`, `plan_name`, `hostname`, `reporter_name`, `uploader_email`, `account_id`, `session_id`, `digest` (a hash), timestamps, and all quota numbers. API tokens are stored **hash-only** (`tokenHash`), never raw (`:1319, 1671, 1695`).

---

## 6. Component: Serverless API

All handlers are Vercel functions; most require a Bearer token via `authenticateApiRequest` → `authenticateOrUpgradeApiToken` (`lib/api-auth.js:4-6`). Responses pass through `withTokenUpgrade` so a legacy `qrp_` token is transparently swapped for a signed `qrp.` token mid-response (`lib/db.js:1329-1347`).

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/auth/fetch-best` | POST | Bearer | Borrow a better/refreshed auth (the core selection path, [§6.1](#61-fetch-best-the-borrow-path)) |
| `/api/auth/upload` | POST | Bearer | Upload local auth to the pool; echoes `disabled_refresh_token` |
| `/api/auth/quota` | POST | Bearer | Publish a local quota snapshot (`report_origin:"client"`) |
| `/api/auth/delete` | POST | Bearer | Remove a pool entry (cascade) |
| `/api/auth/issue-token` | POST | **none** (company-email gate) | Email a one-time access token |
| `/api/admin/flags` | GET/POST | Bearer (POST: admin) | Read flags / flip `disabled_refresh_token` |
| `/api/cron/invalidated-auth-notifications` | GET/POST | **`CRON_SECRET`** | Daily email to latest uploaders of 24h-dead auths |
| `/api/cron/probe-auth-pool` | GET/POST | **`CRON_SECRET`** | Lightweight manual/external trigger that dispatches the GitHub probe workflow when health snapshots are stale |
| `/api/status` | any | Bearer | Dashboard dataset |
| `/api/status-revision` | any | Scoped `qrr.` ticket | Singleton dashboard revision only |
| `/api/quota-history` | GET | Bearer | Exact-account quota history, bounded to the preceding 24 hours and 96 chronological safe points |
| `/api/users` | any | Bearer | Users + fetch-log audit |

`vercel.json`: platform cron only calls `/api/cron/invalidated-auth-notifications` daily at `0 17 * * *` UTC. Vercel Hobby does not support 15-minute cron jobs, so the *probe* worker stays in GitHub Actions. `/api/cron/probe-auth-pool` remains available for manual or external stale-snapshot dispatch when called with `CRON_SECRET`.

### 6.1 fetch-best (the borrow path) — `api/auth/fetch-best.js`
Three branches, in order:
1. **Repair-handback gate** (`:47-86`): a requester with **no healthy uploaded auth** is never served a borrowed credential. If they have a dead auth of their own, it's handed back (`repair_returned`) for re-login; otherwise `no_uploaded_auth`. This enforces *upload-to-borrow*.
2. **`refresh_current` mode** (`:93-142`): when `refresh_current && current_account_id`, fetch the same account's pooled blob and only return it if its AT is genuinely fresh (`accessTokenMsUntilExpiry === null || > 5 min`); otherwise fall through to a normal replacement (so an owner can't dead-lock on its own stale copy).
3. **Normal replacement** (`:144-216`): `bestAuthPoolEntry(...)` → `pickBestAuthPoolCandidate` ([§10](#10-selection-algorithm)). `selection_key` mixes email/requester/IP for stable selection. On a hit, `recordAuthPoolFetch(reason:"served")`.

In branches 2–3, when `disabled_refresh_token` is ON, the served blob is run through `stripRefreshToken` (`lib/fetch-best.js:30-51`) so the borrower gets an AT-only credential.

### 6.2 Stripped-RT poison guard
`isStrippedRefreshToken` (`lib/fetch-best.js:57-74`) detects the hub placeholder RTs. `upsertAuthPoolEntry` rejects any upload carrying one (`{rejected:true, reason:"stripped_refresh_token"}`, `lib/db.js:589-597`) so a borrower running AT-only can never overwrite the pool's real shared RT.

### 6.3 Identity & email
- Company-email gate: token issuance requires `@<AUTH_ALLOWED_EMAIL_DOMAIN>` (default `stardust.ai`) (`lib/company-auth.js:13-16`); admin gate via `ADMIN_EMAIL` comma-list (`:18-28`).
- HMAC tokens: `qrp.<base64url(payload)>.<hmac>` signed with `TOKEN_ISSUE_KEY`, verified with `timingSafeEqual`; DB presence still required so tokens are revocable (`:54-117`).
- Revision tickets: a successful `/api/status` authentication also returns a 12-hour HMAC-signed `qrr.` ticket scoped to `/api/status-revision`. Its routine verification is stateless, so the one-minute change check performs only the singleton revision read and does not update `auth_api_tokens.last_used_at`. The ticket exposes only revision metadata and cannot authorize a full-status or auth-pool request; full data reloads still require the revocable `qrp.` token.
- This stateless ticket is deliberately less revocable than a DB-backed personal token during its 12-hour life. The tradeoff is bounded: it reveals only `revision` and `updated_at`, cannot read account or quota data, and removes the API-token-row read/write from every routine browser poll. Revoking the personal token still blocks full status and history immediately.
- Mailgun for token delivery + 24h-stale-auth alerts (`:127-275`).

`/api/status` reads the revision before and after assembling current state. If a dashboard-visible write occurs between those reads, it retries the assembly once; if state keeps changing, it returns the normal service-unavailable response instead of labeling stale data with the new revision.

The browser keys in-flight full-status requests by the exact session token and a request generation. Pasting or clearing a token invalidates older generations, so a delayed response from the previous session cannot clear or overwrite the current session. Revision responses also recheck tab visibility immediately before requesting full status.

### 6.4 Availability read model and lazy history

`lib/account-availability.js` derives one presentation-neutral state after report freshness and effective windows have been assembled. Precedence is `unavailable` → `waiting_for_new_quota` → `quota_unknown` → `low_quota` → `available`:

- `unavailable`: refresh rejection, auth invalidation, ineligible plan, or an unrecoverable access-token expiry overrides quota history.
- `waiting_for_new_quota`: a required window reset has passed and no post-reset quota exists.
- `quota_unknown`: required evidence is missing, partial, failed, older than the one-hour report-freshness boundary, or has no future reset boundary. An expired access token is also unknown—not unavailable—when the auth entry's safe `has_refresh_token` marker is true, or when a migrated legacy row still has a null/unknown marker. New AT-only entries explicitly store false and are unavailable after access expiry. An identical re-upload repairs a null marker and bumps the dashboard revision only when that visible capability changes.
- `low_quota`: all required evidence is current, but Codex weekly quota is below 5%, or Claude 5-hour/weekly quota is below 20%/5% respectively.
- `available`: all required windows are current and meet the same thresholds used by auth selection.

The collapsed table renders only this state plus current remaining quota and reset countdown, or the expired-window age and next automatic check. Pointer hover, keyboard focus, and touch/click open an accessible dialog; Enter, Space, and Arrow Down deliberately move focus to its close control, and Escape restores focus to the trigger. A quota window's `captured_at` is preserved independently through merge and storage; it is not replaced by a newer row-level `reported_at`. `reset_at` remains the provider's window boundary. When evidence is no longer current, the snapshot remains available in gray as historical evidence and never contributes to current usability.

`GET /api/quota-history` requires exactly one non-empty `source` and `account_id`. Quota-event `reported_at` values are validated and canonicalized to UTC millisecond precision before insertion, keeping the indexed text range correct for equivalent offsets and fractional timestamps. The endpoint queries `[generated_at - 24h, generated_at]`, returns at most 96 chronological points, and projects only report time/status/error plus 5-hour and weekly quota/reset fields. It never returns auth blobs, access/refresh tokens, token hashes, uploader identity, or unrelated accounts. Missing/failed points, reset boundaries, and observation gaps longer than 20 minutes split chart paths rather than being interpolated.

Each availability result includes its next time-derived transition. While visible, the browser schedules one bounded full-status refresh for the earliest deadline and still uses the singleton revision for routine one-minute polling. Hidden tabs clear that timer; visibility regain performs a full load if the deadline passed, otherwise only the cheap revision check.

History is excluded from `/api/status`. The browser requests it only when an account dialog opens, caches the result for five minutes within the current authentication-session generation, and deduplicates concurrent requests for the same account. Changing or clearing the session invalidates the cache key.

---

## 7. Component: Worker

Code: `scripts/probe_auth_pool_worker.mjs`, spawning `scripts/probe_{codex,claude}_auth_blob.py`. Runs on GitHub Actions cron `7 * * * *`, manual dispatch (`.github/workflows/probe-auth-pool.yml`), and the stale-snapshot dispatch endpoint (`/api/cron/probe-auth-pool`). The scheduled workflow installs node 24, the Codex CLI, the Claude CLI, and `pexpect` once, then runs twelve probe cycles in the same runner with `PROBE_INTERVAL_SECONDS=720`.

> The GitHub schedule is **best-effort**: high-frequency cron events can be delayed or skipped, so the production schedule uses one hourly runner and performs the probe loop inside that runner long enough to cover observed 2-3 hour gaps. Manual `workflow_dispatch` defaults to one cycle so a human-triggered repair does not wait for the full scheduled loop.

### 7.1 Run loop (`main`)
1. `authPoolEntries()` → `dedupeEntriesByAccount(allEntries)` → `{canonical, stale}`. Canonical = freshest `uploaded_at` per `(source, account_id)`; rest are stale.
2. **Prune stale** duplicate sessions via `deleteAuthPoolEntryRow` (single-row, **no** account cascade — preserves account-keyed quota/notification state).
3. For each **canonical** entry: `processAuthPoolEntry(entry, {atOnlyMode})`.
4. `summarizePoolHealth(items)` → one `pool_health_snapshots` row per source.

> **Why dedupe before refresh** (`probe_auth_pool_worker.mjs` dedupe comment): multiple sessions of one account each hold an RT from a different rotation generation. Centrally refreshing more than one replays a superseded RT → the provider revokes the whole family. The worker only ever refreshes the canonical session.

### 7.2 Per-entry processing (`processAuthPoolEntry`) — the per-cycle decision
Each cycle decides, **per entry and independently**, whether to probe and whether to refresh:

- **Probe selectivity** (`probeSkipReason`): skip the cloud probe when the client already reported fresh quota (`fresh_client_quota_report`) **or** a client re-uploaded within `PROBE_STALE_MS = 1 h` (`recently_updated`) — *unless* there's no prior report (a brand-new entry is always probed for a baseline). Skipping avoids aging a fresh token and cuts load.
- **Refresh selectivity** (`refreshEntryIfNeeded`, when `disabled_refresh_token` ON): compute `accessTokenMsUntilExpiry(authJson, source)`; refresh only if within `REFRESH_THRESHOLD_MS = 1 h` (T-1h) of expiry — **unified for claude and codex**. Refreshed tokens are written back to the pool, and the *probe sees the fresh AT*.
- **Probe** the (possibly refreshed) blob via the source-specific Python probe.
- **Auth-invalid backstop**: if a probe reports a hard auth error in `disabled_refresh_token` mode but the worker skipped proactive refresh because the saved AT expiry looked far away, the worker force-refreshes the cloud RT once and probes again. Only a provider 400/401 from that forced refresh is treated as confirmed `refresh_token_rejected`; a successful forced refresh clears the stale AT failure.
- **Delete-unusable** codex auths (Free plan, continuous 401, missing quota details, account-id migrated) (`shouldDeleteUnusableAuthPoolEntry`).
- **Codex passive refresh capture**: if the probe's `refresh_capture` shows the codex CLI self-refreshed, write the refreshed blob back. (Coexists with proactive refresh without double-rotation: after a proactive refresh the AT is fresh, so the CLI won't refresh again.)
- Persist the merged quota report (`upsertAuthPoolQuota`).

Result per item carries `central_refresh` (attempted/ok/rejected) and a probe status, aggregated into the health snapshot.

### 7.3 Probe mechanics
- **Codex** (`probe_codex_auth_blob.py` → `quota_reporters.probe_codex`): runs the Codex CLI against the blob, reads `token_count` rate-limit windows, and with `capture_refreshed_auth=True` lets the CLI **self-refresh** and captures the before/after token diff + `refreshed_auth_json` (the **`refresh_capture`**). Report: `status, error, account_id, email, plan_name, windows{5h,1week}, model_context_window, usage_summary, refresh_capture`.
- **Claude** (`probe_claude_auth_blob.py`): a self-contained `pexpect` driver that materializes the blob into a temp `HOME`, drives the Claude CLI's `/usage` UI, and scrapes the statusline snapshot (fallback: regex-scrape the rendered usage page). **No `refresh_capture`** (Claude never self-refreshes here); `model_context_window` is always null. Auth errors map to `claude auth invalid (authentication_error)`.

---

## 8. Ops scripts

### 8.1 assess_health.mjs
Reads `.env.local` if env unset, then: (1) **abuse scan** over `authPoolQuotaLatest` — any abuse-class error → `VERDICT: ABUSE_SUSPECTED`, **exit 3**; (2) per-source **hard-dead trend** over a window (default 4 h) from `pool_health_snapshots` → `CLIMBING`/`flat`/`falling` + central-refresh ok/dead-RT counts. **Exit 0** contained, **1** climbing, **2** no creds, **3** abuse.

### 8.2 invalidated-auth notifications
`lib/invalidated-auth-notifications.js` + the daily cron: an account hard-dead ≥24 h triggers one email to its latest uploader (Mailgun), repeated at most every 24 h; recovery clears the state. `first_invalidated_at` is the **earliest contiguous** invalidation found by scanning the event log backward (`lib/db.js:200-241`), so a recovered-then-failed account resets the clock.

### 8.3 Blob migration
`migrate_auth_blobs_to_object_storage.mjs`: three modes (`scan` / `write-only` / `apply`). Per row it writes the envelope to Tigris, **round-trip verifies** (`readAuthBlob` must equal what was written), then in `apply` mode nulls the inline columns under an **optimistic-concurrency guard** (the UPDATE's WHERE re-checks the exact old ciphertext and `rowsAffected===1`, else throws). Backs up candidates to JSONL first.

---

## 9. The `disabled_refresh_token` mechanism

**Problem.** Rotating OAuth refresh tokens: each refresh returns a *new* RT and invalidates the old one. Share one full credential across N machines and every machine's refresh orphans the others' RTs — a cascading death spiral that empties the pool.

**Solution (flag ON).** The hub becomes the single point of refresh:
1. **Serve AT-only** — `fetch-best` strips the RT to a placeholder before serving ([§6.1](#61-fetch-best-the-borrow-path)). Borrowers can use the AT but cannot rotate the shared RT.
2. **Reject stripped-RT uploads** — the poison guard ([§6.2](#62-stripped-rt-poison-guard)) keeps the real RT in the pool intact.
3. **Uploader goes AT-only too** — after uploading its real RT, that client's guard strips its own local RT (Phase-4, [§3.5](#35-disabled_refresh_token-client-behavior-phase-4-strip)) and thereafter relies on the hub.
4. **Hub refreshes centrally** — the worker proactively refreshes near-expiry ATs ([§7.2](#72-per-entry-processing-processauthpoolentry)) and clients pull fresh ATs via `refresh_current`.

**Lifecycle of one account under the flag:**

```
client uploads full auth ──► pool stores real RT ──► client strips local RT (AT-only)
        │                                                      │
        ▼                                                      ▼
 borrowers fetch AT-only ◄── hub central-refresh (T-1h) ◄── worker probes + refreshes
        │                                                      │
   AT near expiry ──► refresh_current ──► hub serves fresh AT ─┘
        │
   RT truly dead (revoked elsewhere) ──► hard-dead ──► repair-handback ──► latest uploader re-login
```

**Safety properties.** Because borrowers can't refresh, they can't cause cascade. The unique *new* risk is many machines sharing one AT → provider abuse pushback; this is monitored separately ([§8.1](#81-assess_healthmjs), abuse-class scan). Observed data: 0 abuse-class errors; all failures are RT-class.

The flag defaults OFF (`getFeatureFlag("disabled_refresh_token", false)`), so deploys are inert until an admin flips it on the dashboard.

---

## 10. Selection algorithm (`pickBestAuthPoolCandidate`, `lib/auth-pool.js:260-312`)

For a borrow request, candidates are filtered then ranked:

**Eligibility** (`:273-280`): same source; not excluded (incl. `current_account_id`); not `Free` plan and not hard-invalidated; report fresh (`reported_at` within `max_report_age_seconds`, default 3600 s). Codex candidates must meet the weekly share threshold (weekly ≥ 5%) and beat the requester's weekly remaining quota. Claude candidates must meet both thresholds (5h ≥ 20%, weekly ≥ 5%) and beat the requester's `5h × weekly` product.

**Ranking** (`:282-301`): primary key is `projectedWeightedLoad` ascending — a fairness/load score combining a **deterministic exponential jitter** seeded by `selection_key:source:account_id` (stable per requester, spreads load) and a recent-served penalty. Codex quota weight and tie-breaks are weekly-first; Claude quota weight still uses the limiting window and tie-breaks by 5h, weekly, then recency. This balances *give the borrower good quota* against *don't stampede one account*.

**Read budget**: `fetch-best` reads only the requested source's pool entries and latest quota rows. Active load is read from the compact requester/reporter assignment tables, which have one row per requester or reporter, rather than using window functions over the append-only fetch/quota history tables on every request.

---

## 11. Token-refresh architecture

`lib/token-refresh.js` is the server-side refresher (hub is sole refresher under the flag):
- **Endpoints**: Claude `platform.claude.com/v1/oauth/token` (client `9d1c…`, scope `user:inference`); Codex `auth.openai.com/oauth/token` (client `app_EMoam…`, no scope) (`:5-10`).
- **Classification** (`postRefresh` `:12-39`): HTTP 400/401 → `auth_rejected` (RT dead, latest uploader must re-login); anything else (network, 5xx, 200-without-token) → transient.
- **`applyRefreshToBlob`**: per-source field updates that preserve unrelated sections (e.g. claude `mcpOAuth`); sets `expiresAt`/`last_refresh`.
- **`accessTokenMsUntilExpiry`** — the crux of selectivity:
  - **Claude**: `credentials.claudeAiOauth.expiresAt` (real, AT ~8 h).
  - **Codex**: decode the **access_token JWT** `exp` (real ~**10-day** lifetime), falling back to the `id_token` JWT (~1 h, identity only) **only** if the access_token isn't a decodable JWT (`:105-122`).

**Why one T-1h threshold for both** (today's unification): the worker decides which accounts to refresh each cycle by comparing `accessTokenMsUntilExpiry` to `REFRESH_THRESHOLD_MS = 1 h`. Codex's 10-day AT means proactive refresh almost never fires on a healthy codex account (it's effectively claude-driven), but unifying the code path removes per-source special-casing. The threshold is sized against the worst worker gap (~110 min); the backstops for a missed window are client re-upload + the `refresh_current` AT-freshness fallback.

> **Historical pitfall (encoded in tests + memory):** codex AT lifetime was once misread from the id_token (~1 h), producing a wrong "codex AT dies hourly" analysis. The fix reads the access_token JWT. See `memory/codex-access-token-lifetime.md`.

---

## 12. Observability

- **`pool_health_snapshots`** — one row per source per worker run: `total, ok_count, hard_dead_count, other_err_count, central_refresh_{attempted,ok,rejected}`.
- **Account availability** (`index.html`): one primary lifecycle state per account. Detailed probe/token/refresh evidence and the lazy 24-hour quota chart are secondary diagnostics, not peer status lines.
- **Dashboard trend** (`index.html` `renderHealthTrend`): per-source healthy ratio, hard-dead count + trend badge, an SVG sparkline of the hard-dead series, and central-refresh outcomes. The framing: *the death spiral is closed when hard-dead stops climbing*.
- **`assess_health.mjs`** — CLI verdict + abuse scan ([§8.1](#81-assess_healthmjs)).
- **`auth_pool_fetch_log`** — full borrow audit surfaced on `users.html`.

---

## 13. Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | API, worker, ops | DB |
| `AUTH_POOL_ENCRYPTION_KEY` | API, worker | AES-256-GCM key (32 bytes hex/base64) |
| `TIGRIS_STORAGE_{ACCESS_KEY_ID,SECRET_ACCESS_KEY,BUCKET}` | API, worker | Object storage for blobs |
| `AUTH_BLOB_STORAGE_DIR` | API, worker | Local-dir alternative to Tigris |
| `TOKEN_ISSUE_KEY` | API | HMAC signing of `qrp.` tokens |
| `AUTH_ALLOWED_EMAIL_DOMAIN` | API | Company-email gate (default `stardust.ai`) |
| `ADMIN_EMAIL` | API | Comma-list of admins who can flip flags |
| `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM` | API | Email delivery |
| `CRON_SECRET` | API | Auth for the daily notification cron |
| `FRONTEND_PORT` | dev | Local static server port (default 6088) |

---

## 14. Sharp edges & known issues

Facts surfaced during the read that future maintainers should know:

1. **`authPoolEntry()` never returns `auth_expires_at`** — both SELECT projections omit the column while the row mapper reads `row.auth_expires_at`, so it comes back `undefined` on that path (`lib/db.js:889-960`). Other readers (`authPoolEntries`, `getInvalidatedUploaderEntry`) do select it. Not a crash; just unavailable through that one accessor.
2. **No HTTP-method guards** on `/api/status`, `/api/users`, and GET `/api/admin/flags` (they accept any method). Low risk but inconsistent with the POST endpoints' 405s.
3. **`/api/auth/delete` has no owner check** — any authenticated company user can delete any pool entry. Acceptable for a trusted team; worth gating if the trust boundary widens.
4. **`index.html` does not HTML-escape server-supplied strings** (`item.error`, emails, requester fields) while `users.html` does — a stored-XSS surface on the main dashboard if any of those fields become attacker-influenced.
5. **`fetch-best.js` is misleadingly named** — it holds RT-stripping/repair helpers, *not* the borrower selection logic. Selection is `pickBestAuthPoolCandidate` in `lib/auth-pool.js` (reached via `lib/db.js bestAuthPoolEntry`).
6. **Two refreshers exist** — the worker (central, server-side, under the flag) and the client's own Claude AT refresh (`ensure_fresh_claude_access_token`). They don't conflict because under the flag the client strips its RT and stops self-refreshing the shared credential.
7. **Probe schedule is unreliable** — never assume 15 min. Thresholds (`REFRESH_THRESHOLD_MS`, `PROBE_STALE_MS`) are tuned against the real worst-case gap, and the named constants make them a one-line tune.
8. **Probe success is not current quota evidence** — an `ok` request may omit a required window, may be older than the one-hour freshness boundary, or may describe a window whose reset has passed. Diagnose `QUOTA UNKNOWN` or `WAITING FOR NEW QUOTA` by comparing probe time, per-window `captured_at`, and `reset_at`; request latest-uploader login only for an explicit unavailable authentication reason.

---

## 15. End-to-end flow recap

**Onboard:** `login.html` → `/api/auth/issue-token` → emailed `qrp.` token → installer writes config + schedules the guard.

**Dashboard:** authenticated `/api/status` → render one availability state per account and save its revision + scoped `qrr.` ticket → while visible, check the singleton revision once per minute and on visibility regain → reload full status only after a change → fetch one account's bounded history only when its details open, with a five-minute browser cache. Only a missing token or explicit `401` returns the UI to login; transient failures retain the last data and retry.

**Steady state (per machine, every 15 min):** probe local quota → if local auth changed, upload to pool (digest-gated) → publish quota snapshot → if quota low or dead, `fetch-best` → install replacement/refresh, or get own dead auth handed back for re-login.

**Steady state (hub, every ~15–35 min):** dedupe pool to one entry per account → prune stale sessions → for each account: skip-probe-if-fresh, central-refresh-if-near-expiry (T-1h, both sources, only under the flag), cloud-probe, delete-if-unusable, write quota → record a health snapshot.

**Daily:** notify latest uploaders of auths hard-dead ≥24 h.

**Admin:** flip `disabled_refresh_token` on the dashboard to switch the whole pool between full-credential distribution and hub-sole-refresher AT-only distribution.
