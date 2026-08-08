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
  const context = vm.createContext({
    document,
    location: { protocol: "https:", origin: "https://hub.example" },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    fetch: fetchImpl,
    setInterval() {},
    console,
  });
  vm.runInContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { document, documentListeners, element, getCookie: () => cookieValue };
}

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
