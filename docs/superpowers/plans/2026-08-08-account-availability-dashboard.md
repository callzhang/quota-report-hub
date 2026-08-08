# Account Availability Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace parallel technical status lines with one availability-first account state, add lazy latest/24-hour quota diagnostics, and change automatic refresh from full-status polling to revision-driven reads.

**Architecture:** Keep current account assembly in `lib/reports.js`, derive a presentation-neutral availability object in a focused module, and render it in the static dashboard. Add one singleton dashboard revision row for cheap change detection and one exact-account, 24-hour history endpoint backed by the existing quota-event index; history loads only when its popover opens and is cached in the browser.

**Tech Stack:** Node.js 20, Vercel serverless handlers, `@libsql/client`/Turso, static HTML/CSS/JavaScript, Node test runner.

---

## File structure

- Create `lib/account-availability.js`: pure state precedence, quota selection, reasons, and summary text.
- Create `api/status-revision.js`: authenticated lightweight revision response.
- Create `api/quota-history.js`: authenticated, exact-account 24-hour quota history response.
- Create `tests/account-availability.test.mjs`: state-model unit tests.
- Create `tests/status-revision-api.test.mjs`: revision endpoint tests.
- Create `tests/quota-history-api.test.mjs`: history endpoint boundary tests.
- Modify `lib/db.js`: revision schema/read/write helpers and bounded history query.
- Modify `lib/reports.js`: attach derived availability to each current account item.
- Modify `api/status.js`: return the revision loaded alongside current status.
- Modify `index.html`: availability-first row, popover, chart, revision polling, history cache.
- Modify `tests/audit-log.test.mjs`: database revision and indexed history behavior.
- Modify `tests/dashboard-static.test.mjs`: static UI/polling/accessibility contracts.
- Modify `tests/db-read-budget-static.test.mjs`: prevent routine paths from scanning history.
- Modify `README.md` and `SYSTEM_DESIGN.md`: runtime behavior, endpoints, schema, and read budget.

### Task 1: Pure availability state model

**Files:**
- Create: `lib/account-availability.js`
- Create: `tests/account-availability.test.mjs`
- Modify: `lib/reports.js` in `annotateFreshness`

- [ ] **Step 1: Write failing state-model tests**

Create table-driven tests that call `deriveAccountAvailability(item)` with a fixed generated time and assert exact state precedence:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { deriveAccountAvailability } from "../lib/account-availability.js";

const now = "2026-08-08T07:37:12Z";

test("expired successful probe waits for a new quota check", () => {
  const result = deriveAccountAvailability({
    source: "codex",
    effective_status: "ok",
    reported_at: "2026-08-08T07:24:12Z",
    display_windows: {
      "1week": {
        remaining_percent: 0,
        reset_at: "2026-08-08T07:30:26Z",
        reset_unavailable_reason: "quota_window_expired",
      },
    },
    refresh_validity: { status: "unverified" },
  }, now);
  assert.equal(result.state, "waiting_for_new_quota");
  assert.equal(result.currently_usable, false);
  assert.equal(result.historical_snapshot.remaining_percent, 0);
  assert.equal(result.historical_snapshot.captured_at, "2026-08-08T07:24:12Z");
});

test("rejected refresh overrides historical quota", () => {
  const result = deriveAccountAvailability({
    source: "codex",
    refresh_validity: { status: "rejected" },
    display_windows: { "1week": { remaining_percent: 99, reset_at: "2026-08-15T00:00:00Z" } },
  }, now);
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "refresh_token_rejected");
});

