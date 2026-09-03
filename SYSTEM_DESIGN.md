# System Design — quota-report-hub

> **Scope.** This document is the technical "how it's built" companion to [`PRODUCT_DESIGN.md`](PRODUCT_DESIGN.md) (the "why/what"). It records the behaviour of every component and the reasoning behind the load-bearing decisions, and cites `file:line` for claims worth checking. Where behaviour is subtle or surprising, it is called out explicitly (see [§14 Sharp Edges](#14-sharp-edges--known-issues)).
>
> **This is the reference for all development in this repo** ([`AGENTS.md`](AGENTS.md)). Read the
> section covering the area you are about to change *before* changing it, and update this document
> in the same commit as any change to behaviour it describes. A section that no longer matches the
> code is worse than a missing one: the whole point is that a reader can trust it without re-deriving
> it from 20k lines. `file:line` citations drift as code moves — treat the surrounding prose as the
> claim and the citation as a hint.
>
> Last full reconciliation with the code: **2026-08-27**.

## Contents

| § | Section |
|---|---|
| [1](#1-what-the-system-is) | What the system is — the four tiers and the diagram |
| [2](#2-glossary) | Glossary |
| [3](#3-component-local-client-quota-guard) | Local client (the quota guard) |
| [4](#4-data-model) | Data model — Turso tables, Tigris blobs |
| [5](#5-encryption--storage-layering) | Encryption and storage layering |
| [6](#6-component-serverless-api) | Serverless API — endpoints, fetch-best, identity, availability, data router, ingest |
| [7](#7-component-worker) | Worker — probe/refresh loop |
| [8](#8-ops-scripts) | Ops scripts |
| [9](#9-the-disabled_refresh_token-mechanism) | The `disabled_refresh_token` mechanism |
| [9b](#9b-the-premium-share-gate-libpremium-ratiojs) | Fetch policy: reporting, demand share, supply, scarcity, phases |
| [10](#10-selection-algorithm) | Selection algorithm |
| [11](#11-token-refresh-architecture) | Token-refresh architecture |
| [12](#12-observability) | Observability |
| [13](#13-configuration) | Configuration |
| [14](#14-sharp-edges--known-issues) | Sharp edges and known issues |
| [15](#15-end-to-end-flow-recap) | End-to-end flow recap |
| [16](#16-token-usage-pipeline) | Token usage pipeline (collector → ingest → query → retention) |
| [17](#17-repo-layout-tests-and-deploy) | Repo layout, tests, deploy |

---

## 1. What the system is

`quota-report-hub` runs a **shared, encrypted pool of OpenAI Codex + Anthropic Claude subscription credentials** for a team. Members install a local "quota guard" that, every 15 minutes, measures each source's remaining quota and — when a member's own auth is throttled or dead — borrows a healthier credential from the pool. The hub stores credentials encrypted, reports per-account quota for a dashboard, and (in `disabled_refresh_token` mode) acts as the **sole refresher** of OAuth refresh tokens to stop a multi-machine "refresh-token death spiral."

### Token usage read model

Token analytics is an isolated read model, not part of auth selection or quota availability. Each local installation owns a private SQLite checkpoint database at `~/.agents/auth/token-usage.sqlite3` (`0600`). The first collector run fixes a 72-hour backfill cutoff. Subsequent runs discover only changed JSONL files and resume at acknowledged byte positions, with a 10-second cycle budget and a maximum of 400 aggregate rows per batch. A pending upload and its proposed file/counter/fingerprint checkpoint are committed locally only after server acknowledgement; retries reuse the same batch.

Vercel Functions run in `pdx1` (AWS `us-west-2`) so database-backed requests execute in the same cloud region as the Turso primary. Static HTML remains CDN-served near the browser; keeping compute and data together avoids a cross-country database round trip on every dashboard query.

Read-only token analytics requests do not run schema creation or migrations on serverless cold starts. Schema work remains on initialization/write paths, and API-token lookup plus its `last_used_at` touch share one database batch before the bounded analytics query batch.

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
5. **Sync to pool** (only if configured) — `sync_current_{codex,claude}_auth_pool` (digest-gated upload) + `report_current_quota_to_auth_pool`, which always sends a **probe heartbeat** and attaches the quota payload only when the hub would accept it (see 3.7).
6. **Rotate** — `maybe_replace_{codex,claude}_auth` (`:1559-1588`).
7. **Codex app-server restart** if auth changed (`:1589-1609`).
8. **Notifications** (toasts) unless `--no-toast`.

### 3.3 Reading/writing local auth (`quota_reporters.py`)
- **Codex**: `~/.codex/auth.json`. Account id is **canonicalized to the lowercased email** (`canonical_codex_account_id` `:175-179`) so Team users sharing a provider UUID don't collide. Probe runs `codex exec` in an isolated temp `CODEX_HOME` with an **env blocklist** (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_ACCESS_TOKEN`, …) so an ambient key can't mislabel another provider's quota (`:396-424`).
- **Claude**: modern macOS Claude Code stores the active OAuth credential in Claude's encrypted `oauth:tokenCacheV2`; older builds may still use the direct `"Claude Code-credentials"` keychain item, and non-darwin uses `~/.claude/.credentials.json`. `read_claude_oauth_credentials` prefers tokenCacheV2 on macOS so stale files or MCP-only keychain entries cannot shadow the live credential. Writes go back to the same source when possible. Claude account id = `claude-<email-lowercased>` — **this is where the `claude-` prefix originates** (the server derive takes `account_id` as-is).
- Quota source order for Claude: statusline snapshot first, live `/api/oauth/usage` only as fallback after a 429 backoff (`:1420-1432`).

### 3.4 Rotation decision (`source_needs_replacement` `:186-197`)
Replace when the source is hard-invalidated. Neither `maybe_replace_*` gates the fetch on a healthy probe: a hub-fetched credential is AT-only ([§9](#9-the-disabled_refresh_token-mechanism)), so a machine whose access token died cannot refresh its own way out and a failed probe is exactly when the fetch matters most. Claude used to carry such a gate (`missing_stable_claude_auth`) and every hard-invalidated Claude state was therefore unrecoverable until a human re-logged in. A probe that failed without reaching a verdict on the credential (no binary, a timeout) still fetches nothing — `probe_unavailable` — because it is no evidence the account is unhealthy. `claude auth status` exits nonzero exactly when it is logged out and still prints its JSON, so that exit is parsed into the one `CLAUDE_LOGGED_OUT_ERROR` value `is_hard_invalidated` matches, not an opaque command failure. Quota-based replacement uses `5h_remaining < 20%` or `1week_remaining < 5%` for both sources, judged per window the probe actually reported: Plus-tier Codex accounts still meter a 5-hour window and are held to the 20% threshold, while Codex tiers without a 5-hour limit report no `5h` window and are judged on `1week` alone. (This corrects an earlier claim that Codex `5h` was legacy metadata — that was true only of the higher tiers, and treating it as universal let a Plus account run its 5-hour window to zero without rotating.) `maybe_replace_*` then calls `/api/auth/fetch-best`. Two outcomes:
- **`repair_auth`** — the hub hands the dead auth back to its latest uploader so they re-login (state `repair_auth_from_auth_pool`).
- **`replacement`** — install the better auth. If it's the same account it's an `auth_refreshed` (state `fetched_from_auth_pool`), else a true switch.

### 3.5 `disabled_refresh_token` client behavior (Phase-4 strip)
- Placeholder RTs: codex `"rt.1."+"A"*32`, claude `"disabled-by-hub-refresh-token"` (`quota_reporters.py:43-47`).
- `auth_json_is_stripped` short-circuits `sync_current_*` so AT-only auths are **never re-uploaded** (`:2000-2012, 2134-2174`).
- **Both sources install first and strip second.** For codex the payoff is different from claude's:
  the verification refresh mints a new access_token *and* a new ~1-hour `id_token`, and the codex CLI
  times its own refresh off the **id_token**, not the access_token ([§11](#11-token-refresh-architecture)).
  An AT-only codex client left holding its pre-upload id_token starts failing its own refresh within
  the hour even though its access token is good for days. Note the codex strip then reports
  `already_stripped` — the installed blob is AT-only already — so the `fetched_from_auth_pool`
  transition treats that as success; gating it on `stripped:true` alone would strand the machine in
  `owner_local`, where the near-expiry refresh never runs.
- After a successful upload whose response says `disabled_refresh_token:true`, the claude client
  **installs first and strips second**. Verifying the upload means refreshing it, which revokes the
  access token this machine is still running on ([§11](#11-token-refresh-architecture)), so the
  response carries `refreshed_auth_json` (AT-only) and `install_uploaded_claude_refresh` installs it
  before `strip_local_claude_refresh_token` runs. Only then is state recorded as
  `fetched_from_auth_pool`. Stripping first is what used to leave a machine holding a revoked AT and
  a placeholder RT: unable to work and unable to refresh its way out.
- **Interlock**: if no working AT is in hand — an older hub returned nothing, or the install was
  shadowed — the strip is **withheld** (`strip_withheld_no_working_at`) and the real RT is kept for
  the next cycle. A machine that can still refresh is recoverable; one that cannot is not. This also
  means hub and clients can roll out in either order.
- Claude strip writes the placeholder to **every inference-capable grant** in each local store that can
  shadow the hub (macOS tokenCacheV2/tokenCache, keychain, an existing `.credentials.json`), not just
  the highest-scored cache entry — the cache holds one entry per scope set, and an unstripped sibling
  is still a rotatable RT. `claude_stores_with_real_refresh_token` then **reads back**: `stripped`
  means verified AT-only, not "a write returned true". If the active Claude auth is already AT-only,
  the guard still runs this backup-store cleanup while continuing to skip uploads.
- **Installing must reach the token cache.** `read_claude_oauth_credentials` prefers Claude.app's
  encrypted token cache on darwin, so a keychain-or-file write is silently shadowed by it.
  `install_claude_credentials` writes cache, keychain and file, reads back, and reports
  `shadowed_by_<store>` when the install did not take. Before this the guard wrote that cache in
  **zero** places and every fetched or replacement AT was discarded on arrival while the code
  reported success.
- **Restarting Claude.app when it is idle** (`restart_claude_app_if_idle`, opt-in via
  `restart_claude_app_when_idle`). A strip only rewrites the stores; the running app keeps its
  refresh token in memory and writes it back later — measured 2026-08-29, the stores stayed clean for
  2h52m and then the app restored a real RT and re-minted from it. Nothing on disk prevents that, and
  unlike codex there is no `app-server daemon restart` that could spare hosted sessions, so the only
  safe moment is when it is hosting none. Session detection counts the versioned session binary under
  Application Support and skips the `Helpers/disclaimer` wrapper that repeats the same path; it must
  not isolate the executable by splitting on whitespace, because those paths contain spaces and doing
  so matched nothing, reported zero sessions, and let a restart fire with five live. The call refuses
  on absence of evidence — an unreadable process list, or a strip that has not landed yet — never
  only on evidence of absence.
- **Refresh on demand, not on a clock.** Every refresh spends a single-use token and revokes the
  access tokens already issued for that grant, so a timer pays that cost on every tick whether or not
  anything is wrong. A 401 is the one signal that is never a false alarm and arrives exactly when
  renewal is worth its cost. Measured for codex: an id_token 6 minutes past expiry still completed a
  real `codex exec` inference (rc=0, 10,870 tokens billed), so even its hourly cadence exceeds what
  the evidence requires — left as-is only because it is harmless there
  ([`AUTH_TOKENS.md` §3.6](AUTH_TOKENS.md)).
- **Proactive same-account refresh**: `fetched_auth_near_expiry` returns true when state is `fetched_from_auth_pool` and the local AT is within `AT_NEAR_EXPIRY_SKEW_SECONDS = 20 min` of expiry; the guard then calls `fetch-best` with `refresh_current=True` to mint a fresh AT for the *same* account before the dead placeholder RT is ever needed (`:2017-2060`).
  The deferral that protects a healthy account from being swapped onto a borrowed one
  (`kept_current_refresh_deferred`) is lifted by `current_auth_cannot_wait` once the token has been
  refused or has under one guard cycle of life: it is only defensible while the current credential
  still works, and deferring past that point trades churn for an outage.
  ⚠️ This trigger reads `expiresAt`, which is an upper bound rather than a lifetime
  ([§11](#11-token-refresh-architecture)) — it cannot see a revocation. The backstop is the rejection
  path: an AT-only client whose probe 401s reports
  `claude access token rejected (at-only; hub holds the RT)`, `needs_fresh_access_token` routes it to
  the same `refresh_current` fetch, and it is **not** hard invalidation. A client holding only a
  placeholder RT cannot distinguish a dead credential from a refused request, so it does not get to
  declare the account dead — only `auth_rejected`, where a real RT was presented and refused, does
  that ([`AUTH_TOKENS.md` §6](AUTH_TOKENS.md)).

### 3.6 Token handling
- One personal **auth-pool user token** (issued per company email) is the Bearer for all hub calls and also unlocks the dashboard.
- **In-band token upgrade**: every hub response is run through `persist_auth_pool_token_upgrade` — if the body carries a new `auth_pool_user_token`, it's written back to config (0600) and redacted from memory (`:1638-1672`).
- On a `token_invalidated` body, `request_auth_pool_token_email_once` re-issues an emailed token at most once per (email, token-digest) (`:1675-1766`).

### 3.7 Probe heartbeat (why a failing guard is not silence)
A quota report only reaches the hub when the probe produced a payload the hub accepts (`lib/quota-ingest.js`). Every other outcome — a network failure reaching `auth.openai.com`, a rate-limited probe whose exhaustion could not be confirmed, a missing reset time — produces a `status="error"` payload with empty windows that is **not** reported. Before the heartbeat that meant a guard running every 15 minutes and failing every time was indistinguishable, from the hub's side, from a machine that was switched off. It also meant no rotation: `source_needs_replacement` returns False for a non-hard-invalidated error, so the run was treated as healthy (3.4).

So every run now posts to `/api/auth/quota` regardless of probe outcome:
- `quota_payload` — present only when `quota_payload_is_reportable` says the hub would accept it (mirrors `codexClientPayloadAccepted`, so no request is wasted on a payload that would be discarded).
- `heartbeat` — always. Carries reporter name, hostname, `status` (`ok`/`error`), the probe error, the account in use, and `client_version`. A probe that produced no usable quota counts as `error` here even when it did not raise.

The hub stores one row per (source, reporter) in `reporter_probe_heartbeats`, accumulating `consecutive_failures` and preserving `last_ok_at`. `lib/reporter-health.js` derives the state the dashboard shows: **silent** (no heartbeat for over an hour — off, asleep, or the scheduled job stopped), **probe failing** (≥2 consecutive failures), **probe error** (a single failure), or **ok**. Silence outranks a stale failure.

Locally, `notify_probe_failures` toasts the machine's owner after `PROBE_FAILURE_NOTIFY_THRESHOLD = 3` consecutive failures (~45 minutes of a guard that is alive but blind), repeats at most every 6h, and toasts once on recovery.

Note what the heartbeat does **not** change: a failing probe still does not rotate. It makes the condition visible; whether "codex is rate-limiting me but I could not confirm exhaustion" should itself trigger a replacement is a separate policy decision (3.4).

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
| `reporter_probe_heartbeats` | PK `(source, reporter_key)` | Last guard run per machine: outcome, consecutive probe failures, last good probe. Written on every run, including runs with no reportable quota — this is what separates a silent machine from a failing probe ([§3.7](#37-probe-heartbeat-why-a-failing-guard-is-not-silence)). |
| `dashboard_revision` | Singleton row (`singleton = 1`) | Monotonic change marker for dashboard-visible writes. The browser reads this one row instead of rebuilding full status every minute. |

**PK evolution** (`migrateAuthPoolEntriesTableShape` `:23-81`): older deployments are rebuilt to the canonical `(source, account_id, session_id)` PK with **nullable** encryption columns + `auth_blob_key`. The active PK column list lives in a mutable global `authPoolPkColumns` used to build `ON CONFLICT(...)` (`:21, 80, 734`).

### 4.2 Tigris object storage, `lib/auth-blob-storage.js`
- Configured when the Tigris triplet (or a local `AUTH_BLOB_STORAGE_DIR`) is set (`:8-18`).
- Key layout: `auth-pool/<source>/<accountId>/<sessionId|default>/<digest>.json`, each part URL-encoded (`:24-32`).
- Stores the same `{encrypted_auth_json, iv, auth_tag}` GCM envelope the DB would have held inline.

**Live state (verified 2026-06-14, unchanged since):** all entries are on object storage, none inline — migration complete (see `scripts/migrate_auth_blobs_to_object_storage.mjs`, [§8.3](#83-blob-migration)). The DB row keeps only metadata + `auth_blob_key`; the worker fetches+decrypts the blob only at the moment it actually probes/refreshes, so **storage location is orthogonal to the probe/refresh logic**.

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
| `/api/token-usage` | POST | Bearer | Ingest one receipt-gated usage batch ([§16](#16-token-usage-pipeline)) |
| `/api/token-usage-query` | GET | Bearer | Bounded usage read model: totals, trend, breakdown, reporter freshness |
| `/api/cron/token-usage-retention` | GET/POST | **`CRON_SECRET`** | Daily compaction of 15-minute detail into `token_usage_daily` |
| `/api/users` | any | Bearer | Users + fetch-log audit |

The last four are not separate functions: they are `vercel.json` rewrites onto `/api/data?route=…`
([§6.5](#65-the-data-router-apidatajs)).

`vercel.json` pins all functions to `pdx1` (same region as the Turso primary, [§1](#1-what-the-system-is)),
gives the five heavy handlers `maxDuration: 30`, and runs two platform crons: invalidated-auth
notifications at `0 17 * * *` UTC and token-usage retention at `30 18 * * *` UTC. Vercel Hobby does
not support 15-minute cron jobs, so the *probe* worker stays in GitHub Actions;
`/api/cron/probe-auth-pool` remains available for manual or external stale-snapshot dispatch when
called with `CRON_SECRET`.

### 6.1 fetch-best (the borrow path)

Code: `api/auth/fetch-best.js`.
Three branches, in order:
1. **Policy gate** ([§9b](#9b-the-premium-share-gate-libpremium-ratiojs)): refusals for an outdated reporter, unreported consumption, an over-fair-share user during scarcity, or a non-contributor during scarcity. All are cooldowns or fixable states, never lockouts, and the `repair_auth` handback stays open through all of them.
2. **`refresh_current` mode** (`:93-142`): when `refresh_current && current_account_id`, fetch the same account's pooled blob and only return it if its AT is genuinely fresh (`accessTokenMsUntilExpiry === null || > 5 min`); otherwise fall through to a normal replacement (so an owner can't dead-lock on its own stale copy).
3. **Normal replacement**: `bestAuthPoolEntry(...)` → `pickBestAuthPoolCandidate` ([§10](#10-selection-algorithm)). `selection_key` mixes email/requester/IP for stable selection. On a hit, `recordAuthPoolFetch(reason:"served")`.
4. **Empty pool**: selection found nothing. A caller who supplies the pool gets `no_better_auth_available`; one who does not gets their own invalidated auth back to re-login (`repair_returned`) or a `pool_empty` notice, logged as `no_uploaded_auth`. This branch refuses nobody — there was nothing to serve either way — so it carries no rule, only the explanation. Rationing non-contributors happens in branch 1, while there is still something to ration.

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

### 6.5 The data router (`api/data.js`)

Four endpoints share one function. `routeDataRequest` reads `?route=` (set by the `vercel.json`
rewrites, so callers still use the clean paths), looks the handler up in a fixed map, strips the
`route` parameter back off `req.url` so each handler parses its own query normally, and 404s an
unknown route. The handlers themselves live in `lib/data-api.js` and take an injectable `deps`
object — that is what lets the API tests drive them without a database or a clock.

Why one function: Vercel's plan caps the number of deployed functions, and these four are the
cheapest to co-locate (three are read-only or cron, none is on the auth hot path). The cost is that
they share a cold start and a `maxDuration`.

Each handler enforces its own method (`405` with an `Allow` header), its own auth (Bearer for
ingest/query, `CRON_SECRET` for retention), and its own error mapping: `TokenUsageValidationError`
→ its `statusCode` (default 400), a duplicate batch id with a different payload → **409**
`token_usage_batch_conflict`, an unbounded query → **422** `query_too_broad`, anything else →
`sendServiceUnavailable` (503, internals never echoed).

### 6.6 Quota ingest and report merge

Two modules decide what a quota report means, and both are shared by every writer so the rules
cannot drift between the client path and the worker path.

**`lib/quota-ingest.js` — acceptance.** `ingestClientQuota` stamps `report_origin:"client"` and a
reporter identity, then applies one gate: `codexClientPayloadAccepted` requires a *complete* weekly
window (`remaining_percent` **and** `reset_at`) or a hard invalidation. Codex has no live 5-hour
window any more, so weekly completeness is the whole test; Claude reports are not gated here. An
unacceptable payload is not an error — it returns `{ok:true, ignored:true}` and the caller decides
the HTTP status. This is the same predicate the guard mirrors locally as
`quota_payload_is_reportable`, so a report that would be discarded is never sent
([§3.7](#37-probe-heartbeat-why-a-failing-guard-is-not-silence)).

`ingestReporterHeartbeat` is deliberately far cheaper to satisfy: a heartbeat carries no quota
numbers, so there is nothing to validate and nothing it can corrupt. The only hard requirement is a
reporter identity, and the error string is truncated to 500 characters.

**`lib/reports.js` — sanitize, merge, present.** `sanitizeReport` normalizes an incoming report
(sources, statuses, window shapes, timestamps, `captured_at` per window). `mergeLatestReport` is the
one that carries the sharp rules:

- A hard invalidation that is **older** than a stored report with complete windows is dropped — a
  late-arriving failure must not bury fresher good evidence.
- A hard invalidation or an ineligible plan keeps the previous windows as *stale* evidence
  (`windows_stale`) instead of blanking the account, so the dashboard can still show what was last
  true.
- Otherwise the newer report wins per window, and each window keeps its own `captured_at`, which is
  never overwritten by a newer row-level `reported_at`
  ([§6.4](#64-availability-read-model-and-lazy-history)).

`statusPayload` / `authPoolStatusPayload` assemble the dashboard dataset from entries, reports and
invalidation state; `lib/account-availability.js` then reduces each account to the single lifecycle
state the table renders.

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

### 7.2 Per-entry processing (`processAuthPoolEntry`)
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

### 8.4 check_reporter_uptake.mjs
Answers one question before the reporter gate's phase date fires: *who would it refuse right now?*
It reads `client_version` from `auth_pool_user_fetch_stats` — **not** `token_usage_reporter_state`,
which only ever sees clients that already report usage and therefore excludes exactly the population
at risk ([§9b](#9b-the-premium-share-gate-libpremium-ratiojs)).

### 8.5 purge_contaminated_usage.py
Removes usage buckets recording physically impossible volumes (the compaction-as-reset bug in old
collectors re-emitted whole session cumulatives as fresh usage; one pass removed 79 rows holding 86%
of all recorded volume). Backs up before deleting, supports `--dry-run`, and talks to Turso over its
HTTP API rather than `@libsql/client` because this host resolves the Turso name into Tailscale's
intercepted range, which curl and urllib traverse but node's TLS stack does not.

### 8.6 deploy_vercel.py / start_frontend.mjs
`deploy_vercel.py` wraps the Vercel CLI for production/preview/development deploys and env
management. `start_frontend.mjs` serves the static dashboards locally on `FRONTEND_PORT`
(default 6088, `127.0.0.1` only).

---

## 9. The `disabled_refresh_token` mechanism

**Problem.** Rotating OAuth refresh tokens: each refresh returns a *new* RT and invalidates the old one. Share one full credential across N machines and every machine's refresh orphans the others' RTs — a cascading death spiral that empties the pool.

**And a second, sharper edge:** a refresh also **revokes the access tokens already issued** for that grant ([§11](#11-token-refresh-architecture)). So refreshing does not merely orphan other custodians' *refresh* tokens at some future point — it kills whatever they are using **right now**. Any component that refreshes owes the new AT to everyone still holding the old one, in the same operation.

**Solution (flag ON).** The hub becomes the single point of refresh:
1. **Serve AT-only** — `fetch-best` strips the RT to a placeholder before serving ([§6.1](#61-fetch-best-the-borrow-path)). Borrowers can use the AT but cannot rotate the shared RT.
2. **Reject stripped-RT uploads** — the poison guard ([§6.2](#62-stripped-rt-poison-guard)) keeps the real RT in the pool intact.
3. **Uploads are verified by probing, not by refreshing (claude).** A refresh proves the refresh
   token works but revokes the access tokens already issued, so verifying an upload destroyed what
   the uploader was using and drove it to re-mint — the loop in
   [`AUTH_TOKENS.md` §6](AUTH_TOKENS.md). `probeClaudeAccessToken` asks the profile endpoint instead:
   a live access token is itself evidence the refresh token is unspent, since only a refresh could
   have spent it and that would have killed the access token. The response sets
   `local_auth_untouched` and the client strips immediately. The gap this leaves — a session revoked
   out-of-band kills refresh tokens while issued access tokens live on — costs borrowers nothing,
   because they consume access tokens; the dead refresh token surfaces at the first renewal that
   needs it. Codex still verifies by refreshing.
4. **Uploader goes AT-only too** — the upload response carries `refreshed_auth_json` (the AT the hub's verification refresh just minted, RT stripped); the client installs that, *then* strips its own local RT (Phase-4, [§3.5](#35-disabled_refresh_token-client-behavior-phase-4-strip)), and thereafter relies on the hub. Without the handback the verification refresh would revoke the uploader's own access token and the strip would remove its only way back.
5. **Hub refreshes centrally** — the worker proactively refreshes near-expiry ATs ([§7.2](#72-per-entry-processing-processauthpoolentry)) and clients pull fresh ATs via `refresh_current`.

**Lifecycle of one account under the flag:**

```
client uploads full auth
      │
      ▼
hub verifies it by REFRESHING  ──►  pool stores the new real RT
      │   (this revokes the access token the uploader is still using)
      ▼
response carries refreshed_auth_json (AT-only)
      │
      ▼
client INSTALLS it  ──►  then strips its local RT  ──►  state = fetched_from_auth_pool
      │                       │
      │                       └─ no working AT in hand ──► strip WITHHELD, real RT kept for next cycle
      ▼
    ┌─────────────────────── steady state, AT-only ───────────────────────┐
    │                                                                     │
    │  worker probes + central-refreshes (T-1h) ──► borrowers fetch AT-only│
    │                                                                     │
    │  local AT near expiry ──► refresh_current ──► hub serves a fresh AT  │
    │  local AT revoked early ──► probe fails ──► source_needs_replacement │
    └─────────────────────────────────────────────────────────────────────┘
      │
      ▼
RT truly dead (revoked elsewhere) ──► hard-dead ──► repair-handback ──► latest uploader re-login
```

**Who may declare the pooled credential dead.** Only the worker ever presents the pooled refresh
token, so only its `central_refresh.auth_rejected` is evidence about the blob the pool hands out. A
client's healthy probe describes the credential on *that machine*, which may never have been
uploaded. `mergeLatestReport` therefore keeps a standing central-refresh rejection until something
proves the pooled blob itself works — a verified upload (`token_refresh.source === "upload"`) or a
successful central refresh. Symmetrically, an AT-only client's 401 is not allowed to declare death
either ([§3.5](#35-disabled_refresh_token-client-behavior-phase-4-strip)): it holds a placeholder RT
and has nothing to present. Evidence follows whoever holds the refresh token.

**Safety properties.** Because borrowers can't refresh, they can't cause cascade. The unique *new* risk is many machines sharing one AT → provider abuse pushback; this is monitored separately ([§8.1](#81-assess_healthmjs), abuse-class scan). Observed data: 0 abuse-class errors; all failures are RT-class.

The flag defaults OFF (`getFeatureFlag("disabled_refresh_token", false)`), so deploys are inert until an admin flips it on the dashboard.

---

## 9b. The premium-share gate (`lib/premium-ratio.js`)

### Why a share and not a volume cap

Users solve a problem inside one conversation, so every turn replays the whole context. Measured on
the pool, `gpt-5.6-sol` carries 26.2B raw tokens against 787.6M fresh ones: **33 replayed tokens per
new token**. That ratio is a mechanical consequence of not throwing the context away, not a choice —
capping absolute volume would penalise finishing a task, and the workaround it teaches (start a new
session, lose the context, redo the work) costs more than it saves.

Model selection *is* a choice, made fresh on every turn. So the hub caps the share of a user's usage
that goes to premium models, and leaves absolute volume unlimited.

### The metric

`modelCost(modelId, counters)` (`lib/model-tiers.js`) prices usage from a per-model **rate card**
rather than counting tokens: fresh input (`input_tokens − cache_read_tokens`), cache reads, cache
writes and output are each charged at their own per-million rate. `modelCostSql()` — exported as
`MODEL_COST_SQL` — is the SQL twin of that arithmetic, kept so the gate and any dashboard cannot
drift. `premiumShare({ premiumCost, totalCost })` is then simply `premiumCost / totalCost`.

Unknown ids are still priced by family prefix (`gpt-`, `claude-`, `codex-` fall back to a
representative model's card). Only something with no card at all returns `null`, so callers can tell
"the pool does not pay for this" from "priced at zero".

`PREMIUM_MODEL_IDS` is a **blacklist**, not an allow-list of cheap models, so an unrecognised id is
**not** premium. That is deliberate now that the list only drives a notice and never a refusal: a
miss costs one missing hint instead of a wrongly throttled user. **Cost, not membership, decides who
gets held back.**

### Where the gate sits

`api/auth/fetch-best.js` consults it before **both** fetch paths. 82% of pool traffic is
`refresh_current`, so a gate covering only account switches would leave the subsidy that actually
matters — the hub keeping one account's access token alive indefinitely — untouched.

The `repair_auth` path stays open even while gated: it hands back the caller's own invalidated auth
so they can re-login, borrows nothing from the pool, and locking someone out of fixing their own
credentials would make the gate inescapable.

### Cooldown, not a block

Over the threshold, a user may fetch once every `PREMIUM_RATIO_COOLDOWN_MINUTES`. One flat duration,
no per-path or per-severity multipliers: severity is already encoded in how long a user stays above
the line, and a second dial would only make the rule harder to reason about. A refused attempt does
not restart the clock — `last_served_at` advances only on `served` / `refreshed_current`.

Measured re-fetch intervals make this bite where it should: the heaviest users return every 5–15
minutes (they hold AT-only credentials under `disabled_refresh_token` and must keep coming back),
while light users rarely notice.

### Reporter gate: version travels with the request

The gate reads `client_version` off the fetch-best request body, **not** from the last usage batch.
Two traps this avoids:

- A fresh install's first act is to fetch auth, before it has any usage to report. Inferring the
  version from usage history would leave it permanently unrecognised and permanently refused.
- The collector only posts when there IS usage, so "no recent report" is indistinguishable from "took
  the afternoon off". Refusing on report silence would deadlock anyone back from leave: no auth means
  no usage, and no usage means no report to lift the refusal with.

Report silence therefore only ever produces a *notice*. Only an outdated (or absent) request version
produces a refusal, and the fix — letting `self_update_skill()` run — is available whether or not the
hub is serving that user.

### What usage costs, and who gets held back

Usage is priced from the vendors' public rate cards (`lib/model-tiers.js`), not from a hand-tuned
weighting. Only the RATIOS matter: the pool runs on subscriptions, but OpenAI's own price-cut notice
says the Terra/Luna reductions "are also reflected in how usage is counted against paid
subscriptions when using Codex and ChatGPT Work" -- subscription credit burn tracks API pricing.
Standard rates only; Sol's >20% discount expires around November 2026 and a long-lived rationing
mechanism must not drift with a three-month promotion.

The previous formula weighted output at 1x input. Every rate card puts it at **5-6x**, so output was
systematically under-counted -- and that error had a direction: it under-weighted agent fleets and
over-weighted long-context replay, the exact opposite of what the mechanism is for.

A model the pool does not pay for -- somebody's own DeepSeek key, a self-hosted Qwen -- costs zero
and adds nothing to demand. That is the point, not a loophole: moving work off the pool is the
behaviour rationing exists to encourage. Unrecognised models *within* a pooled family
(`gpt-`, `claude-`, `codex-`) are charged that family's top rate, so a new flagship cannot read as
free before somebody prices it.

**Premium share only ever advises.** It is a proxy for "you are expensive", and once usage is priced
there is no reason to enforce a proxy instead of the thing itself -- a user at 90% premium on a tiny
volume costs the pool nothing. The list is now a blacklist: missing from it costs a hint, not a
refusal. What the share is still good for is naming the one concrete action that makes somebody
cheaper.

**Refusal targets the real failure**, and needs both halves:

1. the pool is projected to run dry (see scarcity, below), **and**
2. this user's share of total team spend exceeds the average, `1 / active_users`

Either alone is not worth throttling anyone over: a shortage nobody is driving needs more accounts,
not less work, and a heavy user during abundance is just somebody getting their job done. A share of
team demand needs no threshold in dollars and rescales itself as the team and pool change size.

The line is simply the average: when quota has run out, everyone above average yields. A wider
tolerance was tried and bought nothing -- spend is steep enough that 1.0 and 2.5 selected the same
three people, so the wider line only moved the threshold into an empty stretch while being harder to
explain. One guard remains: **at least two active users**, because fair share presupposes somebody
to be fair to. A sole consumer holds nobody back, so throttling them frees capacity for no one.

Measured on 2026-08-26 across 17 active users (line at 5.9%): it holds shawn.hou at 46.0%, derek at
29.3%, and solutions at 14.7%; the next user down is at 3.3% and nobody else is close.

The cooldown throttles how often somebody may draw on the pool; it does not stop them working. Its
upper bound is the codex id_token, which goes stale about an hour after issue -- past that a held
user cannot refresh at all and stops outright, turning a rate limit into an outage. Thirty minutes
leaves a full margin under that, while cutting the heaviest users from a fetch every five minutes to
one every thirty.

### Scarcity: the cooldown only bites when there is something to ration

Throttling during abundance is pure friction -- nobody gains from slowing a heavy user while there is
quota to spare. `lib/pool-scarcity.js` decides whether the pool is on track to run dry, and the
premium-share cooldown is inert unless it is.

Supply is only ever observable as "how much of each account's week is left", so demand is measured in
the same unit: the summed **decline** in `one_week_remaining_percent` across the pool over 24h. Only
declines count -- a window reset sends the number back up, and that is supply arriving, not
consumption. The horizon is 7 days because these are weekly windows; anything shorter would call
every Monday a crisis. An account whose window renews inside the horizon contributes a full 100
points, which slightly overcounts and therefore errs toward "healthy" -- the safe direction, since a
wrong "scarce" throttles people who did not need throttling.

Measured on 2026-08-20 the codex pool was in deficit: 403 points/day burn against 941 in hand plus
1400 renewing, a runway of 5.8 days against a 7-day horizon. Claude had 32 days.

Missing or stale state (`SCARCITY_STATE_MAX_AGE_HOURS`) reads as **not scarce**. A broken cron must
fail open: throttling people on the strength of missing data is worse than letting a busy week
through, and a stale verdict is missing data wearing a timestamp.

The recompute runs in the probe worker right after fresh quota snapshots land -- the 24h window
function over `auth_pool_quota_events` is far too heavy for the fetch path, which reads one stored
row instead.

### Supply: rationing demand cannot create quota

Every other rule here rations demand, and no amount of rationing puts a single point of quota into
the pool -- when it runs dry the only remedy is another account in it. Supply therefore gets the same
treatment demand does: `hasHealthyUpload` (one entry uploaded by this user that the pool can actually
lend -- not a dead login, not a Free plan; a *drained* account still counts, since being drained is
what a shared account is for) decides whether the same cooldown applies while the pool is scarce.

This is not payment for access, and the numbers are why it cannot be. Over 14 days to 2026-08-27,
half the people who fetched had never supplied anything, but they accounted for 7.4% of priced spend
-- refusing them outright would have recovered almost nothing while locking colleagues out of a
company tool over a Free plan or a broken login. What the pool actually lacked was accounts: 9
suppliers against 28 borrowers, with 718 `no_better_auth_available` refusals in the window. So the
rule buys supply rather than saving demand: a non-contributor is warned while the pool is healthy,
and during scarcity draws once per cooldown instead of every five minutes, keeping the account
already in their hand and getting their own dead auth handed back to re-login -- which is precisely
how somebody stops being a non-contributor.

**The reporting gate is deliberately NOT scarcity-gated.** It is a measurement precondition, not a
rationing rule. Gating it would be self-defeating: nobody fixes their reporter during abundance, so
when the pool does tighten those users still have no measurable share and the cooldown -- the actual
rationing rule -- cannot reach them. The meter has to be running before it is needed.

### Schedule and kill switch

Phase dates are hardcoded in `lib/premium-ratio.js` and cumulative:

| Phase | From | Behaviour |
|---|---|---|
| notice | always | Notices ride on every response; nothing is refused |
| reporter_gate | `PHASE_REPORTER_GATE_AT` | Outdated clients refused |
| cooldown | `PHASE_COOLDOWN_AT` | Over-share users and non-contributors cooled down |

`PREMIUM_RATIO_REPORTER_GATE_AT` / `POOL_COOLDOWN_AT` override the dates (for a canary, an
emergency rollback, or reaching a phase from a test). The `premium_ratio_enforcement` feature flag is
a separate live kill switch: it stops refusals within one request while the notices keep flowing —
turning enforcement off must never also turn the warnings off.

Clients surface notices through `notify_hub_notices()` (`quota_guard.py`), once per notice code per
6 hours. The guard runs every 15 minutes; a toast on every run would train people to dismiss it
without reading, which is the opposite of what a warning is for.

## 10. Selection algorithm

Code: `pickBestAuthPoolCandidate`, `lib/auth-pool.js:260-312`.

For a borrow request, candidates are filtered then ranked:

**Eligibility** (`:273-280`): same source; not excluded (incl. `current_account_id`); not `Free` plan and not hard-invalidated; report fresh (`reported_at` within `max_report_age_seconds`, default 3600 s). Codex candidates must meet the weekly share threshold (weekly ≥ 5%) and beat the requester's weekly remaining quota. Claude candidates must meet both thresholds (5h ≥ 20%, weekly ≥ 5%) and beat the requester's `5h × weekly` product.

**Ranking** (`:282-301`): primary key is `projectedWeightedLoad` ascending — a fairness/load score combining a **deterministic exponential jitter** seeded by `selection_key:source:account_id` (stable per requester, spreads load) and a recent-served penalty. Codex quota weight and tie-breaks are weekly-first; Claude quota weight still uses the limiting window and tie-breaks by 5h, weekly, then recency. This balances *give the borrower good quota* against *don't stampede one account*.

**Read budget**: `fetch-best` reads only the requested source's pool entries and latest quota rows. Active load is read from the compact requester/reporter assignment tables, which have one row per requester or reporter, rather than using window functions over the append-only fetch/quota history tables on every request.

---

## 11. Token-refresh architecture

`lib/token-refresh.js` is the server-side refresher (hub is sole refresher under the flag):
- **Endpoints**: Claude `platform.claude.com/v1/oauth/token` (client `9d1c…`); Codex `auth.openai.com/oauth/token` (client `app_EMoam…`, no scope) (`:5-10`).
- **A refresh revokes the access tokens already issued for that grant.** Not textbook rotation, and
  the single most misleading property of this system: a live AT went `200` → `401 OAuth access token
  has been revoked` within one guard cycle of the hub refreshing that grant, 30 days before its
  stated expiry ([`AUTH_TOKENS.md` §3.5](AUTH_TOKENS.md)). Whoever refreshes therefore **must hand
  the new AT to everyone still using the old one** — which is why `/api/auth/upload` returns
  `refreshed_auth_json` ([§9](#9-the-disabled_refresh_token-mechanism)).
- **Claude scope was believed to decide AT lifetime; it does not.** `user:inference` alone returns
  `expires_in` 28800 while the CLI's own scope set claims 30 days on the same `client_id`, so
  `6e08c8f` made `refreshClaudeToken` ask for the scopes the stored blob was granted
  (`claudeScopesFromAuthBlob`), retrying once with the narrow set if the provider rejects them (a
  rejected refresh does not consume the RT, so the retry cannot orphan the grant). **Deployed
  2026-08-28; the two uploads that followed still minted 8.00 h pool tokens.** Either the wide scope
  is rejected every time and the fallback fires, or scope is not the lever — the `logRefreshOutcome`
  telemetry below distinguishes them and has not been read yet. Do that before changing scope again.
  Codex sends no scope.
- **Every refresh logs one line** (`logRefreshOutcome`): source, attempt, requested scope, granted
  scope, `expires_in`, status, rejection. Stored expiry mirrors only show the result after the fact;
  this is what makes "which scope buys which lifetime" answerable from the Vercel and Actions logs.
  Telemetry is wrapped so it can never fail a refresh.
- **Classification** (`postRefresh` `:12-39`): HTTP 400/401 → `auth_rejected` (RT dead, latest uploader must re-login); anything else (network, 5xx, 200-without-token) → transient.
- **`applyRefreshToBlob`**: per-source field updates that preserve unrelated sections (e.g. claude `mcpOAuth`); sets `expiresAt`/`last_refresh`.
- **`accessTokenMsUntilExpiry`** — the crux of selectivity:
  - **Claude**: `credentials.claudeAiOauth.expiresAt` — an **upper bound, not a lifetime**. The token
    is usually revoked by the next refresh of the grant long before this, so treat a comfortable
    margin here as "not yet expired", never as "still works".
  - **Codex**: decode the **access_token JWT** `exp` (real ~**10-day** lifetime), falling back to the `id_token` JWT (~1 h, identity only) **only** if the access_token isn't a decodable JWT (`:105-122`). The id_token is also what makes codex's refresh *client-initiated* — the CLI refreshes on its hourly schedule, so `fetch-best` refreshes and delivers in the same request and no exposure window opens. Claude has no such clock, which is the structural reason its rotations turn into outages ([`AUTH_TOKENS.md` §3.6](AUTH_TOKENS.md)).

**Why one T-1h threshold for both** (today's unification): the worker decides which accounts to refresh each cycle by comparing `accessTokenMsUntilExpiry` to `REFRESH_THRESHOLD_MS = 1 h`. Codex's 10-day AT means proactive refresh almost never fires on a healthy codex account (it's effectively claude-driven), but unifying the code path removes per-source special-casing. The threshold is sized against the worst worker gap (~110 min); the backstops for a missed window are client re-upload + the `refresh_current` AT-freshness fallback.

> **Historical pitfall (encoded in tests + memory):** codex AT lifetime was once misread from the id_token (~1 h), producing a wrong "codex AT dies hourly" analysis. The fix reads the access_token JWT. See `memory/codex-access-token-lifetime.md`.

---

## 12. Observability

- **`pool_health_snapshots`** — one row per source per worker run: `total, ok_count, hard_dead_count, other_err_count, central_refresh_{attempted,ok,rejected}`.
- **Account availability** (`index.html`): one primary lifecycle state per account. Detailed probe/token/refresh evidence and the lazy 24-hour quota chart are secondary diagnostics, not peer status lines.
- **Dashboard trend** (`index.html` `renderHealthTrend`, on the Settings tab next to the `disabled_refresh_token` toggle): per-source healthy ratio, hard-dead count + trend badge, an SVG sparkline of the hard-dead series, and central-refresh outcomes. The framing: *the death spiral is closed when hard-dead stops climbing*.
- **Reporter health** (`index.html` `renderReporterHealth`, the Devices tab): per-machine guard heartbeat states ([§3.7](#37-probe-heartbeat-why-a-failing-guard-is-not-silence)).
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
4. **Dashboard escaping is now uniform** — `index.html`, `users.html` and `token-usage.html` all run server-supplied strings (`item.error`, emails, requester fields) through `escapeHtml`. This was a real stored-XSS surface on the main dashboard and is fixed; the rule to keep is that *every* interpolation of a server string into markup goes through `escapeHtml`.
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

---

## 16. Token usage pipeline

An isolated read model. Nothing here feeds auth selection, quota availability, or the dashboard's
account states — the only place usage numbers cross over is the fetch policy's cost arithmetic
([§9b](#9b-the-premium-share-gate-libpremium-ratiojs)), and that reads the same stored aggregates
everyone else does. No parser output contains conversation content.

### 16.1 Client collector (`skills/quota-reporter/scripts/token_usage_*.py`)

Each installation owns a private SQLite checkpoint at `~/.agents/auth/token-usage.sqlite3` (`0600`,
`token_usage_state.py`). The first run fixes a **72-hour backfill cutoff** so a machine with years of
transcripts does not upload its history. Subsequent runs:

1. `discover_changed_files` — stat the Codex session roots and `~/.claude/projects`, keep files whose
   size or mtime moved past the acknowledged byte offset.
2. Parse forward from that offset (`token_usage_parsers.py`):
   - **Codex** reads the structural `session_meta` / `turn_context` / cumulative `token_count`
     fields. Canonical numeric fingerprints drop copied parent history, and a counter that goes
     *backwards* starts a new non-negative epoch rather than emitting a negative delta.
   - **Claude** keys on assistant message id, raw model, timestamp and final usage counters; a
     repeated record contributes only the positive difference.
3. Bucket each event into a 15-minute `bucket_start`, attribute it to an account
   (`account_for_event`, [§16.2](#162-account-attribution)), and aggregate — at most
   `MAX_AGGREGATE_ROWS = 400` rows per batch, inside a **10-second cycle budget**.
4. Upload, then commit. The proposed file/counter/fingerprint checkpoint is written locally **only
   after the server acknowledges**, and a retry re-sends the same `batch_id` with the same payload.

### 16.2 Account attribution

Two cases, and the second is deliberately approximate:

- **Automatic guard switch** — before installing a new credential the guard inserts a *prepared
  boundary*, reads the installed account back, then finalizes or cancels it. Collector events are
  split at finalized boundaries, so tokens land on the account that actually served them.
- **Manual switch** — there is no boundary to split on, so events read in that cycle are attributed
  to the account observed during the report.

This is a usage read model, not a billing ledger, and the doc says so on purpose: precision beyond
"which account was in use this cycle" would require instrumenting the provider CLIs.

### 16.3 Ingest (`POST /api/token-usage` → `ingestTokenUsageBatch`)

Exactly-once by receipt, in **one batch**: insert a `token_usage_batch_receipts` row keyed
`(hub_user_email, installation_id, batch_id)` carrying a digest of the payload, then apply every
aggregate row and the reporter-state update **guarded on that receipt existing with the same digest
and `applied_at IS NULL`**, then mark it applied. Consequences:

- A retry of the same batch re-inserts nothing (the receipt exists and is applied) — the counters do
  not double.
- The same `batch_id` with a *different* payload has a different digest, so no row applies and the
  API answers **409 `token_usage_batch_conflict`** rather than silently mixing two payloads.
- Counters accumulate with `ON CONFLICT … DO UPDATE SET x = x + excluded.x` per
  `(hub_user_email, provider, model_account_id, model_id, bucket_start)`.
- `token_usage_reporter_state` keeps the **maximum** `last_reported_at` and the reporting
  `client_version` — the version the reporter gate reads only for display; the gate itself judges the
  version carried on the fetch-best request ([§9b](#9b-the-premium-share-gate-libpremium-ratiojs)).

Validation lives in `lib/token-usage.js` (`normalizeTokenUsageBatch`): canonical quarter-hour buckets
inside the accepted window, known providers, non-negative safe counters, Codex cache/reasoning as
subsets of the total, Claude totals that include input/output/cache-read/cache-write, and no unknown
fields — a malformed batch is rejected, never partially stored.

### 16.4 Query (`GET /api/token-usage-query`)

`parseTokenUsageQuery` bounds every request (detail is capped at `TOKEN_USAGE_DETAIL_DAYS = 90`;
trend at 2000 points; breakdown at 500 rows) and rejects an unbounded one with **422
`query_too_broad`**. Hourly and shorter ranges read `token_usage_15m`; daily ranges read
`token_usage_daily`. The response carries only totals, trend, breakdown and reporter freshness.

Deliberately **never selected**: installation ids, batch ids, payload digests, file paths, logical
record ids, fingerprints. Read-only analytics requests also skip schema creation on cold start, and
the API-token lookup plus its `last_used_at` touch share one round trip before the bounded analytics
batch.

The page (`token-usage.html`) defaults to 7 days / hour / Hub user / Total and makes one lazy
authenticated query. Results are cached five minutes keyed by exact query **plus auth generation**,
concurrent identical requests are deduplicated, and a token rotation moves the successful result to
the new generation so a stale old-token response cannot clear a newer login. Charts preserve
missing-bucket gaps rather than interpolating, and expose exact values to keyboard and screen reader.

### 16.5 Retention (`/api/cron/token-usage-retention`, daily `30 18 * * *` UTC)

`compactTokenUsage` moves at most **seven** UTC days older than the 90-day boundary into
`token_usage_daily` atomically per run, deletes the compacted detail, and prunes old receipts. A
failed daily aggregation leaves that day's detail untouched — the compaction is all-or-nothing per
day, so a partial run can only ever be retried, never lose rows.

---

## 17. Repo layout, tests, and deploy

### 17.1 Layout

| Path | What lives there |
|---|---|
| `api/**` | Vercel function entrypoints. Thin: auth, method check, delegate to `lib/`. |
| `lib/**` | All server logic. Pure modules where possible so tests need no database or clock. |
| `scripts/*.mjs`, `scripts/*.py` | Worker and ops scripts ([§7](#7-component-worker), [§8](#8-ops-scripts)). |
| `skills/quota-reporter/**` | The local client, its installer, and its own docs. Self-updates from `main`. |
| `*.html` | Static dashboards: `index.html` (Accounts/Devices/Settings hash-switched tabs), `users.html` (members + fetch audit), `token-usage.html`, `login.html`. All three share one five-tab top nav (Accounts · Devices · Usages · Users · Settings); Usages and Users are separate pages, the other three are `index.html` tabs, so cross-page tab links use `./#devices`-style hashes. |
| `tests/*.test.mjs` | Server tests, `node --test`. |
| `tests/*_test.py`, `tests/test_*.py` | Client tests, pytest. |
| `docs/superpowers/{plans,specs}` | Per-change design notes, kept for the reasoning trail. |

### 17.2 Tests

```bash
npm test              # node --test over tests/*.test.mjs
python3 -m pytest tests -q
```

Both suites must pass before a commit. Conventions that make them worth having:

- **The policy layer is pure.** `evaluateFetchPolicy` takes every input — including `now` — as an
  argument, so the whole gate is tested without a database or a clock, and phase dates are reached by
  passing a date rather than by waiting.
- **Handler tests share one database per file.** `api/**` imports `lib/db.js` *without* a cache-
  busting query, so the handler binds to the single unqueried module instance. A test that seeds
  through a separately cache-busted copy writes to a different database than the handler reads. Set
  the env and import once at the top of the file (see `tests/premium-ratio-handler.test.mjs`).
- **Order matters in those files.** They share state, so a test that needs an empty pool has to run
  before whatever seeds it.
- **Every bug fix ships a regression test** that fails before the fix and passes after.

### 17.3 Deploy

Push to `main` deploys the API and dashboards through Vercel (`scripts/deploy_vercel.py` wraps the
CLI for manual or preview deploys). The worker deploys with the repo: GitHub Actions reads
`.github/workflows/probe-auth-pool.yml` from `main`. Clients self-update from `main` on their next
15-minute run, which is why a client-visible protocol change must stay backward-compatible for at
least one cycle, and why enforcement of anything client-side is put behind a phase date rather than
shipped hot ([§9b](#9b-the-premium-share-gate-libpremium-ratiojs)).

