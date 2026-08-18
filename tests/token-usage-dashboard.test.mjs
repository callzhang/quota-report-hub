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

async function pageHarness(fetchImpl, initialToken = "saved-token") {
  const html = await readFile(new URL("../token-usage.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "token usage inline script must exist");
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const listeners = {};
      elements.set(id, {
        id,
        hidden: false,
        value: "",
        textContent: "",
        innerHTML: "",
        disabled: false,
        dataset: {},
        addEventListener(type, listener) { listeners[type] = listener; },
        focus() {},
        listeners,
      });
    }
    return elements.get(id);
  };
  let cookieValue = initialToken ? `quota_report_hub_token=${encodeURIComponent(initialToken)}` : "";
  const document = { getElementById: element, querySelectorAll: () => [] };
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
  for (const id of ["summary-region", "trend-region", "breakdown-region", "reporter-region"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /const QUERY_CACHE_MS = 5 \* 60 \* 1000/);
  assert.match(html, /const queryCache = new Map\(\)/);
  assert.match(html, /const queryRequests = new Map\(\)/);
  assert.match(html, /granularity\.value = "hour"/);
  assert.match(html, /groupBy\.value = "hub_user"/);
  assert.match(html, /metric\.value = "total"/);
  assert.match(html, /fetch\(`\/api\/token-usage-query\?\$\{queryString\}`/);
  assert.doesNotMatch(html, /\/api\/(?:status|status-revision|quota-history|auth-pool)/);
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

test("summary, accessible trend, and reporters render exact counters without inventing data", async () => {
  const payload = usagePayload({
    totals: { total_tokens: 1200, input_tokens: 700, output_tokens: 200, cache_read_tokens: 250, cache_write_tokens: 50, reasoning_tokens: 33 },
    trend: [
      { bucket_start: "2026-08-18T09:00:00.000Z", group_value: "derek@stardust.ai", total_tokens: 100, input_tokens: 60, output_tokens: 20, cache_read_tokens: 15, cache_write_tokens: 5, reasoning_tokens: 3 },
      { bucket_start: "2026-08-18T11:00:00.000Z", group_value: "derek@stardust.ai", total_tokens: 200, input_tokens: 120, output_tokens: 40, cache_read_tokens: 30, cache_write_tokens: 10, reasoning_tokens: 4 },
    ],
    reporters: [{ hub_user_email: "derek@stardust.ai", last_reported_at: "2026-08-18T11:45:00.000Z" }],
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
  assert.match(trend, /<svg/);
  assert.match(trend, /tabindex="0"/);
  assert.match(trend, /derek@stardust\.ai/);
  assert.match(trend, /total 100/);
  assert.match(trend, /input 60/);
  assert.match(trend, /cache read 15/);
  assert.match(trend, /reasoning 3/);
  assert.equal((trend.match(/<path /g) || []).length, 2, "missing hourly bucket splits the path");
  assert.match(harness.element("reporter-region").innerHTML, /derek@stardust\.ai/);
});

test("breakdown sorts by total and drilldown applies four exact dimensions once", async () => {
  let calls = 0;
  const payload = usagePayload({ breakdown: [
    { hub_user_email: "small@stardust.ai", provider: "codex", model_account_id: "small-account", model_id: "future-model-x", total_tokens: 10, input_tokens: 8, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 },
    { hub_user_email: "large@stardust.ai", provider: "claude", model_account_id: "large-account", model_id: "claude-new-9", total_tokens: 900, input_tokens: 400, output_tokens: 100, cache_read_tokens: 300, cache_write_tokens: 100, reasoning_tokens: 0 },
  ] });
  const harness = await pageHarness(async () => { calls += 1; return response(200, payload); });
  const table = harness.element("breakdown-region").innerHTML;
  assert.ok(table.indexOf("large@stardust.ai") < table.indexOf("small@stardust.ai"));
  assert.match(table, /future-model-x/);

  await harness.evaluate(`applyBreakdownFilters(${JSON.stringify(payload.breakdown[0])})`);
  assert.equal(harness.element("hub-user").value, "small@stardust.ai");
  assert.equal(harness.element("provider").value, "codex");
  assert.equal(harness.element("model-account").value, "small-account");
  assert.equal(harness.element("model").value, "future-model-x");
  assert.equal(calls, 2, "drilldown changes the query exactly once");
});

test("reporter absence differs from a successful zero usage result", async () => {
  const harness = await pageHarness(async () => response(200, usagePayload({
    totals: { total_tokens: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 },
    reporters: [{ hub_user_email: "never@stardust.ai", last_reported_at: null }],
  })));
  assert.match(harness.element("summary-region").innerHTML, />0</);
  assert.match(harness.element("reporter-region").innerHTML, /No usage report received/);
  assert.match(harness.element("reporter-region").innerHTML, /never@stardust\.ai/);
});
