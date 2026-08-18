# Team Token Usage Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect privacy-safe Codex and Claude token deltas from every quota-reporter installation, store team usage at 15-minute granularity, and expose a separately queried analytics page grouped by Hub user, provider account, and raw model.

**Architecture:** Reuse the existing 15-minute `quota_guard`, but isolate collection behind three focused Python modules for provider parsing, crash-safe local SQLite state, and orchestration/upload. Add a separately authenticated ingestion API, indexed detail/daily tables, bounded query API, and daily compaction in the existing Vercel/Turso application; the static Token Usage page loads only when opened and caches identical queries for five minutes.

**Tech Stack:** Python 3 standard library (`sqlite3`, `json`, `urllib`), Node.js 20, Vercel serverless handlers, `@libsql/client`/Turso, static HTML/CSS/JavaScript/SVG, Node test runner, Python `unittest`.

---

## Scope and execution order

This is one end-to-end feature with three dependency-ordered phases:

1. **Server foundation:** contracts, schema, atomic ingestion, bounded query, and retention.
2. **Local collection:** state transactions, Codex/Claude parsing, 72-hour backfill, account attribution, and `quota_guard` integration.
3. **Team analytics UI and rollout:** independent page, query cache, accessible chart/table, documentation, staged deployment, and production readback.

Each phase is testable before the next starts. Do not start a local collector upload until the server ingestion endpoint has been deployed and read back successfully.

## File structure

### Server

- Create `lib/token-usage.js`: pure payload/query validation, canonical buckets, counter semantics, and response limits.
- Modify `lib/db.js`: token usage schema, atomic idempotent ingestion, indexed query aggregation, reporter state, and retention compaction.
- Create `api/token-usage.js`: authenticated POST ingestion handler.
- Create `api/token-usage-query.js`: authenticated team query handler.
- Create `api/cron/token-usage-retention.js`: `CRON_SECRET`-protected daily compaction handler.
- Modify `vercel.json`: function durations and one additional daily cron.
- Create `tests/token-usage.test.mjs`: pure validation tests.
- Create `tests/token-usage-api.test.mjs`: ingestion handler tests.
- Create `tests/token-usage-query-api.test.mjs`: query handler tests.
- Create `tests/token-usage-db.test.mjs`: real temporary SQLite ingestion/query/retention tests.
- Modify `tests/db-read-budget-static.test.mjs`: prevent current-state paths from scanning token usage and enforce indexed/bounded usage paths.

### Local collector

- Create `skills/quota-reporter/scripts/token_usage_state.py`: private SQLite schema and crash-safe pending/acknowledged transitions.
- Create `skills/quota-reporter/scripts/token_usage_parsers.py`: content-free Codex and Claude usage record extraction.
- Create `skills/quota-reporter/scripts/token_usage_collector.py`: file discovery, cursor reads, 72-hour backfill, bucketing, attribution, time budget, and batch orchestration.
- Modify `skills/quota-reporter/scripts/quota_reporters.py`: authenticated `/api/token-usage` HTTP helper using existing token-upgrade handling.
- Modify `skills/quota-reporter/scripts/quota_guard.py`: exact automatic-switch boundaries and post-quota usage collection.
- Create `tests/test_token_usage_state.py`: local transaction/recovery tests.
- Create `tests/test_token_usage_parsers.py`: structural provider fixture tests.
- Create `tests/test_token_usage_collector.py`: incremental/backfill/upload/attribution tests.
- Modify `tests/reporter_scripts_test.py`: guard ordering, failure isolation, and switch-boundary regressions.

### Browser and documentation

- Create `token-usage.html`: independent analytics-first page.
- Modify `index.html`: add Token Usage navigation only; do not add usage reads to dashboard loading.
- Modify `users.html`: add Token Usage navigation.
- Modify `login.html`: preserve a safe same-origin `next` destination so the new page reuses or restores login automatically.
- Create `tests/token-usage-dashboard.test.mjs`: static and VM behavior tests for defaults, caching, stale-auth races, chart accessibility, and drilldown.
- Modify `tests/dashboard-static.test.mjs`: navigation and status-read isolation.
- Modify `README.md`, `README.zh-CN.md`, `SYSTEM_DESIGN.md`, `skills/quota-reporter/README.md`, and `skills/quota-reporter/SKILL.md`: collection, privacy, storage, query, and operations.

---

## Phase 1: Server foundation

### Task 1: Pure token-usage contracts

**Files:**
- Create: `lib/token-usage.js`
- Create: `tests/token-usage.test.mjs`

- [ ] **Step 1: Write failing ingestion contract tests**

Create tests for exact fields, canonical UTC bucket boundaries, raw model preservation, counter meanings, bounds, and unknown-field rejection:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTokenUsageBatch,
  TokenUsageValidationError,
} from "../lib/token-usage.js";

const now = new Date("2026-08-18T12:00:00.000Z");
const validBody = {
  installation_id: "install-019f",
  batch_id: "batch-01",
  rows: [{
    bucket_start: "2026-08-18T11:45:00.000Z",
    provider: "codex",
    model_account_id: "ir@stardust.ai",
    model_id: "gpt-5.6-sol",
    input_tokens: 120,
    output_tokens: 30,
    cache_read_tokens: 80,
    cache_write_tokens: 0,
    reasoning_tokens: 10,
    total_tokens: 150,
  }],
};

test("normalizes an exact token usage batch without changing raw model id", () => {
  const result = normalizeTokenUsageBatch(validBody, { now });
  assert.equal(result.installation_id, "install-019f");
  assert.equal(result.rows[0].model_id, "gpt-5.6-sol");
  assert.equal(result.rows[0].total_tokens, 150);
});

test("rejects non-quarter-hour buckets and unknown fields", () => {
  assert.throws(
    () => normalizeTokenUsageBatch({
      ...validBody,
      rows: [{ ...validBody.rows[0], bucket_start: "2026-08-18T11:46:00.000Z" }],
    }, { now }),
    TokenUsageValidationError,
  );
  assert.throws(
    () => normalizeTokenUsageBatch({ ...validBody, hub_user_email: "spoof@stardust.ai" }, { now }),
    /unknown field/i,
  );
});
```

Also assert: `rows` length is `1..400`; identifiers are trimmed nonempty strings with fixed maximum lengths; counters are non-negative safe integers; providers are only Codex or Claude; future buckets beyond five minutes fail; buckets older than 90 days fail; Codex cache/reasoning are allowed subsets without being re-added to Total; Claude counters satisfy `total = input + output + cache_read + cache_write`.

- [ ] **Step 2: Write failing query contract tests**

Test exact single `start`, `end`, `granularity`, `group_by`, and `metric` parameters; repeated optional filters; 90-day restrictions; and response limits:

```js
import { parseTokenUsageQuery } from "../lib/token-usage.js";

