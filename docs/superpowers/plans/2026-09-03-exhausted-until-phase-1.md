# Exhausted-Until First-Class State (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the codex client from fabricating "5h 0% + 1week 0%" window pairs when a usage limit is hit; report the measured fact — "account unusable until T" — as a first-class `exhausted_until` field that the hub accepts, persists, excludes from selection, credits as contribution, and displays.

**Architecture:** The client's usage-limit branch stops synthesizing `zero_remaining_window` pairs and instead sets `exhausted_until` (the reset time the CLI reported) alongside only genuinely measured windows. The hub carries the field through sanitize → merge → `payload_json` (no schema migration: reads come from the stored JSON), teaches the codex acceptance gate and the client's local mirror to accept the new shape, excludes exhausted accounts from selection, counts them as healthy contributions, and renders an "exhausted until T" availability state. Server-side changes land first and accept BOTH shapes, so deploy order is safe by construction (Vercel deploys on push; clients self-update ≥15 min later).

**Tech Stack:** Plain ESM (`lib/**`, run by Vercel) + Python 3 client (`skills/quota-reporter/scripts/**`). Tests: `node --test tests/*.test.mjs`, `python3 -m pytest tests -q`.

**Background (read first):**
- `SYSTEM_DESIGN.md` §6.6 (ingest + merge), §10 (selection), §5 (client replacement triggers).
- The incident this fixes: codex Pro accounts stopped reporting a 5h window on 2026-08-29 (Pro meters none); the client's synthesized "5h 0%" pair from a weekly exhaustion was carried forward five days past its reset and blocked selection of a 96%-weekly account. Commit `a5aab3a` added decision-time expiry as the backstop; this plan removes the fabrication at the source. **Keep `a5aab3a`'s expiry check — it still covers windows that roll over between reports and pre-existing rows.**
- Scope guard: the workspace-out-of-credits branch (`quota_reporters.py:816`) keeps its current behavior. Its reports are already discarded server-side (`hasCompleteWindow` fails on its reset-less windows), and credits-exhaustion has no reset clock, so converting it opens a contribution-semantics question that is deliberately out of Phase 1. The claude 429 retry-after synthesis (`quota_reporters.py:1930`) is likewise out of scope.

**Key invariants (from AGENTS.md — violating these fails review):**
- Doc updates ride in the SAME commit as the behavior they describe. Each task below includes its SYSTEM_DESIGN edit.
- Every behavior change ships a regression test that fails before and passes after.
- No fallback/legacy branches: the old synthesized-pair shape is still *accepted* (old clients exist for ≥1 cycle) but the client code that produced it is deleted, not gated.
- Policy functions stay pure — `exhausted_until` comparisons use `options.now` / the report's own timestamps, never a bare `Date.now()` inside `lib/auth-pool.js` decision code (follow the existing `reportIsFresh(report, options)` pattern).

---

### Task 1: `exhausted_until` through sanitize and merge

**Files:**
- Modify: `lib/reports.js` (sanitizeReport, ~line 71–105)
- Test: `tests/reports.test.mjs`

- [x] **Step 1: Write the failing tests**

Append to `tests/reports.test.mjs`:

```js
test("sanitizeReport normalizes exhausted_until and defaults it to null", () => {
  const withField = sanitizeReport({
    source: "codex",
    account_id: "acct-1",
    reported_at: "2026-09-03T21:45:21Z",
    status: "ok",
    exhausted_until: "2026-09-07T05:26:08Z",
    windows: { "5h": null, "1week": null },
  });
  assert.equal(withField.exhausted_until, "2026-09-07T05:26:08.000Z");

  const without = sanitizeReport({
    source: "codex",
    account_id: "acct-1",
    reported_at: "2026-09-03T21:45:21Z",
    status: "ok",
    windows: { "5h": null, "1week": null },
  });
  assert.equal(without.exhausted_until, null);

  const garbage = sanitizeReport({
    source: "codex",
    account_id: "acct-1",
    reported_at: "2026-09-03T21:45:21Z",
    status: "ok",
    exhausted_until: "not-a-time",
    windows: { "5h": null, "1week": null },
  });
  assert.equal(garbage.exhausted_until, null);
});

test("mergeLatestReport lets a fresh report clear a previous exhausted_until", () => {
  // exhausted_until is per-report evidence: a later report that does not carry it means the
  // exhaustion is over (or was never re-observed). It must never be carried forward the way
  // windows are — sanitizeReport always emits the key, so the merge spread overwrites it.
  const previous = sanitizeReport({
    source: "codex",
    account_id: "acct-1",
    reported_at: "2026-09-03T10:00:00Z",
    status: "ok",
    exhausted_until: "2026-09-07T05:26:08Z",
    windows: { "5h": null, "1week": null },
  });
  const incoming = sanitizeReport({
    source: "codex",
    account_id: "acct-1",
    reported_at: "2026-09-03T11:00:00Z",
    status: "ok",
    windows: {
      "5h": null,
      "1week": { used_percent: 4, remaining_percent: 96, reset_at: "2026-09-07T05:26:08Z" },
    },
  });
  const merged = mergeLatestReport(previous, incoming);
  assert.equal(merged.exhausted_until, null);
  assert.equal(merged.windows["1week"].remaining_percent, 96);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node --test tests/reports.test.mjs`
