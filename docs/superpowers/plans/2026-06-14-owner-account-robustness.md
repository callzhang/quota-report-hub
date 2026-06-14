# Owner-Account Robustness for disabled_refresh_token — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make owner accounts self-heal (never dead-lock) under `disabled_refresh_token` mode by (1) alerting on ban/abuse-class errors, (2) collapsing each account to a single pool entry, and (3) giving codex the same proactive worker-side refresh claude already has.

**Architecture:** All changes are server/worker-side (Vercel API + the GitHub-Actions auth-pool worker) — none touch a user's local auth. Each change is gated so the default (flag OFF) behavior is unchanged. The pool keeps `disabled_refresh_token` (hub is the sole RT custodian; borrowers get access-token-only blobs); these fixes keep the hub's copy fresh and unambiguous.

**Tech Stack:** Node ESM (`lib/*.js`, `api/auth/*.js`, `scripts/*.mjs`), node:test, libsql/Turso, Python guard (`skills/quota-reporter/scripts/*.py`) + pytest.

---

## Background — already shipped this session (context, do NOT re-do)

- **keychain-first read** (commit `149b186`): `read_claude_oauth_credentials` on macOS now reads the keychain before `~/.claude/.credentials.json`, so the guard stops reading a stale dummy file and an owner's freshly-relogged-in live RT actually reaches the pool.
- **refresh_current fallback** (commit `972e284`): `api/auth/fetch-best.js` checks the pooled copy's AT via `accessTokenMsUntilExpiry`; if it's already (near) expired it falls through to a normal replacement (a different healthy account) instead of handing back a stale copy of the owner's own account.

## Verified facts the tasks rely on

- `auth_pool_entries` PRIMARY KEY is `(source, account_id, session_id)` (lib/db.js:351). Same account logging in N times ⇒ N rows (different `session_id`).
- `upsertAuthPoolEntry` (lib/db.js) already purges "same email, different account_id" rows **for codex only** (lib/db.js:711-720), right before the `INSERT … ON CONFLICT(${authPoolPkColumns})`.
- `lib/token-refresh.js` already exports `refreshCodexToken(refreshToken, fetchImpl=fetch)`, `applyRefreshToBlob(authJson, source, refreshed, now=Date.now())`, and `accessTokenMsUntilExpiry(authJson, source, now=Date.now())`. codex AT expiry is read from the id_token `exp`.
- The worker (`scripts/probe_auth_pool_worker.mjs`) already has `refreshClaudeEntryIfNeeded(...)` + `const CLAUDE_REFRESH_THRESHOLD_MS = 30 * 60 * 1000` and calls it inside `processAuthPoolEntry` when `atOnlyMode && entry.source === "claude"`. codex has only the passive `refresh_capture` write-back (entry.source === "codex" && refreshCapture?.delta?.refreshed).
- Real error strings seen in the pool today: `auth invalidated (token_invalidated)`, `auth failed (401 unauthorized)`, `claude auth invalid (authentication_error)`, `claude auth email unavailable`. Zero ban/abuse-class errors so far.
- `lib/db.js` exports `authPoolQuotaLatest()` (rows have `source`, `status`, `error`, `account_id`). `scripts/assess_health.mjs` already loads `.env.local`/env and imports `./lib/db.js`.

## File Structure

| File | Responsibility | Tasks |
|------|----------------|-------|
| `lib/abuse-errors.js` (new) | Single source of truth: classify an error string as ban/abuse-class | 1 |
| `scripts/assess_health.mjs` (modify) | Report ban-class errors + non-zero exit when present | 1 |
| `lib/db.js` (modify) | upsert purges other sessions of the same account; one-shot `collapseAuthPoolSessions()` cleanup | 2 |
| `scripts/probe_auth_pool_worker.mjs` (modify) | `refreshCodexEntryIfNeeded` + wire into `processAuthPoolEntry` | 3 |
| `tests/abuse-errors.test.mjs` (new) | classifier unit tests | 1 |
| `tests/audit-log.test.mjs` (modify) | upsert session-collapse + collapse cleanup tests | 2 |
| `tests/probe-auth-pool-worker.test.mjs` (modify) | codex proactive-refresh worker tests | 3 |

---

## Task 1: Ban/abuse-class error monitor

**Files:**
- Create: `lib/abuse-errors.js`
- Create: `tests/abuse-errors.test.mjs`
- Modify: `scripts/assess_health.mjs`

- [ ] **Step 1: Write the failing classifier test**

