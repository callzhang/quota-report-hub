# Team Token Usage Analytics Design

## Goal

Add a separate Token Usage page that answers:

> Which Hub user used how many tokens, on which Codex or Claude account, with which model, during a selected time range?

The feature must collect usage without uploading conversation content, reuse the existing 15-minute `quota_guard` schedule, preserve quota reporting reliability, and keep routine local and database work bounded.

## Confirmed product decisions

- Attribution identity is the authenticated Hub user, such as `derek@stardust.ai`.
- Usage is also split by provider, actual Codex or Claude account, raw model ID, and time.
- Storage granularity is 15 minutes.
- Every authenticated Hub user can view team-wide usage.
- The collector uploads numbers and deduplication identifiers only. It never uploads prompts, responses, tool content, project names, file paths, or conversation titles.
- The service preserves input, output, cache-read, cache-write, reasoning, and total counters.
- Fifteen-minute detail is retained for 90 days; older data is retained as daily summaries.
- Every new installation backfills the previous 72 hours, including installations belonging to users other than the initial operator.
- The existing 15-minute job runs the collector, but usage ingestion uses a separate API from quota reporting.
- The UI is a separate analytics-first page, defaults to the previous seven days, uses hourly display buckets, and splits the trend by Hub user.

## Definitions

- **Hub user**: the company email bound to the authenticated personal Hub token. The client cannot assert this value.
- **Provider**: `codex` or `claude`.
- **Model account**: the actual Codex or Claude account active on the reporting machine.
- **Model ID**: the raw model string recorded by the provider client, for example `gpt-5.5` or `gpt-5.6-sol`. It is not restricted by a hardcoded model list.
- **Installation ID**: a random local identifier used only for retry and duplicate protection. It is never shown in the UI.
- **Bucket**: a UTC-aligned 15-minute interval identified by its start time.

## Architecture

The existing `quota_guard` remains the only scheduler. Each run performs work in this order:

1. Complete existing quota probing, quota reporting, and account-rotation work.
2. Retry any previously prepared but unacknowledged usage batch.
3. Scan bounded log increments.
4. Aggregate new usage into 15-minute buckets.
5. Upload one bounded batch to `/api/token-usage`.
6. Advance acknowledged file positions only after the Hub confirms the batch.

Usage failure must not change the result of quota probing, quota reporting, authentication upload, or account rotation.

The browser queries usage through a separate read API. Usage data is not added to `/api/status`, the dashboard revision endpoint, quota history, or auth-pool candidate selection.

## Local collection state

Use a local SQLite database under the existing private quota-reporter state directory. It stores only collection metadata and numeric usage:

- the random installation ID;
- file identity, path, size, modification time, and acknowledged byte position;
- hashes of canonical usage records needed to suppress copied Codex history;
- account-switch boundaries written by `quota_guard`;
- pending batch ID, numeric bucket deltas, payload digest, and proposed cursor positions;
- the first-run backfill cutoff and completion state.

The database must not store conversation text or incomplete JSON lines. If the final line is incomplete, the acknowledged position remains before that line so the next run rereads it after completion.

### Cursor transaction

For each collection cycle:

1. Start from acknowledged positions.
2. Parse new complete records and prepare numeric bucket deltas.
3. Persist the pending batch and proposed cursor positions in one local transaction.
4. Send the batch.
5. After a successful Hub acknowledgement, promote the proposed positions to acknowledged positions and clear the pending batch in one local transaction.

After a crash, the collector sends the pending batch before scanning new bytes. A response lost after a successful server commit therefore causes a safe retry, not duplicate usage.

## File discovery and incremental reads

On ordinary runs, the collector compares file identity, size, and modification time and opens only new or changed conversation files. It reads only bytes after the acknowledged position.

It must handle:

- a file growing while it is read;
- an incomplete final line;
- truncation or replacement;
- renaming or archival;
- a file disappearing between discovery and open;
- a new Codex subagent file containing copied parent history.

A disappearing or concurrently moved file is skipped for that cycle and retried through normal discovery. It must not fail `quota_guard`.

