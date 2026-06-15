# Auth Tokens — Codex & Claude (Technical Reference)

> Hard-won operational knowledge about how Codex and Claude OAuth credentials are stored, refreshed,
> rotated, pooled, and how they die. Companion to [`SYSTEM_DESIGN.md`](SYSTEM_DESIGN.md). Most claims
> here are grounded in code (`lib/token-refresh.js`, `lib/auth-pool.js`, `lib/fetch-best.js`,
> `scripts/probe_auth_pool_worker.mjs`, `skills/quota-reporter/scripts/*`) and in live debugging.

---

## 0. TL;DR — the rules that matter

1. **Both providers use *rotating* refresh tokens.** Each refresh issues a *new* RT and invalidates the
   old one. Replaying a superseded RT is treated as token reuse and the provider revokes the **whole
   token family** → permanent `authentication_error` / `token_invalidated`.
2. **A credential can have only ONE refresher.** If two independent actors refresh the same account
   (two machines, two pool sessions, two overlapping worker runs, or Claude Desktop + the hub), they
   rotate each other out and the credential dies. This is the "refresh-token death spiral."
3. **`disabled_refresh_token` mode makes the hub the sole refresher**: borrowers get access-token-only
   blobs (RT stripped to a placeholder), the hub holds the one real RT and refreshes centrally.