Expected: 2 new tests FAIL — `exhausted_until` is `undefined`, not the asserted values.

- [x] **Step 3: Implement in `lib/reports.js`**

Add above `sanitizeReport` (next to `toFiniteNumber`):

```js
// "Account unusable until T" is account-level evidence from a limit-hit response, not a window
// measurement — the client reports it instead of fabricating per-window zeros (a codex Pro
// account meters no 5h window; a synthesized "5h 0%" once outlived its reset by five days and
// blocked selection of a 96%-weekly account). Normalized to ISO or null; consumers compare it to
// a clock, so a stale value in the past is inert by construction.
function normalizeExhaustedUntil(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
```

In the `sanitizeReport` return object, after `windows_stale: Boolean(input.windows_stale),` add:

```js
    exhausted_until: normalizeExhaustedUntil(input.exhausted_until),
```

No merge changes are needed: `mergeReportFields` spreads `{...previous, ...incoming}` and sanitized
incoming always carries the key, so it overwrites. (The `return previous` guard branches keep the
previous value — acceptable, since a past `exhausted_until` has no effect anywhere.)

- [x] **Step 4: Run tests to verify they pass**

Run: `node --test tests/reports.test.mjs`
Expected: PASS (all tests in file).

- [x] **Step 5: Update SYSTEM_DESIGN §6.6 (same commit)**

In the `lib/reports.js` bullet list of §6.6, append a bullet:

```markdown
- `exhausted_until` (account unusable until T, from a limit-hit probe) is normalized per report and
  never carried forward: a later report without it clears it, and consumers compare it to a clock so
  a stale past value is inert. It exists so the client reports limit-hits as the account-level fact
  they are, instead of fabricating per-window zeros ([§10](#10-selection-algorithm)).
```

- [x] **Step 6: Commit**

```bash
git add lib/reports.js tests/reports.test.mjs SYSTEM_DESIGN.md
git commit -m "feat: carry exhausted_until through report sanitize and merge"
```

---

### Task 2: Persist, read back, and credit contribution

**Files:**
- Modify: `lib/db.js` — `rowToReport` (~line 99–138), `HEALTHY_POOL_ENTRY_SQL` (~line 1951)
- Create: `tests/exhausted-state-db.test.mjs`

No schema migration: `serializeReport` already stores the full sanitized report as `payload_json`
(`JSON.stringify(report)`, db.js:165), so once Task 1 lands the field is persisted for free.
Reads come from the parsed payload; the one SQL consumer uses `json_extract`.

- [x] **Step 1: Write the failing test**