## First-run 72-hour backfill

Every new installation uses the same backfill behavior:

1. Set the cutoff to exactly 72 hours before installation initialization.
2. Discover files updated within that period, including old conversations that were recently appended.
3. Count only usage records whose event time is at or after the cutoff.
4. For files that cannot contain eligible records, initialize the cursor at end-of-file without parsing their content.
5. After eligible files are processed, continue with ordinary incremental collection.

Backfill runs after normal quota work and has a maximum wall-clock budget of 10 seconds per `quota_guard` cycle. Progress is persistent, so it resumes during the next 15-minute cycle. It must never restart completed backfill work from zero.

The measured reference machine had 95 recently updated Codex files totaling about 2.9 GB. A complete parse took 44.97 seconds, about 39 seconds of CPU time, and about 54 MB peak memory. The 10-second budget is therefore an acceptance requirement, not an optional optimization. On the reference machine, the backfill should complete in approximately five scheduled cycles while normal quota work completes first on every cycle.

## Provider parsing and counting

### Codex

Codex token-count records expose cumulative and last-use counters including:

- `input_tokens`;
- `output_tokens`;
- `cached_input_tokens`;
- `cache_write_input_tokens`;
- `reasoning_output_tokens`;
- `total_tokens`.

The collector calculates deltas from cumulative counters within the logical session and attributes each delta to the model active for that record. It must identify logical sessions independently from physical files because Codex subagent files can embed copied parent and sibling session history.

A canonical record hash includes the logical session identity and the minimum numeric/time/model fields needed to identify the usage record. Copied history produces the same hash and is counted once. The raw source line is never persisted or uploaded.

For Codex display:

- `total_tokens` delta is authoritative Total;
- cached input is a subset of input and is not added again;
- reasoning output is a subset of output and is not added again.

### Claude

Claude assistant records expose the raw model ID, message ID, and usage containing:

- `input_tokens`;
- `output_tokens`;
- `cache_read_input_tokens`;
- `cache_creation_input_tokens`.

Claude may update the same assistant message repeatedly while streaming. The collector keeps the final observed usage for each message ID and reports only the positive difference from the previously acknowledged final value.

Claude Total is:

```text
input + output + cache read + cache creation
```

Claude cache creation is presented as cache write. Reasoning is zero when the provider record supplies no separate reasoning counter.

## Account attribution

The Hub user is always derived from primary token authentication on the server.

Model-account attribution follows these rules:

1. When `quota_guard` changes an account, it records an exact local switch boundary. Usage before and after that boundary is assigned to the corresponding accounts.
2. The switch record must be durably prepared before installing the new auth and finalized with the observed post-switch identity, so a crash cannot silently reverse the boundary.
3. For a user-initiated account switch that was not performed by `quota_guard`, all newly discovered usage in that report cycle is assigned to the account active at report time.
4. The product accepts up to one reporting interval of attribution error for manual switches.
5. During first-run backfill, known automatic switch boundaries are honored. Usage without a known automatic boundary is assigned to the current report-time account.

Multiple installations authenticated as the same Hub user contribute to the same team totals. Installation ID is used for duplicate protection only.

## Upload API

Add an authenticated `POST /api/token-usage` endpoint using the existing revocable primary Hub token. A batch contains:

- installation ID;
- batch ID;
- bucket deltas grouped by provider, model account, model ID, and bucket start;
- input, output, cache-read, cache-write, reasoning, and total values.

The payload does not contain a Hub email. The server obtains it from authentication.

The endpoint validates:

- an allowed provider;
- canonical UTC 15-minute bucket boundaries;
- finite non-negative integer counters;
- bounded string lengths;
- bounded rows and payload size;
- timestamps no more than five minutes in the future;
- detail no older than the 90-day retention boundary;
- absence of unknown fields.

### Idempotent server transaction

The server stores a unique receipt for `(Hub user, installation ID, batch ID)` together with the payload digest.

In one transaction it:

1. rejects reuse of the same identity with a different digest;
2. returns success without applying counters when the same receipt already exists;
3. inserts the receipt for a new batch;
4. adds deltas to the matching 15-minute rows;
5. updates compact current reporter state for the authenticated Hub user.

The receipt table is indexed by its unique key and retention time. Routine ingestion never scans usage history.

## Server data model

### Fifteen-minute detail

One row per:

```text
bucket_start × hub_user_email × provider × model_account_id × model_id
```

The row contains the six numeric counters and `updated_at`. The composite primary key supports additive upsert without a prior read.

### Daily summary

One row per UTC day and the same identity dimensions. Daily counters use the same meanings as detail counters.

### Reporter state

A compact current-state row records each Hub user's last successful usage report time. The UI reads this table to distinguish no report from zero usage without scanning batch receipts or token history.

### Retention

A daily maintenance operation processes detail older than 90 days. In one transaction it:

1. aggregates eligible 15-minute rows into daily rows;
2. upserts daily totals;
3. deletes only the detail rows included in the successful aggregation.

The operation is bounded by day or row batch so it cannot monopolize the database. Batch receipts are also pruned under a documented bounded retention policy after they can no longer be retried legitimately.

## Query API

Add a team-readable authenticated usage query endpoint. It accepts:

- start and end time;
- one or more Hub users;
- provider;
- model account;
- raw model ID;
- display granularity: 15 minutes, hour, or day;
- trend grouping: Hub user, provider, model account, or model;
- metric: total, input, output, cache read, cache write, or reasoning.

The endpoint returns:

- overall metric totals;
- a bounded chronological trend already aggregated to the requested granularity and grouping;
- a bounded breakdown grouped by Hub user, provider, model account, and model;
- compact last-report state for relevant Hub users.

Fifteen-minute and hourly queries are limited to the most recent 90 days. Older ranges use daily granularity. Query conditions must map to indexed equality or time-range constraints before aggregation. The API must not return installation IDs, file metadata, record hashes, batch IDs, or local paths.

## Token Usage page

Add a dedicated Token Usage navigation item and page. Do not place token analytics on the account availability page.

### Defaults

- Range: previous seven days.
- Display granularity: hour.
- Trend grouping: Hub user.
- Metric: Total.
- Visibility: every authenticated Hub user can view team-wide data.

### Filters

- quick ranges: 15 minutes, 1 hour, 24 hours, 7 days, and 30 days;
- custom start and end;
- Hub user;
- Codex or Claude;
- model account;
- raw model ID;
- display granularity;
- trend grouping;
- metric.

### Result layout

The selected analytics-first layout contains:

1. A top filter bar.
2. Summary cards for Total, Input, Output, and Cache.
3. A chronological trend chart, stacked by Hub user by default.
4. Exact hover/focus detail for time, Hub user, provider, model account, model, and token counters.
5. A breakdown table grouped by Hub user, provider, model account, and model, sorted by Total descending by default.
6. Row interaction that applies the row dimensions as filters for further drilldown.
7. Each Hub user's latest successful report time.

No report must render as `No usage report received`, not as zero. A valid query with reports but no matching usage may render zero.

## Browser and database read controls

- The Token Usage page queries lazily when opened.
- It does not change `/api/status` or dashboard revision polling.
- The default seven-day request is aggregated to hours on the server; the browser never downloads all 15-minute rows for that view.
- Identical browser queries are cached for five minutes within the current login session.
- Concurrent identical queries share one in-flight request.
- Authentication replacement or logout clears the cache and invalidates older in-flight responses.
- The page does not cause a team-wide push refresh after ingestion. It refreshes when visible and its cache expires, or after explicit user action.
- Server responses enforce bounded series and breakdown sizes.
- Static read-budget tests prevent usage ingestion and current account endpoints from scanning token history.

## Error behavior

### Local collector

- A provider parser error does not block the other provider or existing quota work.
- A malformed line is skipped with a local warning counter; no conversation content is written to logs.
- A concurrently moved or deleted file is retried later.
- Upload failure preserves the pending batch and proposed cursors.
- A rejected permanent payload is isolated and reported clearly rather than retried forever as an opaque failure.
- Backfill stops when its 10-second budget expires and resumes from persistent progress.