Create `tests/abuse-errors.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { isAbuseClassError, ABUSE_ERROR_PATTERNS } from "../lib/abuse-errors.js";

test("isAbuseClassError flags ban/abuse/rate-limit wording", () => {
  for (const s of [
    "rate limit exceeded",
    "suspicious activity detected",
    "account locked",
    "account suspended",
    "403 forbidden",
    "Too Many Requests",
  ]) {
    assert.equal(isAbuseClassError(s), true, s);
  }
});

test("isAbuseClassError does NOT flag ordinary RT-failure errors", () => {
  for (const s of [
    "auth invalidated (token_invalidated)",
    "auth failed (401 unauthorized)",
    "claude auth invalid (authentication_error)",
    "claude auth email unavailable",
    null,
    "",
  ]) {
    assert.equal(isAbuseClassError(s), false, String(s));
  }
});

test("ABUSE_ERROR_PATTERNS is a non-empty array of RegExp", () => {
  assert.ok(Array.isArray(ABUSE_ERROR_PATTERNS) && ABUSE_ERROR_PATTERNS.length > 0);
  for (const p of ABUSE_ERROR_PATTERNS) assert.ok(p instanceof RegExp);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/abuse-errors.test.mjs`
Expected: FAIL — `Cannot find module '../lib/abuse-errors.js'`.

- [ ] **Step 3: Implement the classifier**

Create `lib/abuse-errors.js`:

```javascript
// Ban / abuse / rate-limit class errors. These are categorically different from ordinary RT
// failures (token_invalidated / 401 / authentication_error), which mean "refresh token died" —
// NOT "the provider is pushing back on this auth". Sharing one access token across many machines
// is unique to disabled_refresh_token mode, so we watch for provider pushback explicitly.
export const ABUSE_ERROR_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /suspicious/i,
  /suspend/i,
  /\block(ed)?\b/i,
  /\bbanned?\b/i,
  /forbidden/i,
  /\b403\b/,
  /abuse/i,
];

export function isAbuseClassError(error) {
  if (!error || typeof error !== "string") {
    return false;
  }
  return ABUSE_ERROR_PATTERNS.some((p) => p.test(error));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/abuse-errors.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the monitor into assess_health.mjs**

In `scripts/assess_health.mjs`, after the existing `const db = await import(...)` line and before the `poolHealthSnapshots` call, add an abuse scan over the latest quota. Insert this block (uses the already-imported `db`):

```javascript
const { isAbuseClassError } = await import(join(root, "lib/abuse-errors.js"));
const latestForAbuse = await db.authPoolQuotaLatest();
const abuseHits = latestForAbuse.filter((r) => r.status === "error" && isAbuseClassError(r.error));
if (abuseHits.length) {
  console.log(`\n🚨 ABUSE/BAN-CLASS ERRORS DETECTED (${abuseHits.length}) — possible pushback on shared access tokens:`);
  for (const r of abuseHits) console.log(`  ${r.source} ${r.account_id} | ${r.error}`);
  console.log("VERDICT: ABUSE_SUSPECTED — investigate; consider turning disabled_refresh_token OFF.");
  process.exit(3);
}
```

- [ ] **Step 6: Verify assess_health still runs and exits 0 with no abuse errors**

Run: `node scripts/assess_health.mjs 4`
Expected: normal health output, no "ABUSE" line, exit 0 (no ban-class errors in the pool today).

- [ ] **Step 7: Commit**

```bash
git add lib/abuse-errors.js tests/abuse-errors.test.mjs scripts/assess_health.mjs
git commit -m "feat: ban/abuse-class error monitor for shared-AT pushback"
```

---

## Task 2: Collapse each account to a single pool entry

**Files:**
- Modify: `lib/db.js` (upsert purge at lib/db.js:711-720; add `collapseAuthPoolSessions`)
- Modify: `tests/audit-log.test.mjs`

- [ ] **Step 1: Write the failing upsert-collapse test**

In `tests/audit-log.test.mjs`, append a test (it uses the existing `loadDbWithTempStore` helper). Two uploads of the SAME account with DIFFERENT session_id must leave exactly ONE row — the newest:

```javascript
test("upsertAuthPoolEntry collapses the same account to one row (drops other sessions)", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    const codexBlob = (sid) => JSON.stringify({
      tokens: {
        account_id: "acct-uuid",
        refresh_token: "rt.1.REAL" + sid,
        access_token: "AT" + sid,
        id_token: "h." + Buffer.from(JSON.stringify({ email: "u@stardust.ai", sid })).toString("base64url") + ".s",
      },
      last_refresh: sid === "B" ? "2026-06-13T02:00:00Z" : "2026-06-13T01:00:00Z",
    });
    await mod.upsertAuthPoolEntry({ source: "codex", auth_json: codexBlob("A"), uploader_email: "u@stardust.ai" });
    await mod.upsertAuthPoolEntry({ source: "codex", auth_json: codexBlob("B"), uploader_email: "u@stardust.ai" });
    const rows = (await client.execute({ sql: "SELECT session_id FROM auth_pool_entries WHERE source='codex' AND account_id='u@stardust.ai'" })).rows;
    assert.equal(rows.length, 1, "same account must collapse to one row");
  } finally {
    cleanup();
  }
});
```

> Note: codex `account_id` canonicalizes to the email (`u@stardust.ai`). The two blobs differ only by `sid` ⇒ different `session_id`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/audit-log.test.mjs`
Expected: FAIL — `rows.length` is 2 (both sessions kept).

