# Task 1 report: Fine Multi-series Trend Renderer

## Status

Implemented and committed on `main`.

## Changes

- Replaced stacked trend geometry with independent shared-scale metric lines grouped by `group_value`.
- Preserved missing-bucket gaps while connecting explicit zero values.
- Added compact y-axis labels, four horizontal grid levels, sampled x-axis labels, and accessible X/Y axis groups.
- Added hidden-by-default, keyboard-focusable point markers with the existing escaped point labels.
- Replaced inert legend spans with focusable buttons and presentational hover/focus highlighting; no query/filter/URL state is changed.
- Added focused regression coverage for two groups with a missing hourly bucket and for a consecutive explicit-zero point.

## Exact RED/GREEN evidence

RED (before implementation):

```text
node --test tests/token-usage-dashboard.test.mjs
tests 10, pass 8, fail 2
summary and accessible trend ... failed: expected /Trend · Total/ but renderer emitted "Stacked by ..."
explicit zero remains connected ... failed: expected 1 trend-line path, received 0
```

GREEN (after implementation):

```text
node --test tests/token-usage-dashboard.test.mjs
tests 10, pass 10, fail 0
```

Full suite:

```text
npm test
tests 335, pass 334, fail 1
```

The sole failure is the pre-existing environment-sensitive `assertPortAvailable rejects occupied ports instead of allowing fallback` test. Its attempt to bind `127.0.0.1` failed with `EPERM` before the assertion; it is unrelated to this chart slice. All token-usage dashboard tests passed in the full run.

## Files

- `token-usage.html`
- `tests/token-usage-dashboard.test.mjs`
- `.superpowers/sdd/2026-08-21-token-usage-trend-pagination/task-1-report.md`

## Self-review

- No packages, routes, APIs, database reads, authentication flow, cache behavior, filters, or breakdown drill-down logic were changed.
- No changes were made to the unrelated `scripts/check_reporter_uptake.mjs` file.
- `git diff --check` passed.
- Legend listeners only set/remove chart highlight state and CSS classes; they do not call `loadUsage`, mutate controls, or update URL state.

## Concerns

- The full suite remains one test short of clean because the sandbox denied a loopback listener (`EPERM`). This is an environment blocker, not a renderer failure.
- Legend DOM event binding is exercised by the browser implementation; the lightweight existing VM harness does not implement query selectors, so the binding helper safely no-ops there.

## Review fix round 1

Addressed both review findings:

- X-axis labels now derive from distinct bucket timestamps, sample up to five evenly across the full range, and use local intraday time for hourly/15-minute views. Added a regression with two groups per bucket across four buckets; it verifies four unique, spread labels and intraday text.
- Enhanced only the dashboard VM harness with minimal chart/legend objects and added a behavioral regression invoking stored focus and blur listeners. It verifies `data-highlight-group` is set and removed without an additional fetch.

Verification after the fix:

```text
node --test tests/token-usage-dashboard.test.mjs
tests 12, pass 12, fail 0

npm test
tests 337, pass 336, fail 1
```

The same unrelated `assertPortAvailable` loopback bind failure (`EPERM`) remains the only full-suite failure.
