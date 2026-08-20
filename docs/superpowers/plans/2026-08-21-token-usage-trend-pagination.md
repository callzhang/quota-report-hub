# Token Usage Trend and Breakdown Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Token Usage stacked trend with a fine, accessible multi-series line chart and render Breakdown in local 20-row pages.

**Architecture:** Keep `/api/token-usage-query` and its five-minute client cache unchanged. `token-usage.html` groups the already-bounded trend payload by current `group_by`, draws a same-scale path per group, and splits paths at missing expected buckets. It retains sorted Breakdown rows in `breakdownRegion.dataset`, tracks a local one-based page number, and re-renders table markup without fetching.

**Tech Stack:** Static HTML, inline CSS/JavaScript, Node built-in test runner, VM browser-script harness.

**Spec:** `docs/superpowers/specs/2026-08-21-token-usage-trend-pagination-design.md`

## Global Constraints

- Do not add packages, routes, API pagination, or database reads.
- Preserve authenticated query flow, token upgrades, five-minute query cache, selected filters, server-side result bounds, and existing drill-down query behavior.
- Use one independent 1.5–2 px line per `group_by` value on a shared scale; do not stack, smooth, interpolate, or synthesize values.
- Split paths at absent expected buckets; keep explicitly reported zero values connected.
- Render at most 20 Breakdown rows per browser page; pagination must not fetch.
- Reset Breakdown to page 1 on every new successful payload and before a Breakdown drill-down query.
- Retain keyboard access to data-point labels and provide semantic pager labels and bounds.

---

### Task 1: Fine Multi-series Trend Renderer

**Files:**
- Modify: `tests/token-usage-dashboard.test.mjs:180-226`
- Modify: `token-usage.html:59-66,239-310`

**Interfaces:**
- Consumes: `renderTrendChart(points)`, `selectedMetricCounter()`, `trendBucketMs()`, `pointLabel(point)`, and `stableColor(group)` from `token-usage.html`.
- Produces: `renderTrendChart(points)` HTML containing same-scale SVG line paths with `data-trend-group`, hidden-by-default focusable point markers, axis/grid labels, and focusable legend controls.

- [ ] **Step 1: Write the failing renderer tests**

  Replace the existing stacked-chart assertions in the `summary and accessible trend` test with a payload containing two groups and a missing hourly bucket. Add these assertions:

  ```js
  assert.match(trend, /Trend · Total/);
  assert.match(trend, /data-trend-group="derek@stardust\.ai"/);
  assert.match(trend, /data-trend-group="member@stardust\.ai"/);
  assert.match(trend, /stroke-width="1\.8"/);
  assert.match(trend, /stroke-linecap="round"/);
  assert.match(trend, /data-trend-point/);
  assert.match(trend, /aria-label="Y axis/);
  assert.match(trend, /aria-label="X axis/);
  assert.equal((trend.match(/<path class="trend-line"/g) || []).length, 3);
  ```

  Add a separate zero-value regression with three consecutive hourly points for one group, where the middle point has `total_tokens: 0`, and assert one `<path class="trend-line">` exists. The existing missing-bucket fixture must assert two paths for that same group.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run:

  ```bash
  node --test tests/token-usage-dashboard.test.mjs
  ```

  Expected: FAIL because the existing chart says `Stacked by`, uses `stack_top`, and emits 3 px paths with permanent 5 px circles rather than the specified independent line structure.

- [ ] **Step 3: Implement the smallest chart helpers and markup**

  In `token-usage.html`, replace stacked-point construction with helpers that are local to the page script:

  ```js
  function compactNumber(value) {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }

  function splitTrendSegments(points) {
    const segments = [];
    let segment = [];
    let previousTime = null;
    for (const point of points) {
      const time = new Date(point.bucket_start).getTime();
      if (previousTime !== null && time - previousTime > trendBucketMs() * 1.5) {
        segments.push(segment);
        segment = [];
      }
      segment.push({ point, time });
      previousTime = time;
    }
    if (segment.length) segments.push(segment);
    return segments;
  }
  ```

  Compute `maximum` from individual selected-metric values, group sorted points by `group_value`, and map each segment to one path using `y(Number(point[metricCounter] || 0))`. Emit a `trend-line` path with `data-trend-group`, `stroke-width="1.8"`, `stroke-linecap="round"`, and `stroke-linejoin="round"`. Build 4 horizontal grid/y labels and up to 5 evenly sampled x labels. Give the SVG accessible X/Y axis group labels.

  Emit point circles with class `trend-point`, `data-trend-point`, `tabindex="0"`, `role="img"`, and the existing escaped `pointLabel`; style `.trend-point { opacity: 0; }` and reveal it for `:hover`/`:focus`. Replace inert legend spans with buttons using `data-trend-legend` and `data-trend-group`; add CSS that dims nonmatching paths when the SVG wrapper has `data-highlight-group`.

