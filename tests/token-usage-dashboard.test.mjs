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
