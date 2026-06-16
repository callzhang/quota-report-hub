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
4. **The desktop app is a second OAuth refresher — don't pool an account you use in it.** Claude Desktop's
   UI uses a separate claude.ai *cookie* (independent of the CLI OAuth), **but** it also runs an OAuth
   `host-auth-refresh` (`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`, scope `user:inference`) for the Claude
   Code sessions it spawns — same account, same OAuth family as the pooled RT — so it rotates and kills the
   pooled copy within ~one cycle. A **purely-CLI** account (never used for Claude Code in the desktop app)
   is poolable; an account you use in the desktop app is not.
   (See [§7](#7-claude-desktop-vs-the-cli-the-desktop-app-is-a-second-oauth-refresher).)
5. **AT expiry ≠ death.** An expired access token is normal and refreshable. Death is an **RT-class**
   error (`token_invalidated` / `401 unauthorized` / `authentication_error`) — the RT itself is gone and
   only an **owner re-login** can recover it; central refresh cannot.

---

## 1. Codex auth

### Storage — CLI lane vs desktop-app lane (two lanes, like Claude — see [§7](#7-claude-desktop-vs-the-cli-the-desktop-app-is-a-second-oauth-refresher))
- **CLI lane (guard-managed):** `~/.codex/auth.json`. Shape: `{ "tokens": { access_token, refresh_token, id_token, account_id }, "last_refresh": <iso> }`. The Codex CLI owns this file and **self-refreshes** during use (rotates `access_token`/`refresh_token`, bumps `last_refresh`).
- **Desktop-app lane (`Codex.app`, guard CANNOT manage):** the standalone Codex desktop app caches its own auth in `~/Library/Application Support/Codex/` (`Cookies`, `Local`/`Session Storage`), encrypted by keychain item **`Codex Safe Storage`** — the exact mirror of Claude Desktop. A running `Codex.app` **caches auth at startup and won't switch** just because the guard rewrote `~/.codex/auth.json`. (The guard partially mitigates the *CLI* `codex app-server --listen` daemon via `stale_codex_app_server_for_auth` + `restart_codex_app_server`, but it does **not** control `Codex.app`'s store.)

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
| **Claude Desktop** | claude.ai session cookie (`sessionKey`) in `~/Library/Application Support/Claude/Cookies`, encrypted by keychain `Claude Safe Storage` | **Claude Desktop only** — a *separate* web-session auth, not OAuth (see [§7](#7-claude-desktop-vs-the-cli-the-desktop-app-is-a-second-oauth-refresher)) |

- On **macOS the read order is keychain-first** (`read_claude_oauth_credentials`,
  [quota_reporters.py](skills/quota-reporter/scripts/quota_reporters.py)); the keychain is the source of truth, the file is a
  fallback that can go stale. Writes are keychain-first too, with a read-back verification to avoid a
  known hex-corruption logout bug.
- **Desktop is a different auth system** (claude.ai cookie session — see [§7](#7-claude-desktop-vs-the-cli-the-desktop-app-is-a-second-oauth-refresher)). A stripped/garbage keychain RT does
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
- **The Claude Desktop app's `host-auth-refresh`** — it refreshes its own `user:inference` OAuth token (same
  account, same family) for every Claude Code session run from the app, so the pooled copy dies ~hourly/per-AT-cycle.
  **Not fixable** from the guard side; the rule is just "don't pool a desktop-used account" ([§7](#7-claude-desktop-vs-the-cli-the-desktop-app-is-a-second-oauth-refresher)).
- **Repeated CLI re-logins** of the same account, each minting/rotating an OAuth grant and orphaning the previously-pooled copy.

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

## 7. Claude Desktop vs the CLI (the desktop app is a second OAuth refresher)

**Both Claude and Codex** have **two separate auth lanes** — a CLI lane the guard manages, and a
desktop-app lane it cannot. Conflating them caused several wrong conclusions earlier in this project;
the truth below is verified empirically.

| Lane | Carrier | Credential type | Managed by |
|---|---|---|---|
| **Claude CLI / pool** | keychain `Claude Code-credentials` (+ `~/.claude/.credentials.json` fallback) | **OAuth** (accessToken + rotating refreshToken) | terminal CLI **and the quota guard** |
| **Claude Desktop** | claude.ai **session cookie** (`sessionKey`) in `~/Library/Application Support/Claude/Cookies`, encrypted by keychain `Claude Safe Storage` | claude.ai **web session** — **not** OAuth | Claude Desktop only |
| **Codex CLI / pool** | `~/.codex/auth.json` | **OAuth** (access_token + rotating refresh_token) | Codex CLI **and the quota guard** |
| **Codex.app** | `~/Library/Application Support/Codex/{Cookies, Local/Session Storage}`, encrypted by keychain `Codex Safe Storage` | app web session — separate from `auth.json` | `Codex.app` only |

A **running desktop app** (Claude Desktop or `Codex.app`) caches its auth at startup in its own store
and **won't switch** when the guard updates the CLI lane. The guard can only mitigate the *CLI*-side
`codex app-server --listen` daemon (restart on auth change); it has no channel into either desktop app's
store. So the rules below apply symmetrically to both products.

**The Desktop *UI cookie* is independent of the CLI OAuth** (verified):
- Moving Desktop's `Local Storage`/leveldb aside and relaunching did **not** log Desktop out → the
  Desktop UI credential is a cookie in `Cookies`, not leveldb. *(leveldb holds only app/UI state.)*
- `claude logout` (CLI) removed the keychain `claudeAiOauth` block + deleted the file, but **Desktop
  stayed logged in** → the CLI OAuth and the Desktop *cookie* don't touch each other.

**BUT the Desktop also runs an OAuth `host-auth-refresh`, and that is NOT independent — it is the second
custodian.** A Claude Code session spawned by the desktop app carries
`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1` and `CLAUDE_CODE_OAUTH_SCOPES=user:inference`: the desktop app
**mints and refreshes its own `user:inference` OAuth token** (host-injected, *not* in the keychain) for
the **same account**, every time you run Claude Code from it. That token **shares and rotates the same
OAuth family** as the pooled CLI refresh token — so each host-auth-refresh **invalidates the pooled copy**,
within ~one access-token cycle (~8h).

### Can you pool an account you use in the desktop app? — **No** (if you use it for Claude Code there)
A CLI-seed (`claude login` → guard sync → Phase-4 strip → hub sole refresher) keeps a pooled account alive
**only while nothing else refreshes its OAuth family.** The desktop app's host-auth-refresh *does* refresh
it whenever you use Claude Code from the app, so the seed survives ~one cycle and then dies
(`authentication_error`) — and the guard can neither see nor stop that host-injected token.

**Durable rule ("one custodian", [§0](#0-tldr--the-rules-that-matter) rule 2): do NOT pool the account the desktop
app is logged into / used for Claude Code.** Pool a *different* account via the CLI lane. A **purely-CLI
account** (logged in via `claude`/`codex` CLI, never used in the desktop app) **is** poolable — the desktop
app is the second refresher, not the CLI.

> **History (so future readers don't re-derive it the hard way):** `leizhang0121@gmail.com` kept dying
> RT-class. Ruled out one by one: multi-session replay (fixed by single-entry), overlapping worker runs
> (fixed by the concurrency group), the CLI keychain (logged out → `claudeAiOauth` absent), and the Desktop
> *cookie* (independent). What remained, by elimination + the env evidence above, is the **Desktop
> host-auth-refresh** rotating the `user:inference` family — confirmed by the seed staying `ok` ~8h then
> dying while Claude Code was used through the app. Earlier drafts wrongly blamed leveldb, then "repeated
> re-logins", then called a Desktop account poolable — all wrong; **host-auth-refresh is the second
> custodian.**

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