- [ ] **Step 4: Bind legend interaction without changing query state**

  Add `bindTrendLegendActions()` and call it after assigning `trendRegion.innerHTML` in `renderShell`:

  ```js
  function bindTrendLegendActions() {
    const chart = trendRegion.querySelector("[data-trend-chart]");
    trendRegion.querySelectorAll("[data-trend-legend]").forEach((legend) => {
      const setHighlight = () => { chart.dataset.highlightGroup = legend.dataset.trendGroup; };
      legend.addEventListener("mouseenter", setHighlight);
      legend.addEventListener("focus", setHighlight);
      legend.addEventListener("mouseleave", () => { delete chart.dataset.highlightGroup; });
      legend.addEventListener("blur", () => { delete chart.dataset.highlightGroup; });
    });
  }
  ```

  Keep the legend action presentational only: it must not call `loadUsage`, mutate filters, or write URL state.

- [ ] **Step 5: Run the focused test to verify it passes**

  Run:

  ```bash
  node --test tests/token-usage-dashboard.test.mjs
  ```

  Expected: PASS; both missing-bucket and explicit-zero behavior are covered, and all existing dashboard behavior remains green.

- [ ] **Step 6: Commit the chart slice**

  ```bash
  git add token-usage.html tests/token-usage-dashboard.test.mjs
  git commit -m "feat: refine token usage trend chart"
  ```

### Task 2: Local Breakdown Pagination

**Files:**
- Modify: `tests/token-usage-dashboard.test.mjs:37-82,227-247`
- Modify: `token-usage.html:146-166,313-351,389-391`

**Interfaces:**
- Consumes: `renderBreakdown(rows)`, `bindBreakdownActions()`, `applyBreakdownFilters(row)`, and the existing `breakdownRegion` element.
- Produces: `BREAKDOWN_PAGE_SIZE`, `breakdownPage`, `renderBreakdownPage()`, and pager buttons that update only `breakdownRegion.innerHTML`.

- [ ] **Step 1: Write failing pagination tests**

  Add a helper fixture with 42 deterministic Breakdown rows where totals decrease with index. The test calls the page-script `goToBreakdownPage(1)` helper that this task will introduce; it does not need a DOM parser in the VM harness.

  Add a test that starts from the normal successful page load and asserts:

  ```js
  assert.equal((firstPage.match(/data-breakdown-index/g) || []).length, 20);
  assert.match(firstPage, /Showing 1–20 of 42/);
  assert.match(firstPage, /Page 1 of 3/);
  assert.match(firstPage, /aria-label="Previous breakdown page"[^>]*disabled/);
  assert.match(firstPage, /aria-label="Next breakdown page"/);
  ```

  Call `goToBreakdownPage(1)`, assert `Showing 21–40 of 42`, then call it again and assert exactly two row controls and `Showing 41–42 of 42`; assert Next is disabled. Track `fetch` calls and assert they remain one throughout page changes.

  Add a test that navigates to page 2, calls `renderShell(payload)`, and asserts page 1 is restored. Change the drill-down fixture to use the 42-row helper, call `goToBreakdownPage(1)`, then invoke `applyBreakdownFilters(rows[20])`; assert the four filter values equal that selected row, the new rendered Breakdown says `Page 1 of`, and the fetch count rises by exactly one.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run:

  ```bash
  node --test tests/token-usage-dashboard.test.mjs
  ```

  Expected: FAIL because the current renderer outputs every row and has no range, page state, or pager controls.

- [ ] **Step 3: Add browser-local page state and page renderer**

  Define this state next to the existing page-script globals:

  ```js
  const BREAKDOWN_PAGE_SIZE = 20;
  let breakdownPage = 1;
  ```

  Make `renderBreakdown(rows)` sort rows, store the full sorted list in `breakdownRegion.dataset.rows`, set `breakdownPage = 1`, and return `renderBreakdownPage()`.

  Implement `renderBreakdownPage()` to parse the stored rows, clamp `breakdownPage` to `1..pageCount`, render `rows.slice(startIndex, endIndex)`, and append:

  ```html
  <div class="breakdown-pagination" aria-label="Breakdown pagination">
    <span class="meta">Showing 21–40 of 42</span>
    <div class="pager-actions">
      <button data-breakdown-page="previous" aria-label="Previous breakdown page">Previous</button>
      <span aria-live="polite">Page 2 of 3</span>
      <button data-breakdown-page="next" aria-label="Next breakdown page">Next</button>
    </div>
  </div>
  ```

  Render `disabled` on the appropriate boundary buttons. Use the page-local index for `id="breakdown-${index}"` but preserve the absolute sorted-row index in `data-breakdown-index` so drill-down uses the correct row. Add the page-script helper used by the test:

  ```js
  function goToBreakdownPage(delta) {
    const rows = JSON.parse(breakdownRegion.dataset.rows || "[]");
    const pageCount = Math.max(1, Math.ceil(rows.length / BREAKDOWN_PAGE_SIZE));
    breakdownPage = Math.min(pageCount, Math.max(1, breakdownPage + delta));
    breakdownRegion.innerHTML = renderBreakdownPage();
    bindBreakdownActions();
  }
  ```