### Server and browser

- Reusing a batch identity with different content returns a conflict and applies no counters.
- A transient ingestion failure applies no partial batch.
- Query failure preserves the selected filters and displays a query-specific error.
- Usage query `401` follows the existing login recovery flow; non-401 failures do not clear login.
- Token Usage failures never alter the account availability page.

## Testing and acceptance

### Parser and cursor tests

- Codex cumulative counters produce positive deltas exactly once.
- Codex copied parent/sibling history in subagent files is not counted again.
- Model switches preserve raw model attribution.
- Codex cached input and reasoning are not double-counted in Total.
- Claude repeated streaming updates keep the final message usage and report only the acknowledged delta.
- Claude cache fields contribute to Total exactly once.
- A second scan with unchanged files reads no conversation bytes.
- An appended file reads only bytes after its acknowledged cursor.
- Partial lines, truncation, replacement, archival, and disappearance are recoverable.
- No persisted collector state contains prompt, response, path content beyond required file location, or raw log lines.

### Backfill tests

- Every fresh installation sets a 72-hour event cutoff.
- Old conversations updated recently are considered; old records inside them remain excluded.
- Files outside the backfill scope initialize without content parsing.
- Work stops within the 10-second budget and resumes at the saved position.
- Normal quota work executes before each backfill slice.
- Backfill completion is persistent and does not restart on reboot.

### Attribution tests

- Hub identity is derived from authentication, not payload fields.
- Automatic guard switches split usage at the recorded boundary.
- Manual switches attribute the report cycle to the report-time account.
- First-run history without known switch evidence uses the report-time account.
- Two installations for one Hub user add usage without colliding batch identities.

### API and database tests

- Retrying an identical batch applies counters once.
- Reusing a batch ID with a different digest fails without mutation.
- Receipt, bucket increments, and reporter state update atomically.
- Invalid counters, timestamps, dimensions, fields, and oversized payloads are rejected.
- All authenticated users can query team data; unauthenticated requests cannot.
- Equality and time constraints use the intended indexes.
- Daily compaction preserves exact totals before deleting detail.
- Fifteen-minute/hour queries reject ranges beyond 90 days; daily history remains queryable.

### UI behavior tests

- Default query is seven days, hourly, grouped by Hub user, metric Total.
- Every confirmed filter changes the query deterministically.
- Summary, trend, and breakdown totals agree.
- Cache and reasoning subsets are labeled so they cannot be read as additions to Codex Total.
- No-report state is distinct from a valid zero result.
- Five-minute cache and in-flight deduplication prevent redundant reads.
- Logout or token replacement prevents stale responses from updating the page.
- Chart details are keyboard focusable and do not rely only on color.

### Performance acceptance

- The three-day reference candidate set remains the benchmark: about 2.9 GB, 44.97 seconds complete parse, and about 54 MB peak memory before production optimization.
- A scheduled backfill slice returns control at the 10-second budget boundary.
- Ordinary cycles inspect only new or changed files and parse only new bytes.
- A no-change cycle performs no full log read.
- Usage querying remains independent from status refresh and quota-history reads.

## Rollout

1. Deploy schema and APIs without enabling collection.
2. Deploy the updated quota-reporter collector and local state migration.
3. Enable first-run 72-hour backfill for every installation.
4. Verify one installation end to end: local delta, authenticated batch, query result, retry idempotency, and no quota regression.
5. Enable the Token Usage navigation item after query data is verified.
6. Observe ingestion errors, query latency, daily compaction, and database row growth before broad rollout.

## Out of scope

- Uploading prompts, responses, project names, paths, or session titles.
- Cost or billing estimates; token counts are observed usage, not an invoice.
- Reconstructing exact account boundaries for manual switches between reports.
- Per-project attribution.
- Per-conversation browsing or links back to local logs.
- Real-time collection more frequent than the existing 15-minute schedule.
- A separate daemon, file watcher, or scheduler.
