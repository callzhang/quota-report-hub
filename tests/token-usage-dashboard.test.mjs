import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  };
}

function usagePayload(overrides = {}) {
  return {
    generated_at: "2026-08-18T12:00:00.000Z",
    query: {},
    totals: { total_tokens: 10, input_tokens: 8, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 },
    trend: [],
    breakdown: [],
    reporters: [],
    ...overrides,
  };
}

function breakdownRows() {
  return Array.from({ length: 42 }, (_, index) => ({
    hub_user_email: `user-${index + 1}@stardust.ai`,
    provider: index % 2 ? "claude" : "codex",
    model_account_id: `account-${index + 1}`,
    model_id: `model-${index + 1}`,
    total_tokens: 4_200 - index,
    input_tokens: 2_000 - index,
    output_tokens: 1_000 - index,
    cache_read_tokens: 800 - index,
    cache_write_tokens: 300 - index,
    reasoning_tokens: 100 - index,
  }));
}

async function pageHarness(fetchImpl, initialToken = "saved-token") {
  const html = await readFile(new URL("../token-usage.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "token usage inline script must exist");
  const elements = new Map();
  let activeElement = null;
  const breakdownButtons = { rows: [], pager: [], byId: new Map() };
  const makeInteractiveElement = ({ id = "", dataset = {}, disabled = false } = {}) => {
    const listeners = {};
    return {
      id,
      dataset,
      disabled,
      addEventListener(type, listener) { listeners[type] = listener; },
      focus() { activeElement = this; },
      listeners,
    };
  };
  const hydrateBreakdownRows = (html) => {
    breakdownButtons.rows = [...html.matchAll(/<button id="([^"]+)" data-breakdown-index="([^"]+)"/g)]
      .map(([, id, index]) => makeInteractiveElement({ id, dataset: { breakdownIndex: index } }));
    breakdownButtons.byId = new Map(breakdownButtons.rows.map((button) => [button.id, button]));
  };
  const hydrateBreakdownButtons = (html) => {
    hydrateBreakdownRows(html);
    breakdownButtons.pager = [...html.matchAll(/<button data-breakdown-page="([^"]+)"([^>]*)>/g)]
      .map(([, page, attributes]) => makeInteractiveElement({ dataset: { breakdownPage: page }, disabled: /\sdisabled(?:\s|$)/.test(attributes) }));
  };
  const element = (id) => {
    if (!elements.has(id)) {
      const listeners = {};
      const current = {
        id,
        hidden: false,
        value: "",
        textContent: "",
        innerHTML: "",
        disabled: false,
        dataset: {},
        addEventListener(type, listener) { listeners[type] = listener; },
        focus() { activeElement = this; },
        listeners,
      };
      if (id === "trend-region") {
        const trendLines = [
          { dataset: { trendGroup: "derek@stardust.ai" }, classList: { states: new Set(), toggle(name, enabled) { if (enabled) this.states.add(name); else this.states.delete(name); }, remove(name) { this.states.delete(name); } } },
          { dataset: { trendGroup: "member@stardust.ai" }, classList: { states: new Set(), toggle(name, enabled) { if (enabled) this.states.add(name); else this.states.delete(name); }, remove(name) { this.states.delete(name); } } },
        ];
        const chart = { dataset: {}, querySelectorAll: (selector) => selector === ".trend-line" ? trendLines : [] };
        const legend = makeInteractiveElement({ dataset: { trendGroup: "derek@stardust.ai" } });
        current.querySelector = (selector) => selector === "[data-trend-chart]" ? chart : null;
        current.querySelectorAll = (selector) => selector === "[data-trend-legend]" ? [legend] : [];
        current.trendChart = chart;
        current.trendLines = trendLines;
        current.trendLegend = legend;
      }
      if (id === "breakdown-region") {
        let innerHTML = "";
        const table = {
          _innerHTML: "",
          get innerHTML() { return this._innerHTML; },
          set innerHTML(value) { this._innerHTML = value; hydrateBreakdownRows(value); },
        };
        const range = { _textContent: "", get textContent() { return this._textContent; }, set textContent(value) { this._textContent = value; } };
        const pageStatus = { _textContent: "", get textContent() { return this._textContent; }, set textContent(value) { this._textContent = value; } };
        Object.defineProperty(current, "innerHTML", {
          get() {
            return innerHTML
              .replace(/(<div data-breakdown-table>)[\s\S]*?(<\/div>)/, `$1${table.innerHTML}$2`)
              .replace(/(<span class="meta" data-breakdown-range>)[\s\S]*?(<\/span>)/, `$1${range.textContent}$2`)
              .replace(/(<span aria-live="polite" data-breakdown-page-status>)[\s\S]*?(<\/span>)/, `$1${pageStatus.textContent}$2`)
              .replace(/(<button data-breakdown-page="previous"[^>]*?)( disabled)?(>Previous)/, `$1${breakdownButtons.pager.find((button) => button.dataset.breakdownPage === "previous")?.disabled ? " disabled" : ""}$3`)
              .replace(/(<button data-breakdown-page="next"[^>]*?)( disabled)?(>Next)/, `$1${breakdownButtons.pager.find((button) => button.dataset.breakdownPage === "next")?.disabled ? " disabled" : ""}$3`);
          },
          set(value) {
            innerHTML = value;
            hydrateBreakdownButtons(value);
            table._innerHTML = value.match(/<div data-breakdown-table>([\s\S]*?)<\/div>/)?.[1] || "";
            range._textContent = value.match(/data-breakdown-range>([^<]+)/)?.[1] || "";
            pageStatus._textContent = value.match(/data-breakdown-page-status>([^<]+)/)?.[1] || "";
          },
        });
        current.querySelector = (selector) => {
          if (selector === "[data-breakdown-table]") return table;
          if (selector === "[data-breakdown-range]") return range;
          if (selector === "[data-breakdown-page-status]") return pageStatus;
          if (selector === "[data-breakdown-page=previous]") return breakdownButtons.pager.find((button) => button.dataset.breakdownPage === "previous") || null;
          if (selector === "[data-breakdown-page=next]") return breakdownButtons.pager.find((button) => button.dataset.breakdownPage === "next") || null;
          return null;
        };
        current.querySelectorAll = (selector) => {
          if (selector === "[data-breakdown-index]") return breakdownButtons.rows;
          if (selector === "[data-breakdown-page]") return breakdownButtons.pager;
          return [];
        };
      }
      elements.set(id, current);
    }
    return elements.get(id);
  };
  let cookieValue = initialToken ? `quota_report_hub_token=${encodeURIComponent(initialToken)}` : "";
  const document = {
    get activeElement() { return activeElement; },
    getElementById(id) { return /^breakdown-\d+$/.test(id) ? breakdownButtons.byId.get(id) || null : element(id); },
    querySelectorAll(selector) {
      if (selector === "[data-breakdown-index]") return breakdownButtons.rows;
      if (selector === "[data-breakdown-page]") return breakdownButtons.pager;
      return [];
    },
  };
  Object.defineProperty(document, "cookie", {
    get() { return cookieValue; },
    set(value) { cookieValue = value.includes("Max-Age=0") ? "" : value.split(";")[0]; },
  });
  const replacements = [];
  const location = {
    protocol: "https:",
    origin: "https://hub.example",
    pathname: "/token-usage.html",
    search: "",
    replace(value) { replacements.push(value); },
  };
  let now = Date.parse("2026-08-18T12:00:00.000Z");
  class FixedDate extends Date {
    constructor(value) { super(value === undefined ? now : value); }
    static now() { return now; }
  }
  const context = vm.createContext({
    document,
    location,
    history: { replaceState() {} },
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    Date: FixedDate,
    Intl,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    element,
    trendChart: element("trend-region").trendChart,
    trendLines: element("trend-region").trendLines,
    trendLegend: element("trend-region").trendLegend,
    get breakdownNext() { return breakdownButtons.pager.find((button) => button.dataset.breakdownPage === "next"); },
    get activeElement() { return document.activeElement; },
    replacements,
    getCookie: () => cookieValue,
    setNow(value) { now = value; },
    evaluate(source) { return vm.runInContext(source, context); },
  };
}

test("page exposes the complete query shell and reads only token usage", async () => {
  const html = await readFile(new URL("../token-usage.html", import.meta.url), "utf8");
  assert.match(html, /href="\.\/"[^>]*>Accounts/);
  assert.match(html, /href="\.\/users\.html"[^>]*>Users/);
  for (const id of ["start", "end", "hub-user", "provider", "model-account", "model", "granularity", "group-by", "metric"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const id of ["summary-region", "trend-region", "breakdown-region"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /const QUERY_CACHE_MS = 5 \* 60 \* 1000/);
  assert.match(html, /const BREAKDOWN_PAGE_SIZE = 20/);
  assert.match(html, /data-trend-chart/);
  assert.match(html, /breakdown-pagination/);
  assert.match(html, /const queryCache = new Map\(\)/);
  assert.match(html, /const queryRequests = new Map\(\)/);
  assert.match(html, /granularity\.value = "hour"/);
  assert.match(html, /groupBy\.value = "hub_user"/);
  assert.match(html, /metric\.value = "total"/);
  assert.match(html, /fetch\(`\/api\/token-usage-query\?\$\{queryString\}`/);
  assert.doesNotMatch(html, /id="reporter-panel"|id="reporter-region"|Usage by Hub user/);
  assert.doesNotMatch(html, /#trend-panel\s*\{[^}]*grid-column:\s*span 8/);
  assert.doesNotMatch(html, /\/api\/(?:status|status-revision|quota-history|auth-pool)/);
});

test("public READMEs document trend gaps and 20-row browser pagination", async () => {
  for (const file of ["../README.md", "../README.zh-CN.md"]) {
    const readme = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(readme, /20/);
    assert.match(readme, /(?:gap|缺口|空档)/i);
  }
});

test("saved login loads automatically and missing login returns through login page", async () => {
  let calls = 0;
  await pageHarness(async () => { calls += 1; return response(200, usagePayload()); });
  assert.equal(calls, 1);
  const missing = await pageHarness(async () => { throw new Error("must not fetch"); }, "");
  assert.deepEqual(missing.replacements, ["/login.html?next=%2Ftoken-usage.html"]);
});

test("identical and concurrent queries share the five minute cache", async () => {
  const pending = deferred();
  let calls = 0;
  const harnessPromise = pageHarness(async () => {
    calls += 1;
    if (calls === 1) return response(200, usagePayload());
    return pending.promise;
  });
  const harness = await harnessPromise;
  await harness.evaluate("loadUsage()")
  await harness.evaluate("loadUsage()")
  assert.equal(calls, 1, "startup and identical reloads reuse the cached response");
  harness.element("provider").value = "codex";
  const first = harness.evaluate("loadUsage()")
  const second = harness.evaluate("loadUsage()")
  assert.equal(calls, 2, "changed filter starts one new request");
  pending.resolve(response(200, usagePayload()));
  await Promise.all([first, second]);
  assert.equal(calls, 2, "concurrent identical query shares one fetch");
});

test("token upgrade is cached under the new session", async () => {
  let calls = 0;
  const harness = await pageHarness(async () => {
    calls += 1;
    return response(200, usagePayload({ auth_pool_user_token: "rotated-token" }));
  });
  await harness.evaluate("loadUsage()")
  assert.equal(calls, 1);
  assert.match(harness.getCookie(), /rotated-token/);
  assert.equal(harness.evaluate("authSessionGeneration"), 1);
});

test("stale 401 cannot clear a replacement session but current 401 returns to login", async () => {
  const oldRequest = deferred();
  let calls = 0;
  const harness = await pageHarness(async () => {
    calls += 1;
    if (calls === 1) return response(200, usagePayload());
    return oldRequest.promise;
  });
  harness.element("provider").value = "codex";
  const stale = harness.evaluate("loadUsage()")
  harness.evaluate('setCurrentToken("new-token")');
  oldRequest.resolve(response(401, { error: "unauthorized" }));
  await assert.rejects(stale, /session changed/);
  assert.match(harness.getCookie(), /new-token/);
  assert.deepEqual(harness.replacements, []);

  const current = await pageHarness(async () => response(401, { error: "unauthorized" }));
  assert.deepEqual(current.replacements, ["/login.html?next=%2Ftoken-usage.html"]);
  assert.equal(current.getCookie(), "");
});

test("transient errors preserve auth, selected filters, and the last successful result", async () => {
  let calls = 0;
  const harness = await pageHarness(async () => {
    calls += 1;
    return calls === 1 ? response(200, usagePayload()) : response(503, { error: "unavailable" });
  });
  const prior = harness.element("summary-region").innerHTML;
  harness.element("model").value = "gpt-5.5";
  await assert.rejects(harness.evaluate("loadUsage()"), /unavailable/);
  assert.equal(harness.element("model").value, "gpt-5.5");
  assert.equal(harness.element("summary-region").innerHTML, prior);
  assert.match(harness.getCookie(), /saved-token/);
  assert.equal(harness.replacements.length, 0);
  assert.equal(harness.element("error-region").hidden, false);
});

test("summary and accessible trend render exact counters without inventing data", async () => {
  const payload = usagePayload({
    totals: { total_tokens: 1200, input_tokens: 700, output_tokens: 200, cache_read_tokens: 250, cache_write_tokens: 50, reasoning_tokens: 33 },
    trend: [
      { bucket_start: "2026-08-18T09:00:00.000Z", group_value: "derek@stardust.ai", total_tokens: 100, input_tokens: 60, output_tokens: 20, cache_read_tokens: 15, cache_write_tokens: 5, reasoning_tokens: 3 },
      { bucket_start: "2026-08-18T10:00:00.000Z", group_value: "member@stardust.ai", total_tokens: 50, input_tokens: 30, output_tokens: 10, cache_read_tokens: 7, cache_write_tokens: 3, reasoning_tokens: 1 },
      { bucket_start: "2026-08-18T11:00:00.000Z", group_value: "derek@stardust.ai", total_tokens: 200, input_tokens: 120, output_tokens: 40, cache_read_tokens: 30, cache_write_tokens: 10, reasoning_tokens: 4 },
    ],
  });
  const harness = await pageHarness(async () => response(200, payload));
  const summary = harness.element("summary-region").innerHTML;
  const trend = harness.element("trend-region").innerHTML;
  assert.match(summary, />1,200</);
  assert.match(summary, />700</);
  assert.match(summary, />200</);
  assert.match(summary, />300</);
  assert.match(summary, /Cache read 250/);
  assert.match(summary, /Cache write 50/);
  assert.match(summary, /Reasoning 33/);
  assert.match(summary, /subsets of Total/);
  assert.match(trend, /Trend · Total/);
  assert.match(trend, /<svg/);
  assert.match(trend, /tabindex="0"/);
  assert.match(trend, /derek@stardust\.ai/);
  assert.match(trend, /member@stardust\.ai/);
  assert.match(trend, /total 100/);
  assert.match(trend, /input 60/);
  assert.match(trend, /cache read 15/);
  assert.match(trend, /reasoning 3/);
  assert.match(trend, /data-trend-group="derek@stardust\.ai"/);
  assert.match(trend, /data-trend-group="member@stardust\.ai"/);
  assert.match(trend, /stroke-width="1\.8"/);
  assert.match(trend, /stroke-linecap="round"/);
  assert.match(trend, /data-trend-point/);
  assert.match(trend, /aria-label="Y axis/);
  assert.match(trend, /aria-label="X axis/);
  assert.equal((trend.match(/<path class="trend-line"/g) || []).length, 3, "missing hourly bucket splits the path");
});

test("explicit zero remains connected in a trend line", async () => {
  const payload = usagePayload({ trend: [
    { bucket_start: "2026-08-18T09:00:00.000Z", group_value: "derek@stardust.ai", total_tokens: 100 },
    { bucket_start: "2026-08-18T10:00:00.000Z", group_value: "derek@stardust.ai", total_tokens: 0 },
    { bucket_start: "2026-08-18T11:00:00.000Z", group_value: "derek@stardust.ai", total_tokens: 200 },
  ] });
  const harness = await pageHarness(async () => response(200, payload));
  const trend = harness.element("trend-region").innerHTML;
  assert.equal((trend.match(/<path class="trend-line"/g) || []).length, 1);
});

test("singleton trend segments include painted line geometry while their exact-value markers stay hidden", async () => {
  const payload = usagePayload({ trend: [
    { bucket_start: "2026-08-18T09:00:00.000Z", group_value: "derek@stardust.ai", total_tokens: 100 },
    { bucket_start: "2026-08-18T11:00:00.000Z", group_value: "derek@stardust.ai", total_tokens: 200 },
  ] });
  const harness = await pageHarness(async () => response(200, payload));
  const trend = harness.element("trend-region").innerHTML;
  assert.match(trend, /<path class="trend-line"[^>]*d="M[^\"]+ L[^\"]+"/);
  const html = await readFile(new URL("../token-usage.html", import.meta.url), "utf8");
  assert.match(html, /\.trend-point \{ opacity: 0/);
});

test("trend x-axis labels use unique evenly spaced buckets and intraday time", async () => {
  const trend = [];
  for (const bucket of ["09:00:00.000Z", "10:00:00.000Z", "11:00:00.000Z", "12:00:00.000Z"]) {
    for (const group of ["derek@stardust.ai", "member@stardust.ai"]) {
      trend.push({ bucket_start: `2026-08-18T${bucket}`, group_value: group, total_tokens: 100 });
    }
  }
  const harness = await pageHarness(async () => response(200, usagePayload({ trend })));
  const xAxis = harness.element("trend-region").innerHTML.match(/<g aria-label="X axis labels">([\s\S]*?)<\/g>/)?.[1] || "";
  const labels = [...xAxis.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((match) => match[1]);
  assert.equal(labels.length, 4);
  assert.equal(new Set(labels).size, labels.length);
  assert.match(xAxis, /\d{1,2}:00/);
});

test("multi-day hourly trend labels include compact local dates and times", async () => {
  const trend = Array.from({ length: 7 }, (_, index) => ({
    bucket_start: new Date(Date.UTC(2026, 7, 17 + index, 9)).toISOString(),
    group_value: "derek@stardust.ai",
    total_tokens: 100 + index,
  }));
  const harness = await pageHarness(async () => response(200, usagePayload({ trend })));
  const xAxis = harness.element("trend-region").innerHTML.match(/<g aria-label="X axis labels">([\s\S]*?)<\/g>/)?.[1] || "";
  assert.ok((xAxis.match(/<text /g) || []).length <= 5);
  assert.match(xAxis, /<tspan[^>]*>[^<]+<\/tspan><tspan[^>]*>[^<]+<\/tspan>/);
});

test("legend focus highlights its group and blur clears it without fetching", async () => {
  let calls = 0;
  const harness = await pageHarness(async () => { calls += 1; return response(200, usagePayload()); });
  assert.equal(calls, 1);
  harness.trendLegend.listeners.focus();
  assert.equal(harness.trendChart.dataset.highlightGroup, "derek@stardust.ai");
  assert.equal(harness.trendLines[0].classList.states.has("is-highlighted"), true);
  assert.equal(harness.trendLines[1].classList.states.has("is-highlighted"), false);
  harness.trendLegend.listeners.blur();
  assert.equal(harness.trendChart.dataset.highlightGroup, undefined);
  assert.equal(calls, 1);
});

test("focused Next keeps its logical control after local paging", async () => {
  let calls = 0;
  const harness = await pageHarness(async () => { calls += 1; return response(200, usagePayload({ breakdown: breakdownRows() })); });
  const next = harness.breakdownNext;
  next.focus();
  next.listeners.click();
  assert.match(harness.element("breakdown-region").innerHTML, /Showing 21–40 of 42/);
  assert.equal(calls, 1);
  assert.equal(harness.activeElement, harness.breakdownNext);
});

test("breakdown paginates locally without additional fetches and resets on a successful payload", async () => {
  let calls = 0;
  const payload = usagePayload({ breakdown: breakdownRows() });
  const harness = await pageHarness(async () => { calls += 1; return response(200, payload); });
  const firstPage = harness.element("breakdown-region").innerHTML;
  assert.equal((firstPage.match(/data-breakdown-index/g) || []).length, 20);
  assert.match(firstPage, /Showing 1–20 of 42/);
  assert.match(firstPage, /Page 1 of 3/);
  assert.match(firstPage, /aria-label="Previous breakdown page"[^>]*disabled/);
  assert.match(firstPage, /aria-label="Next breakdown page"/);

  harness.evaluate("goToBreakdownPage(1)");
  assert.match(harness.element("breakdown-region").innerHTML, /Showing 21–40 of 42/);
  harness.evaluate("goToBreakdownPage(1)");
  const finalPage = harness.element("breakdown-region").innerHTML;
  assert.equal((finalPage.match(/data-breakdown-index/g) || []).length, 2);
  assert.match(finalPage, /Showing 41–42 of 42/);
  assert.match(finalPage, /aria-label="Next breakdown page"[^>]*disabled/);
  assert.equal(calls, 1, "page changes reuse the successful payload");

  harness.evaluate(`renderShell(${JSON.stringify(payload)})`);
  assert.match(harness.element("breakdown-region").innerHTML, /Page 1 of 3/);
  assert.equal(calls, 1, "re-rendering a successful payload does not fetch");
});

test("breakdown sorts by total and drilldown applies four exact dimensions once", async () => {
  let calls = 0;
  const rows = breakdownRows();
  const payload = usagePayload({ breakdown: rows });
  const harness = await pageHarness(async () => { calls += 1; return response(200, payload); });
  const table = harness.element("breakdown-region").innerHTML;
  assert.ok(table.indexOf("user-1@stardust.ai") < table.indexOf("user-2@stardust.ai"));

  harness.evaluate("goToBreakdownPage(1)");
  await harness.evaluate(`applyBreakdownFilters(${JSON.stringify(rows[20])})`);
  assert.equal(harness.element("hub-user").value, "user-21@stardust.ai");
  assert.equal(harness.element("provider").value, "codex");
  assert.equal(harness.element("model-account").value, "account-21");
  assert.equal(harness.element("model").value, "model-21");
  assert.match(harness.element("breakdown-region").innerHTML, /Page 1 of 3/);
  assert.equal(calls, 2, "drilldown changes the query exactly once");
});

test("successful zero usage remains visible without a duplicate user summary panel", async () => {
  const harness = await pageHarness(async () => response(200, usagePayload({
    totals: { total_tokens: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 },
    reporters: [{ hub_user_email: "never@stardust.ai", last_reported_at: null, total_tokens: 0 }],
  })));
  assert.match(harness.element("summary-region").innerHTML, />0</);
});