test("valid quota below the codex share threshold is low quota", () => {
  const result = deriveAccountAvailability({
    source: "codex",
    refresh_validity: { status: "unverified" },
    display_windows: { "1week": { remaining_percent: 3, reset_at: "2026-08-15T00:00:00Z" } },
  }, now);
  assert.equal(result.state, "low_quota");
  assert.equal(result.currently_usable, false);
});
```

Also cover `available`, missing quota as `quota_unknown`, Claude requiring both live 5-hour and weekly windows, account ineligibility, and access-token expiry that cannot be recovered.

- [ ] **Step 2: Run the unit test and verify RED**

Run: `node --test tests/account-availability.test.mjs`

Expected: FAIL because `lib/account-availability.js` does not exist.

- [ ] **Step 3: Implement the pure derivation module**

Export one function with no database or DOM dependency:

```js
export function deriveAccountAvailability(item, generatedAt = new Date().toISOString()) {
  // Return: state, currently_usable, reason, tone, summary,
  // current_quota, historical_snapshot.
}
```

Use the existing share thresholds: Codex weekly quota must be at least 5%; Claude must have at least 20% in 5-hour and 5% weekly. Apply the approved precedence exactly: unavailable, waiting, unknown, low, available. Preserve the latest quota value, `reported_at`, and `reset_at` in `historical_snapshot` whenever the value exists but is not current.

- [ ] **Step 4: Attach availability to status items**

In `annotateFreshness`, build the annotated item first, then add:

```js
return {
  ...annotated,
  availability: deriveAccountAvailability(annotated, generatedAt),
};
```

- [ ] **Step 5: Run focused and report tests**

Run: `node --test tests/account-availability.test.mjs tests/reports.test.mjs`

Expected: all tests PASS, including the expired successful-probe regression.

- [ ] **Step 6: Commit**

```bash
git add lib/account-availability.js lib/reports.js tests/account-availability.test.mjs tests/reports.test.mjs
git commit -m "feat: derive account availability from current quota"
```

### Task 2: Singleton dashboard revision

**Files:**
- Modify: `lib/db.js` in schema setup and dashboard-visible write functions
- Modify: `tests/audit-log.test.mjs`
- Modify: `tests/db-read-budget-static.test.mjs`

- [ ] **Step 1: Write failing database tests**

Add tests proving a singleton revision starts at zero, increments monotonically, and changes after quota, auth, flag, health, and displayed fetch-state writes:

```js
const before = await mod.dashboardRevision();
await mod.bumpDashboardRevision("2026-08-08T08:00:00Z");
const after = await mod.dashboardRevision();
assert.equal(after.revision, before.revision + 1);
assert.equal(after.updated_at, "2026-08-08T08:00:00Z");
```

Add a static test that extracts `dashboardRevision` and asserts it does not reference auth entries, quota latest, quota events, fetch logs, or health snapshots.

- [ ] **Step 2: Run database tests and verify RED**

Run: `node --test tests/audit-log.test.mjs tests/db-read-budget-static.test.mjs`

Expected: FAIL because revision schema and functions do not exist.

- [ ] **Step 3: Add schema and helpers**

Add one singleton table:

```sql
CREATE TABLE IF NOT EXISTS dashboard_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
)
```

Seed it with `INSERT OR IGNORE` for singleton `1`, revision `0`. Export:

```js
export async function dashboardRevision() {
  await ensureSchema();
  const result = await client.execute({
    sql: "SELECT revision, updated_at FROM dashboard_revision WHERE singleton = 1",
    args: [],
  });
  return {
    revision: Number(result.rows[0]?.revision || 0),
    updated_at: result.rows[0]?.updated_at || null,
  };
}

