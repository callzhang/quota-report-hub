import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

function makeElement() {
  const children = new Map();
  const listeners = {};
  return {
    hidden: false,
    innerHTML: "",
    textContent: "",
    value: "",
    disabled: false,
    listeners,
    addEventListener(type, listener) { listeners[type] = listener; },
    click() { listeners.click?.(); },
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, makeElement());
      return children.get(selector);
    },
  };
}

async function usersHarness(initialPayload) {
  const html = await readFile(new URL("../users.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "users page inline script must exist");

  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  let cookieValue = "quota_report_hub_token=test-token";
  const document = { getElementById: element };
  Object.defineProperty(document, "cookie", {
    get() { return cookieValue; },
    set(value) { cookieValue = value.includes("Max-Age=0") ? "" : value.split(";")[0]; },
  });
  const state = { payload: initialPayload };
  const context = vm.createContext({
    document,
    location: { protocol: "https:", origin: "https://hub.example", hash: "" },
    fetch: async () => ({ status: 200, json: async () => state.payload }),
    setInterval() {},
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    element,
    setPayload(payload) { state.payload = payload; },
    reload: () => vm.runInContext("load()", context),
  };
}

function rowCount(tbody) {
  return (tbody.innerHTML.match(/<tr/g) || []).length;
}

function samplePayload({ userCount, logCount }) {
  return {
    viewer_email: "viewer@example.com",
    generated_at: "2026-09-03T12:00:00Z",
    users: Array.from({ length: userCount }, (_, index) => ({
      email: `user${index}@example.com`,
      created_at: "2026-01-01T00:00:00Z",
      last_token_issued_at: new Date(Date.UTC(2026, 8, 3, 0, userCount - index)).toISOString(),
      has_active_token: true,
      token_last_used_at: null,
      fetch_count: 1,
      last_fetched_at: null,
    })),
    fetch_log: Array.from({ length: logCount }, (_, index) => ({
      fetched_at: new Date(Date.UTC(2026, 8, 3, 0, logCount - index)).toISOString(),
      requester_email: `requester${index}@example.com`,
      source: "codex",
      reason: "served",
      served_account_id: `acct-${index}`,
    })),
  };
}

test("pagination bars hide via the hidden attribute despite display:flex", async () => {
  const html = await readFile(new URL("../users.html", import.meta.url), "utf8");
  // display:flex on .pagination overrides the UA's [hidden]{display:none}; without this
  // guard a hidden bar still renders its Previous/Next buttons under an empty table.
  assert.match(html, /\.pagination\[hidden\] \{ display: none; \}/);
});

test("token holders and fetch log paginate twenty rows per page, newest first", async () => {
  const harness = await usersHarness(samplePayload({ userCount: 25, logCount: 45 }));

  const usersRows = harness.element("users-rows");
  const usersBar = harness.element("users-pagination");
  assert.equal(rowCount(usersRows), 20);
  assert.equal(usersBar.hidden, false);
  assert.equal(usersBar.querySelector("[data-range]").textContent, "Showing 1–20 of 25");
  assert.equal(usersBar.querySelector("[data-page-status]").textContent, "Page 1 of 2");
  // page 1 starts with the newest issuance (API order preserved, not re-sorted)
  assert.match(usersRows.innerHTML, /user0@example\.com/);
  assert.doesNotMatch(usersRows.innerHTML, /user24@example\.com/);

  const logRows = harness.element("log-rows");
  const logBar = harness.element("log-pagination");
  assert.equal(rowCount(logRows), 20);
  assert.equal(logBar.querySelector("[data-page-status]").textContent, "Page 1 of 3");
  assert.match(logRows.innerHTML, /requester0@example\.com/);
  assert.equal(logBar.querySelector("[data-page-prev]").disabled, true);
  assert.equal(logBar.querySelector("[data-page-next]").disabled, false);
});

test("next and previous move through fetch log pages and disable at the ends", async () => {
  const harness = await usersHarness(samplePayload({ userCount: 1, logCount: 45 }));
  const logRows = harness.element("log-rows");
  const logBar = harness.element("log-pagination");
  const next = logBar.querySelector("[data-page-next]");
  const prev = logBar.querySelector("[data-page-prev]");

  next.click();
  assert.equal(logBar.querySelector("[data-range]").textContent, "Showing 21–40 of 45");
  assert.equal(prev.disabled, false);

  next.click();
  assert.equal(logBar.querySelector("[data-range]").textContent, "Showing 41–45 of 45");
  assert.equal(rowCount(logRows), 5);
  assert.equal(next.disabled, true);

  prev.click();
  assert.equal(logBar.querySelector("[data-page-status]").textContent, "Page 2 of 3");

  // one page of users → the users bar stays hidden entirely
  assert.equal(harness.element("users-pagination").hidden, true);
});

test("a refresh that shrinks the data clamps the open page instead of stranding it", async () => {
  const harness = await usersHarness(samplePayload({ userCount: 1, logCount: 45 }));
  const logBar = harness.element("log-pagination");
  logBar.querySelector("[data-page-next]").click();
  logBar.querySelector("[data-page-next]").click();
  assert.equal(logBar.querySelector("[data-page-status]").textContent, "Page 3 of 3");

  harness.setPayload(samplePayload({ userCount: 1, logCount: 5 }));
  await harness.reload();
  assert.equal(logBar.querySelector("[data-page-status]").textContent, "Page 1 of 1");
  assert.equal(logBar.hidden, true);
  assert.equal(rowCount(harness.element("log-rows")), 5);
});
