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
    headers: { get: () => "application/json" },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function statusPayload(revision, revisionToken, email = "member@stardust.ai") {
  return {
    viewer_email: email,
    dashboard_revision: revision,
    dashboard_revision_token: revisionToken,
    items: [],
    archived_invalidated_items: [],
    fetch_log: [],
    health_history: [],
  };
}

async function dashboardHarness(fetchImpl, initialToken = "old-token") {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "dashboard inline script must exist");

  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const listeners = {};
      elements.set(id, {
        hidden: false,
        value: "",
        textContent: "",
        innerHTML: "",
        checked: false,
        disabled: false,
        placeholder: "",
        querySelectorAll() { return []; },
        addEventListener(type, listener) { listeners[type] = listener; },
        listeners,
      });
    }
    return elements.get(id);
  };
  const documentListeners = {};
  let cookieValue = `quota_report_hub_token=${encodeURIComponent(initialToken)}`;
  const document = {
    visibilityState: "visible",
    getElementById: element,
    addEventListener(type, listener) { documentListeners[type] = listener; },
  };
  Object.defineProperty(document, "cookie", {
    get() { return cookieValue; },
    set(value) {
      cookieValue = value.includes("Max-Age=0") ? "" : value.split(";")[0];
    },
  });
  const storage = new Map();
  const windowListeners = new Map();
  const context = vm.createContext({
    document,
    location: { protocol: "https:", origin: "https://hub.example" },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    fetch: fetchImpl,
    setInterval() {},
    setTimeout,
    clearTimeout,
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener(type, listener) { windowListeners.set(type, listener); },
      removeEventListener(type, listener) {
        if (windowListeners.get(type) === listener) windowListeners.delete(type);
      },
    },
    console,
  });
  vm.runInContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    document,
    documentListeners,
    element,
    getCookie: () => cookieValue,
    evaluate(source) { return vm.runInContext(source, context); },
    windowListeners,
  };
}

test("mixed quota history colors expired evidence gray without graying current evidence", async () => {
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    throw new Error(`unexpected request ${url}`);
  });
  const now = Date.now();
  const points = [
    { reported_at: new Date(now - 7200000).toISOString(), status: "ok", one_week_remaining_percent: 10, one_week_reset_at: new Date(now - 3600000).toISOString() },
    { reported_at: new Date(now - 1800000).toISOString(), status: "ok", one_week_remaining_percent: 80, one_week_reset_at: new Date(now + 7200000).toISOString() },
  ];
  const markup = harness.evaluate(`renderQuotaHistoryChart(${JSON.stringify(points)})`);

  assert.match(markup, /history-historical/);
  assert.match(markup, /history-current/);
  assert.equal((markup.match(/history-historical/g) || []).length, 1);
  assert.equal((markup.match(/history-current/g) || []).length, 1);
});

test("quota history cache and in-flight requests do not cross auth sessions", async () => {
  const oldHistory = deferred();
  let historyCalls = 0;
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    if (url.startsWith("/api/quota-history")) {
      historyCalls += 1;
      if (historyCalls === 1) return oldHistory.promise;
      return response(200, { points: [{ reported_at: "new-session" }] });
    }
    throw new Error(`unexpected request ${url}`);
  });

  const staleRequest = harness.evaluate(`loadQuotaHistory("codex", "acct")`);
  const oldGeneration = harness.evaluate(`authSessionGeneration`);
  harness.evaluate(`setCurrentToken("new-token")`);
  const currentPayload = await harness.evaluate(`loadQuotaHistory("codex", "acct")`);
  oldHistory.resolve(response(200, { points: [{ reported_at: "old-session" }] }));
  await assert.rejects(staleRequest, /session changed/);
  const cachedPayload = await harness.evaluate(`loadQuotaHistory("codex", "acct")`);

  assert.equal(historyCalls, 2);
  assert.equal(currentPayload.points[0].reported_at, "new-session");
  assert.equal(cachedPayload.points[0].reported_at, "new-session");
  assert.equal(harness.evaluate(`historyPopoverIsCurrent(null, ${oldGeneration})`), false);
});