- [ ] **Step 3: Extend the upsert purge to drop other sessions of the same account**

In `lib/db.js`, the block at lines 711-720 currently purges "same email, different account_id" for codex only. Replace that block with a version that (a) applies to BOTH sources and (b) also drops other sessions of the SAME account. Replace:

```javascript
  // Purge stale entries for the same email with a different account_id (e.g. old UUID-based
  // entries from before canonicalCodexAccountId switched to email-based account_ids).
  if (derived.email && derived.source === "codex") {
    await client.execute({
      sql: `DELETE FROM auth_pool_entries WHERE source = ? AND email = ? AND account_id != ?`,
      args: [derived.source, derived.email, derived.account_id],
    });
    await client.execute({
      sql: `DELETE FROM auth_pool_quota_latest WHERE source = ? AND email = ? AND account_id != ?`,
      args: [derived.source, derived.email, derived.account_id],
    });
  }
```

with:

```javascript
  // Collapse each account to a single entry. Same account = same (source, account_id) regardless
  // of session_id; quota is account-level so extra sessions add no value, only stale rows that
  // pollute `latest` and make refresh_current ambiguous. Also purge legacy same-email/diff-account
  // rows (old UUID-based account_ids). Done before INSERT so the fresh row survives.
  await client.execute({
    sql: `DELETE FROM auth_pool_entries WHERE source = ? AND account_id = ? AND session_id IS NOT ?`,
    args: [derived.source, derived.account_id, sessionId],
  });
  if (derived.email) {
    await client.execute({
      sql: `DELETE FROM auth_pool_entries WHERE source = ? AND email = ? AND account_id != ?`,
      args: [derived.source, derived.email, derived.account_id],
    });
    await client.execute({
      sql: `DELETE FROM auth_pool_quota_latest WHERE source = ? AND email = ? AND account_id != ?`,
      args: [derived.source, derived.email, derived.account_id],
    });
  }
```

