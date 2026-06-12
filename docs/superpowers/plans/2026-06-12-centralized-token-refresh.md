# Plan: Centralized refresh + AT-only distribution (kill refresh-token rotation churn)

Status: proposed (2026-06-12)

## Problem

Claude and Codex auths use **rotating refresh tokens**: refreshing the access token (AT)
returns a *new* refresh token (RT) and invalidates the old one. Because the pool shares a
full credential (AT + RT) and **every client refreshes independently** (the CLI does it on
its own, not just our guard), one machine's refresh invalidates every other copy. When a
rotation isn't propagated back to the pool, the shared auth dies for everyone — observed
as all 3 shared Claude accounts going `error` (a death spiral).

## Verified facts (feasibility — see session 2026-06-12)

- **Both clients run on AT-only** (valid AT + dead RT), so they don't need a working RT to
  operate, only to refresh:
  - Claude: keychain blob with valid `accessToken` + scrambled `refreshToken` → `claude -p`
    returns normally.
  - Codex: `auth.json` with valid `access_token` + a **well-formed but invalid** `refresh_token`
    (shape `rt.1.…`) → `codex exec` returns normally. The field must be **present and
    well-formed** (absent → `missing field refresh_token` parse error). Codex uses the fresh
    AT directly and never touches the RT unless it must refresh.
- **Both refresh endpoints work server-side** (a plain HTTPS POST, no browser):
  - Claude: `POST https://platform.claude.com/v1/oauth/token`
    `{grant_type:"refresh_token", refresh_token, client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e", scope}`
    + a non-default `User-Agent` (Cloudflare 403s the urllib UA). Returns new AT + new RT + `expires_in`.
  - Codex: `POST https://auth.openai.com/oauth/token`
    `{grant_type:"refresh_token", refresh_token, client_id:"app_EMoamEEZ73f0CkXaXp7hrann"}`.
    Returns new AT + new RT + `expires_in` + `earliest_refresh_at`.
- **AT lifetime ~1h** for both. Worker cadence (15 min) and client re-fetch can stay ahead.
- **Keychain write hardened** already (compact JSON + read-back verify; cross-platform file
  fallback) — commit 651e308. A bad write silently logs the user out, so this was a prereq.

## Architecture

The **hub becomes the sole RT custodian and the sole refresher.** Nobody else holds a
working RT, so nobody else can rotate.

1. **Hub stores the real RT and refreshes AT centrally.** A cloud worker refreshes each pool
   auth's AT from its RT before the AT expires, persisting the rotated RT + new AT into the
   encrypted blob. Rotation happens in exactly one place, serialized.
2. **Hub serves AT-only.** On `fetch-best`, the returned blob has its RT replaced with a
   well-formed dummy (Claude: `refreshToken` dummy/empty; Codex: `refresh_token` = `rt.1.<dummy>`).
   The real RT never leaves the hub.
