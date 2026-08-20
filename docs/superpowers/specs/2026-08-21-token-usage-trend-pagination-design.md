# Token Usage Trend and Breakdown Pagination Design

**Date:** 2026-08-21  
**Status:** User-approved design; implementation awaits review of this document.  
**Scope:** `token-usage.html` presentation and its browser-side behavior only.

## Goal

Make the Token Usage page easier to scan when the selected time range contains multiple Hub users and many provider/model combinations:

1. replace the current stacked, point-heavy trend display with a fine multi-series line chart; and
2. prevent the Breakdown table from growing without limit by rendering it in fixed-size browser-side pages.

The existing authenticated query API, query cache, filters, server-side result bounds, data model, and database reads are unchanged.

## Chosen Direction: A — Fine Multi-series Lines + 20-row Pagination

The chart renders one independent line for each current `group_by` value. Lines show the currently selected metric and share the same x-axis and y-axis, so their heights remain directly comparable. The chart is not stacked and does not infer missing data.

The Breakdown list remains sorted by descending total token count, as today. The page stores the bounded response locally, shows exactly 20 rows per page, and changes pages without another HTTP request.

## Trend Chart

### Visual behavior

- A chart has a compact `Trend · <metric>` label and an SVG with a responsive view box.
- Each group uses its existing stable color and a 1.5–2 px line. Lines have rounded joins/caps.
- The y-axis contains 3–5 evenly spaced, compact values such as `0`, `125K`, `2.4M`, or `1.1B`.
- The x-axis contains up to five evenly spaced local-time labels chosen from the actual bucket range.
- Low-contrast horizontal grid lines support reading values without competing with the data.
- The legend retains each group name and color. Hovering or keyboard focusing a legend item highlights its line and dims the others. Leaving the legend restores all lines.
- A point marker is visually hidden by default. Hovering or keyboard focusing a chart point makes the marker visible and exposes its existing exact time, dimensions, and counters through the accessible label/title. Points remain keyboard focusable.

### Data and gaps

- Lines are sorted by `bucket_start` within a group.
- The renderer starts a new SVG path whenever successive observations are farther apart than one expected bucket. A missing quarter-hour, hour, or day therefore remains a visible gap; no value is interpolated.
- A zero-valued reported bucket remains a valid point on the baseline. Only an absent bucket creates a gap.
- If the response contains no points, the existing empty state remains.
- For more than a practical number of groups, all groups are still represented; legend interaction makes a series readable without changing query results or omitting data.

## Breakdown Pagination

### Layout

- The table retains all existing columns and horizontal scrolling behavior on narrow screens.
- It renders at most 20 rows at a time.
- A footer below the table states the inclusive range and total, for example `Showing 21–40 of 86`.
- `Previous` and `Next` buttons are disabled at their respective bounds. Between them, the current page is announced as `Page 2 of 5`.
- With 20 or fewer rows, the footer still gives a total count but controls may be omitted or disabled; no empty second page is created.

### State and accessibility

- Pagination state is browser-local and resets to page 1 whenever a new successful query payload is rendered or a Breakdown row applies its drill-down filters.
- Changing pages re-renders only Breakdown markup. It does not call `/api/token-usage-query`, alter the selected query, or disturb the chart/summary.
- Button labels state their result, for example `Previous breakdown page` and `Next breakdown page`.
- Keyboard users can move to the pager and then to the newly visible row controls in normal tab order. Focus is not forcibly moved on ordinary paging.

## Error, Loading, and Compatibility Rules

- Existing authentication, token-upgrade, request de-duplication, five-minute query cache, and transient-error behavior remain unchanged.
- A failed query preserves the last successful result and therefore preserves its currently rendered page; a later successful query resets to page 1.
- The existing Breakdown-row drill-down continues to set the four exact filter dimensions and perform one query; its returned results begin on page 1.
- The implementation remains plain inline HTML/CSS/JavaScript; it adds no packages and no API route.

## Test Plan

Add browser-script harness coverage for:

1. independent line paths rather than stacked-area geometry, fine stroke styling, y-axis labels, and bounded x-axis labels;
2. a missing expected bucket producing two paths rather than a connecting line;
3. zero-valued reported buckets remaining connected;
4. legend focus/hover state making the selected series distinguishable;
5. exactly 20 rows on page 1, correct range text and page count, and a correct final partial page;
6. disabled Previous/Next boundaries and page navigation without a new fetch;
7. new query payloads and Breakdown drill-down resetting the page to 1.

Run the focused dashboard tests and the full repository test suite. Then use the authenticated production page for desktop and mobile visual checks: page identity, non-empty content, chart readability, pager interaction, and console health.

## Non-goals

- No API pagination and no increase to the existing server-side breakdown result limit.
- No changes to collection frequency, aggregation granularity, token accounting, or access control.
- No trend smoothing, interpolation, or synthetic data.