> `sessionId` is the normalized current session computed earlier in the function (`const sessionId = String(derived.session_id || rawEntry.session_id || '')`). `IS NOT ?` handles NULL/empty session correctly in SQLite.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/audit-log.test.mjs`
Expected: PASS (collapse test + all existing tests).

- [ ] **Step 5: Write the failing one-shot cleanup test**

The deployed pool already has accumulated multi-session rows. Add `collapseAuthPoolSessions()` to remove, per (source, account_id), every row except the newest `uploaded_at`. First the failing test in `tests/audit-log.test.mjs`:

```javascript
test("collapseAuthPoolSessions keeps only the newest row per account", async () => {
  const { mod, client, cleanup } = await loadDbWithTempStore();
  try {
    const ins = async (sid, uploadedAt) => client.execute({
      sql: `INSERT INTO auth_pool_entries (source, account_id, session_id, email, uploaded_at) VALUES ('codex','a@x.ai',?,?,?)`,
      args: [sid, "a@x.ai", uploadedAt],
    });
    await ins("s1", "2026-06-01T00:00:00Z");
    await ins("s2", "2026-06-03T00:00:00Z");
    await ins("s3", "2026-06-02T00:00:00Z");
    const removed = await mod.collapseAuthPoolSessions();
    assert.equal(removed, 2);
    const rows = (await client.execute({ sql: "SELECT session_id FROM auth_pool_entries WHERE account_id='a@x.ai'" })).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, "s2");
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test tests/audit-log.test.mjs`
Expected: FAIL — `mod.collapseAuthPoolSessions is not a function`.

- [ ] **Step 7: Implement `collapseAuthPoolSessions`**

In `lib/db.js`, add this exported function (near `upsertAuthPoolEntry`):

```javascript
// One-shot cleanup for already-accumulated multi-session rows: keep only the newest uploaded_at
// per (source, account_id), delete the rest. Returns the number of rows removed.
export async function collapseAuthPoolSessions() {
  await ensureSchema();
  const result = await client.execute(`
    DELETE FROM auth_pool_entries
    WHERE rowid NOT IN (
      SELECT rowid FROM (
        SELECT rowid,
               ROW_NUMBER() OVER (PARTITION BY source, account_id ORDER BY uploaded_at DESC, rowid DESC) AS rn
        FROM auth_pool_entries
      ) WHERE rn = 1
    )
  `);
  return Number(result.rowsAffected || 0);
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test tests/audit-log.test.mjs`
Expected: PASS.

- [ ] **Step 9: Full suite + commit**

```bash
node --test tests/*.test.mjs
git add lib/db.js tests/audit-log.test.mjs
git commit -m "feat: collapse each pool account to a single entry (drop stale sessions)"
```

- [ ] **Step 10: Run the one-shot cleanup against production (manual, after deploy)**

After this is deployed, run once from the repo root (loads `.env.local`):

```bash
node -e 'import("fs").then(async fs=>{const e=fs.readFileSync(".env.local","utf8");for(const l of e.split("\n")){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["\x27]|["\x27]$/g,"");}const db=await import("./lib/db.js");console.log("removed:", await db.collapseAuthPoolSessions());})'
```
Expected: prints the number of stale session rows removed (the deployed pool should drop from many-per-account to one-per-account).

---

## Task 3: codex proactive worker-side central refresh

**Files:**
- Modify: `scripts/probe_auth_pool_worker.mjs` (mirror `refreshClaudeEntryIfNeeded`)
- Modify: `tests/probe-auth-pool-worker.test.mjs`

- [ ] **Step 1: Write the failing worker test**

In `tests/probe-auth-pool-worker.test.mjs`, append (uses the existing `loadWorkerModule` helper). A codex entry whose AT is near expiry, in atOnlyMode, must be refreshed and written back before probe:

```javascript
test("processAuthPoolEntry centrally refreshes a near-expiry codex auth in atOnlyMode", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  const authWrites = [];
  const now = new Date("2026-06-12T00:00:00Z");
  // id_token exp 5 minutes out -> inside the 30-minute window.
  const idToken = "h." + Buffer.from(JSON.stringify({ exp: Math.floor(now.getTime() / 1000) + 300 })).toString("base64url") + ".s";
  const expiringBlob = JSON.stringify({ tokens: { account_id: "acct-x", id_token: idToken, access_token: "OLD_AT", refresh_token: "REAL_RT" }, last_refresh: "old" });

  const result = await processAuthPoolEntry(
    { source: "codex", account_id: "acct-x", uploader_email: "derek@stardust.ai" },
    {
      atOnlyMode: true,
      nowImpl: () => now,
      decryptAuthJsonImpl: () => expiringBlob,
      refreshCodexTokenImpl: async (rt) => {
        assert.equal(rt, "REAL_RT");
        return { ok: true, access_token: "NEW_AT", refresh_token: "NEW_RT", id_token: idToken, expires_in: 3600 };
      },
      probeCodexAuthJsonImpl: (authJsonText) => {
        assert.equal(JSON.parse(authJsonText).tokens.access_token, "NEW_AT"); // probe sees refreshed AT
        return { source: "codex", account_id: "acct-x", status: "ok", error: null, windows: { "5h": null, "1week": null } };
      },
      upsertAuthPoolQuotaImpl: async () => {},
      upsertAuthPoolEntryImpl: async (entry) => { authWrites.push(entry); return { deduplicated: false }; },
      authPoolQuotaLatestForEntryImpl: async () => null,
    }
  );
  assert.equal(result.codex_refresh.ok, true);
  assert.equal(authWrites.length, 1);
  assert.equal(JSON.parse(authWrites[0].auth_json).tokens.refresh_token, "NEW_RT");
});

test("processAuthPoolEntry leaves codex untouched when atOnlyMode is off", async () => {
  const { processAuthPoolEntry } = await loadWorkerModule();
  let refreshCalled = false;
  const now = new Date("2026-06-12T00:00:00Z");
  const idToken = "h." + Buffer.from(JSON.stringify({ exp: Math.floor(now.getTime() / 1000) + 300 })).toString("base64url") + ".s";
  const blob = JSON.stringify({ tokens: { account_id: "acct-x", id_token: idToken, access_token: "OLD", refresh_token: "REAL_RT" } });
  const result = await processAuthPoolEntry(
    { source: "codex", account_id: "acct-x" },
    {
      atOnlyMode: false,
      nowImpl: () => now,
      decryptAuthJsonImpl: () => blob,
      refreshCodexTokenImpl: async () => { refreshCalled = true; return { ok: true, access_token: "N", refresh_token: "N" }; },
      probeCodexAuthJsonImpl: () => ({ source: "codex", account_id: "acct-x", status: "ok", error: null, windows: { "5h": null, "1week": null } }),
      upsertAuthPoolQuotaImpl: async () => {},
      upsertAuthPoolEntryImpl: async () => ({ deduplicated: false }),
      authPoolQuotaLatestForEntryImpl: async () => null,
    }
  );
  assert.equal(refreshCalled, false);
  assert.equal(result.codex_refresh ?? null, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/probe-auth-pool-worker.test.mjs`
Expected: FAIL — `result.codex_refresh` is undefined / `refreshCodexTokenImpl` not invoked.

- [ ] **Step 3: Add `refreshCodexEntryIfNeeded` + import `refreshCodexToken`**

In `scripts/probe_auth_pool_worker.mjs`, add `refreshCodexToken` to the existing import from `../lib/token-refresh.js`:

```javascript
import { refreshClaudeToken, refreshCodexToken, applyRefreshToBlob, accessTokenMsUntilExpiry } from "../lib/token-refresh.js";
```

Add this constant next to `CLAUDE_REFRESH_THRESHOLD_MS`:

```javascript
const CODEX_REFRESH_THRESHOLD_MS = 30 * 60 * 1000;
```

Add this function right after `refreshClaudeEntryIfNeeded`:

```javascript
function codexRefreshToken(authJsonText) {
  try {
    return JSON.parse(authJsonText)?.tokens?.refresh_token || null;
  } catch {
    return null;
  }
}

// When disabled_refresh_token is on, proactively rotate a near-expiry codex AT (id_token exp)
// and persist the rotated tokens to the pool — mirroring refreshClaudeEntryIfNeeded — so the
// pooled copy stays fresh instead of relying on the passive probe-time refresh_capture path.
async function refreshCodexEntryIfNeeded(
  authJsonText,
  entry,
  { refreshCodexTokenImpl, upsertAuthPoolEntryImpl, nowImpl },
) {
  const msLeft = accessTokenMsUntilExpiry(authJsonText, "codex", nowImpl().getTime());
  if (msLeft !== null && msLeft > CODEX_REFRESH_THRESHOLD_MS) {
    return { authJsonText, result: { attempted: false } };
  }
  const refreshToken = codexRefreshToken(authJsonText);
  if (!refreshToken) {
    return { authJsonText, result: { attempted: false, reason: "no_refresh_token" } };
  }
  const refreshed = await refreshCodexTokenImpl(refreshToken);
  if (!refreshed.ok) {
    return { authJsonText, result: { attempted: true, ok: false, auth_rejected: refreshed.auth_rejected, status: refreshed.status } };
  }
  const refreshedAuthJson = applyRefreshToBlob(authJsonText, "codex", refreshed, nowImpl().getTime());
  await upsertAuthPoolEntryImpl({
    source: "codex",
    auth_json: refreshedAuthJson,
    uploader_email: entry.uploader_email || null,
    reporter_name: "actions@github-actions",
    hostname: "github-actions",
  });
  return { authJsonText: refreshedAuthJson, result: { attempted: true, ok: true } };
}
```

- [ ] **Step 4: Wire it into `processAuthPoolEntry`**

In `processAuthPoolEntry`, add `refreshCodexTokenImpl = refreshCodexToken` to the destructured options (next to `refreshClaudeTokenImpl = refreshClaudeToken`). Then, in the `try` block, extend the claude branch to also handle codex. Replace:

```javascript
  let report;
  let claudeRefreshResult = null;
  try {
    let authJsonText = await decryptAuthJsonImpl(entry);
    if (atOnlyMode && entry.source === "claude") {
      const refreshed = await refreshClaudeEntryIfNeeded(authJsonText, entry, {
        refreshClaudeTokenImpl,
        upsertAuthPoolEntryImpl,
        nowImpl,
      });
      authJsonText = refreshed.authJsonText;
      claudeRefreshResult = refreshed.result;
    }
```

with:

```javascript
  let report;
  let claudeRefreshResult = null;
  let codexRefreshResult = null;
  try {
    let authJsonText = await decryptAuthJsonImpl(entry);
    if (atOnlyMode && entry.source === "claude") {
      const refreshed = await refreshClaudeEntryIfNeeded(authJsonText, entry, {
        refreshClaudeTokenImpl,
        upsertAuthPoolEntryImpl,
        nowImpl,
      });
      authJsonText = refreshed.authJsonText;
      claudeRefreshResult = refreshed.result;
    } else if (atOnlyMode && entry.source === "codex") {
      const refreshed = await refreshCodexEntryIfNeeded(authJsonText, entry, {
        refreshCodexTokenImpl,
        upsertAuthPoolEntryImpl,
        nowImpl,
      });
      authJsonText = refreshed.authJsonText;
      codexRefreshResult = refreshed.result;
    }
```

Then add `codex_refresh: codexRefreshResult,` to BOTH return objects in `processAuthPoolEntry` (the delete-path return and the normal return — each already has a `claude_refresh: claudeRefreshResult,` line; add the codex line right beside it).

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/probe-auth-pool-worker.test.mjs`
Expected: PASS (both new tests + existing).

- [ ] **Step 6: Full suite + commit**

```bash
node --test tests/*.test.mjs && python3 -m pytest tests/ -q
git add scripts/probe_auth_pool_worker.mjs tests/probe-auth-pool-worker.test.mjs
git commit -m "feat: codex proactive worker central refresh (mirror claude)"
```

---

## Task 4: Deploy + document

**Files:**
- Modify: `docs/superpowers/plans/2026-06-12-centralized-token-refresh.md`

- [ ] **Step 1: Append a status section to the centralized-refresh plan**

Add an `## Update — owner-account robustness (2026-06-14)` section to `docs/superpowers/plans/2026-06-12-centralized-token-refresh.md` summarizing: abuse monitor (Task 1), single-entry-per-account (Task 2), codex proactive refresh (Task 3), and the already-shipped keychain-first + refresh_current fallback. One short paragraph each.

- [ ] **Step 2: Deploy + run the one-shot collapse**

```bash
git push origin main
vercel --prod
```
Then run Task 2 Step 10 (the `collapseAuthPoolSessions` one-shot) against production.

- [ ] **Step 3: Trigger a worker run and verify codex refresh + no abuse**

```bash
gh workflow run probe-auth-pool.yml --ref main
# after it completes:
node scripts/assess_health.mjs 4
```
Expected: assess_health exits 0 (no abuse), codex accounts trend healthy, pool has one entry per account.

- [ ] **Step 4: Commit the doc**

```bash
git add docs/superpowers/plans/2026-06-12-centralized-token-refresh.md
git commit -m "docs: record owner-account robustness fixes"
git push origin main
```

---

## Self-Review

**Spec coverage:** (1) abuse monitor → Task 1. (2) single-entry-per-account: upsert collapse + one-shot cleanup → Task 2. (3) codex proactive refresh → Task 3. Already-shipped keychain-first + refresh_current fallback → Background section. Deploy/migrate/doc → Task 4. ✅

**Placeholder scan:** every code step shows full code; every command has expected output. No TBD/TODO. ✅

**Type/name consistency:** `isAbuseClassError`/`ABUSE_ERROR_PATTERNS` (Task 1) used consistently; `collapseAuthPoolSessions` (Task 2) defined + tested + called identically; `refreshCodexEntryIfNeeded`/`codexRefreshResult`/`codex_refresh`/`CODEX_REFRESH_THRESHOLD_MS` (Task 3) consistent with the existing claude counterparts; `refreshCodexToken`/`applyRefreshToBlob`/`accessTokenMsUntilExpiry` match `lib/token-refresh.js` exports. ✅

## Risk notes

- Task 2's upsert collapse is destructive (drops other sessions). It only ever runs when a fresh auth for that account is uploaded, and keeps the just-uploaded row. Multi-device owners converge to one shared pool entry by design (quota is account-level).
- All worker/refresh changes are gated on `atOnlyMode` (the `disabled_refresh_token` flag); with the flag OFF nothing new runs.
- The abuse monitor is read-only; auto-OFF of the flag is intentionally NOT included (avoid false-positive auto-disable) — it exits 3 + prints so a human/loop decides.