3. **Clients never refresh; they re-fetch.** A client installs the served AT-only blob and the
   CLI uses the AT. When the AT nears expiry, the guard re-fetches a fresh AT-only blob from the
   hub (the dummy RT can't refresh, so this is the only path). `state_source ==
   "fetched_from_auth_pool"` marks these.
4. **Owner strips its own local RT after upload.** Once the owner's guard has uploaded the
   freshly-logged-in auth (with the real RT) to the hub, it replaces the *local* RT with a dummy,
   so even the owner becomes an AT-only client that re-fetches. Hub is the only RT holder.

## Admin-controlled kill switch (runtime, no redeploy)

The RT-stripping behavior (Phase 3/4) is gated behind a **runtime feature flag** stored in
the DB, so it can be flipped instantly without a redeploy if anything goes wrong.

- **Flag:** `at_only_mode` (boolean), stored in a small `feature_flags` table (or settings row)
  in `lib/db.js`. **Default = off** → deploying the code changes nothing until an admin turns it
  on; turning it off instantly reverts to serving full credentials.
- **Admin gate:** env var `ADMIN_EMAIL` (comma-separated allowed; e.g. `derek@stardust.ai`).
  Only a request whose authenticated `authContext.email` is in `ADMIN_EMAIL` may change the flag.
- **Endpoints** (`api/admin/flags.js`):
  - `GET /api/admin/flags` → current flag values (any authed user may read).
  - `POST /api/admin/flags` `{at_only_mode: bool}` → set; **admin-only** (403 otherwise).
- **Read path:** `fetch-best` (and the client, via `/api/status`) read `at_only_mode`. When on,
  serve AT-only; when off, serve the full credential.
- The flag value is also surfaced in `/api/status` so the client guard knows whether to strip
  its own RT after upload (Phase 4) — toggling the flag off means owners keep their RT again.

## Phased implementation (each phase is independently shippable + testable)

Order matters: keep the pool fresh BEFORE withholding RTs from clients, or served ATs would
expire with no way to refresh.

### Phase 1 — Hub-side central refresh (additive, safe)
- New JS refresh helpers in a hub lib (e.g. `lib/token-refresh.js`):
  `refreshClaudeToken(rt)` and `refreshCodexToken(rt)` mirroring the verified requests
  (endpoints, client_ids, scope, UA above). Return `{access_token, refresh_token, expires_in}`
  or a typed failure (`auth_rejected` vs `transient`).
- Worker step (extend `scripts/probe_auth_pool_worker.mjs`): for each pool entry whose AT is
  within N minutes of expiry, refresh from the stored RT, then write the rotated RT + new AT +
  expiry back into the encrypted blob (`lib/db.js` upsert path). On `auth_rejected`, leave it and
  let the invalidated-auth handback/notification fire (owner re-login).
- No client change yet. Effect: pool auths stay fresh; nothing breaks.
- Tests: refresh helpers (mock fetch: success / 400 / network); worker refreshes a near-expiry
  entry and persists the new tokens; skips fresh ones; handles auth_rejected.

### Phase 2 — Client re-fetch on near-expiry for fetched auths (additive)
- `quota_guard.py`: when the current auth was `fetched_from_auth_pool` and its AT is within N
  minutes of expiry (or already 401), fetch a fresh blob from the hub and re-install — instead
  of relying on a CLI/our-own refresh. Claude `ensure_fresh_claude_access_token` must NOT try to
  refresh a fetched auth (its RT is a dummy); it should signal "re-fetch" instead.
- Tests: guard re-fetches when a fetched auth is near expiry; does not attempt refresh on a
  fetched auth.

### Phase 3 — Hub serves AT-only, gated by the `at_only_mode` flag (the switch)
- Add the feature-flag table + `getFeatureFlag`/`setFeatureFlag` in `lib/db.js`, and the
  admin-gated `api/admin/flags.js` endpoints (see "Admin-controlled kill switch" above).
- `api/auth/fetch-best.js`: when `at_only_mode` is on, before returning a `replacement`, strip
  the RT via a helper `stripRefreshToken(authJson, source)`:
  - codex: `tokens.refresh_token = "rt.1." + <fixed dummy>` (present + well-formed).
  - claude: `claudeAiOauth.refreshToken = "<dummy>"`.
  Leave `repair_auth` (owner re-login handback) untouched. When the flag is off, behave exactly
  as today (full credential).
- Surface `at_only_mode` in `/api/status`.
- Roll out: deploy with flag **off** (no behavior change), then admin flips it on. If anything
  breaks, admin flips it off → instant revert, no redeploy.
- Tests: with flag on, replacement carries a dummy RT (well-formed for codex) + real AT; with
  flag off, replacement carries the real RT; admin endpoint rejects non-admins (403); repair
  path always returns the owner's own blob.

### Phase 4 — Owner local RT strip (close the loop)
- `quota_guard.py`: after a successful upload of a freshly-logged-in auth, rewrite the local
  store (keychain via the hardened writer / `auth.json`) replacing the RT with a dummy. From then
  on the owner re-fetches like any client.
- Guard against stripping before the upload is confirmed (don't lose the only real RT before the
  hub has it).
- Tests: after upload, local RT is a dummy; AT preserved; subsequent guard runs re-fetch.

## Freshness cadence
- Worker refreshes every run (15 min) → served ATs are < ~15 min old, well inside the ~1h life.
- Client re-fetches when AT has < ~20 min left → CLI never has to refresh.
- Risk window: CLI used between guard runs with an already-expired AT → fails (dummy RT can't
  refresh) until the next guard re-fetch. Mitigation: shorten guard interval or re-fetch slightly
  earlier; acceptable for a background tool.

## Risks & mitigations
- **Single point of failure:** if the hub's RT dies (owner revoked / rotated elsewhere), the
  hub can't refresh → that auth dies. But it's now ONE failure, not N; the existing
  invalidated-auth handback (commit 04f14f8) prompts the owner to re-login.
- **Codex requires a well-formed RT field** — the dummy must keep the `rt.1.…` shape and be
  present, or codex parse-errors. Encode this in `stripRefreshToken` + a test.
- **Bootstrapping:** owner logs in (real RT) → guard uploads → hub takes custody → owner local
  RT stripped (Phase 4). Until Phase 4 ships, owner still rotates; Phases 1–3 already stop
  *borrowers* from killing the pool.
- **Worker refresh write must be atomic** to avoid serving a half-written blob.

## Rollback
- **Primary (instant, no redeploy):** an admin flips `at_only_mode` off via
  `POST /api/admin/flags` → `fetch-best` immediately returns full credentials again; clients
  re-fetch and get a real RT back. This is the fast kill switch.
- **Deeper fallback:** `git revert` the relevant phase commit and let Vercel redeploy (~1 min),
  if the flag mechanism itself is implicated.
- Phases 1–2 are additive and safe to keep regardless.

## Scope note
- Applies to the pooled subscription auths (codex chatgpt + claude.ai). API-key / setup-token
  paths are out of scope (different billing / scope; see the setup-token research — rejected for
  pooling).