4. **Claude Desktop and the CLI/pool are *separate* auth systems** — Desktop = a claude.ai **session
   cookie**, CLI/pool = **OAuth** tokens in the keychain; logging in/out of one doesn't affect the other.
   So a Desktop-used account **can** be pooled, as long as nothing local keeps rotating its OAuth RT.
   Working recipe: CLI-login to seed → CLI-logout → Desktop on its cookie → hub is sole refresher.
   (See [§7](#7-claude-desktop-vs-the-cli-two-independent-auth-systems).)
5. **AT expiry ≠ death.** An expired access token is normal and refreshable. Death is an **RT-class**
   error (`token_invalidated` / `401 unauthorized` / `authentication_error`) — the RT itself is gone and
   only an **owner re-login** can recover it; central refresh cannot.

---

## 1. Codex auth

### Storage
- File: `~/.codex/auth.json`. Shape: `{ "tokens": { access_token, refresh_token, id_token, account_id }, "last_refresh": <iso> }`.
- The Codex CLI owns this file and **self-refreshes** during use (rotates `access_token`/`refresh_token`, bumps `last_refresh`).

### The two JWTs (critical, easy to get wrong)
- **`access_token`** — a JWT with `exp` **~10 days**. This is the *real* access-token lifetime and what the API uses.
- **`id_token`** — a JWT with `exp` **~1 hour**. Identity only; does **not** reflect the access token's life.
- ⚠️ Pitfall: reading the codex AT lifetime from `id_token` (~1h) gives a wildly wrong "codex AT dies hourly"
  picture. Always decode **`access_token`** for AT expiry. `accessTokenMsUntilExpiry(authJson, "codex")`
  ([lib/token-refresh.js](lib/token-refresh.js)) decodes the access_token JWT `exp`, falling back to id_token
  only when access_token isn't a decodable JWT.

### Identity
- Pool account id is **canonicalized to the lowercased email** (`canonical_codex_account_id`,
  [skills/quota-reporter/scripts/quota_reporters.py](skills/quota-reporter/scripts/quota_reporters.py)) — falling back to the
  provider UUID, then `"codex-email-missing"`. Email-keying stops Team users who share a provider UUID
  from colliding.

### Refresh endpoint
- `POST https://auth.openai.com/oauth/token`, `client_id = app_EMoamEEZ73f0CkXaXp7hrann`,
  `grant_type=refresh_token`, no scope (`refreshCodexToken`, [lib/token-refresh.js](lib/token-refresh.js)).

### Consequence of the ~10-day AT
- A healthy codex account almost never sits inside the T-1h proactive-refresh window, so the worker's
  proactive refresh rarely fires on it. Codex mostly relies on the CLI's own passive refresh during a
  probe (the "`refresh_capture`" write-back). Codex `token_invalidated` failures are **RT** problems
  (rotation/death-spiral), not AT expiry.

---

## 2. Claude auth

### Storage — there are THREE separate stores
| Store | Path / service | Owner |
|---|---|---|
| **macOS keychain** | service `Claude Code-credentials`, account `$USER` | terminal/CLI Claude Code **and the quota guard** |
| **File** | `~/.claude/.credentials.json` | fallback for the CLI/guard (non-darwin primary) |
| **Claude Desktop** | claude.ai session cookie (`sessionKey`) in `~/Library/Application Support/Claude/Cookies`, encrypted by keychain `Claude Safe Storage` | **Claude Desktop only** — a *separate* web-session auth, not OAuth (see [§7](#7-claude-desktop-vs-the-cli-two-independent-auth-systems)) |

- On **macOS the read order is keychain-first** (`read_claude_oauth_credentials`,
  [quota_reporters.py](skills/quota-reporter/scripts/quota_reporters.py)); the keychain is the source of truth, the file is a
  fallback that can go stale. Writes are keychain-first too, with a read-back verification to avoid a
  known hex-corruption logout bug.
- **Desktop is a different auth system** (claude.ai cookie session — see [§7](#7-claude-desktop-vs-the-cli-two-independent-auth-systems)). A stripped/garbage keychain RT does
  **not** affect Desktop, and Desktop does **not** touch the keychain / OAuth tokens.

### Credential shape
- `credentials.claudeAiOauth = { accessToken, refreshToken, expiresAt (ms epoch), subscriptionType }`.
- AT lifetime **~8 hours**, with a real `expiresAt`. `accessTokenMsUntilExpiry(authJson, "claude")`
  reads `expiresAt - now` directly.
- The pool blob is wrapped as schema `claude_credentials_v1` (`build_claude_auth_blob`), carrying
  `credentials`, `account_id`, `session_id`, `auth_last_refresh`, `claude_cli_state`.

### Identity
- Pool account id = **`claude-<email-lowercased>`** (the `claude-` prefix is added **client-side** in the
  reporter, e.g. `probe_claude` / `build_claude_auth_blob`; the server's `deriveClaudeAuthPoolEntry` takes
  `account_id` as-is).

### Refresh endpoint
- `POST https://platform.claude.com/v1/oauth/token`, `client_id = 9d1c250a-e61b-44d9-88ed-5944d1962f5e`,
  scope `user:inference`, CLI-style User-Agent (`refreshClaudeToken`, [lib/token-refresh.js](lib/token-refresh.js)).

---

## 3. The refresh-token rotation death spiral

```
Machine/actor A refreshes RT_n  ->  gets RT_{n+1}, RT_n invalidated at provider
Machine/actor B still holds RT_n ->  refreshes RT_n  ->  REJECTED (reuse) -> family revoked
```

Any time **more than one independent custodian** refreshes the same account, they rotate each other
out. Sources of "more than one custodian" observed in this project:
- The same account logged into **multiple machines**, each with a real RT (the original motivation).
- **Multiple pool sessions** of one account (different `session_id`), each a different RT generation —
  the worker refreshing >1 in a run = replay (fixed, [§6](#6-failure-modes--invariants)).
- **Two overlapping worker runs** both refreshing the same entry (fixed, [§6](#6-failure-modes--invariants)).
- **Repeated re-logins** of the same account (CLI or Desktop), each minting/rotating an OAuth grant and orphaning the previously-pooled copy. *(Claude Desktop's separate **cookie** session does NOT refresh the OAuth RT — see [§7](#7-claude-desktop-vs-the-cli-two-independent-auth-systems).)*

---

## 4. `disabled_refresh_token` mode (centralized refresh + AT-only distribution)

Admin kill-switch flag (dashboard toggle, `ADMIN_EMAIL`-gated). When ON, the hub becomes the **sole
refresher**:

1. **Serve AT-only.** `fetch-best` runs `stripRefreshToken` ([lib/fetch-best.js](lib/fetch-best.js)) before serving:
   the real RT is replaced with a placeholder of the right shape. Borrowers can use the access token but
   cannot rotate the shared RT.
   - **Placeholder RTs:** codex `"rt.1." + "A"*32`; claude `"disabled-by-hub-refresh-token"`.
2. **Reject stripped-RT uploads.** `isStrippedRefreshToken` ([lib/fetch-best.js](lib/fetch-best.js)) detects those
   placeholders; `upsertAuthPoolEntry` rejects any upload carrying one, so a borrower can't overwrite the
   real shared RT with its useless placeholder.
3. **Owner goes AT-only too (Phase-4 strip).** After a client uploads its real RT and the upload response
   says `disabled_refresh_token: true`, the guard overwrites its **own** local RT with the placeholder
   (`strip_local_{codex,claude}_refresh_token`) and marks state `fetched_from_auth_pool`. From then on it
   relies on the hub for fresh ATs and never re-uploads (a stripped blob → `local_auth_is_at_only`).
4. **Hub refreshes centrally** ([§5](#5-hub-central-refresh-the-worker)); clients pull fresh ATs via `refresh_current`.

Default OFF → deploys are inert until an admin flips it.

---

## 5. Hub central refresh (the worker)

`scripts/probe_auth_pool_worker.mjs`, GitHub Actions cron (~15 min nominal, jittery — sometimes
35 min, occasionally 1–2 h).

- **Unified proactive refresh, T-1h.** `refreshEntryIfNeeded(authJson, entry, source, …)` refreshes any
  entry whose `accessTokenMsUntilExpiry <= REFRESH_THRESHOLD_MS (1 h)`, for **both** claude and codex
  (one threshold, no per-source special-casing). On dead-RT accounts the attempt is correctly rejected
  (harmless); on a live near-expiry account it rotates + writes the new tokens back to the pool.
- **Lazy probe.** Each run skips the cloud probe for an entry that was re-uploaded within
  `PROBE_STALE_MS (1 h)` — **but only when the prior report was healthy** (`status ok`). A
  previously-errored, just-re-uploaded entry (a recovery) is always re-probed promptly so a stale error
  clears. Brand-new entries (no prior report) are always probed for a baseline.
- The **probe** (quota measurement) is per canonical entry; only the **refresh** is selective.

---

## 6. Failure modes & invariants (and the fixes)

| Failure | Cause | Fix |
|---|---|---|
| **Multi-session replay** | One account had N pool sessions (different RT generations); the worker refreshed >1 in a run → reuse → family revoked | **Single entry per account**: `dedupeEntriesByAccount` (per-run, refresh only the canonical/freshest), `upsertAuthPoolEntry` delete-other-sessions on upload, one-shot `collapseAuthPoolSessions()` |
| **Overlapping-run replay** | Two worker runs (cron + manual dispatch) each snapshot the pool at start and both refresh the same RT → reuse → revoked | GitHub Actions **`concurrency` group** on `probe-auth-pool.yml` (`cancel-in-progress: false`) → runs serialize, next starts on a fresh snapshot |
| **Replacement silently ineffective on macOS** | Claude replacement install wrote `~/.claude/.credentials.json` only; macOS reads keychain-first → write shadowed → "replaced" every cycle | Claude replacement now writes **keychain-first** (file fallback), mirroring the repair path |
| **Healthy account swapped to a borrowed one** | In `refresh_current` mode (healthy, just needs an AT) the hub fell through to a *different* account when it couldn't refresh in place; the guard installed it → churn + "switched to X" toasts | Guard **declines a different-account replacement in `refresh_current` mode** (`kept_current_refresh_deferred`) — only same-account refreshes are accepted; genuinely quota-low/dead accounts still fail over via the `source_needs_replacement` path |
| **Owner dead-locked on a stale copy** | `refresh_current` returned the owner's own stale AT | Server checks `accessTokenMsUntilExpiry > 5 min`; otherwise falls through to a real replacement (for genuinely dead accounts) |

Hard-invalidation error strings (RT-class death; needs owner re-login):
`auth invalidated (token_invalidated)`, `auth failed (401 unauthorized)`,
`claude auth invalid (authentication_error)`, `claude auth email unavailable`.

Abuse-class errors (a *different* risk unique to shared-AT mode — provider pushback): `429`, `403`,
rate-limit / suspend / ban / abuse. Watched separately (`lib/abuse-errors.js`, `assess_health.mjs` exit 3).

---

## 7. Claude Desktop vs the CLI (two independent auth systems)

Claude has **two completely separate auth systems**. Conflating them caused several wrong conclusions
earlier in this project — the truth below is verified empirically.

| | Carrier | Credential type | Managed by |
|---|---|---|---|
| **Claude CLI / the pool** | keychain `Claude Code-credentials` (+ `~/.claude/.credentials.json` fallback) | **OAuth** (accessToken + rotating refreshToken) | terminal CLI **and the quota guard** |
| **Claude Desktop** | claude.ai **session cookie** (`sessionKey`/`sessionKeyLC`) in `~/Library/Application Support/Claude/Cookies`, encrypted by keychain item `Claude Safe Storage` | a **claude.ai web session** (like a browser login) — **not** OAuth | Claude Desktop only |

**They are independent** (each step verified by experiment):
- Moving Desktop's `Local Storage`/leveldb aside and relaunching did **not** log Desktop out → the
  Desktop credential is **not** in leveldb (it's in `Cookies`). *(leveldb holds only app/UI state.)*
- `claude logout` (CLI) removed the keychain `claudeAiOauth` block and deleted the file, but **Desktop
  stayed logged in** → CLI OAuth and the Desktop cookie don't touch each other.
- `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1` just means the Desktop host injects its own session into the
  Claude Code process it spawns.

**Correction to an earlier belief in this repo:** a Desktop-used account is **NOT inherently unpoolable.**
Because Desktop runs on a separate cookie session, the account's **OAuth** credential (CLI/keychain) can
be pooled independently — *provided nothing local keeps rotating that OAuth RT.*

### Working recipe to pool a Desktop-used account
Verified: `leizhang` came back **`ok`** in the pool (hub-refreshed) while Desktop stayed logged in.
1. With Claude Desktop running normally (on its cookie session),
2. **`claude` CLI login** the account once → the guard reads the fresh OAuth RT from the keychain and
   **uploads it to the pool** (seeds the real RT),
3. **`claude` CLI logout** → clears the local OAuth creds (keychain `claudeAiOauth` + file). **Verified:
   logout is local-only — it does NOT revoke the RT server-side** (the pooled RT kept working after).
4. Result: **no local refresher competes** (CLI logged out; Desktop on a separate cookie) → the **hub is
   the sole refresher** of the pooled OAuth RT and keeps it alive.

This satisfies the "one custodian" condition ([§0](#0-tldr--the-rules-that-matter) rule 2). Sustained survival
across many refresh cycles should still be watched, but the mechanism is sound and confirmed for one cycle.

> **On the earlier repeated `leizhang` deaths:** they were RT-class but **not** from Desktop rotating the
> OAuth family (Desktop never touches it). The most consistent explanation is the **repeated CLI/Desktop
> re-logins during debugging** — each mints/rotates a grant and orphans the previously-pooled copy. Once a
> single seeded RT was left with only the hub refreshing it, it stayed healthy. (Earlier drafts of this
> doc wrongly attributed it to a "Desktop ↔ hub" dual-refresher fight; that was incorrect.)

---

## 8. Quota probing (how each source is measured)

- **Codex** — run `codex exec` against the auth blob and read the latest `token_count` rollout event's
  `rate_limits` (`primary` → 5h, `secondary` → 1week). The worker probe
  (`scripts/probe_codex_auth_blob.py`) sets `capture_refreshed_auth=True` so the CLI **self-refreshes**
  during the probe and the worker captures the before/after diff (`refresh_capture`) and writes the
  refreshed blob back. Probing runs in an isolated `CODEX_HOME` with provider env vars (`OPENAI_API_KEY`,
  `OPENAI_BASE_URL`, …) **blocklisted**, so a stray shell key can't mislabel a different provider's quota.
- **Claude** — windows come from the rate-limit data Claude Code emits **only after the first API
  response in a session**:
  - **Local guard (passive):** reads the statusline snapshot `~/.claude/statusline-rate-limits.json`,
    populated by your normal Claude Code usage via the installed `statusLine` hook; falls back to a live
    `GET https://api.anthropic.com/api/oauth/usage` probe (windows from response **headers**), guarded by
    an 1800s backoff.
  - **Worker (active):** `scripts/probe_claude_auth_blob.py` drives a headless Claude CLI via `pexpect`
    to the `/usage` page (forcing fresh `rate_limits`) and scrapes both the snapshot it generates and the
    rendered page. So the worker doesn't depend on a pre-existing snapshot — it generates the data.
  - `model_context_window` is always `null` for Claude.
- ⚠️ A custom-provider session (`ANTHROPIC_BASE_URL` gateway / host-managed Desktop) emits **no
  subscription `rate_limits`**, so the statusline shows `rate_limits: null` and the guard reports
  `quota_unavailable`. Unknown quota is **not** treated as low (`remaining_percent < 0 → not replaced`).

---

## 9. Key code map

| Concern | Location |
|---|---|
| AT-expiry decode (claude `expiresAt`, codex access_token JWT) | `accessTokenMsUntilExpiry` — [lib/token-refresh.js](lib/token-refresh.js) |
| Provider refresh calls + classification (400/401 = RT dead) | `refreshClaudeToken` / `refreshCodexToken` / `postRefresh` — [lib/token-refresh.js](lib/token-refresh.js) |
| Apply a refresh result back into a blob | `applyRefreshToBlob` — [lib/token-refresh.js](lib/token-refresh.js) |
| Strip / detect placeholder RTs | `stripRefreshToken` / `isStrippedRefreshToken` — [lib/fetch-best.js](lib/fetch-best.js) |
| Derive pool identity (account_id, email, digest, expiry) | `deriveAuthPoolEntry` — [lib/auth-pool.js](lib/auth-pool.js) |
| Worker proactive refresh + lazy probe | `refreshEntryIfNeeded` / `probeSkipReason` — [scripts/probe_auth_pool_worker.mjs](scripts/probe_auth_pool_worker.mjs) |
| Single-entry-per-account collapse | `dedupeEntriesByAccount` (worker) + `upsertAuthPoolEntry` / `collapseAuthPoolSessions` — [lib/db.js](lib/db.js) |
| Local read/write of claude creds (keychain-first) | `read_claude_oauth_credentials` / `write_claude_keychain_credentials` — [quota_reporters.py](skills/quota-reporter/scripts/quota_reporters.py) |
| Client rotation/refresh decisions | `maybe_replace_{codex,claude}_auth` / `fetched_auth_near_expiry` — [quota_guard.py](skills/quota-reporter/scripts/quota_guard.py) |
| Phase-4 local strip | `strip_local_{codex,claude}_refresh_token` — [quota_reporters.py](skills/quota-reporter/scripts/quota_reporters.py) |