Create `tests/exhausted-state-db.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const DB_FILE = "quota-report-hub-exhausted-state-test.db";
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.TURSO_AUTH_TOKEN = "test-token";

const { upsertAuthPoolQuota, authPoolQuotaLatestForEntry, fetchPolicyInputs, upsertAuthPoolEntry } =
  await import("../lib/db.js");

test.after(() => {
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

// NOTE: codex pool entries derive account_id from the id_token EMAIL (deriveCodexAuthPoolEntry),
// and the healthy-upload query joins e.account_id = q.account_id — so the quota rows below use the
// email as account_id to match the entry written in the second test.
test("exhausted_until survives the quota-latest roundtrip", async () => {
  await upsertAuthPoolQuota({
    source: "codex",
    account_id: "exhausted@example.com",
    email: "exhausted@example.com",
    plan_name: "Pro",
    reported_at: "2026-09-03T21:45:21Z",
    status: "ok",
    exhausted_until: "2026-09-07T05:26:08Z",
    windows: { "5h": null, "1week": null },
  });
  const report = await authPoolQuotaLatestForEntry({ source: "codex", accountId: "exhausted@example.com" });
  assert.equal(report.exhausted_until, "2026-09-07T05:26:08.000Z");
});

test("an exhausted upload with no windows still counts as a healthy contribution", async () => {
  // Being drained is what a shared account is for (db.js HEALTHY_POOL_ENTRY_SQL comment). An
  // exhaustion report carries no windows, so without the exhausted_until clause the uploader
  // would lose contribution credit at the exact moment their account was drained by the pool.
  await upsertAuthPoolEntry({
    source: "codex",
    auth_json: JSON.stringify({
      tokens: {
        account_id: "provider-acct-1",
        access_token: "x.e30.y",
        refresh_token: "rt.1.REALFIXTURETOKEN",
        id_token: `x.${Buffer.from(JSON.stringify({
          email: "exhausted@example.com",
          "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
        })).toString("base64url")}.y`,
      },
      last_refresh: "2026-09-03T00:00:00Z",
    }),
    uploader_email: "exhausted@example.com",
    reporter_name: "test@host",
    hostname: "host",
  });
  const inputs = await fetchPolicyInputs({
    email: "exhausted@example.com",
    since: "2026-08-01T00:00:00Z",
  });
  assert.equal(inputs.hasHealthyUpload, true);
});
```

(`fetchPolicyInputs({ email, since })` returns `hasHealthyUpload` — verified against the
`has_healthy_upload` EXISTS subquery and its return mapping at lib/db.js:2521-2545.)

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/exhausted-state-db.test.mjs`
Expected: FAIL — `report.exhausted_until` is `undefined` (rowToReport does not expose it) and
`hasHealthyUpload` is `false` (SQL requires a non-null window).

- [x] **Step 3: Implement in `lib/db.js`**

In `rowToReport`, after `windows_stale: Boolean(payload.windows_stale),` add:

```js
    exhausted_until: payload.exhausted_until || null,
```

In `HEALTHY_POOL_ENTRY_SQL`, change the window-presence line:

```sql
  AND (
    q.five_h_remaining_percent IS NOT NULL
    OR q.one_week_remaining_percent IS NOT NULL
    OR json_extract(q.payload_json, '$.exhausted_until') IS NOT NULL
  )
