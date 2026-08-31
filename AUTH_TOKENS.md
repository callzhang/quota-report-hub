# Auth Tokens — Codex & Claude (Technical Reference)

> Hard-won operational knowledge about how Codex and Claude OAuth credentials are stored, refreshed,
> rotated, pooled, and how they die. Companion to [`SYSTEM_DESIGN.md`](SYSTEM_DESIGN.md). Most claims
> here are grounded in code (`lib/token-refresh.js`, `lib/auth-pool.js`, `lib/fetch-best.js`,
> `scripts/probe_auth_pool_worker.mjs`, `skills/quota-reporter/scripts/*`) and in live debugging.

| Section | What it answers |
|---|---|
| [0. TL;DR — the rules that matter](#0-tldr--the-rules-that-matter) | the six rules; read these even if you read nothing else |
| [1. Codex auth](#1-codex-auth) | storage, the two JWTs, why codex rarely refreshes |
| [2. Claude auth](#2-claude-auth) | four stores — the one that wins is not the obvious one |
| [3. The refresh-token rotation death spiral](#3-the-refresh-token-rotation-death-spiral) | rotation, two custodians, and what was ruled out |
| [3.5 Refreshing REVOKES the access tokens already issued (measured 2026-08-28)](#35-refreshing-revokes-the-access-tokens-already-issued-measured-2026-08-28) | **a refresh revokes access tokens already issued** — the rule most things got wrong |
| [3.6 Why codex never goes dark and claude does: who opens the conversation](#36-why-codex-never-goes-dark-and-claude-does-who-opens-the-conversation) | the initiator decides whether there is a gap at all |
| [4. `disabled_refresh_token` mode (centralized refresh + AT-only distribution)](#4-disabled_refresh_token-mode-centralized-refresh--at-only-distribution) | AT-only distribution when the hub is sole refresher |
| [5. Hub central refresh (the worker)](#5-hub-central-refresh-the-worker) | the worker: proactive refresh + lazy probe |
| [6. Failure modes & invariants (and the fixes)](#6-failure-modes--invariants-and-the-fixes) | every failure seen, its cause, and its fix |
| [7. Claude Desktop vs the CLI](#7-claude-desktop-vs-the-cli) | the two lanes, and who actually holds the credential |
| [8. Quota probing (how each source is measured)](#8-quota-probing-how-each-source-is-measured) | how quota is measured per source |
| [9. Key code map](#9-key-code-map) | where each concern lives in code |

---

## 0. TL;DR — the rules that matter

1. **Both providers use *rotating* refresh tokens.** Each refresh issues a *new* RT and invalidates the
   old one. Replaying a superseded RT is treated as token reuse and the provider revokes the **whole
   token family** → permanent `authentication_error` / `token_invalidated`.
2. **A credential can have only ONE refresher.** If two independent actors refresh the same account
   (two machines, two pool sessions, two overlapping worker runs, or Claude Desktop + the hub), they
   rotate each other out and the credential dies. It is the *reuse* that kills it, **not** the network/IP
   the refresh runs from — a valid RT refreshes fine from residential, AWS, and Azure alike (verified,
   [§3](#3-the-refresh-token-rotation-death-spiral)); a *successful* refresh is precisely what consumes the
   RT and orphans any other holder of that generation. This is the "refresh-token death spiral."
3. **`disabled_refresh_token` mode makes the hub the sole refresher**: borrowers get access-token-only
   blobs (RT stripped to a placeholder), the hub holds the one real RT and refreshes centrally.
4. **A desktop-used account IS poolable (fixed `4b9b49f`) — the old "don't pool it" rule is obsolete.**
   Claude Desktop periodically **rewrites the CLI keychain credential access-token-only** (`refreshToken=""`).
   The guard would upload that, and an empty RT used to slip past the strip-guard and **overwrite the real
   pooled RT with nothing** → the account died. Both the server (`isStrippedRefreshToken`) and the guard
   (`auth_json_is_stripped`) now **reject empty/absent RTs**, so the blank can't reach the pool. The desktop
   does **not** "revoke the OAuth family" (a myth — the CLI RT refreshes fine with the app open).
   (See [§7](#7-claude-desktop-vs-the-cli).)
5. **AT expiry ≠ death.** An expired access token is normal and refreshable. Death is an **RT-class**
   error (`token_invalidated` / `401 unauthorized` / `authentication_error`) — the RT itself is gone and
   only an **owner re-login** can recover it; central refresh cannot.
6. **A refresh REVOKES the access tokens already issued for that grant**, immediately, whatever their
   `expiresAt`. Not textbook rotation, and the most misleading property here: measured, a live AT went
   `200` → `401 OAuth access token has been revoked` one guard cycle after the hub refreshed that grant
   ([§3.5](#35-refreshing-revokes-the-access-tokens-already-issued-measured-2026-08-28)). Two rules follow:
   **whoever refreshes must hand the new AT to everyone still using the old one**, and `expiresAt` is an
   upper bound, never proof a token still works.

---

## 1. Codex auth

### Storage — CLI lane vs desktop-app lane (two lanes, like Claude — see [§7](#7-claude-desktop-vs-the-cli))
- **CLI/pool lane:** `~/.codex/auth.json`. Shape: `{ "tokens": { access_token, refresh_token, id_token, account_id }, "last_refresh": <iso> }`. The Codex CLI can self-refresh during use; the quota guard also probes, uploads, and replaces this file when weekly quota is low or the auth is invalid.
- **Desktop-app lane (`Codex.app`):** the standalone Codex desktop app manages its own local state. After the guard writes CLI auth, it requests only an official managed-daemon restart. It never signals unmanaged or desktop app-server processes and never launches `codex login`.

### The two JWTs (critical, easy to get wrong)
- **`access_token`** — a JWT with `exp` **~10 days**. This is the *real* access-token lifetime and what the API uses.
- **`id_token`** — a JWT with `exp` **~1 hour**. Identity only; does **not** reflect the access token's
  life. `aud` is the CLIENT (`app_EMoam…`), not the API, so the API never sees it and an expired one
  cannot break an API call. It answers a different question — "is this login session still good?" —
  which is why it is short where the access token is long. Its real job here is to be **the alarm
  clock**: the codex CLI refreshes on the id_token's schedule, hours before the access token is at
  risk, and that is what keeps codex from ever going dark
  ([§3.6](#36-why-codex-never-goes-dark-and-claude-does-who-opens-the-conversation)).
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

### Storage — four stores, and the one that wins is not the obvious one
| Store | Path / service | Owner |
|---|---|---|
| **Encrypted token cache** ← *source of truth* | `oauth:tokenCacheV2` (older: `oauth:tokenCache`) inside `~/Library/Application Support/Claude/config.json`, encrypted with the `Claude Safe Storage` keychain key | **Claude.app** — modern Claude Code's real OAuth record. Holds one entry per `client_id` + scope set |
| **macOS keychain** | service `Claude Code-credentials`, account `$USER` | older Claude Code builds **and the quota guard** |
| **File** | `~/.claude/.credentials.json` | fallback for the CLI/guard (non-darwin primary); often absent on macOS |
| **Claude Desktop web session** | claude.ai session cookie (`sessionKey`) in `~/Library/Application Support/Claude/Cookies` | **Claude Desktop only** — a *separate* web-session auth, not OAuth ([§7](#7-claude-desktop-vs-the-cli)) |

- **Read order on macOS is token-cache first**, then keychain, then file (`read_claude_oauth_credentials`,
  [quota_reporters.py](skills/quota-reporter/scripts/quota_reporters.py)). A write that skips the cache is therefore
  **shadowed**: it returns success and changes nothing. That is not hypothetical — the guard wrote the
  cache in zero places until 2026-08-28, so every fetched or replacement AT was discarded on arrival
  ([§6](#6-failure-modes--invariants-and-the-fixes)). Write through `install_claude_credentials`, which
  writes all stores and reads back.
- **The cache holds several entries, across several client ids.** One account routinely carries more
  than one OAuth grant — this machine had three client ids, two of them inference-capable. A strip has
  to cover **every grant that can do inference**, not every entry of one client id: a second grant
  re-mints just as effectively, and rotating it revokes the tokens the hub is serving. That is what
  `claude_cache_entry_can_mint_inference` decides. Grants without inference scope are left alone.
- **Two different things are both called "desktop".** The claude.ai *cookie session* really is separate
  and unaffected by a stripped keychain RT. But the OAuth *token cache* above lives in Claude.app's own
  config, and every Claude Code session runs as a child of the Claude.app process — so the app's process
  tree is very much in the OAuth path ([§7](#7-claude-desktop-vs-the-cli)).

### Credential shape
- `credentials.claudeAiOauth = { accessToken, refreshToken, expiresAt (ms epoch), subscriptionType }`.
- **`expiresAt` is not the token's real lifetime.** A refresh on the grant revokes every access token
  already issued for it, whatever their stated expiry
  ([§3.5](#35-refreshing-revokes-the-access-tokens-already-issued-measured-2026-08-28)) — so a token
  claiming 30 days routinely dies in minutes. `accessTokenMsUntilExpiry(authJson, "claude")` reads
  `expiresAt - now` and is therefore an **upper bound**, not a prediction; anything that must know
  whether a token still works has to probe it.
- Observed lifetimes: a CLI-minted token claims **30 days**, a hub refresh returns `expires_in` 28800
  (**8 h**). Scope looked like the cause and is not — the correction and what to check instead are in
  [§3.5](#35-refreshing-revokes-the-access-tokens-already-issued-measured-2026-08-28) point 3.
- The pool blob is wrapped as schema `claude_credentials_v1` (`build_claude_auth_blob`), carrying
  `credentials`, `account_id`, `session_id`, `auth_last_refresh`, `claude_cli_state`.

### Identity
- Pool account id = **`claude-<email-lowercased>`** (the `claude-` prefix is added **client-side** in the
  reporter, e.g. `probe_claude` / `build_claude_auth_blob`; the server's `deriveClaudeAuthPoolEntry` takes
  `account_id` as-is).

### Refresh endpoint
- `POST https://platform.claude.com/v1/oauth/token`, `client_id = 9d1c250a-e61b-44d9-88ed-5944d1962f5e`,
  CLI-style User-Agent (`refreshClaudeToken`, [lib/token-refresh.js](lib/token-refresh.js)).
- **Scope**: the credential's own `scopes`, falling back to `user:inference` once if the provider
  rejects them. A rejected refresh does not consume the refresh token, so the narrow retry costs one
  request and cannot orphan the grant. Every refresh logs `{requested_scope, granted_scope,
  expires_in}` so the lifetime a scope buys stays observable rather than inferred.

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
  the worker refreshing >1 in a run = replay (fixed, [§6](#6-failure-modes--invariants-and-the-fixes)).
- **Two overlapping worker runs** both refreshing the same entry (fixed, [§6](#6-failure-modes--invariants-and-the-fixes)).
- ~~The Claude Desktop app's `host-auth-refresh`~~ **(corrected — NOT a death-spiral source).** The desktop
  app does **not** refresh/rotate the pooled OAuth family (earlier drafts wrongly listed it here; the CLI RT
  refreshes fine with the app open). Its real, *separate* harm was blanking the keychain RT, which used to
  wipe the pooled RT on upload — a different bug, now fixed ([§7](#7-claude-desktop-vs-the-cli)).
- **Repeated CLI re-logins** of the same account, each minting/rotating an OAuth grant and orphaning the previously-pooled copy.

**Refresh is single-use: a *successful* refresh is what consumes the token.** `ok:true` does **not** mean
"the RT is still yours to keep" — it means "that RT was spent, and here is its replacement (the next
generation)." The old RT is invalidated at the provider the instant the new one is issued. So if the caller
doesn't persist the returned RT, **whoever still holds the old generation is now orphaned** (next use →
`authentication_error`). This is the exact knife-edge two custodians cut each other on, and it has nothing
to do with *where* the refresh runs.

**Ruled out — it is NOT a datacenter / cloud-IP / geo binding** (tested 2026-06-17, recorded so nobody
re-chases it). One *valid, current* claude RT was refreshed with identical code/headers from three
environments; only the egress differed:

| Environment | Egress | Refresh a valid RT? |
|---|---|---|
| Residential (owner's Mac) | home IP | ✅ (×3) |
| AWS — Vercel function | `54.236.11.217` | ✅ |
| Azure — GitHub Actions runner | `57.151.137.138` (AS8075 Microsoft) | ✅ |

All three succeed — so the worker's `authentication_error` was **not** its cloud IP being rejected. The
actual cause was a **hub-side bug** (the "two custodians" framing was wrong — there was only ever *one*
refresher, the hub, killing itself):

> **The freshness-gate drop (root cause, fixed `bd96ae0`).** `applyRefreshToBlob` updated claude's
> `expiresAt` but **not** the top-level `auth_last_refresh` mirror (the guard sets that mirror = `expiresAt`,
> [quota_reporters.py:1602](skills/quota-reporter/scripts/quota_reporters.py:1602)). So a centrally-refreshed
> blob carried a rotated RT but an **unchanged `auth_last_refresh`** → `shouldReplaceAuthPoolEntry`
> ([lib/auth-pool.js:314](lib/auth-pool.js:314)) returned `false` (equal, not greater) → `upsertAuthPoolEntry`
> **dropped the write-back**. The hub kept the now-spent `RT_n`, replayed it next cycle → reuse → family
> revoked → `authentication_error`. Confirmed on live data: every claude entry's `auth_last_refresh`
> equalled its `expiresAt` and never advanced across refreshes. **Fix:** the claude branch of
> `applyRefreshToBlob` now bumps `auth_last_refresh = expiresAt` on every refresh (mirroring what codex
> already did for `last_refresh`).

**Why codex was immune:** codex's `applyRefreshToBlob` already bumps its own `last_refresh` on every
refresh, so its write-back was never dropped. (Its ~10-day AT also means it refreshes ~30× less often than
claude's ~8 h AT, so even the latent bug had far fewer chances to fire — but the decisive difference is the
`last_refresh` bump.) This is why the pool was ~half-healthy on codex and **0/3 on claude** before the fix.

*(Aside — the rotating-token "two custodians cut each other" hazard above is still real in general, e.g.
the desktop host-auth refresher ([§7](#7-claude-desktop-vs-the-cli)),
and the `ok:true` cloud tests genuinely burned the owner's keychain RT by consuming it — but that hazard was
**not** what was killing the pool. The freshness-gate drop was.)*

---

## 3.5 Refreshing REVOKES the access tokens already issued (measured 2026-08-28)

Textbook OAuth rotation invalidates the **refresh** token and leaves outstanding access tokens alone
until they expire. **This provider does not.** A successful refresh revokes every access token
previously issued for that grant, immediately.

Measured with a pinned access token re-probed against the read-only `/api/oauth/profile` (no refresh,
no rotation, nothing consumed):

| Time (UTC) | Event | Pinned AT |
|---|---|---|
| 23:01:51 | Claude Code mints the token; `expiresAt` claims **30 days** | — |
| 23:04:06 | probe | **200 alive** |
| 23:14:51 | guard uploads the real RT; `/api/auth/upload` refreshes it to verify (hub records `auth_expires_at` = upload + 8 h) | — |
| 23:19:07 | probe | **401 `OAuth access token has been revoked`** |

Three consequences, all of which had been misread before this was measured:

1. **`expiresAt` is not the lifetime.** The 30-day value is real but almost never reached — the token
   is revoked by the next refresh of the grant long before it expires. Any logic that decides "is this
   token still good?" from `expiresAt` alone (e.g. `fetched_auth_near_expiry`) is reading a number that
   does not describe reality.
2. **Verifying an upload kills the uploader.** `/api/auth/upload` refreshes to verify, which revokes
   the access token the uploading machine is still running on. The response used to carry metadata
   only, so the client then stripped its RT and was left with a revoked AT and a placeholder RT: dead,
   and unable to refresh its way out. The response now returns `refreshed_auth_json` (AT-only, via
   `stripRefreshToken`) and the client installs it **before** stripping.
3. **The 8-hour AT is NOT explained by scope — that hypothesis is falsified.** The obvious story was
   that the hub asked for `user:inference` alone (`expires_in: 28800`) while the CLI's own scope set
   mints 30-day tokens on the same `client_id`. `6e08c8f` made the refresh use the credential's own
   scopes with a narrow fallback. **Deployed 2026-08-28 06:2x UTC; the two uploads that followed still
   produced pool access tokens with a lifetime of exactly 8.00 h.** So either the provider rejects the
   wide scope on a *refresh* grant and the fallback fires every time, or scope does not determine the
   lifetime of a refresh-minted AT at all. The `token_refresh` telemetry
   (`requested_scope` / `granted_scope` / `expires_in`, [lib/token-refresh.js](lib/token-refresh.js))
   distinguishes those two, but it lands in Vercel runtime logs and has not been read yet — **do that
   before touching scope again.** Either way this was never the failure: revocation-on-refresh happens
   at any lifetime.

**The refresh token is more forgiving than the access token.** At 23:19 the local stores held only the
placeholder, yet at 00:39 the machine produced a brand-new AT+RT — a live process refreshed using an
in-memory copy of the RT the hub had already spent at 23:14. So a spent RT is not always hard-invalidated.
Not always accepted either: `refresh_token_rejected` has fired 136 times in the guard log. Treat it as a
race window, not a rule.

---

## 3.6 Why codex never goes dark and claude does: who opens the conversation

Both sources rotate about ten times a day. Codex has had zero outages; claude had two this week, each
ending with its owner logging back in by hand. The difference is not the provider's generosity — it is
**which side initiates the refresh**, and everything else follows from that.

### The mechanism, side by side

| | **Codex** | **Claude** |
|---|---|---|
| Refresh trigger | client's **`id_token`, ~1 h** — a clock | client's `expiresAt`, nominally 30 days |
| Does that clock ring? | every hour, while the AT still has ~10 days | **never** — the token is *revoked*, not expired, so the deadline it watches never arrives |
| Who opens the conversation | **the client**, on schedule | **the hub**, on upload-verify or worker cron |
| Refresh and delivery | the **same request**: `fetch-best` refreshes and hands the result back in one call | separate: the hub refreshes, the client finds out later |
| Exposure window | **zero** | until the client next probes — one guard cycle, or longer |
| Can the client re-mint on its own? | **no** — no super key, so it waits | **yes** — the desktop session key ([§7](#7-claude-desktop-vs-the-cli)) |

### Why zero, and not "one guard cycle"

The intuition that an AT-only codex client must go dark for up to a guard cycle after a central
refresh is right — *if* the hub refreshes on its own. It does not get the chance. Observed
2026-08-30: the client asked at 18:28:10 because its id_token was near expiry, `fetch-best` took the
`refreshed_current` path, and the hub refreshed **inside that request** and returned the result.
Local `last_refresh` and the pool's `auth_last_refresh` match to the millisecond
(`17:40:12.928`) — one operation, not two. The old token dies at the instant the new one lands in the
caller's hands.

A gap can only open when the hub rotates a grant while its user is not looking. Codex's hourly clock
means someone is almost always looking.

### The margin is thinner than it looks, and claude spends it

Codex's trigger fires at 20 minutes left against a 15-minute guard cycle — a five-minute margin, and
only if the run actually happens. A run that dies takes the margin with it, and the likeliest way for
one to die is the **claude** probe: `claude auth status` is slow cold, and per-call retries used to
compound to 120 s (2 calls x 2 attempts x 30 s). claude and codex share one guard process, so a slow
claude probe spends codex's headroom. `CLAUDE_AUTH_STATUS_TOTAL_BUDGET_SECONDS` (60 s) now caps all
of those calls together.

Worth being precise about why codex survives anyway: **not** the five-minute margin, which one lost
run erases. An expired id_token is simply harmless — measured 2026-08-30 with id_token 2.2 minutes
past expiry, a placeholder refresh token, and a valid access token: `/v1/me` returned **200** and
`codex login status` returned **rc=0, "Logged in using ChatGPT"**. The API never sees the id_token
([§1](#1-codex-auth)), and the CLI does not refuse to work without a fresh one. (This contradicts the
older note that a stale id_token makes an AT-only client's own refresh fail; that failure, if it is
real, is not on this path.)

Claude has neither cushion: its trigger reads an `expiresAt` that never arrives, and its access token
going invalid is an immediate 401.

### Refresh on demand, not on a clock

Codex renews hourly because its id_token expires hourly. That cadence turns out to be **more than
the evidence requires**. Measured 2026-08-30 in an isolated `CODEX_HOME`, with an id_token 6 minutes
past expiry, a placeholder refresh token, and a valid access token:

| Operation | Result |
|---|---|
| `/v1/me` (direct API) | **200** |
| `codex login status` | **rc=0**, "Logged in using ChatGPT" |
| `codex exec` — a real inference | **rc=0**, correct reply, **10,870 tokens billed** |

A stale id_token breaks nothing, including the inference path. The API never sees it — its `aud` is
the client, not the API ([§1](#1-codex-auth)). (Bounded claim: 6 minutes of staleness, three
operations. It does not prove an id_token is never needed for anything.)

So the rule this project settles on is **refresh on demand, not on a clock**:

- **Do not** renew pre-emptively on a timer. Every refresh spends a single-use token and revokes the
  access tokens already issued for the grant — a cost paid on every tick, whether or not anything was
  wrong.
- **Do** renew the moment a credential is actually refused. A 401 is the only signal that is never a
  false alarm, and it arrives exactly when renewal is worth its cost.
- The claude client already works this way: an AT-only 401 reports
  `claude access token rejected (at-only; hub holds the RT)`, `needs_fresh_access_token` routes it to
  `refresh_current`, and the hub refreshes in place and hands the result back
  ([§6](#6-failure-modes--invariants-and-the-fixes)). What was missing was not the trigger but the
  hub honouring it — `refresh_current` used to serve without refreshing.
- Codex's hourly cadence is left alone: it costs nothing visible (its client cannot re-mint, so
  rotations start no tug-of-war) and codex has had zero outages. Changing a healthy system to match a
  principle is not worth the risk.

### What claude can and cannot copy

- **Cannot:** the super key. It belongs to the desktop app, and it is why a claude client answers a
  revoked token by minting its own instead of waiting ([§3.5](#35-refreshing-revokes-the-access-tokens-already-issued-measured-2026-08-28)).
- **Cannot:** a longer AT, or the provider's revoke-on-refresh behaviour.
- **Can:** make the client the initiator. Claude has no `id_token`, but it does not need one — the hub
  knows its own rotation schedule, and a client that asks "is the credential I hold still the one you
  are serving?" every cycle costs a digest comparison and consumes nothing. Whoever asks first turns
  refresh-and-deliver into a single atomic step, which is the whole of codex's advantage.

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
| **Replacement STILL silently ineffective** | The keychain-first fix was one layer short: modern Claude Code keeps its OAuth record in the encrypted **token cache**, which `read_claude_oauth_credentials` reads FIRST — so a keychain+file install is shadowed by the cache. The guard wrote the token cache in **zero** places, so every fetched AT was discarded on arrival | `install_claude_credentials` writes the cache, keychain and file, then **reads back** and reports `shadowed_by_<store>` when the install did not take |
| **Uploader left holding a revoked AT** | `/api/auth/upload` refreshes to verify, revoking the uploader's own access token ([§3.5](#35-refreshing-revokes-the-access-tokens-already-issued-measured-2026-08-28)); the response returned metadata only, then the client stripped its RT | Upload returns `refreshed_auth_json` (AT-only); the client installs it **before** the strip |
| **One transient 401 killed a working account** | An AT-only client that got a 401 reported `claude auth invalid (authentication_error)` — hard invalidation. But it holds a placeholder RT, so it can never reach the `transient_error` branch that was supposed to spare it: every 401 looked terminal. Observed 2026-08-28 08:11 — the entry was marked dead and refused to borrowers while the very same token returned 200 on both `/api/oauth/profile` and `/api/oauth/usage` | An AT-only client now reports `claude access token rejected (at-only; hub holds the RT)`, which is **not** a hard-invalidation string. It routes to `refresh_current` — a fresh AT for the same account from the hub, the only party holding a real RT and therefore the only one that can prove death (via `auth_rejected`) |
| **A month-dead credential kept being handed out** | The worker presented `claude-qpt0311@uw.edu`'s pooled RT every ~13 min and was refused every time (`400 auth_rejected`), but a client kept reporting the account `ok` — that machine runs a credential it never re-uploaded, so its health says nothing about the pooled blob. Last-write-wins let the client overwrite the verdict every cycle: pooled AT 726 h expired, entry green, still offered to borrowers. (Separately, `reportAuthRefreshMs` ran `Date.parse` on claude's **ms-epoch** `auth_last_refresh` → `NaN`, so the staleness guard was dead code for every claude report; fixing that alone would have made the masking permanent instead of intermittent) | `reportAuthRefreshMs` accepts both formats; central-refresh rejections are exempt from the staleness guard; and a standing rejection is now lifted **only** by proof about the pooled blob — a verified upload or a successful central refresh — never by a client's own healthy probe |
| **Deferred into an outage** | `refresh_current` declines a *different* account so a healthy machine is never swapped onto a borrowed credential — its comment justifies this with "its AT still has life". Routing a rejected AT-only token into `refresh_current` made that premise false: the hub could not refresh the dead entry in place, the guard declined the borrowed one, and every cycle deferred identically. Measured 2026-08-29: near-expiry fired correctly at T-20 min, nothing refreshed, the token died at 00:19 and the machine sat on a **401 for 80 minutes** before anything escalated — then briefly installed a pool credential that had itself expired 733 h earlier | `current_auth_cannot_wait` breaks the deferral when the token was refused or has under one guard cycle (15 min) of life left. A borrowed credential beats going dark; the churn guard still holds while the token is merely near expiry |
| **A second grant kept re-minting** | The strip filtered on the hub's `client_id`, but the same account carried another OAuth grant (`a473d7bb`, scopes `user:inference user:profile user:sessions:claude_code`) whose refresh token was never touched. Claude.app used it to re-mint a full 30-day credential within minutes of every strip — 9-10 rotations in two hours — and each rotation revoked the access token the hub was serving to borrowers. Restarting the app only cleared the in-memory copy; the other grant on disk brought it straight back | Membership is now the **capability**, not the id: `claude_cache_entry_can_mint_inference` selects the hub's client plus any grant carrying `user:inference`. Measured after the change: **0 re-mints and 0 rotations across 60 samples** spanning a full guard cycle. Grants with no inference scope belong to other desktop features and are deliberately spared |
| **A slow CLI call lost the whole run** | `claude auth status` is slow cold and fast warm — 10.66s then 1.43s then 0.57s, measured back to back — and occasionally exceeds any fixed ceiling; raising the timeout 10s → 30s still lost. `--text` had no timeout handling at all, so it raised out of `probe_claude` as an opaque `claude probe failed`, discarding the answer the first call had already given. Either way the guard reports `probe_unavailable`, makes no rotation decision, and the account's quota shows **stale** on the dashboard | `run_claude_auth_status_command` retries once — the warm path has never been slow — and a `--text` timeout now degrades to the existing `claude auth email unavailable` route instead of exploding |
| **Verifying an upload started the loop it was meant to guard against** | `/api/auth/upload` proved every uploaded credential by refreshing it. That revokes the access tokens already issued for the grant, so each upload killed the uploader's own token; the desktop app re-minted from its session key, the guard uploaded that, and the new refresh token needed verifying — ten rotations a day, each one revoking the pooled token borrowers were holding | Claude uploads are verified by **probing** the access token (`probeClaudeAccessToken`), which consumes nothing. A live access token is already proof the refresh token beside it is unspent: only a refresh could have spent it, and that would have killed the access token too. The response says `local_auth_untouched`, and the client strips without waiting for a replacement it is not owed. **Codex keeps refresh-verify** — its client cannot re-mint, so there is no loop, and its hourly id_token renewal needs the rotation anyway |
| **A month-dead credential came back as `ok`** | The sticky-rejection rule lived inside one merge branch and read the marker off the PREVIOUS report, so it only held while consecutive reports carried it. One report that neither rejects nor clears — a skipped worker probe, say — erased the evidence, and the next client `ok` sailed past. `claude-qpt0311@uw.edu` returned to `status: ok` on 2026-08-31 with a pooled access token **782 hours expired**, re-entering rotation and resetting its owner's invalidation clock | The verdict is carried at the **outer edge** of `mergeLatestReport`, after whichever branch ran, and the evidence is re-attached each time so the next merge can still see it. Neutral reports can no longer break the chain; only a verified upload or a successful central refresh lifts it |
| **Strip only cosmetic** | The strip rewrote the single highest-scored token-cache entry; sibling entries for the same client id kept real RTs, and a write returning `True` was taken as proof | `strip_claude_token_cache_refresh_tokens` strips **every** hub-client entry; `claude_stores_with_real_refresh_token` read-back gates the `fetched_from_auth_pool` claim and reports `strip_not_sticking` |
| **Healthy account swapped to a borrowed one** | In `refresh_current` mode (healthy, just needs an AT) the hub fell through to a *different* account when it couldn't refresh in place; the guard installed it → churn + "switched to X" toasts | Guard **declines a different-account replacement in `refresh_current` mode** (`kept_current_refresh_deferred`) — only same-account refreshes are accepted; genuinely quota-low/dead accounts still fail over via the `source_needs_replacement` path |
| **Owner dead-locked on a stale copy** | `refresh_current` returned the owner's own stale AT | Server checks `accessTokenMsUntilExpiry > 5 min`; otherwise falls through to a real replacement (for genuinely dead accounts) |

Hard-invalidation error strings (RT-class death; needs owner re-login):
`auth invalidated (token_invalidated)`, `auth failed (401 unauthorized)`,
`claude auth invalid (authentication_error)`, `claude auth email unavailable`,
`refresh_token_rejected`. The set lives in `AUTH_INVALIDATION_ERRORS`
([lib/auth-status.js](lib/auth-status.js)) and `is_hard_invalidated` (guard) and must stay in sync.

**Deliberately NOT in that set:** `claude access token rejected (at-only; hub holds the RT)`. Only a
party holding **the pooled credential** has evidence of RT-class death. Its 401 means "get me a fresh
access token", never "this account is dead" — it routes to `refresh_current` instead. Hard
invalidation from a client is reserved for `auth_rejected`, where a real RT was actually presented and
refused.

The test for that is **provenance, not possession** (`claude_client_owns_the_pooled_credential`):
`state_source == "owner_local"` means this credential is ours and unreplaced, so a rejection here
really is a rejection of what the pool serves. `fetched_from_auth_pool` means we are a participant,
and what we hold may be a token the hub served *or one the desktop app minted for itself from its
session key* — a different grant entirely.

The first version of this rule asked "do I have a real refresh token?" and got the converse wrong:
holding a real RT does not make it the pool's RT, and on claude the app mints its own routinely.
Observed 2026-08-30 18:43 — a participant machine holding an app-minted RT took a 401 and marked the
entry `claude auth invalid (authentication_error)` while the pooled credential was fine (+7.75 h),
refusing borrowers until it self-healed.

Abuse-class errors (a *different* risk unique to shared-AT mode — provider pushback): `429`, `403`,
rate-limit / suspend / ban / abuse. Watched separately (`lib/abuse-errors.js`, `assess_health.mjs` exit 3).

---

## 7. Claude Desktop vs the CLI

Claude and Codex have separate CLI and desktop-app lanes. The quota guard manages both CLI/pool lanes
while leaving desktop-app state and unmanaged process lifecycle alone.

| Lane | Carrier | Credential type | Managed by |
|---|---|---|---|
| **Claude CLI / pool** | keychain `Claude Code-credentials` (+ `~/.claude/.credentials.json` fallback) | **OAuth** (accessToken + rotating refreshToken) | terminal CLI **and the quota guard** |
| **Claude Desktop** | claude.ai **session cookie** (`sessionKey`) in `~/Library/Application Support/Claude/Cookies`, encrypted by keychain `Claude Safe Storage` | claude.ai **web session** — **not** OAuth | Claude Desktop only |
| **Codex CLI / pool** | `~/.codex/auth.json` | **OAuth** (access_token + rotating refresh_token) | Codex CLI **and the quota guard** |
| **Codex.app** | `~/Library/Application Support/Codex/{Cookies, Local/Session Storage}`, encrypted by keychain `Codex Safe Storage` | app web session — separate from `auth.json` | `Codex.app` only |

A running desktop app owns its own state. The guard may change CLI credentials, but it never terminates
desktop or unmanaged Codex processes. Existing sessions may need to be reopened after replacement.

**The Desktop *UI cookie* is independent of the CLI OAuth** (verified):
- Moving Desktop's `Local Storage`/leveldb aside and relaunching did **not** log Desktop out → the
  Desktop UI credential is a cookie in `Cookies`, not leveldb. *(leveldb holds only app/UI state.)*
- `claude logout` (CLI) removed the keychain `claudeAiOauth` block + deleted the file, but **Desktop
  stayed logged in** → the CLI OAuth and the Desktop *cookie* don't touch each other.

**The Desktop's real harm to the pool is mundane — it blanks the keychain RT, it does NOT "revoke the OAuth
family".** A Claude Code session spawned by the desktop app carries `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`
/ `CLAUDE_CODE_OAUTH_SCOPES=user:inference` and runs on a host-injected token. While it's running, the
desktop app **periodically rewrites the CLI keychain credential (`Claude Code-credentials`)
access-token-only — `refreshToken=""`, accessToken present.** It does **not** rotate or revoke the pooled
CLI refresh-token family — verified: the CLI RT refreshes fine from residential, AWS, and Azure with the app
open ([§3](#3-the-refresh-token-rotation-death-spiral)). (Earlier drafts of this doc claimed the
host-auth-refresh "shared and rotated the same family" and killed the pooled copy — that was **wrong**.)

### The bug this caused (fixed `4b9b49f`) — and why a desktop-used account IS poolable now
With the keychain blanked, the guard read `refreshToken=""` and uploaded it. The strip-guards
(`isStrippedRefreshToken` server-side, `auth_json_is_stripped` guard-side) only matched the literal
placeholder `"disabled-by-hub-refresh-token"` — **not empty/absent** — so the empty RT was accepted and
**overwrote the real pooled RT with `""`**, leaving the hub no token to refresh centrally → the account died
`authentication_error` at AT expiry → auto-relogin re-seeded → the desktop blanked it again → endless cycle.
**Fix:** both strip-guards now treat empty/whitespace/absent as "no usable RT" and reject the upload, so a
desktop AT-only write can never reach the pool. Confirmed end-to-end (an empty-RT upload is now
`rejected (stripped_refresh_token)`, the real pooled RT preserved).

**Current rule: a desktop-used claude account IS poolable.** `claude login` (CLI) once to put a real RT in
the keychain; the guard uploads it, the hub refreshes it centrally, and the desktop's subsequent AT-only
blanks are rejected. The earlier "do NOT pool a desktop-used account" rule rested on the wrong
"second refresher" mechanism and is **obsolete**.

> **History (so future readers don't re-derive it the hard way):** `leizhang0121@gmail.com` kept dying
> RT-class, and we chased a string of wrong causes before finding it. Ruled out: multi-session replay
> (fixed by single-entry), overlapping worker runs (concurrency group), leveldb, "repeated re-logins",
> **datacenter-IP binding** (refuted — a valid RT refreshes from residential, AWS, and Azure alike), and
> the **"Desktop host-auth-refresh revokes the OAuth family"** theory (refuted — the CLI RT refreshes fine
> with the app open). Two *real* bugs were behind it: **(A)** the hub dropping its own rotated RT and
> replaying the spent one (`auth_last_refresh` not advancing, [§6](#6-failure-modes--invariants-and-the-fixes), fixed
> `bd96ae0`), and **(B)** the **empty-RT wipe** above — the desktop blanks the keychain RT and the
> strip-guards let the empty value overwrite the real pooled RT (fixed `4b9b49f`). (B) was what kept
> leizhang specifically dying after (A) was fixed. The evidence that cracked it: the pooled blob literally
> had `refreshToken=""` with `isStrippedRefreshToken=false`.

### Who actually holds the credential (the codex `app-server` analogue)

The OAuth token cache lives in **Claude.app's own config** ([§2](#2-claude-auth)), and every Claude Code
session on the machine runs as a child of the Claude.app process:

```
PID 20350  /Applications/Claude.app/Contents/MacOS/Claude       (observed up 1d3h)
   └─ claude --output-format stream-json ...                    (ppid 20350)
```

So Claude.app is the claude-side counterpart of codex's app-server daemon — with one asymmetry that
decides what fixes are even possible: **there is no `daemon restart`.** codex exposes
`codex app-server daemon restart` and the guard already calls it (`stale_codex_app_server_for_auth` →
`app_server_started_before_auth`). `claude --help` offers `auth` / `gateway` / `mcp` / `setup-token` and
nothing equivalent, so the only lever is quitting and relaunching Claude.app, which kills every session
it hosts. The guard cannot do that surgically, so **the fix has to work without it**.

This matters because a running process keeps its refresh token in memory. A strip rewrites the stores,
not the process — observed: a real RT was back in the cache **10 s** after a verified strip, because the
hub's refresh had revoked the app's access token and its next call hit a 401. The re-mint is
**401-triggered, not timed**: once the upload hands the fresh AT back ([§3.5](#35-refreshing-revokes-the-access-tokens-already-issued-measured-2026-08-28)),
the app never sees the 401 and the machine stays AT-only.

> **Reopened:** [§3](#3-the-refresh-token-rotation-death-spiral) struck out "the Claude Desktop app's
> `host-auth-refresh`" as *not* a death-spiral source. That correction no longer holds: the OAuth token
> cache lives in the desktop app's config and is rewritten while it runs. Whether the writer is the
> desktop app itself or a CLI session it hosts is unresolved — both sit in the same process tree and
> both survive a strip — but "the desktop app is unrelated" is withdrawn.

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
| Strip every local store + read-back | `strip_claude_token_cache_refresh_tokens` / `claude_stores_with_real_refresh_token` — [quota_reporters.py](skills/quota-reporter/scripts/quota_reporters.py) |
| Install a credential into every store + read-back | `install_claude_credentials` — [quota_reporters.py](skills/quota-reporter/scripts/quota_reporters.py) |
| Hand the refreshed AT back to the uploader | `refreshed_auth_json` — [api/auth/upload.js](api/auth/upload.js) / `install_uploaded_claude_refresh` (client) |
| Derive pool identity (account_id, email, digest, expiry) | `deriveAuthPoolEntry` — [lib/auth-pool.js](lib/auth-pool.js) |
| Worker proactive refresh + lazy probe | `refreshEntryIfNeeded` / `probeSkipReason` — [scripts/probe_auth_pool_worker.mjs](scripts/probe_auth_pool_worker.mjs) |
| Single-entry-per-account collapse | `dedupeEntriesByAccount` (worker) + `upsertAuthPoolEntry` / `collapseAuthPoolSessions` — [lib/db.js](lib/db.js) |
| Local read/write of claude creds (keychain-first) | `read_claude_oauth_credentials` / `write_claude_keychain_credentials` — [quota_reporters.py](skills/quota-reporter/scripts/quota_reporters.py) |
| Client rotation/refresh decisions | `maybe_replace_{codex,claude}_auth` / `fetched_auth_near_expiry` — [quota_guard.py](skills/quota-reporter/scripts/quota_guard.py) |
| Phase-4 local strip | `strip_local_{codex,claude}_refresh_token` — [quota_reporters.py](skills/quota-reporter/scripts/quota_reporters.py) |