test("parses repeated filters and preserves raw model strings", () => {
  const query = parseTokenUsageQuery(
    "/api/token-usage-query?start=2026-08-11T12%3A00%3A00.000Z&end=2026-08-18T12%3A00%3A00.000Z&granularity=hour&group_by=hub_user&metric=total&hub_user=derek%40stardust.ai&model=gpt-5.6-sol",
    { now },
  );
  assert.deepEqual(query.hubUsers, ["derek@stardust.ai"]);
  assert.deepEqual(query.models, ["gpt-5.6-sol"]);
  assert.equal(query.granularity, "hour");
  assert.equal(query.groupBy, "hub_user");
});
```

Cover `15m`, `hour`, and `day`; groupings `hub_user`, `provider`, `model_account`, and `model`; metrics `total`, `input`, `output`, `cache_read`, `cache_write`, and `reasoning`; `start < end`; at most 90 days for `15m`/`hour`; and daily queries for older ranges.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test tests/token-usage.test.mjs`

Expected: FAIL because `lib/token-usage.js` does not exist.

- [ ] **Step 4: Implement constants, exact-key validation, and normalization**

Export the contract used by APIs and database functions:

```js
export const TOKEN_USAGE_COUNTERS = Object.freeze([
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "total_tokens",
]);
export const TOKEN_USAGE_MAX_ROWS = 400;
export const TOKEN_USAGE_TREND_LIMIT = 2000;
export const TOKEN_USAGE_BREAKDOWN_LIMIT = 500;
export const TOKEN_USAGE_DETAIL_DAYS = 90;

export class TokenUsageValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "TokenUsageValidationError";
    this.statusCode = statusCode;
  }
}
```

Implement `normalizeTokenUsageBatch(body, { now })` to return only `installation_id`, `batch_id`, and normalized rows sorted by bucket/provider/account/model so payload digests are deterministic. Implement `parseTokenUsageQuery(url, { now })` to return canonical property names and arrays plus the exact public echo shape consumed by the response:

```js
return {
  start,
  end,
  granularity,
  groupBy,
  metric,
  hubUsers,
  providers,
  modelAccounts,
  models,
  publicQuery: {
    start,
    end,
    granularity,
    group_by: groupBy,
    metric,
    hub_users: hubUsers,
    providers,
    model_accounts: modelAccounts,
    models,
  },
};
```

Check object keys with `Object.keys()` against exported sets; do not silently discard unknown fields. Preserve raw model/account strings after trim and length/control-character validation; never map models through a hardcoded alias list.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/token-usage.test.mjs`

Expected: all contract tests PASS.

```bash
git add lib/token-usage.js tests/token-usage.test.mjs
git commit -m "feat: define token usage ingestion contracts"
```

### Task 2: Token-usage schema and atomic idempotent ingestion

**Files:**
- Modify: `lib/db.js:340` in `ensureSchema`
- Modify: `lib/db.js` after current quota-history helpers
- Create: `tests/token-usage-db.test.mjs`
- Modify: `tests/db-read-budget-static.test.mjs`

- [ ] **Step 1: Add a real temporary-database test harness**

In `tests/token-usage-db.test.mjs`, create a cache-busted `lib/db.js` import using the same temporary `file:` Turso pattern as `tests/audit-log.test.mjs`. Return `{ mod, client, cleanup }`, restore environment values in `cleanup`, and never use the developer database.

- [ ] **Step 2: Write failing schema and ingestion tests**

Test a first batch, identical retry, conflicting retry, multi-row atomicity, additive second batch, and reporter state:

```js
const batch = {
  installationId: "install-1",
  batchId: "batch-1",
  rows: [{
    bucket_start: "2026-08-18T11:45:00.000Z",
    provider: "codex",
    model_account_id: "ir@stardust.ai",
    model_id: "gpt-5.6-sol",
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 60,
    cache_write_tokens: 0,
    reasoning_tokens: 5,
    total_tokens: 120,
  }],
};

const first = await mod.ingestTokenUsageBatch({
  hubUserEmail: "derek@stardust.ai",
  ...batch,
  receivedAt: "2026-08-18T12:00:00.000Z",
});
const retry = await mod.ingestTokenUsageBatch({
  hubUserEmail: "derek@stardust.ai",
  ...batch,
  receivedAt: "2026-08-18T12:01:00.000Z",
});
assert.equal(first.applied, true);
assert.equal(retry.applied, false);
assert.equal((await client.execute("SELECT total_tokens FROM token_usage_15m")).rows[0].total_tokens, 120);
```

Also invoke two identical first attempts with `Promise.all`, using the same `receivedAt`, and assert exactly one result has `applied === true`, the other has `applied === false`, and the stored counters are added once. Reuse `batch-1` with changed counters and assert an error carrying `code === "token_usage_batch_conflict"` and no database mutation. Force a bad second row through a test-only direct call and assert the receipt, detail, and reporter-state tables all remain unchanged.

- [ ] **Step 3: Run database tests and verify RED**

Run: `node --test tests/token-usage-db.test.mjs`

Expected: FAIL because the schema and `ingestTokenUsageBatch` do not exist.

- [ ] **Step 4: Add the four current/detail tables and indexes**

Add these schema objects to `ensureSchema()`:

```sql
CREATE TABLE IF NOT EXISTS token_usage_batch_receipts (
  hub_user_email TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied_at TEXT,
  apply_marker TEXT,
  PRIMARY KEY (hub_user_email, installation_id, batch_id)
);

CREATE INDEX IF NOT EXISTS token_usage_batch_receipts_received_idx
  ON token_usage_batch_receipts (received_at);