export async function bumpDashboardRevision(updatedAt = new Date().toISOString()) {
  await ensureSchema();
  await client.execute({
    sql: `UPDATE dashboard_revision
          SET revision = revision + 1, updated_at = ?
          WHERE singleton = 1`,
    args: [updatedAt],
  });
  return dashboardRevision();
}
```

- [ ] **Step 4: Increment revision from visible writes**

Call `bumpDashboardRevision` only after successful writes that affect the dashboard: auth upload/delete, latest quota update, invalidation state transition, feature flag, health snapshot, and fetch event displayed by the dashboard. Do not increment on rejected/no-op writes. Where a function already executes a batch, append the revision update to that batch so current data and revision cannot diverge.

- [ ] **Step 5: Verify database tests and full suite**

Run: `node --test tests/audit-log.test.mjs tests/db-read-budget-static.test.mjs && npm test`

Expected: all tests PASS and the revision helper remains a singleton read.

- [ ] **Step 6: Commit**

```bash
git add lib/db.js tests/audit-log.test.mjs tests/db-read-budget-static.test.mjs
git commit -m "feat: track dashboard data revisions"
```

### Task 3: Revision API and revision-driven browser refresh

**Files:**
- Create: `api/status-revision.js`
- Create: `tests/status-revision-api.test.mjs`
- Modify: `api/status.js`
- Modify: `index.html` near `load` and refresh timer
- Modify: `tests/dashboard-static.test.mjs`

- [ ] **Step 1: Write failing endpoint tests**

Test that missing auth returns `401`, database unavailability follows the existing service-unavailable contract, and valid auth returns only revision metadata plus an upgraded user token when applicable:

```js
assert.deepEqual(JSON.parse(res.body), {
  revision: 42,
  updated_at: "2026-08-08T08:00:00Z",
});
```

Assert that endpoint dependencies include `dashboardRevision` but none of the full-status readers.

- [ ] **Step 2: Run endpoint tests and verify RED**

Run: `node --test tests/status-revision-api.test.mjs`

Expected: FAIL because `api/status-revision.js` does not exist.

- [ ] **Step 3: Implement the revision handler**

Follow `api/status.js` authentication/error patterns. Authenticate, read the singleton revision, return JSON, and use `withTokenUpgrade` without loading pool entries, reports, history, fetch logs, or health history.

- [ ] **Step 4: Return the loaded revision from full status**

Load `dashboardRevision()` in the existing `Promise.all` and add:

```js
dataset.dashboard_revision = revision.revision;
dataset.dashboard_updated_at = revision.updated_at;
```

- [ ] **Step 5: Write failing browser-contract tests**

Replace the current unconditional visible timer assertions with contracts for:

```js
assert.match(html, /async function checkDashboardRevision\(\)/);
assert.match(html, /fetch\("\/api\/status-revision"/);
assert.match(html, /if \(payload\.revision !== loadedDashboardRevision\) \{\s*await load\(\);/);
assert.match(html, /setInterval\(checkDashboardRevision, DASHBOARD_REFRESH_MS\)/);
assert.doesNotMatch(html, /setInterval\(refreshWhenVisible/);
```

- [ ] **Step 6: Implement revision-driven refresh**

Track `loadedDashboardRevision`. A successful full load updates it from `payload.dashboard_revision`. The one-minute timer and `visibilitychange` call `checkDashboardRevision`; only a changed revision calls `load`. Deduplicate concurrent revision and full-status requests. Preserve the existing rule that hidden tabs do nothing and transient errors do not reveal login.

- [ ] **Step 7: Run focused tests and commit**

Run: `node --test tests/status-revision-api.test.mjs tests/status-api.test.mjs tests/dashboard-static.test.mjs`

Expected: all tests PASS.

```bash
git add api/status-revision.js api/status.js index.html tests/status-revision-api.test.mjs tests/status-api.test.mjs tests/dashboard-static.test.mjs
git commit -m "feat: refresh dashboard only when data changes"
```

### Task 4: Bounded 24-hour quota history API

**Files:**
- Modify: `lib/db.js` in `authPoolQuotaEvents`
- Create: `api/quota-history.js`
- Create: `tests/quota-history-api.test.mjs`
- Modify: `tests/audit-log.test.mjs`
- Modify: `tests/db-read-budget-static.test.mjs`

- [ ] **Step 1: Write failing bounded-query tests**

Insert events before and within a fixed 24-hour cutoff for two accounts. Assert the query returns only the requested source/account, excludes the old event, orders chronologically, and caps results:

```js
const events = await mod.authPoolQuotaEvents({
  source: "codex",
  accountId: "acct-history",
  since: "2026-08-07T08:00:00Z",
  limit: 96,
});
assert.deepEqual(events.map((event) => event.reported_at), [
  "2026-08-07T09:00:00Z",
  "2026-08-08T07:00:00Z",
]);
```

Add a static assertion that the exact-account query contains `source = ?`, `account_id = ?`, and `reported_at >= ?`, and uses a finite `LIMIT`.

- [ ] **Step 2: Run history database tests and verify RED**

Run: `node --test tests/audit-log.test.mjs tests/db-read-budget-static.test.mjs`

Expected: FAIL because `since` is not enforced and ordering does not meet the chart contract.

- [ ] **Step 3: Implement the indexed bounded query**

Require nonempty exact `source`, `accountId`, and `since` for the dashboard history path. Query descending with a capped limit using the existing index, then reverse the bounded result in application code for chronological output. Never select encrypted auth columns.

- [ ] **Step 4: Write failing API tests**

Cover authentication, required exact parameters, URL decoding, a fixed 24-hour cutoff, maximum 96 events, source/account isolation, safe response fields, and service errors. Reject missing or malformed parameters with `400` without calling the database.

- [ ] **Step 5: Implement `api/quota-history.js`**

Return this minimal shape:

```js
{
  source,
  account_id,
  from,
  generated_at,
  points: events.map((event) => ({
    reported_at: event.reported_at,
    status: event.status,
    error: event.error,
    five_h_remaining_percent: event.windows?.["5h"]?.remaining_percent ?? null,
    five_h_reset_at: event.windows?.["5h"]?.reset_at ?? null,
    one_week_remaining_percent: event.windows?.["1week"]?.remaining_percent ?? null,
    one_week_reset_at: event.windows?.["1week"]?.reset_at ?? null,
  })),
}
```

- [ ] **Step 6: Run tests and commit**

Run: `node --test tests/quota-history-api.test.mjs tests/audit-log.test.mjs tests/db-read-budget-static.test.mjs`

Expected: all tests PASS.

```bash
git add lib/db.js api/quota-history.js tests/quota-history-api.test.mjs tests/audit-log.test.mjs tests/db-read-budget-static.test.mjs
git commit -m "feat: expose bounded account quota history"
```

### Task 5: Availability-first row and lazy accessible popover

**Files:**
- Modify: `index.html` styles, account row rendering, and client behavior
- Modify: `tests/dashboard-static.test.mjs`

- [ ] **Step 1: Write failing static UI tests**

Assert the collapsed status cell calls `availabilityCell(item)`, does not render the four existing state lines, and includes an accessible popover trigger:

```js
assert.match(html, /function availabilityCell\(item\)/);
assert.match(html, /aria-expanded="false"/);
assert.match(html, /role="dialog"/);
assert.doesNotMatch(html, /\$\{tokenStateLine\(item\)\}/);
assert.doesNotMatch(html, /\$\{quotaSnapshotLine\(item\)\}/);
assert.doesNotMatch(html, /\$\{refreshValidityLine\(item\)\}/);
```

Assert history code has a five-minute cache, one in-flight promise per account, an exact encoded source/account URL, pointer/focus/touch activation, outside/Escape close behavior, and explicit history error/empty text.

- [ ] **Step 2: Run dashboard tests and verify RED**

Run: `node --test tests/dashboard-static.test.mjs`

Expected: FAIL because the availability cell and popover do not exist.

- [ ] **Step 3: Implement the collapsed availability cell**

Render `item.availability.state`, summary, current quota, and reset countdown. Use text plus an icon and tone class. Do not render Probe, Token, Quota, or Refresh as peer states in the collapsed row.

- [ ] **Step 4: Implement latest snapshot diagnostics**

Populate the popover synchronously from the current item. If the snapshot is historical, show its value in gray with exact capture and reset times plus `Historical - not current quota`. Include last probe, token upload, access expiry, refresh state, and actual refresh-check time.

- [ ] **Step 5: Implement lazy history loading and cache**

Use:

```js
const HISTORY_CACHE_MS = 5 * 60 * 1000;
const quotaHistoryCache = new Map();
const quotaHistoryInFlight = new Map();
```

On first open, request `/api/quota-history?source=${encodeURIComponent(source)}&account_id=${encodeURIComponent(accountId)}` with the bearer token. Reuse cached data for five minutes and reuse the same promise while a request is in flight.

- [ ] **Step 6: Render the 24-hour SVG chart**

Render source-appropriate series without external chart dependencies. Preserve gaps for null values, gray historical/expired segments, mark reset boundaries when they fall inside the range, and provide a textual point list or accessible labels containing exact timestamp/value pairs. Do not infer values between points.

- [ ] **Step 7: Implement accessible interactions**

Open on pointer hover after a short intent delay, keyboard focus, or touch/click. Keep the popover open while pointer/focus is inside it. Close on outside click or Escape, restore trigger focus, and update `aria-expanded`.

- [ ] **Step 8: Run focused tests and commit**

Run: `node --test tests/dashboard-static.test.mjs`

Expected: all tests PASS.

```bash
git add index.html tests/dashboard-static.test.mjs
git commit -m "feat: show availability-first quota diagnostics"
```

### Task 6: Documentation, full verification, and production rollout

**Files:**
- Modify: `README.md`
- Modify: `SYSTEM_DESIGN.md`

- [ ] **Step 1: Update runtime documentation**

Document the five primary states, historical snapshot semantics, lazy 24-hour history, revision endpoint, singleton revision table, one-minute lightweight checks, five-minute browser history cache, and the rule that only explicit `401` displays login.

- [ ] **Step 2: Run complete verification**

Run:

```bash
npm test
git diff --check
git status --short
```

Expected: all tests PASS, no whitespace errors, and only intended files are modified. Preserve unrelated user changes and do not include them in feature commits.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md SYSTEM_DESIGN.md
git commit -m "docs: describe availability dashboard read model"
```

- [ ] **Step 4: Push and verify production deployment**

Run `git push origin main`, then read the GitHub/Vercel deployment status for the exact pushed commit until it reports `Production` and `success`. Confirm local HEAD and `origin/main` resolve to the same commit. Do not report completion from push success alone.

- [ ] **Step 5: Perform authenticated production readback**

Using the existing local Hub credential without printing it, verify:

- `/api/status-revision` returns a revision;
- `/api/status` includes the same dashboard revision and account availability;
- one exact-account `/api/quota-history` response is bounded to 24 hours and contains no auth material;
- a second revision read with unchanged data does not require a full status request in the browser contract.

Report deployment and readback separately from local test results.
