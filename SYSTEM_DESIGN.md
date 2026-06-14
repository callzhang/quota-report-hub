# System Design — quota-report-hub

> **Scope.** This document is the technical "how it's built" companion to [`PRODUCT_DESIGN.md`](PRODUCT_DESIGN.md) (the "why/what"). It is derived from a line-by-line read of the codebase as of 2026-06-14 and cites `file:line` for the load-bearing claims. Where behavior is subtle or surprising, it is called out explicitly (see [§14 Sharp Edges](#14-sharp-edges--known-issues)).

---

## 1. What the system is

`quota-report-hub` runs a **shared, encrypted pool of OpenAI Codex + Anthropic Claude subscription credentials** for a team. Members install a local "quota guard" that, every 15 minutes, measures each source's remaining quota and — when a member's own auth is throttled or dead — borrows a healthier credential from the pool. The hub stores credentials encrypted, reports per-account quota for a dashboard, and (in `disabled_refresh_token` mode) acts as the **sole refresher** of OAuth refresh tokens to stop a multi-machine "refresh-token death spiral."

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
- **Owner / uploader** — the member whose machine first uploaded an account's auth. Tracked in `uploader_email`.
- **Borrower** — a member whose local quota is low and who fetches a replacement auth from the pool.
- **AT / RT** — OAuth **access token** (short-lived, used for API calls) / **refresh token** (long-lived, mints new ATs; rotates on use).
- **Refresh-token death spiral** — when N machines share one full credential, each refresh rotates the RT and invalidates the others' copies, cascading the whole token family to death. The motivating problem (see [§9](#9-the-disabled_refresh_token-mechanism)).
- **`disabled_refresh_token`** — the admin kill-switch flag. When ON: borrowers receive **access-token-only** blobs (RT stripped to a placeholder) and the hub becomes the **sole** RT custodian/refresher.
- **Hard-dead / hard invalidation** — an account whose RT is rejected: errors `auth invalidated (token_invalidated)`, `auth failed (401 unauthorized)`, `claude auth invalid (authentication_error)`, `claude auth email unavailable`. Needs owner re-login. (`lib/db.js:174-183`, `lib/auth-pool.js:202-212`)
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
- **Claude**: macOS is **keychain-first** (`security find-generic-password -s "Claude Code-credentials"`), file `~/.claude/.credentials.json` second; non-darwin reverses (`read_claude_oauth_credentials` `:830-850`). The keychain is the source of truth so a stale file can't shadow a live credential. Writes are keychain-first with read-back verification to avoid a known hex-corruption logout bug (`:913-950`). Claude account id = `claude-<email-lowercased>` (`:1413-1417`) — **this is where the `claude-` prefix originates** (the server derive takes `account_id` as-is).
- Quota source order for Claude: statusline snapshot first, live `/api/oauth/usage` only as fallback after a 429 backoff (`:1420-1432`).

### 3.4 Rotation decision (`source_needs_replacement` `:186-197`)
Replace when the source is hard-invalidated, OR status≠ok, OR `5h_remaining < 20%`, OR `1week_remaining < 5%`. `maybe_replace_*` then calls `/api/auth/fetch-best`. Two outcomes:
- **`repair_auth`** — the hub hands back the *owner's own* dead auth so they re-login (state `repair_auth_from_auth_pool`).
- **`replacement`** — install the better auth. If it's the same account it's an `auth_refreshed` (state `fetched_from_auth_pool`), else a true switch.

### 3.5 `disabled_refresh_token` client behavior (Phase-4 strip)
- Placeholder RTs: codex `"rt.1."+"A"*32`, claude `"disabled-by-hub-refresh-token"` (`quota_reporters.py:43-47`).
- `auth_json_is_stripped` short-circuits `sync_current_*` so AT-only auths are **never re-uploaded** (`:2000-2012, 2134-2174`).
- After a successful upload whose response says `disabled_refresh_token:true`, the client calls `strip_local_{codex,claude}_refresh_token` to overwrite its own local RT with the placeholder and records state `fetched_from_auth_pool` (`:2146-2192`). From then on it behaves like a borrower: it relies on the hub for fresh ATs.
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
| `auth_pool_quota_events` | PK `id` (uuid) | Append-only quota history; used for continuous-invalidation windows + active-reporter counts. (`:388-420`) |
| `auth_users` | PK `email` | Known members. (`:421-427`) |
| `auth_api_tokens` | PK `token_hash` | Issued tokens, **hash only**, one active per email. (`:428-435`) |
| `auth_pool_fetch_log` | PK autoinc | Audit of every pool fetch (served / repair / no-match) + requester quota. (`:436-456`) |
| `auth_pool_invalidated_notifications` | PK `(source, account_id)` | Since-when an account is hard-dead + last email sent. (`:459-468`) |
| `feature_flags` | PK `key` | `disabled_refresh_token` (stored as `"true"`/`"false"`). (`:469-476`) |
| `pool_health_snapshots` | PK autoinc | Observability time series: ok/hard-dead/other + central-refresh outcomes per source per worker run. (`:477-494`) |

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
| `/api/cron/invalidated-auth-notifications` | GET/POST | **`CRON_SECRET`** | Daily email to owners of 24h-dead auths |
| `/api/status` | any | Bearer | Dashboard dataset |
| `/api/users` | any | Bearer | Users + fetch-log audit |

`vercel.json`: only one platform cron — `/api/cron/invalidated-auth-notifications` daily at `0 17 * * *` UTC (`vercel.json:14-19`). The *probe* worker is **not** Vercel cron; it runs on GitHub Actions (CLI environment required).

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
- Mailgun for token delivery + 24h-stale-auth alerts (`:127-275`).

---

## 7. Component: Worker

Code: `scripts/probe_auth_pool_worker.mjs`, spawning `scripts/probe_{codex,claude}_auth_blob.py`. Runs on GitHub Actions cron `*/15 * * * *` + manual dispatch (`.github/workflows/probe-auth-pool.yml`). The job installs node 24, the Codex CLI, the Claude CLI, and `pexpect`, then runs the worker with Turso + encryption + Tigris secrets.

> The schedule is **best-effort**: cron `*/15` actually fires ~35 min typical with occasional 1–2 h gaps. This unreliability is a first-class design constraint (drives threshold choices, [§11](#11-token-refresh-architecture)).

### 7.1 Run loop (`main`)
1. `authPoolEntries()` → `dedupeEntriesByAccount(allEntries)` → `{canonical, stale}`. Canonical = freshest `uploaded_at` per `(source, account_id)`; rest are stale.
2. **Prune stale** duplicate sessions via `deleteAuthPoolEntryRow` (single-row, **no** account cascade — preserves account-keyed quota/notification state).
3. For each **canonical** entry: `processAuthPoolEntry(entry, {atOnlyMode})`.
4. `summarizePoolHealth(items)` → one `pool_health_snapshots` row per source.

> **Why dedupe before refresh** (`probe_auth_pool_worker.mjs` dedupe comment): multiple sessions of one account each hold an RT from a different rotation generation. Centrally refreshing more than one replays a superseded RT → the provider revokes the whole family. The worker only ever refreshes the canonical session.

### 7.2 Per-entry processing (`processAuthPoolEntry`) — the per-cycle decision
Each cycle decides, **per entry and independently**, whether to probe and whether to refresh:

- **Probe selectivity** (`probeSkipReason`): skip the cloud probe when the client already reported fresh quota (`fresh_client_quota_report`) **or** the owner re-uploaded within `PROBE_STALE_MS = 1 h` (`recently_updated`) — *unless* there's no prior report (a brand-new entry is always probed for a baseline). Skipping avoids aging a fresh token and cuts load.
- **Refresh selectivity** (`refreshEntryIfNeeded`, when `disabled_refresh_token` ON): compute `accessTokenMsUntilExpiry(authJson, source)`; refresh only if within `REFRESH_THRESHOLD_MS = 1 h` (T-1h) of expiry — **unified for claude and codex**. Refreshed tokens are written back to the pool, and the *probe sees the fresh AT*.
- **Probe** the (possibly refreshed) blob via the source-specific Python probe.
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
`lib/invalidated-auth-notifications.js` + the daily cron: an account hard-dead ≥24 h triggers one owner email (Mailgun), repeated at most every 24 h; recovery clears the state. `first_invalidated_at` is the **earliest contiguous** invalidation found by scanning the event log backward (`lib/db.js:200-241`), so a recovered-then-failed account resets the clock.

### 8.3 Blob migration
`migrate_auth_blobs_to_object_storage.mjs`: three modes (`scan` / `write-only` / `apply`). Per row it writes the envelope to Tigris, **round-trip verifies** (`readAuthBlob` must equal what was written), then in `apply` mode nulls the inline columns under an **optimistic-concurrency guard** (the UPDATE's WHERE re-checks the exact old ciphertext and `rowsAffected===1`, else throws). Backs up candidates to JSONL first.

---

## 9. The `disabled_refresh_token` mechanism

**Problem.** Rotating OAuth refresh tokens: each refresh returns a *new* RT and invalidates the old one. Share one full credential across N machines and every machine's refresh orphans the others' RTs — a cascading death spiral that empties the pool.

**Solution (flag ON).** The hub becomes the single point of refresh:
1. **Serve AT-only** — `fetch-best` strips the RT to a placeholder before serving ([§6.1](#61-fetch-best-the-borrow-path)). Borrowers can use the AT but cannot rotate the shared RT.
2. **Reject stripped-RT uploads** — the poison guard ([§6.2](#62-stripped-rt-poison-guard)) keeps the real RT in the pool intact.
3. **Owner goes AT-only too** — after uploading its real RT, the owner's guard strips its own local RT (Phase-4, [§3.5](#35-disabled_refresh_token-client-behavior-phase-4-strip)) and thereafter relies on the hub.
4. **Hub refreshes centrally** — the worker proactively refreshes near-expiry ATs ([§7.2](#72-per-entry-processing-processauthpoolentry)) and clients pull fresh ATs via `refresh_current`.

**Lifecycle of one account under the flag:**

```
owner uploads full auth ──► pool stores real RT ──► owner strips local RT (AT-only)
        │                                                      │
        ▼                                                      ▼
 borrowers fetch AT-only ◄── hub central-refresh (T-1h) ◄── worker probes + refreshes
        │                                                      │
   AT near expiry ──► refresh_current ──► hub serves fresh AT ─┘
        │
   RT truly dead (revoked elsewhere) ──► hard-dead ──► repair-handback ──► owner re-login
```

**Safety properties.** Because borrowers can't refresh, they can't cause cascade. The unique *new* risk is many machines sharing one AT → provider abuse pushback; this is monitored separately ([§8.1](#81-assess_healthmjs), abuse-class scan). Observed data: 0 abuse-class errors; all failures are RT-class.

The flag defaults OFF (`getFeatureFlag("disabled_refresh_token", false)`), so deploys are inert until an admin flips it on the dashboard.

---

## 10. Selection algorithm (`pickBestAuthPoolCandidate`, `lib/auth-pool.js:260-312`)

For a borrow request, candidates are filtered then ranked:

**Eligibility** (`:273-280`): same source; not excluded (incl. `current_account_id`); not `Free` plan and not hard-invalidated; report fresh (`reported_at` within `max_report_age_seconds`, default 3600 s); meets a share threshold (5h ≥ 20%, weekly ≥ 5%); and **beats current** — candidate's `5h × weekly` product must exceed the requester's.

**Ranking** (`:282-301`): primary key is `projectedWeightedLoad` ascending — a fairness/load score combining a **deterministic exponential jitter** seeded by `selection_key:source:account_id` (stable per requester, spreads load) and a recent-served penalty; ties broken by quota weight, then raw 5h, then weekly, then recency. This balances *give the borrower good quota* against *don't stampede one account*.

---

## 11. Token-refresh architecture

`lib/token-refresh.js` is the server-side refresher (hub is sole refresher under the flag):
- **Endpoints**: Claude `platform.claude.com/v1/oauth/token` (client `9d1c…`, scope `user:inference`); Codex `auth.openai.com/oauth/token` (client `app_EMoam…`, no scope) (`:5-10`).
- **Classification** (`postRefresh` `:12-39`): HTTP 400/401 → `auth_rejected` (RT dead, owner must re-login); anything else (network, 5xx, 200-without-token) → transient.
- **`applyRefreshToBlob`**: per-source field updates that preserve unrelated sections (e.g. claude `mcpOAuth`); sets `expiresAt`/`last_refresh`.
- **`accessTokenMsUntilExpiry`** — the crux of selectivity:
  - **Claude**: `credentials.claudeAiOauth.expiresAt` (real, AT ~8 h).
  - **Codex**: decode the **access_token JWT** `exp` (real ~**10-day** lifetime), falling back to the `id_token` JWT (~1 h, identity only) **only** if the access_token isn't a decodable JWT (`:105-122`).

**Why one T-1h threshold for both** (today's unification): the worker decides which accounts to refresh each cycle by comparing `accessTokenMsUntilExpiry` to `REFRESH_THRESHOLD_MS = 1 h`. Codex's 10-day AT means proactive refresh almost never fires on a healthy codex account (it's effectively claude-driven), but unifying the code path removes per-source special-casing. The threshold is sized against the worst worker gap (~110 min); the backstops for a missed window are owner re-upload + the `refresh_current` AT-freshness fallback.

> **Historical pitfall (encoded in tests + memory):** codex AT lifetime was once misread from the id_token (~1 h), producing a wrong "codex AT dies hourly" analysis. The fix reads the access_token JWT. See `memory/codex-access-token-lifetime.md`.

---

## 12. Observability

- **`pool_health_snapshots`** — one row per source per worker run: `total, ok_count, hard_dead_count, other_err_count, central_refresh_{attempted,ok,rejected}`.
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

---

## 15. End-to-end flow recap

**Onboard:** `login.html` → `/api/auth/issue-token` → emailed `qrp.` token → installer writes config + schedules the guard.

**Steady state (per machine, every 15 min):** probe local quota → if local auth changed, upload to pool (digest-gated) → publish quota snapshot → if quota low or dead, `fetch-best` → install replacement/refresh, or get own dead auth handed back for re-login.

**Steady state (hub, every ~15–35 min):** dedupe pool to one entry per account → prune stale sessions → for each account: skip-probe-if-fresh, central-refresh-if-near-expiry (T-1h, both sources, only under the flag), cloud-probe, delete-if-unusable, write quota → record a health snapshot.

**Daily:** notify owners of auths hard-dead ≥24 h.

**Admin:** flip `disabled_refresh_token` on the dashboard to switch the whole pool between full-credential distribution and hub-sole-refresher AT-only distribution.