CREATE TABLE IF NOT EXISTS token_usage_15m (
  hub_user_email TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_account_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (hub_user_email, provider, model_account_id, model_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS token_usage_15m_time_idx
  ON token_usage_15m (bucket_start, hub_user_email, provider, model_account_id, model_id);

CREATE TABLE IF NOT EXISTS token_usage_daily (
  hub_user_email TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_account_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  day_start TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (hub_user_email, provider, model_account_id, model_id, day_start)
);

CREATE INDEX IF NOT EXISTS token_usage_daily_time_idx
  ON token_usage_daily (day_start, hub_user_email, provider, model_account_id, model_id);

CREATE TABLE IF NOT EXISTS token_usage_reporter_state (
  hub_user_email TEXT PRIMARY KEY,
  last_reported_at TEXT NOT NULL
);
```

- [ ] **Step 5: Implement a receipt-gated additive upsert**

Export:

```js
export async function ingestTokenUsageBatch({
  hubUserEmail,
  installationId,
  batchId,
  rows,
  receivedAt = new Date().toISOString(),
})
```

Compute `payloadDigest` from a stable JSON serialization of the normalized row array plus installation/batch identity. Generate one random `attemptMarker` for this database call. Build one `client.batch(statements, "write")` containing:

1. `INSERT ... ON CONFLICT DO NOTHING` for a receipt with `applied_at = NULL`.
2. One additive upsert per row, guarded by an `EXISTS` subquery for the same pending receipt and digest.
3. Reporter-state upsert guarded by the same pending receipt.
4. Receipt finalization that sets both `applied_at` and `apply_marker = attemptMarker`, guarded by the same digest and `applied_at IS NULL`.
5. A final receipt `SELECT` returned in the same batch.

Use this exact detail statement shape so retries do not require reading history first:

```sql
INSERT INTO token_usage_15m (
  hub_user_email, provider, model_account_id, model_id, bucket_start,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, total_tokens, updated_at
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE EXISTS (
  SELECT 1 FROM token_usage_batch_receipts
  WHERE hub_user_email = ? AND installation_id = ? AND batch_id = ?
    AND payload_digest = ? AND applied_at IS NULL
)
ON CONFLICT(hub_user_email, provider, model_account_id, model_id, bucket_start)
DO UPDATE SET
  input_tokens = token_usage_15m.input_tokens + excluded.input_tokens,
  output_tokens = token_usage_15m.output_tokens + excluded.output_tokens,
  cache_read_tokens = token_usage_15m.cache_read_tokens + excluded.cache_read_tokens,
  cache_write_tokens = token_usage_15m.cache_write_tokens + excluded.cache_write_tokens,
  reasoning_tokens = token_usage_15m.reasoning_tokens + excluded.reasoning_tokens,
  total_tokens = token_usage_15m.total_tokens + excluded.total_tokens,
  updated_at = excluded.updated_at;
```

After the batch, compare the selected digest. Throw `{ code: "token_usage_batch_conflict" }` when identity exists with another digest. Return `{ applied: receipt.apply_marker === attemptMarker, received_at, applied_at }` without exposing the digest, marker, or installation ID. This marker comparison distinguishes the one applying caller even when two concurrent attempts have the same millisecond timestamp.

- [ ] **Step 6: Add static read/write budget tests**

Assert that:

- ingestion uses a single `client.batch` and no scan of `token_usage_15m` or `token_usage_daily`;
- the detail upsert is additive and guarded by the pending receipt;
- current `/api/status`, revision, quota ingestion, and fetch-best modules do not reference token-usage tables;
- the time indexes exist.

- [ ] **Step 7: Run focused tests and commit**

Run: `node --test tests/token-usage-db.test.mjs tests/db-read-budget-static.test.mjs`

Expected: all tests PASS, including identical concurrent retries applying once.

```bash
git add lib/db.js tests/token-usage-db.test.mjs tests/db-read-budget-static.test.mjs
git commit -m "feat: store idempotent token usage batches"
```

### Task 3: Authenticated ingestion API

**Files:**
- Create: `api/token-usage.js`
- Create: `tests/token-usage-api.test.mjs`

- [ ] **Step 1: Write failing handler tests**

Use dependency injection like `api/quota-history.js`. Cover:

- non-POST returns `405` with `Allow: POST`;
- missing auth returns `401` before body parsing or database calls;
- the server uses `authContext.email` and ignores any client attempt to provide an email;
- valid input calls normalization then ingestion once;
- identical retry returns `200` with `applied: false`;
- validation returns `400`;
- digest conflict returns `409`;
- database failure follows `sendServiceUnavailable`;
- token upgrade is persisted through the existing `withTokenUpgrade` response.

```js
assert.deepEqual(seenIngest, {
  hubUserEmail: "derek@stardust.ai",
  installationId: "install-1",
  batchId: "batch-1",
  rows: normalizedRows,
  receivedAt: "2026-08-18T12:00:00.000Z",
});
assert.equal(JSON.parse(body).hub_user_email, "derek@stardust.ai");
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/token-usage-api.test.mjs`

Expected: FAIL because `api/token-usage.js` does not exist.

- [ ] **Step 3: Implement the handler**

Export an injectable implementation:

```js
export async function tokenUsageHandlerImpl(req, res, deps = {
  authenticateApiRequest,
  ingestTokenUsageBatch,
  normalizeTokenUsageBatch,
  readJsonBody,
  sendServiceUnavailable,
  sendUnauthorized,
  withTokenUpgrade,
  now: () => new Date(),
})
```

Authenticate before `readJsonBody`. Normalize with the injected `now`. Pass only `authContext.email` as `hubUserEmail`. Return:

```js
{
  ok: true,
  hub_user_email: authContext.email,
  batch_id: normalized.batch_id,
  applied: result.applied,
  received_at: result.received_at,
}
```

Map only `TokenUsageValidationError` to its `400` status and `token_usage_batch_conflict` to `409`; all other failures go through `sendServiceUnavailable`. Never echo rows, installation ID, or payload digest.

- [ ] **Step 4: Run tests and commit**

Run: `node --test tests/token-usage-api.test.mjs tests/http-body.test.mjs`

Expected: all tests PASS.

```bash
git add api/token-usage.js tests/token-usage-api.test.mjs
git commit -m "feat: accept authenticated token usage batches"
```

### Task 4: Indexed team query API

**Files:**
- Modify: `lib/db.js`
- Create: `api/token-usage-query.js`
- Create: `tests/token-usage-query-api.test.mjs`
- Modify: `tests/token-usage-db.test.mjs`
- Modify: `tests/db-read-budget-static.test.mjs`

- [ ] **Step 1: Write failing real-database query tests**

Insert two Hub users, two providers, multiple accounts/models, recent detail, and older daily rows. Assert exact filters and aggregation:

```js
const result = await mod.queryTokenUsage({
  start: "2026-08-11T12:00:00.000Z",
  end: "2026-08-18T12:00:00.000Z",
  granularity: "hour",
  groupBy: "hub_user",
  metric: "total",
  hubUsers: ["derek@stardust.ai"],
  providers: [],
  modelAccounts: [],
  models: [],
});
assert.equal(result.totals.total_tokens, 270);
assert.deepEqual(result.trend.map((point) => point.group_value), ["derek@stardust.ai"]);
assert.equal(result.breakdown[0].model_id, "gpt-5.6-sol");
```

Test `15m`, hourly, and day bucket starts; every filter; every grouping; every metric; daily query unioning old daily plus recent detail without overlap; deterministic ordering; reporter-state join showing an authenticated `auth_users` member with no report; and `query_too_broad` when trend exceeds 2,000 or breakdown exceeds 500.

- [ ] **Step 2: Write failing query handler tests**

Cover auth-first behavior, exact query validation, team-readable data for an ordinary authenticated member, token upgrade, `400`/`422`, and `503` without clearing auth.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test tests/token-usage-db.test.mjs tests/token-usage-query-api.test.mjs`

Expected: FAIL because query functions and endpoint do not exist.

- [ ] **Step 4: Implement parameterized query aggregation**

Export:

```js
export async function queryTokenUsage({
  start,
  end,
  granularity,
  groupBy,
  metric,
  hubUsers = [],
  providers = [],
  modelAccounts = [],
  models = [],
})
```

Map validated values to fixed SQL expressions:

```js
const bucketExpression = {
  "15m": "bucket_start",
  hour: "substr(bucket_start, 1, 13) || ':00:00.000Z'",
  day: "substr(bucket_start, 1, 10) || 'T00:00:00.000Z'",
}[granularity];

const groupColumn = {
  hub_user: "hub_user_email",
  provider: "provider",
  model_account: "model_account_id",
  model: "model_id",
}[groupBy];
```

Build filter clauses only from validated arrays and bound `?` parameters. For `15m`/hour, query `token_usage_15m` only. For day, use a `UNION ALL` source of daily rows in range plus detail rows in range, then group again by day and dimensions so a partially compacted day remains exact.

Execute totals, trend, breakdown, and reporter-state reads in one read batch. Request `limit + 1` for trend and breakdown; throw `query_too_broad` instead of silently truncating. Return six counters in totals/points regardless of the selected chart metric so summary and hover values agree.

- [ ] **Step 5: Implement `api/token-usage-query.js`**

Authenticate, parse the URL with `parseTokenUsageQuery`, call `queryTokenUsage(parsed)`, and return:

```js
{
  generated_at: now.toISOString(),
  query: parsed.publicQuery,
  totals: result.totals,
  trend: result.trend,
  breakdown: result.breakdown,
  reporters: result.reporters,
}
```

Use `withTokenUpgrade`. Return `422` for `query_too_broad`, validation status for invalid queries, and `503` for service failures.

- [ ] **Step 6: Add indexed-read static contracts**

Assert the query function reads only token usage tables plus `auth_users`/`token_usage_reporter_state`, all time filters are applied before grouping, the result limits are finite, and `/api/status` remains independent.

- [ ] **Step 7: Run focused tests and commit**

Run: `node --test tests/token-usage.test.mjs tests/token-usage-db.test.mjs tests/token-usage-query-api.test.mjs tests/db-read-budget-static.test.mjs`

Expected: all tests PASS.

```bash
git add lib/db.js api/token-usage-query.js tests/token-usage-db.test.mjs tests/token-usage-query-api.test.mjs tests/db-read-budget-static.test.mjs
git commit -m "feat: query indexed team token usage"
```

### Task 5: Bounded daily compaction and server deployment checkpoint

**Files:**
- Modify: `lib/db.js`
- Create: `api/cron/token-usage-retention.js`
- Modify: `vercel.json`
- Modify: `tests/token-usage-db.test.mjs`
- Create: `tests/token-usage-retention-api.test.mjs`

- [ ] **Step 1: Write failing compaction tests**

Insert detail immediately before, exactly at, and after a fixed 90-day cutoff. Include two models and a day that already has a daily row. Assert:

- only `bucket_start < cutoff` is compacted;
- daily counters are exact after additive upsert;
- included detail is deleted only after daily rows succeed;
- rerunning compaction is a no-op;
- at most seven distinct UTC days are processed per call;
- receipts older than the documented 90-day retry horizon are pruned, while the boundary receipt remains.

Force a failing daily insert through an injected test statement and assert detail remains untouched.

- [ ] **Step 2: Write failing cron handler tests**

Cover method, missing/wrong `CRON_SECRET`, configuration failure, fixed cutoff calculation, bounded result, and service error. The handler must not require mail configuration.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test tests/token-usage-db.test.mjs tests/token-usage-retention-api.test.mjs`

Expected: FAIL because compaction and cron handler do not exist.

- [ ] **Step 4: Implement bounded transactional compaction**

Export:

```js
export async function compactTokenUsage({
  before,
  maxDays = 7,
  receiptBefore = before,
})
```

Select at most seven distinct `substr(bucket_start, 1, 10)` days before `before`. For each selected day, run one write batch containing:

```sql
INSERT INTO token_usage_daily (..., day_start, ..., updated_at)
SELECT ..., substr(bucket_start, 1, 10) || 'T00:00:00.000Z', SUM(...), ?
FROM token_usage_15m
WHERE bucket_start >= ? AND bucket_start < ? AND bucket_start < ?
GROUP BY hub_user_email, provider, model_account_id, model_id, substr(bucket_start, 1, 10)
ON CONFLICT(...) DO UPDATE SET
  input_tokens = token_usage_daily.input_tokens + excluded.input_tokens,
  output_tokens = token_usage_daily.output_tokens + excluded.output_tokens,
  cache_read_tokens = token_usage_daily.cache_read_tokens + excluded.cache_read_tokens,
  cache_write_tokens = token_usage_daily.cache_write_tokens + excluded.cache_write_tokens,
  reasoning_tokens = token_usage_daily.reasoning_tokens + excluded.reasoning_tokens,
  total_tokens = token_usage_daily.total_tokens + excluded.total_tokens,
  updated_at = excluded.updated_at;
```

Follow it in the same batch with deletion using identical day/cutoff predicates. Prune receipts in a separate bounded statement after all successful day batches. Return days, detail rows removed, daily rows affected, and receipts removed.

- [ ] **Step 5: Implement the protected daily cron and Vercel configuration**

Follow `api/cron/invalidated-auth-notifications.js`: accept GET/POST, require `Authorization: Bearer ${CRON_SECRET}`, require DB configuration, compute `before = now - 90 days`, and call `compactTokenUsage` with `maxDays: 7`.

Add function duration and a second once-daily cron, for example:

```json
"api/cron/token-usage-retention.js": { "maxDuration": 30 }
```

```json
{ "path": "/api/cron/token-usage-retention", "schedule": "30 18 * * *" }
```

This remains valid on the current [Vercel cron limits](https://vercel.com/docs/limits) and [Hobby scheduling contract](https://vercel.com/docs/cron-jobs/manage-cron-jobs): multiple project crons are supported, while each Hobby cron remains once daily and may execute within its scheduled hour.

- [ ] **Step 6: Run the server phase and commit**

Run:

```bash
node --test tests/token-usage.test.mjs tests/token-usage-api.test.mjs tests/token-usage-query-api.test.mjs tests/token-usage-db.test.mjs tests/token-usage-retention-api.test.mjs tests/db-read-budget-static.test.mjs
npm test
git diff --check
```

Expected: focused and full Node suites PASS; `vercel.json` parses; no whitespace errors.

```bash
git add lib/db.js api/cron/token-usage-retention.js vercel.json tests/token-usage-db.test.mjs tests/token-usage-retention-api.test.mjs
git commit -m "feat: compact token usage into daily history"
```

Record this commit as the **server checkpoint SHA** for staged production rollout.

---

## Phase 2: Local collection

### Task 6: Crash-safe local SQLite state

**Files:**
- Create: `skills/quota-reporter/scripts/token_usage_state.py`
- Create: `tests/test_token_usage_state.py`

Use `~/.agents/auth/token-usage.sqlite3` as `DEFAULT_TOKEN_USAGE_STATE_PATH`. Create its parent directory if needed and keep both directory and database private to the current OS user; the database itself must be mode `0o600` on supported platforms.

- [ ] **Step 1: Write failing state tests**

Use `tempfile.TemporaryDirectory()` and cover:

- first open creates a random installation ID and fixed 72-hour cutoff;
- reopening preserves both values;
- file cursors remain acknowledged while a batch is pending;
- `ack_pending_batch` atomically applies proposed cursor/counter/fingerprint state;
- restart returns the same pending payload before any new scan;
- `reject_pending_batch` records numeric failure details and advances the proposed cursor once so an invalid payload does not loop forever;
- account switch prepare/finalize/cancel/reconcile;
- fingerprint pruning keeps the latest 90 days;
- SQLite file mode is owner-only on supported platforms.

```python
pending = state.stage_batch(
    payload={"installation_id": state.installation_id, "batch_id": "batch-1", "rows": []},
    proposed={
        "files": [{"file_key": "1:2", "path": "/tmp/a.jsonl", "offset": 80, "size": 80, "mtime_ns": 1}],
        "counters": [{"record_key": "codex:session-1", "value": {"total_tokens": 100}}],
        "fingerprints": [{"digest": "abc", "event_at": "2026-08-18T11:00:00.000Z"}],
    },
)
assert state.file_cursor("1:2") is None
state.ack_pending_batch("batch-1")
assert state.file_cursor("1:2")["offset"] == 80
```

- [ ] **Step 2: Run tests and verify RED**

Run: `python3 -m unittest tests/test_token_usage_state.py -v`

Expected: FAIL because `token_usage_state.py` does not exist.

- [ ] **Step 3: Implement schema and public state API**

Create `TokenUsageState(path, now=...)` with these tables:

```sql
CREATE TABLE collector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE file_cursors (
  file_key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE usage_counters (
  record_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE seen_usage_records (
  digest TEXT PRIMARY KEY,
  event_at TEXT NOT NULL
);
CREATE TABLE pending_uploads (
  batch_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  proposed_state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT
);
CREATE TABLE account_switches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  from_account_id TEXT,
  to_account_id TEXT,
  status TEXT NOT NULL,
  finalized_at TEXT
);
```

Expose `pending_upload`, `stage_batch`, `ack_pending_batch`, `reject_pending_batch`, `file_cursor`, `usage_counter`, `has_fingerprint`, `prune_fingerprints`, `prepare_account_switch`, `finalize_account_switch`, `cancel_account_switch`, `reconcile_prepared_switches`, and `switches_for_range`.

Use `BEGIN IMMEDIATE` for stage/ack/reject transitions. Store only numeric aggregate payloads and proposed metadata; never store raw JSONL lines. Set the DB file to `0o600` after creation.

- [ ] **Step 4: Run tests and commit**

Run: `python3 -m unittest tests/test_token_usage_state.py -v`

Expected: all state and restart tests PASS.

```bash
git add skills/quota-reporter/scripts/token_usage_state.py tests/test_token_usage_state.py
git commit -m "feat: persist token collector checkpoints"
```

### Task 7: Codex structural parser and copied-history deduplication

**Files:**
- Create: `skills/quota-reporter/scripts/token_usage_parsers.py`
- Create: `tests/test_token_usage_parsers.py`

- [ ] **Step 1: Write sanitized Codex fixture tests**

Build JSON lines in the test; include no prompt/response content. Cover:

- `session_meta` selects logical session ID from `payload.session_id` then `payload.id`;
- `turn_context` selects raw `payload.model`;
- `token_count` reads `payload.info.total_token_usage`;
- metadata lines produce no usage record;
- a parent token record copied into a subagent file yields the same canonical fingerprint;
- a genuine subagent counter with another logical session ID yields another fingerprint;
- a malformed or irrelevant line yields a counted warning, not content output;
- a counter reset starts a new epoch instead of emitting a negative delta.

```python
records = list(parse_codex_lines([
    json.dumps({"type": "session_meta", "payload": {"session_id": "session-1"}}),
    json.dumps({"type": "turn_context", "payload": {"model": "gpt-5.6-sol"}}),
    json.dumps({
        "timestamp": "2026-08-18T11:45:01.000Z",
        "type": "event_msg",
        "payload": {"type": "token_count", "info": {"total_token_usage": {
            "input_tokens": 100, "output_tokens": 20,
            "cached_input_tokens": 60, "cache_write_input_tokens": 0,
            "reasoning_output_tokens": 5, "total_tokens": 120,
        }}},
    }),
] ))
assert records[0].logical_session_id == "session-1"
assert records[0].model_id == "gpt-5.6-sol"
assert records[0].counters["total_tokens"] == 120
```

- [ ] **Step 2: Run tests and verify RED**

Run: `python3 -m unittest tests/test_token_usage_parsers.py -v`

Expected: FAIL because `token_usage_parsers.py` does not exist.

- [ ] **Step 3: Implement content-free record types and Codex parsing**

Define:

```python
@dataclasses.dataclass(frozen=True)
class UsageRecord:
    provider: str
    event_at: str
    logical_record_key: str
    model_id: str
    counters: dict[str, int]
    fingerprint: str

@dataclasses.dataclass
class CodexParseContext:
    logical_session_id: str | None = None
    model_id: str | None = None
```

`parse_codex_line(line, context)` parses one JSON object, mutates only structural context, and emits an optional cumulative `UsageRecord`. Build the fingerprint with SHA-256 over canonical JSON containing provider, logical session ID, event timestamp, raw model ID, and the six cumulative numeric values. It must never include the original line, prompt fields, path, title, or tool content.

Add `codex_counter_delta(current, acknowledged)` returning normalized positive fields. When a cumulative counter drops, increment an epoch in the caller's counter state and treat the current values as the first values of that epoch; do not subtract into negative usage.

- [ ] **Step 4: Run tests and commit**

Run: `python3 -m unittest tests/test_token_usage_parsers.py -v`

Expected: Codex tests PASS.

```bash
git add skills/quota-reporter/scripts/token_usage_parsers.py tests/test_token_usage_parsers.py
git commit -m "feat: parse deduplicated Codex token counters"
```

### Task 8: Claude final-message parser

**Files:**
- Modify: `skills/quota-reporter/scripts/token_usage_parsers.py`
- Modify: `tests/test_token_usage_parsers.py`

- [ ] **Step 1: Write failing Claude parser tests**

Cover:

- assistant records expose message ID, timestamp, raw `message.model`, and `message.usage`;
- repeated lines for the same message ID collapse to the latest observed counters;
- an unchanged repetition emits zero delta;
- a later increase emits only the positive difference;
- cache creation maps to cache write;
- Claude Total equals input + output + cache read + cache write;
- unrelated user/tool content is never returned or hashed;
- missing message ID/model/usage yields a warning and no usage record.

```python
line = json.dumps({
    "type": "assistant",
    "timestamp": "2026-08-18T11:50:00.000Z",
    "message": {
        "id": "msg-1",
        "model": "claude-opus-4-8",
        "usage": {
            "input_tokens": 2,
            "output_tokens": 100,
            "cache_read_input_tokens": 900,
            "cache_creation_input_tokens": 50,
        },
    },
})
record = parse_claude_line(line)
assert record.counters["cache_write_tokens"] == 50
assert record.counters["total_tokens"] == 1052
```

- [ ] **Step 2: Run tests and verify RED**

Run: `python3 -m unittest tests/test_token_usage_parsers.py -v`

Expected: FAIL because Claude parsing is absent.

- [ ] **Step 3: Implement Claude parsing and final-value deltas**

Implement `parse_claude_line(line)` returning a cumulative `UsageRecord` keyed by `claude:<message.id>`. Fingerprint canonical structural/numeric fields only. Implement `claude_counter_delta(current, acknowledged)` field-wise; later increases produce positive deltas, equal counters produce none, and lower corrections update local final state without uploading a negative server counter.

- [ ] **Step 4: Run tests and commit**

Run: `python3 -m unittest tests/test_token_usage_parsers.py -v`

Expected: all Codex and Claude parser tests PASS.

```bash
git add skills/quota-reporter/scripts/token_usage_parsers.py tests/test_token_usage_parsers.py
git commit -m "feat: parse final Claude token usage"
```

### Task 9: Incremental collector, 72-hour backfill, and batch upload

**Files:**
- Create: `skills/quota-reporter/scripts/token_usage_collector.py`
- Modify: `skills/quota-reporter/scripts/quota_reporters.py`
- Create: `tests/test_token_usage_collector.py`

- [ ] **Step 1: Write failing file discovery and cursor tests**

Create temporary Codex/Claude roots and assert:

- ordinary discovery opens only new/size-changed/mtime-changed JSONL files;
- an unchanged second cycle reads zero content bytes;
- an appended file starts at the acknowledged offset;
- an incomplete last line leaves the cursor before that line;
- a truncated/replaced file restarts from zero under a new file identity;
- a file disappearing between discovery and open returns a warning and remains retryable;
- paths and lines never enter the upload payload.

Instrument the reader's byte count rather than relying on wall-clock timing.

- [ ] **Step 2: Write failing backfill and time-budget tests**

With an injected monotonic clock, assert every fresh state uses `now - 72 hours`, old records inside recently modified files remain excluded, old unaffected files initialize at EOF, the scan stops once 10 seconds elapse between complete records, and the next cycle resumes at the saved proposed/acknowledged point. Verify quota work is outside this module and the collector returns within the budget plus the current complete-line parse.

- [ ] **Step 3: Write failing aggregation and attribution tests**

Assert UTC quarter-hour buckets and dimensions:

```python
assert rows == [{
    "bucket_start": "2026-08-18T11:45:00.000Z",
    "provider": "codex",
    "model_account_id": "ir@stardust.ai",
    "model_id": "gpt-5.6-sol",
    "input_tokens": 100,
    "output_tokens": 20,
    "cache_read_tokens": 60,
    "cache_write_tokens": 0,
    "reasoning_tokens": 5,
    "total_tokens": 120,
}]
```

Automatic switch boundaries split before/after events. Without a known switch, all newly discovered manual-switch usage uses the report-time account. Multiple events with the same dimensions/bucket add locally. Stop before a record would make more than 400 aggregate rows so the cursor never advances past unsent usage.

- [ ] **Step 4: Write failing retry and HTTP tests**

Test pending-first behavior, identical batch ID on timeout retry, ack only after `ok`, permanent `400` isolation, `401` existing token-reissue handling without acknowledging, rejecting, or advancing the pending batch, and no scan while a retryable pending batch exists.

- [ ] **Step 5: Run tests and verify RED**

Run: `python3 -m unittest tests/test_token_usage_collector.py -v`

Expected: FAIL because collector and HTTP helper do not exist.

- [ ] **Step 6: Implement authenticated upload helper**

Add `post_token_usage_batch(auth_pool_url, auth_pool_user_token, payload)` to `quota_reporters.py`. POST JSON to `/api/token-usage` with bearer auth, reuse `read_auth_pool_response` so upgraded tokens persist, and reuse `read_auth_pool_http_error` so invalidated tokens follow the existing email reissue behavior. Return status code/reason without logging the bearer token or numeric payload.

- [ ] **Step 7: Implement collector orchestration**

Expose:

```python
def collect_and_report_token_usage(
    *,
    config: dict,
    codex_account_id: str | None,
    claude_account_id: str | None,
    state: TokenUsageState | None = None,
    state_path: Path = DEFAULT_TOKEN_USAGE_STATE_PATH,
    codex_roots: tuple[Path, ...] = DEFAULT_CODEX_SESSION_ROOTS,
    claude_root: Path = DEFAULT_CLAUDE_PROJECT_ROOT,
    budget_seconds: float = 10.0,
    wall_now: Callable[[], datetime] = utc_now,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict:
```

Flow:

1. Reuse the injected state, or open `state_path` when called standalone, and reconcile pending switches against report-time accounts.
2. If a pending retry exists, upload it and return after ack/reject handling.
3. Discover changed files.
4. Read complete lines from acknowledged positions until 10 seconds or 400 aggregate rows.
5. Parse/dedupe, calculate acknowledged counter deltas, assign accounts, and bucket by original event time.
6. Build `{ installation_id, batch_id, rows }` with `uuid.uuid4()` batch ID.
7. Stage payload plus proposed file/counter/fingerprint state.
8. Upload and ack only on server success.
9. Prune acknowledged fingerprints older than 90 days.

Return a compact summary containing `ok`, `reported`, row count, total tokens, bytes read, backfill completion, retry status, warning counts, and elapsed time. It must not return paths, record hashes, or raw lines.

- [ ] **Step 8: Run tests and commit**

Run:

```bash
python3 -m unittest tests/test_token_usage_state.py tests/test_token_usage_parsers.py tests/test_token_usage_collector.py -v
```

Expected: all local collector tests PASS; the second no-change cycle reads zero bytes.

```bash
git add skills/quota-reporter/scripts/token_usage_collector.py skills/quota-reporter/scripts/quota_reporters.py tests/test_token_usage_collector.py
git commit -m "feat: collect incremental local token usage"
```

### Task 10: Exact automatic-switch boundaries and `quota_guard` integration

**Files:**
- Modify: `skills/quota-reporter/scripts/quota_guard.py:1120-1420`
- Modify: `skills/quota-reporter/scripts/quota_guard.py:1711-1885`
- Modify: `tests/reporter_scripts_test.py`

- [ ] **Step 1: Write failing switch-boundary tests**

For Codex normal replacement, Codex repair auth, Claude normal replacement, and Claude repair auth, inject a fake token-usage state and assert:

- `prepare_account_switch(provider, from, to, prepared_at)` occurs before auth/keychain/file mutation;
- post-write metadata is verified before `finalize_account_switch`;
- a write failure rereads the installed identity: it cancels only when the old account is still installed, finalizes when the new account actually landed, and otherwise leaves the prepared boundary for next-cycle reconciliation;
- same-account access-token refresh records no account switch;
- prepared switch reconciliation finalizes only when the next observed account equals `to_account_id`, otherwise cancels.

- [ ] **Step 2: Write failing guard-order and isolation tests**

Mock every `run_guard` phase and assert exact ordering:

```text
probe -> auth sync/quota report -> replacement -> app-server handling -> token usage -> notifications
```

Assert a collector exception appears under `errors.token_usage`, returns a compact `token_usage` result, and does not change `ok`, quota reports, replacements, or notifications. Assert missing Hub config yields `reported: false, reason: missing_auth_pool_config` without scanning logs.

- [ ] **Step 3: Run tests and verify RED**

Run: `python3 -m unittest tests/reporter_scripts_test.py -v`

Expected: new tests FAIL because switch state and collector integration are absent.

- [ ] **Step 4: Add a single auth-install boundary helper**

Avoid four duplicated prepare/finalize blocks. Add an injectable helper in `quota_guard.py`:

```python
def install_auth_with_usage_boundary(
    *, provider, from_account_id, to_account_id,
    usage_state, write_auth, read_installed_account, now_iso,
):
    switch_id = None
    if usage_state is not None and from_account_id != to_account_id:
        switch_id = usage_state.prepare_account_switch(
            provider=provider,
            from_account_id=from_account_id,
            to_account_id=to_account_id,
            prepared_at=now_iso(),
        )
    try:
        write_auth()
        observed = read_installed_account()
        if observed != to_account_id:
            raise RuntimeError("installed auth account did not match replacement")
    except Exception:
        if switch_id is not None:
            observed = read_installed_account()
            if observed == to_account_id:
                usage_state.finalize_account_switch(switch_id, finalized_at=now_iso())
            elif observed == from_account_id:
                usage_state.cancel_account_switch(switch_id)
        raise
    if switch_id is not None:
        usage_state.finalize_account_switch(switch_id, finalized_at=now_iso())
```

Route both replacement and repair writes through it. Preserve keychain-first Claude behavior and current file permissions. Pass `usage_state` as an optional dependency so existing focused tests remain isolated.

- [ ] **Step 5: Run token collection after existing critical work**

Open the state once in `run_guard` even when Hub upload configuration is absent, pass it to replacement helpers, then call `collect_and_report_token_usage` after replacement/app-server handling and before notifications. Pass post-replacement account IDs when replaced; otherwise pass probed account IDs. Wrap with `run_guard_step` and `timed_guard_step`:

```python
token_usage = run_guard_step(
    "token_usage_failed",
    lambda: timed_guard_step(
        timings,
        "token_usage",
        lambda: collect_and_report_token_usage(
            config=config,
            codex_account_id=effective_codex_account_id,
            claude_account_id=effective_claude_account_id,
            state=token_usage_state,
        ),
    ),
)
```

Add `token_usage` to JSON and compact text summaries. Do not include paths or per-record identifiers.

- [ ] **Step 6: Run the complete Python phase and commit**

Run:

```bash
python3 -m unittest tests/test_token_usage_state.py tests/test_token_usage_parsers.py tests/test_token_usage_collector.py tests/reporter_scripts_test.py tests/test_trigger_remote_probe.py -v
```

Expected: all Python tests PASS; quota guard behavior remains green.

```bash
git add skills/quota-reporter/scripts/quota_guard.py tests/reporter_scripts_test.py
git commit -m "feat: report token usage from quota guard"
```

Record this commit as the **collector checkpoint SHA** for staged production rollout.

---

## Phase 3: Independent analytics page

### Task 11: Page shell, authentication, filters, and five-minute query cache

**Files:**
- Create: `token-usage.html`
- Create: `tests/token-usage-dashboard.test.mjs`
- Modify: `index.html`
- Modify: `users.html`
- Modify: `login.html`
- Modify: `tests/dashboard-static.test.mjs`

- [ ] **Step 1: Write failing static page tests**

Assert the new page has:

- navigation back to Accounts and Users;
- default seven-day range, hourly granularity, Hub-user grouping, Total metric;
- filters for time, Hub user, provider, model account, raw model, granularity, grouping, and metric;
- summary, trend, breakdown, and reporter-state regions;
- a five-minute cache and one in-flight promise per exact query/session;
- `/api/token-usage-query` only, with no `/api/status`, revision, quota-history, or auth-pool data reads;
- navigation links from `index.html` and `users.html`.

- [ ] **Step 2: Write failing VM behavior tests**

Build a small DOM/fetch harness like `tests/dashboard-refresh-behavior.test.mjs`. Cover:

- an existing cookie automatically loads without a login click;
- missing cookie navigates to `/login.html?next=%2Ftoken-usage.html`;
- an upgraded token updates the cookie and caches under the new session generation;
- identical query within five minutes makes one fetch;
- concurrent identical queries share one fetch;
- filter change makes a new fetch;
- stale old-token `401` cannot clear a newly saved token or update the page;
- current-session `401` clears auth and returns through login;
- non-401 error preserves login and selected filters.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test tests/token-usage-dashboard.test.mjs tests/dashboard-static.test.mjs`

Expected: FAIL because the page and links do not exist.

- [ ] **Step 4: Implement safe login return and navigation**

In `login.html`, parse optional `next` only when no installer callback is active. Resolve it against `location.origin`, require the same origin and a pathname other than the login page, and then use `location.replace(nextUrl.pathname + nextUrl.search)` after successful or restored login. Otherwise preserve the existing `/` destination and loopback callback behavior.

Add Token Usage links to the existing page nav areas without changing account table layout.

- [ ] **Step 5: Implement page state and query construction**

Use the existing cookie name and safe decode pattern. Define:

```js
const QUERY_CACHE_MS = 5 * 60 * 1000;
const queryCache = new Map();
const queryRequests = new Map();
let authSessionGeneration = 0;
let currentToken = "";
```

Initialize `end = now`, `start = now - 7 days`, `granularity = "hour"`, `group_by = "hub_user"`, and `metric = "total"`. Encode repeated filters with `URLSearchParams.append`. Cache by auth generation plus canonical query string. Apply token upgrades before storing the successful response under the post-upgrade generation key. Invalidate cache/in-flight results on logout or token replacement and guard every post-await DOM mutation by captured token/generation.

- [ ] **Step 6: Implement loading, empty, error, and reporter states**

Show `No usage report received` when reporter state is absent. Show a valid zero only when the authenticated query succeeds and totals are zero. Preserve filters and last successful result on transient errors, with a visible retry action. Never show login for a non-401 query failure.

- [ ] **Step 7: Run tests and commit**

Run: `node --test tests/token-usage-dashboard.test.mjs tests/dashboard-static.test.mjs`

Expected: page/auth/cache tests PASS.

```bash
git add token-usage.html index.html users.html login.html tests/token-usage-dashboard.test.mjs tests/dashboard-static.test.mjs
git commit -m "feat: add token usage query page"
```

### Task 12: Analytics summary, accessible trend, breakdown, and drilldown

**Files:**
- Modify: `token-usage.html`
- Modify: `tests/token-usage-dashboard.test.mjs`

- [ ] **Step 1: Write failing render tests**

Given a fixed API response, assert:

- Total/Input/Output/Cache summary values agree with response totals;
- Codex cache and reasoning labels say they are subsets, not additions to Total;
- trend defaults to stacking by Hub user;
- every point exposes exact bucket, group, provider/account/model dimensions when present, and all counters;
- an empty time gap has no connecting SVG path;
- chart meaning is available by keyboard focus and text, not color only;
- breakdown rows are sorted Total descending by default;
- selecting a breakdown row fills Hub user/provider/account/model filters and triggers exactly one query;
- raw new model names render without a known-model list.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/token-usage-dashboard.test.mjs`

Expected: new rendering assertions FAIL.

- [ ] **Step 3: Implement summary and chart rendering**

Render four cards: Total, Input, Output, Cache (`cache_read + cache_write`). Provide separate Cache Read, Cache Write, and Reasoning values in card detail/hover.

Render a compact SVG from server-aggregated points. Build one series per `group_value`, preserve missing bucket gaps, assign stable colors by hashing group text, and include a text legend. Each SVG point is focusable and has an accessible label such as:

```text
2026-08-18 11:00–12:00, derek@stardust.ai, total 1,944,700,
input 1,929,364, output 15,336, cache read 1,654,016,
cache write 0, reasoning 5,102
```

Do not infer provider/account/model when the selected grouping combines them; the exact breakdown remains in the table.

- [ ] **Step 4: Implement breakdown and drilldown**

Render `Hub user × provider × model account × model` rows with six counters. Sort numerically in the browser only within the bounded server response. A row button applies all four dimensions as filters, updates the URL query state, and calls the deduplicated query loader once. Support Enter/Space and restore focus after rerender.

- [ ] **Step 5: Run UI tests and commit**

Run: `node --test tests/token-usage-dashboard.test.mjs tests/dashboard-static.test.mjs`

Expected: all UI behavior/accessibility tests PASS.

```bash
git add token-usage.html tests/token-usage-dashboard.test.mjs
git commit -m "feat: visualize team token usage"
```

### Task 13: Documentation, full verification, staged rollout, and live readback

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SYSTEM_DESIGN.md`
- Modify: `skills/quota-reporter/README.md`
- Modify: `skills/quota-reporter/SKILL.md`
- Modify: `tests/db-read-budget-static.test.mjs`

- [ ] **Step 1: Write final static privacy/read-budget regressions**

Assert:

- status, revision, quota history, quota ingestion, and fetch-best do not read token usage;
- token query does not select installation IDs, batch IDs, payload digests, local paths, or record fingerprints;
- ingestion responses do not echo rows or installation identity;
- collector upload construction has no prompt, response, project, path, title, or tool-content fields;
- page startup performs one usage query only after authentication restoration.

- [ ] **Step 2: Update operator and skill documentation**

Document:

- dimensions and provider-specific counter semantics;
- every installation's initial 72-hour backfill and 10-second per-cycle budget;
- ordinary byte-position incremental reads;
- automatic versus manual account attribution;
- privacy exclusions;
- local state path/permissions and recovery behavior;
- POST and query APIs;
- 90-day detail/daily retention;
- separate lazy page, defaults, filters, five-minute cache, and no-report versus zero;
- server daily cron and reference benchmark (95 files, about 2.9 GB, 44.97 seconds full parse, about 54 MB peak memory).

Do not claim exact manual-switch attribution or billing equivalence.

- [ ] **Step 3: Run full local verification**

Run:

```bash
python3 -m unittest tests/test_token_usage_state.py tests/test_token_usage_parsers.py tests/test_token_usage_collector.py tests/reporter_scripts_test.py tests/test_trigger_remote_probe.py -v
npm test
git diff --check
git status --short
```

Expected: all Python and Node tests PASS; no whitespace errors; only intended documentation/test files remain before the docs commit.

- [ ] **Step 4: Run a privacy-safe local performance/read-position check**

Against temporary/sanitized fixtures, run one 72-hour backfill cycle with a fake 10-second clock and then an unchanged second cycle. Assert the first stops at its budget checkpoint and the second resumes; after completion, another no-change cycle reads zero bytes. Do not run tests against or print real conversation content.

Run one opt-in read-only benchmark against the local real log roots that prints only file count, bytes read, elapsed time, counters, and warnings. Confirm no paths or content appear in output.

- [ ] **Step 5: Commit docs and final contracts**

```bash
git add README.md README.zh-CN.md SYSTEM_DESIGN.md skills/quota-reporter/README.md skills/quota-reporter/SKILL.md tests/db-read-budget-static.test.mjs
git commit -m "docs: describe team token usage analytics"
```

Record this commit as the **final UI checkpoint SHA**.

- [ ] **Step 6: Review the complete branch before external rollout**

Use the repository's code-review workflow. Verify the diff from `7c8d80e` through final HEAD, rerun all suites, and require no unresolved Important or blocking findings. Confirm the branch contains the server and collector checkpoint commits in order.

- [ ] **Step 7: Deploy and read back the server checkpoint**

Advance production to the recorded server checkpoint first. Wait for the exact commit's Vercel production deployment to report success. Using an existing local Hub token without printing it, verify:

- POST `/api/token-usage` rejects invalid data and accepts one sanitized numeric batch;
- retrying the same batch is `applied: false` with no counter increase;
- GET `/api/token-usage-query` returns that row for the authenticated team query;
- `/api/status` response shape/read latency remains unchanged;
- the retention cron is registered and rejects requests without `CRON_SECRET`.

Do not advance to the collector checkpoint if idempotency or current-status isolation fails.

- [ ] **Step 8: Deploy and verify the collector checkpoint**

Advance production/GitHub `main` to the collector checkpoint. Wait for exact-commit deployment success, then run one installed `quota_guard.py --skip-self-update --no-toast --json` cycle. Verify quota probing/reporting/replacement completes before token usage, the local DB is owner-only, a pending batch is acknowledged, and the server query shows the authenticated Hub user with the actual provider account/model. Rerun once and verify only new bytes are read and unchanged usage is not added.

Allow other installations to self-update normally; verify at least one additional Hub user starts a 72-hour backfill rather than beginning at zero history. Never collect or display their conversation content.

- [ ] **Step 9: Deploy final UI and verify browser behavior**

Advance production to the final UI checkpoint and wait for exact-commit success. In a real browser with an existing valid cookie, verify Token Usage opens without another login click, defaults to seven days/hour/Hub user/Total, filters and drilldown work, and a second identical query within five minutes performs no extra database request. Verify an unauthenticated page returns through login using `next`, transient query failure does not clear login, and the account availability page still uses revision-only refresh.

- [ ] **Step 10: Synchronize local main and report evidence**

After the final production readback, fast-forward local `main` and confirm local HEAD, `origin/main`, and the deployed production commit are identical. Report separately:

- Python and Node test counts;
- benchmark/read-position evidence;
- server checkpoint deployment/readback;
- collector checkpoint deployment/readback;
- final UI deployment/readback;
- any user installation still awaiting its scheduled 72-hour backfill completion.

Do not report completion from push or accepted deployment alone.