test("a history token upgrade caches under the upgraded session without refetching", async () => {
  let historyCalls = 0;
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    if (url.startsWith("/api/quota-history")) {
      historyCalls += 1;
      return response(200, { auth_pool_user_token: "upgraded-token", points: [{ reported_at: "upgraded" }] });
    }
    throw new Error(`unexpected request ${url}`);
  });

  const first = await harness.evaluate(`loadQuotaHistory("codex", "acct-upgrade")`);
  const second = await harness.evaluate(`loadQuotaHistory("codex", "acct-upgrade")`);

  assert.equal(first.points[0].reported_at, "upgraded");
  assert.equal(second.points[0].reported_at, "upgraded");
  assert.equal(historyCalls, 1);
});

test("quota chart never connects readings across reset boundaries", async () => {
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    throw new Error(`unexpected request ${url}`);
  });
  const now = Date.now();
  const points = [
    { reported_at: new Date(now - 1200000).toISOString(), status: "ok", one_week_remaining_percent: 20, one_week_reset_at: new Date(now + 3600000).toISOString() },
    { reported_at: new Date(now - 600000).toISOString(), status: "ok", one_week_remaining_percent: 90, one_week_reset_at: new Date(now + 7200000).toISOString() },
  ];
  const markup = harness.evaluate(`renderQuotaHistoryChart(${JSON.stringify(points)})`);

  assert.equal((markup.match(/<g class="history-current">/g) || []).length, 2);
  assert.doesNotMatch(markup, /L460\.0/);
});

test("popover viewport listeners are registered and removed as one lifecycle", async () => {
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    throw new Error(`unexpected request ${url}`);
  });

  harness.evaluate(`bindPopoverViewportListeners()`);
  assert.equal(harness.windowListeners.has("scroll"), true);
  assert.equal(harness.windowListeners.has("resize"), true);
  harness.evaluate(`unbindPopoverViewportListeners()`);
  assert.equal(harness.windowListeners.has("scroll"), false);
  assert.equal(harness.windowListeners.has("resize"), false);
});

test("brief pointer sweep cancels hover intent before opening details", async () => {
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    throw new Error(`unexpected request ${url}`);
  });
  harness.evaluate(`
    globalThis.hoverTestListeners = {};
    bindAvailabilityTrigger({
      addEventListener(type, listener) { globalThis.hoverTestListeners[type] = listener; }
    });
    globalThis.hoverTestListeners.mouseenter();
    globalThis.hoverTestListeners.mouseleave();
  `);
  await new Promise((resolve) => setTimeout(resolve, 220));

  assert.equal(harness.evaluate(`openAvailabilityTrigger`), null);
});

test("a new unlock starts its own status request and ignores the old token response", async () => {
  const oldStatus = deferred();
  let statusCalls = 0;
  const harness = await dashboardHarness(async (url) => {
    if (url !== "/api/status") throw new Error(`unexpected request ${url}`);
    statusCalls += 1;
    if (statusCalls === 1) return oldStatus.promise;
    return response(200, statusPayload(2, "new-revision-ticket", "new@stardust.ai"));
  });

  harness.element("token-input").value = "new-token";
  const unlocking = harness.element("save-token").listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  const callsBeforeOldResponse = statusCalls;
  oldStatus.resolve(response(401, { allowed_domain: "stardust.ai" }));
  await unlocking;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(callsBeforeOldResponse, 2);
  assert.match(harness.getCookie(), /new-token/);
  assert.equal(harness.element("auth-panel").hidden, true);
  assert.equal(harness.element("token-input").value, "new-token");
});

test("a revision response received after the page becomes hidden does not load full status", async () => {
  const revisionResponse = deferred();
  let statusCalls = 0;
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") {
      statusCalls += 1;
      return response(200, statusPayload(1, "revision-ticket"));
    }
    if (url === "/api/status-revision") return revisionResponse.promise;
    throw new Error(`unexpected request ${url}`);
  });

  const checking = harness.documentListeners.visibilitychange();
  harness.document.visibilityState = "hidden";
  revisionResponse.resolve(response(200, { revision: 2, updated_at: "2026-08-08T08:00:00Z" }));
  await checking;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(statusCalls, 1);
});

test("a revision 401 received after the page becomes hidden does not retry full status", async () => {
  const revisionResponse = deferred();
  let statusCalls = 0;
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") {
      statusCalls += 1;
      return response(200, statusPayload(1, "revision-ticket"));
    }
    if (url === "/api/status-revision") return revisionResponse.promise;
    throw new Error(`unexpected request ${url}`);
  });

  const checking = harness.documentListeners.visibilitychange();
  harness.document.visibilityState = "hidden";
  revisionResponse.resolve(response(401, { error: "token_invalidated" }));
  await checking;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(statusCalls, 1);
});