- [ ] **Step 4: Bind paging and preserve existing drill-down behavior**

  In `bindBreakdownActions()`, add click handlers for `[data-breakdown-page]` that call `goToBreakdownPage(-1)` or `goToBreakdownPage(1)`. Do not call `loadUsage()`.

  Keep row buttons bound from the full `dataset.rows` array. At the start of `applyBreakdownFilters(row)`, set `breakdownPage = 1` before setting the four filter inputs and calling `loadUsage()`.

  Add CSS near `.table-shell`:

  ```css
  .breakdown-pagination { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-top:14px; }
  .pager-actions { display:flex; align-items:center; gap:8px; }
  .pager-actions button:disabled { cursor:default; opacity:.45; }
  ```

- [ ] **Step 5: Run focused tests to verify they pass**

  Run:

  ```bash
  node --test tests/token-usage-dashboard.test.mjs
  ```

  Expected: PASS; 20-row bounds, partial final page, no-fetch paging, reset behavior, and exact drill-down remain covered.

- [ ] **Step 6: Commit the pagination slice**

  ```bash
  git add token-usage.html tests/token-usage-dashboard.test.mjs
  git commit -m "feat: paginate token usage breakdown"
  ```

### Task 3: Documentation and Full Validation

**Files:**
- Modify: `README.md:7-15`
- Modify: `README.zh-CN.md:5-13`
- Verify: `token-usage.html`
- Verify: `tests/token-usage-dashboard.test.mjs`

**Interfaces:**
- Consumes: completed chart and pager behavior from Tasks 1–2.
- Produces: concise public documentation and verified desktop/mobile production rendering.

- [ ] **Step 1: Add the failing documentation expectation**

  In `tests/token-usage-dashboard.test.mjs`, add a small `readFile`-based test for both READMEs:

  ```js
  for (const file of ["../README.md", "../README.zh-CN.md"]) {
    const readme = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(readme, /20/);
    assert.match(readme, /(?:gap|缺口|空档)/i);
  }
  ```

  Also extend the page-shell assertion with `BREAKDOWN_PAGE_SIZE = 20`, `data-trend-chart`, and `breakdown-pagination` so later refactors retain the approved behavioral contracts.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run:

  ```bash
  node --test tests/token-usage-dashboard.test.mjs
  ```

  Expected: FAIL because neither README yet documents the 20-row Breakdown page size or unfilled chart gaps.

- [ ] **Step 3: Update user-facing documentation**

  Add one short sentence to both READMEs:

  ```markdown
  The Token Usage Trend is a same-scale line chart by the selected group; missing collection buckets remain visible gaps. Breakdown is browser-paginated in 20-row pages and does not issue another query when you change pages.
  ```

  Translate the sentence naturally in `README.zh-CN.md`, retaining the exact facts: shared scale, gaps are not filled, 20 rows, and no extra query.

- [ ] **Step 4: Run focused and full automated verification**

  Run:

  ```bash
  node --test tests/token-usage-dashboard.test.mjs
  npm test
  git diff --check
  ```

  Expected: all tests pass and `git diff --check` produces no output.

- [ ] **Step 5: Commit documentation and verification contract**

  ```bash
  git add README.md README.zh-CN.md tests/token-usage-dashboard.test.mjs
  git commit -m "docs: describe token usage chart navigation"
  ```

- [ ] **Step 6: Deploy the verified page to production**

  Run:

  ```bash
  vercel deploy --prod --yes
  vercel inspect https://quota-report-hub.vercel.app
  ```

  Expected: the deployment is `Ready` and aliases `https://quota-report-hub.vercel.app`.

- [ ] **Step 7: Perform rendered production QA**

  Use the Browser plugin on `https://quota-report-hub.vercel.app/token-usage.html` with the existing authenticated session. Verify:

  1. title is `Token Usage · Quota Report Hub` and the page is nonempty;
  2. desktop chart has fine separate lines, axes, legible legend, and visible missing-bucket gaps;
  3. select one legend item with mouse and keyboard focus and observe highlight/dimming without an API request;
  4. navigate Breakdown to the final page and back, checking range text, disabled boundary controls, and no console warnings/errors;
  5. repeat visual inspection at a 390 px-wide mobile viewport, confirming chart labels and pager are readable and the table scrolls horizontally.

  Capture desktop and mobile screenshots outside the repository.