```

with this comment above the changed line:

```js
// An exhaustion report carries no windows — the account was drained, which is what a shared
// account is FOR. json_extract instead of a dedicated column: payload_json is the full sanitized
// report, and this is the only SQL consumer of the field.
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/exhausted-state-db.test.mjs`
Expected: PASS.

- [x] **Step 5: Run the full node suite (schema/SQL changes can break neighbors)**

Run: `npm test`
Expected: all pass.

- [x] **Step 6: Update SYSTEM_DESIGN §6.6 (same commit)**

In §6.6's `lib/quota-ingest.js` paragraph area, wherever the healthy-contribution rule is described
(search for "healthy" in §9b/§6.6 and pick the section that cites `HEALTHY_POOL_ENTRY_SQL`), append:

```markdown
An exhausted account (`exhausted_until` set, no windows) still counts as a healthy contribution —
being drained is what a shared account is for.
```

- [x] **Step 7: Commit**

```bash
git add lib/db.js tests/exhausted-state-db.test.mjs SYSTEM_DESIGN.md
git commit -m "feat: persist exhausted_until and credit exhausted uploads as contributions"
```

---

### Task 3: Accept the new shape at the codex ingest gate

**Files:**
- Modify: `lib/quota-ingest.js` — `codexClientPayloadAccepted` (~line 22–33)
- Test: `tests/quota-ingest.test.mjs`

- [x] **Step 1: Write the failing test**

Append to `tests/quota-ingest.test.mjs`:

```js
test("codexClientPayloadAccepted accepts an exhaustion report without windows", () => {
  assert.equal(codexClientPayloadAccepted({
    account_id: "a",
    status: "ok",
    exhausted_until: "2026-09-07T05:26:08Z",
    windows: { "5h": null, "1week": null },
  }), true);
  // a malformed timestamp is not evidence
  assert.equal(codexClientPayloadAccepted({
    account_id: "a",
    status: "ok",
    exhausted_until: "not-a-time",
    windows: { "5h": null, "1week": null },
  }), false);
  // status must still be ok — an error probe with a leftover field stays rejected
  assert.equal(codexClientPayloadAccepted({
    account_id: "a",
    status: "error",
    error: "codex exec failed",
    exhausted_until: "2026-09-07T05:26:08Z",
  }), false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/quota-ingest.test.mjs`
Expected: FAIL on the first assertion (no windows → currently rejected).

- [x] **Step 3: Implement in `lib/quota-ingest.js`**

Replace the final return of `codexClientPayloadAccepted`:

```js
  return (
    payload?.status === "ok" &&
    (hasCompleteWindow(payload?.windows?.["1week"]) ||
      // A limit-hit probe measures "unusable until T" instead of windows; that is a complete,
      // trustworthy quota fact in its own right (§6.6).
      Number.isFinite(Date.parse(payload?.exhausted_until || "")))
  );
```

Also update the comment above the function ("Codex no longer has a live 5H quota window…") to:

```js
// A client Codex report is trustworthy when the weekly window is complete, when it is a hard
// invalidation, or when it reports exhausted_until (a limit-hit measured "unusable until T").
// Claude has no such gate here.
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/quota-ingest.test.mjs`
Expected: PASS.

- [x] **Step 5: Update SYSTEM_DESIGN §6.6 (same commit)**

In the §6.6 acceptance paragraph, change the sentence describing `codexClientPayloadAccepted` to
mention the third accepted shape:

```markdown
`codexClientPayloadAccepted` requires a *complete* weekly window (`remaining_percent` **and**
`reset_at`), a hard invalidation, or a valid `exhausted_until` timestamp.
```

- [x] **Step 6: Commit**

```bash
git add lib/quota-ingest.js tests/quota-ingest.test.mjs SYSTEM_DESIGN.md
git commit -m "feat: accept codex exhaustion reports at the ingest gate"
```

---

### Task 4: Exclude exhausted accounts from selection

**Files:**
- Modify: `lib/auth-pool.js` — `pickBestAuthPoolCandidate` filter chain (~line 296–303)
- Test: `tests/auth-pool.test.mjs`

- [x] **Step 1: Write the failing test**

Append to `tests/auth-pool.test.mjs`:

```js
test("pickBestAuthPoolCandidate excludes an account exhausted until later than now", () => {
  const reports = [
    {
      source: "codex",
      account_id: "drained",
      status: "ok",
      error: null,
      exhausted_until: "2026-09-07T05:26:08Z",
      windows: { "5h": null, "1week": null },
      reported_at: "2026-09-03T21:45:21Z",
    },
  ];
  const pool = [{ account_id: "drained" }];
  const options = {
    source: "codex",
    current_quota: { five_h_remaining_percent: 0, one_week_remaining_percent: 0 },
    now: "2026-09-03T22:00:00Z",
  };

  assert.equal(pickBestAuthPoolCandidate(reports, pool, options), null);

  // once the exhaustion deadline passes, the field is inert — but the account still has no
  // windows, so it stays unshareable until a real measurement arrives
  assert.equal(
    pickBestAuthPoolCandidate(reports, pool, { ...options, now: "2026-09-07T06:00:00Z" }),
    null
  );
});
```

Note: today this test "passes by accident" for the wrong reason — a windowless codex report already
fails the weekly ≥ 5% threshold. The explicit filter still earns its place: it is the stated
semantics rather than a side effect, and it protects against any future report shape that carries
both `exhausted_until` and (stale but unexpired) windows. Verify the test exercises the filter by
temporarily asserting on a report that ALSO carries a fresh weekly window:

```js
test("pickBestAuthPoolCandidate excludes an exhausted account even when stale windows look healthy", () => {
  const reports = [
    {
      source: "codex",
      account_id: "drained-with-windows",
      status: "ok",
      error: null,
      exhausted_until: "2026-09-07T05:26:08Z",
      windows: {
        "5h": null,
        "1week": { remaining_percent: 96, reset_at: "2026-09-07T05:26:08Z" },
      },
      reported_at: "2026-09-03T21:45:21Z",
    },
  ];
  const pool = [{ account_id: "drained-with-windows" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_quota: { five_h_remaining_percent: 0, one_week_remaining_percent: 0 },
    now: "2026-09-03T22:00:00Z",
  });

  assert.equal(candidate, null);
});
```

- [x] **Step 2: Run tests to verify the second one fails**

Run: `node --test tests/auth-pool.test.mjs`
Expected: `excludes an exhausted account even when stale windows look healthy` FAILS (candidate is
returned today); the first test passes for the accidental reason noted above.

- [x] **Step 3: Implement in `lib/auth-pool.js`**

Add next to `isPoolIneligible`:

```js
// "Unusable until T" from a limit-hit probe. Compared against options.now (the reportIsFresh
// pattern) so the policy layer stays clock-free; a past deadline makes the field inert.
function isExhausted(report, options = {}) {
  const untilMs = Date.parse(report?.exhausted_until || "");
  if (!Number.isFinite(untilMs)) {
    return false;
  }
  const nowMs = options.now ? Date.parse(options.now) : Date.now();
  return Number.isFinite(nowMs) && untilMs > nowMs;
}
```

In `pickBestAuthPoolCandidate`, add to the filter chain directly after
`.filter((report) => !isPoolIneligible(report))`:

```js
    .filter((report) => !isExhausted(report, options))
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node --test tests/auth-pool.test.mjs`
Expected: PASS (all).

- [x] **Step 5: Update SYSTEM_DESIGN §10 (same commit)**

In §10's **Eligibility** paragraph, after the freshness clause, add:

```markdown
An account whose report carries `exhausted_until` later than now is excluded outright — a limit-hit
probe measured it as unusable until then, whatever its (possibly carried-forward) windows claim.
```

- [x] **Step 6: Commit**

```bash
git add lib/auth-pool.js tests/auth-pool.test.mjs SYSTEM_DESIGN.md
git commit -m "feat: exclude exhausted-until accounts from pool selection"
```

---

### Task 5: Availability state for exhausted accounts

**Files:**
- Modify: `lib/account-availability.js` — `deriveAccountAvailability` (~line 152) and `nextTransitionAt` (~line 121)
- Test: `tests/account-availability.test.mjs`

The item passed to `deriveAccountAvailability` is the `annotateFreshness` spread of `rowToReport`
output (reports.js:460), so `item.exhausted_until` is already present after Task 2 — no plumbing.

- [x] **Step 1: Write the failing test**

Append to `tests/account-availability.test.mjs` (module-level, following the existing standalone
test style — reuse the file's `now` constant only if it fits; here we need our own timestamps):

```js
test("deriveAccountAvailability reports an exhausted account as low_quota until its reset", () => {
  const item = {
    source: "codex",
    status: "ok",
    effective_status: "ok",
    reported_at: "2026-09-03T21:45:21Z",
    exhausted_until: "2026-09-07T05:26:08Z",
    display_windows: {},
    refresh_validity: { status: "unverified" },
  };
  const result = deriveAccountAvailability(item, "2026-09-03T22:00:00Z");
  assert.equal(result.state, "low_quota");
  assert.equal(result.reason, "usage_limit_exhausted");
  assert.equal(result.currently_usable, false);
  // nextTransitionAt picks the EARLIEST future transition. The report-staleness boundary
  // (reported_at + 3600s + 1) comes before the exhaustion reset here, and that is correct — a
  // report going stale changes the display before the quota resets. The exhausted_until candidate
  // added in Step 3 becomes the binding transition whenever re-reports keep the row fresh.
  assert.equal(result.next_transition_at, "2026-09-03T22:45:22.000Z");
});

test("deriveAccountAvailability ignores a past exhausted_until", () => {
  const item = {
    source: "codex",
    status: "ok",
    effective_status: "ok",
    reported_at: "2026-09-07T06:00:00Z",
    exhausted_until: "2026-09-07T05:26:08Z",
    display_windows: {
      "1week": { remaining_percent: 96, reset_at: "2026-09-14T00:00:00Z" },
    },
    refresh_validity: { status: "unverified" },
  };
  const result = deriveAccountAvailability(item, "2026-09-07T06:05:00Z");
  assert.notEqual(result.reason, "usage_limit_exhausted");
});
```

- [x] **Step 2: Run tests to verify the first fails**

Run: `node --test tests/account-availability.test.mjs`
Expected: first test FAILS (state is `quota_unknown` today, reason not `usage_limit_exhausted`).

- [x] **Step 3: Implement in `lib/account-availability.js`**

In `deriveAccountAvailability`, after the `if (unavailable) {...}` block and before
`hasExpiredWindow`, insert:

```js
  // A limit-hit probe measured the account as unusable until a known time. This outranks the
  // window-derived states below: the windows of an exhaustion report are empty (or stale
  // carry-forward), but the account state itself is fully known — drained, recovering at T.
  const exhaustedUntilMs = Date.parse(item?.exhausted_until || "");
  if (Number.isFinite(exhaustedUntilMs) && exhaustedUntilMs > generatedAtMs) {
    return withNextTransition(stateResult(
      "low_quota",
      "usage_limit_exhausted",
      "Usage limit exhausted; the provider resets it automatically.",
      null,
      historicalSnapshot,
    ), item, names, generatedAtMs);
  }
```

In `nextTransitionAt`, after the `auth_expires_at` candidate, add:

```js
  const exhaustedMs = Date.parse(item?.exhausted_until || "");
  if (Number.isFinite(exhaustedMs)) candidates.push(exhaustedMs);
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node --test tests/account-availability.test.mjs`
Expected: PASS (all).

- [x] **Step 5: Update SYSTEM_DESIGN (same commit)**

In the section describing the availability read model (§6.4 — search for
`waiting_for_new_quota`), add to the state list/prose:

```markdown
An account with `exhausted_until` in the future renders as `low_quota` /
`usage_limit_exhausted` with the reset moment as its next transition — measured-drained, not
unknown.
```

- [x] **Step 6: Commit**

```bash
git add lib/account-availability.js tests/account-availability.test.mjs SYSTEM_DESIGN.md
git commit -m "feat: render exhausted-until accounts as measured low_quota"
```

---

### Task 6: Client — stop fabricating windows in the usage-limit branch

**Files:**
- Modify: `skills/quota-reporter/scripts/quota_reporters.py` — the `quota_exhausted` payload (~line 876–899)
- Modify: `skills/quota-reporter/scripts/quota_guard.py` — `source_needs_replacement` (~line 323)
- Test: `tests/reporter_scripts_test.py`

**Server must already be deployed with Tasks 1–5 when this lands** — which is automatic: one push
deploys Vercel immediately, while clients pull from `main` on their next 15-minute cycle. The server
keeps accepting the old synthesized-pair shape, so mixed fleets are safe in both directions.

**Critical trap:** today the fabricated zero windows are what trip the client's own rotation
(`source_needs_replacement` returns False when both windows are absent, quota_guard.py:335). If the
probe stops fabricating windows without teaching the trigger about `exhausted_until`, an exhausted
machine would sit on its dead account and never ask for a replacement. Both changes land together
in this task.

- [x] **Step 1: Rewrite the four synthesis tests to assert the new shape**

In `tests/reporter_scripts_test.py`, keep every fixture (auth file, mocked `subprocess.run`,
mocked `latest_token_count_event`) exactly as it is and change ONLY the trailing assertion blocks
(and the test names). The four tests and their new assertion blocks:

`test_probe_codex_maps_usage_limit_event_to_zero_remaining_windows` (line ~775) → rename to
`test_probe_codex_reports_usage_limit_as_exhausted_until`:

```python
        self.assertEqual(report["status"], "ok")
        self.assertIsNone(report["error"])
        self.assertIsNone(report["windows"]["5h"])
        self.assertIsNone(report["windows"]["1week"])
        self.assertIsNotNone(report["exhausted_until"])
        self.assertEqual(report["exhausted_until"], report["usage_summary"]["next_retry_at"])
        self.assertEqual(report["usage_summary"]["credits"]["balance"], "0")
```

`test_probe_codex_maps_structured_reset_to_zero_remaining_windows` (line ~897) → rename to
`test_probe_codex_reports_structured_reset_as_exhausted_until`:

```python
        self.assertEqual(report["status"], "ok")
        self.assertIsNone(report["windows"]["5h"])
        self.assertIsNone(report["windows"]["1week"])
        self.assertIsNotNone(report["exhausted_until"])
        self.assertEqual(report["exhausted_until"], report["usage_summary"]["next_retry_at"])
```

(The old `reset_in_seconds == 900` assertion has no home in the new shape; the reset moment itself
is `exhausted_until`.)

`test_probe_codex_maps_rate_limited_exhausted_window_to_zero_remaining_windows` (line ~955) →
rename to `test_probe_codex_reports_rate_limited_exhaustion_as_exhausted_until`:

```python
        self.assertEqual(report["status"], "ok")
        self.assertIsNone(report["windows"]["5h"])
        self.assertIsNone(report["windows"]["1week"])
        self.assertEqual(report["exhausted_until"], "2026-04-22T16:30:00Z")
        self.assertEqual(report["usage_summary"]["rate_limit_reached_type"], "rate_limited")
        self.assertEqual(report["usage_summary"]["next_retry_at"], "2026-04-22T16:30:00Z")
```

`test_probe_codex_maps_partial_missing_window_usage_limit_to_zero_remaining_windows` (line ~1068) →
rename to `test_probe_codex_reports_partial_missing_window_usage_limit_as_exhausted_until`:

```python
        self.assertEqual(report["status"], "ok")
        self.assertIsNone(report["error"])
        self.assertIsNone(report["windows"]["5h"])
        self.assertIsNone(report["windows"]["1week"])
        self.assertIsNotNone(report["exhausted_until"])
        self.assertEqual(report["exhausted_until"], report["usage_summary"]["next_retry_at"])
```

Leave `test_probe_codex_does_not_create_zero_windows_without_reset_time` (line ~840) untouched —
no reset time means no `exhausted_until` either; it must keep asserting `status == "error"`. Add
one assertion to it:

```python
        self.assertIsNone(report.get("exhausted_until"))
```

Leave `test_probe_codex_maps_workspace_out_of_credits_to_zero_remaining_windows` (line ~1182)
untouched (workspace-credits branch is out of scope).

- [x] **Step 2: Add the rotation-trigger test**

Append to the quota_guard test class in `tests/reporter_scripts_test.py` (find the class that
imports from `quota_guard`; follow its import style):

```python
    def test_source_needs_replacement_triggers_on_exhausted_until(self):
        payload = {
            "account_id": "acct-1",
            "status": "ok",
            "exhausted_until": "2026-09-07T05:26:08Z",
            "windows": {"5h": None, "1week": None},
        }
        self.assertTrue(source_needs_replacement(payload, 20.0, 5.0))

    def test_source_needs_replacement_still_ignores_windowless_healthy_payloads(self):
        payload = {
            "account_id": "acct-1",
            "status": "ok",
            "windows": {"5h": None, "1week": None},
        }
        self.assertFalse(source_needs_replacement(payload, 20.0, 5.0))
```

(`source_needs_replacement` must be added to the test file's `quota_guard` import list if not
already there.)

- [x] **Step 3: Run tests to verify the rewritten/new ones fail**

Run: `python3 -m pytest tests/reporter_scripts_test.py -q`
Expected: the four rewritten probe tests FAIL (windows are still fabricated,
`exhausted_until` missing) and `test_source_needs_replacement_triggers_on_exhausted_until` FAILS.

- [x] **Step 4: Implement the probe change in `quota_reporters.py`**

In the usage-limit branch (the `if rate_limits and not has_complete_windows and
codex_usage_limit_reached(...)` block), replace the final quota-exhausted payload (the one
currently building `"windows": {"5h": zero_remaining_window(300, ...), "1week":
zero_remaining_window(10080, ...)}`) with:

```python
        payload = {
            **base,
            "model_context_window": info.get("model_context_window") if isinstance(info, dict) else None,
            "plan_name": human_plan_name(rate_limits.get("plan_type")) or metadata["plan_name"],
            "status": "ok",
            "error": None,
            # A limit-hit is account-level evidence ("unusable until T"), not a window
            # measurement. Fabricating per-window zeros here is how a Pro account — which meters
            # no 5h window at all — once carried a synthetic "5h 0%" five days past its reset and
            # was locked out of pool selection at 96% weekly quota. Only genuinely measured
            # windows are reported.
            "exhausted_until": reset_at,
            "windows": windows,
            "usage_summary": {
                "credits": rate_limits.get("credits"),
                "rate_limit_reached_type": rate_limits.get("rate_limit_reached_type"),
                "next_retry_at": reset_at,
            },
        }
```

(`windows` is the `codex_windows_from_rate_limits` result computed earlier in `probe_codex` —
the measured windows, possibly `{"5h": None, "1week": None}`.)

If `zero_remaining_window` is now referenced only by the workspace-credits branch, leave it; if it
becomes fully unreferenced, delete it (no dead code).

- [x] **Step 5: Implement the trigger change in `quota_guard.py`**

In `source_needs_replacement`, after the `if payload.get("status") != "ok": return False` line,
insert:

```python
    # A limit-hit probe reports no windows at all — "unusable until T" travels as
    # exhausted_until. The payload here is this run's fresh probe result, so any exhausted_until
    # it carries is current by construction; no clock comparison needed.
    if payload.get("exhausted_until"):
        return True
```

- [x] **Step 6: Run the python suite**

Run: `python3 -m pytest tests -q`
Expected: all pass.

- [x] **Step 7: Update SYSTEM_DESIGN §5 (same commit)**

In the §5 paragraph describing quota-based replacement (the one beginning "Quota-based replacement
uses `5h_remaining < 20%`…"), append:

```markdown
A codex limit-hit probe reports `exhausted_until` instead of fabricated zero windows, and
`source_needs_replacement` treats its presence as an immediate replacement trigger.
```

- [x] **Step 8: Commit**

```bash
git add skills/quota-reporter/scripts/quota_reporters.py skills/quota-reporter/scripts/quota_guard.py tests/reporter_scripts_test.py SYSTEM_DESIGN.md
git commit -m "feat: report codex limit-hits as exhausted_until instead of fabricated zero windows"
```

---

### Task 7: Client — accept the new shape in the local reportability mirror

**Files:**
- Modify: `skills/quota-reporter/scripts/quota_guard.py` — `quota_payload_is_reportable` (~line 390)
- Test: `tests/reporter_scripts_test.py`

Without this, the client would produce the new payload and then refuse to post it (the mirror
predicts the hub's acceptance to avoid burning requests, and it does not know the new shape yet).

- [x] **Step 1: Write the failing test**

Append to the quota_guard test class:

```python
    def test_quota_payload_is_reportable_accepts_codex_exhaustion(self):
        payload = {
            "account_id": "acct-1",
            "status": "ok",
            "exhausted_until": "2026-09-07T05:26:08Z",
            "windows": {"5h": None, "1week": None},
        }
        self.assertTrue(quota_payload_is_reportable("codex", payload))
```

- [x] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/reporter_scripts_test.py -q -k reportable`
Expected: FAIL (no complete weekly window → not reportable today).

- [x] **Step 3: Implement in `quota_guard.py`**

In `quota_payload_is_reportable`'s codex branch, add one clause to the `bool(...)` expression,
directly after the complete-window clause:

```python
            or (payload.get("status") == "ok" and bool(payload.get("exhausted_until")))
```

Update the function's docstring line to keep the mirror claim honest:

```python
    Mirrors codexClientPayloadAccepted / ingestClientQuota in lib/quota-ingest.js -- posting a
    payload the hub will discard just burns a request. Accepted codex shapes: complete weekly
    window, hard invalidation, or exhausted_until.
```

- [x] **Step 4: Run the full python suite**

Run: `python3 -m pytest tests -q`
Expected: all pass.

- [x] **Step 5: Run the full node suite once more (whole-phase check)**

Run: `npm test`
Expected: all pass.

- [x] **Step 6: Commit**

```bash
git add skills/quota-reporter/scripts/quota_guard.py tests/reporter_scripts_test.py
git commit -m "feat: teach the client reportability mirror the exhausted_until shape"
```

---

## Post-plan verification (manual, read-only)

After deploy, confirm against production data (read-only Turso queries, per AGENTS.md):

1. Next time any codex account hits its usage limit, its `auth_pool_quota_latest.payload_json`
   should carry `exhausted_until` and NO synthesized `"5h"` block.
2. `auth/fetch-best` responses should never serve an account whose `exhausted_until` is in the
   future (check `auth_pool_fetch_log` joined against `payload_json`).
3. The uploader of an exhausted account keeps `hasHealthyUpload = true` (premium-gate inputs).

## Known follow-ups (explicitly NOT in this plan)

- **Phase 2:** soft errors stop touching quota rows (probe-health track split; removes window
  carry-forward). Depends on this phase's `exhausted_until` existing.
- **Phase 3:** credential state split (AT validity from client probes, RT validity only from
  central-refresh actions/verified uploads); replaces the sticky central-refresh merge rules.
- **Phase 4:** minimum-protocol-version gate at ingest, phased with kill switch per §9b/§17.3.
- Workspace-out-of-credits branch still fabricates windows the server discards (mirror drift:
  `quota_payload_is_confirmed_out_of_credits` says reportable, `codexClientPayloadAccepted` says
  no). Needs its own decision on contribution semantics for creditless workspaces.
- Claude 429 retry-after still synthesizes a 5h window (`quota_reporters.py:1930`); converting it
  to `exhausted_until` for consistency is a candidate once codex proves the shape out.
- Scarcity burn estimation (`recomputePoolScarcity`) reads quota events, and exhaustion reports now
  contribute null windows where they used to contribute synthesized zeros. Direction of drift:
  the pool looks slightly less burned, scarcity fires later — consistent with the "rationing fails
  open" invariant, but worth a look when tuning scarcity.
