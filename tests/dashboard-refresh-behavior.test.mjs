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

function quotaItem(overrides = {}) {
  return {
    source: "claude",
    account_id: "acct-1",
    email: "alice@example.com",
    display_windows: {
      "5h": { remaining_percent: 80 },
      "1week": { remaining_percent: 80 },
    },
    ...overrides,
  };
}

async function dashboardHarness(fetchImpl, initialToken = "old-token", { notificationPermission = "granted" } = {}) {
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
  const notifications = [];
  let currentNotificationPermission = notificationPermission;
  let requestPermissionCalls = 0;
  let windowFocusCalls = 0;
  function NotificationMock(title, options) {
    this.title = title;
    this.options = options;
    notifications.push(this);
  }
  Object.defineProperty(NotificationMock, "permission", {
    get() { return currentNotificationPermission; },
  });
  NotificationMock.requestPermission = async () => {
    requestPermissionCalls += 1;
    currentNotificationPermission = "granted";
    return currentNotificationPermission;
  };
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
      focus() { windowFocusCalls += 1; },
      Notification: NotificationMock,
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
    notifications,
    getRequestPermissionCalls: () => requestPermissionCalls,
    getWindowFocusCalls: () => windowFocusCalls,
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

test("quota chart never connects successful readings across a long observation gap", async () => {
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    throw new Error(`unexpected request ${url}`);
  });
  const now = Date.now();
  const resetAt = new Date(now + 7200000).toISOString();
  const points = [
    { reported_at: new Date(now - 3600000).toISOString(), status: "ok", one_week_remaining_percent: 70, one_week_reset_at: resetAt },
    { reported_at: new Date(now - 600000).toISOString(), status: "ok", one_week_remaining_percent: 65, one_week_reset_at: resetAt },
  ];
  const markup = harness.evaluate(`renderQuotaHistoryChart(${JSON.stringify(points)})`);

  assert.equal((markup.match(/<g class="history-/g) || []).length, 2);
  assert.doesNotMatch(markup, /L460\.0/);
});

test("visibility regain reloads once after a time-derived availability deadline", async () => {
  let statusCalls = 0;
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") {
      statusCalls += 1;
      return response(200, statusPayload(statusCalls, "revision-ticket"));
    }
    if (url === "/api/status-revision") throw new Error("deadline should bypass revision read");
    throw new Error(`unexpected request ${url}`);
  });
  harness.evaluate(`nextDashboardTransitionAt = Date.now() - 1`);
  harness.document.visibilityState = "hidden";
  await harness.documentListeners.visibilitychange();
  harness.document.visibilityState = "visible";
  await harness.documentListeners.visibilitychange();

  assert.equal(statusCalls, 2);
});

test("waiting summary uses the most recent passed reset and ignores future Claude resets", async () => {
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    throw new Error(`unexpected request ${url}`);
  });
  const now = Date.now();
  const markup = harness.evaluate(`formatAvailabilitySummary({
    state: "waiting_for_new_quota",
    historical_snapshot: { windows: {
      "5h": { reset_at: ${JSON.stringify(new Date(now - 8 * 60 * 1000).toISOString())} },
      "1week": { reset_at: ${JSON.stringify(new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString())} }
    }}
  })`);

  assert.match(markup, /reset 8m ago/);
  assert.doesNotMatch(markup, /reset 0s ago/);
});

test("visibility regain before a future deadline reschedules its full-refresh timer", async () => {
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    if (url === "/api/status-revision") return response(200, { revision: 1 });
    throw new Error(`unexpected request ${url}`);
  });
  harness.evaluate(`nextDashboardTransitionAt = Date.now() + 10 * 60 * 1000`);
  harness.document.visibilityState = "hidden";
  await harness.documentListeners.visibilitychange();
  assert.equal(harness.evaluate(`dashboardTransitionTimer`), null);
  harness.document.visibilityState = "visible";
  await harness.documentListeners.visibilitychange();

  assert.notEqual(harness.evaluate(`dashboardTransitionTimer`), null);
  harness.evaluate(`clearTimeout(dashboardTransitionTimer); dashboardTransitionTimer = null`);
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

test("checkQuotaFullNotifications fires when a window recovers from below 100 to 100", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); });
  const low = [quotaItem({ display_windows: { "5h": { remaining_percent: 60 }, "1week": { remaining_percent: 60 } } })];
  const full = [quotaItem({ display_windows: { "5h": { remaining_percent: 100 }, "1week": { remaining_percent: 60 } } })];

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(low)})`);
  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(full)})`);

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].title, "alice@example.com (claude) quota is back to 100%");
  assert.equal(harness.notifications[0].options.body, "5h window full");
  assert.equal(harness.notifications[0].options.tag, "claude:acct-1:5h");
});

test("checkQuotaFullNotifications does not fire for an account already at 100 on first load", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); });
  const full = [quotaItem({ display_windows: { "5h": { remaining_percent: 100 }, "1week": { remaining_percent: 100 } } })];

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(full)})`);

  assert.equal(harness.notifications.length, 0);
});

test("checkQuotaFullNotifications does not fire when remaining percent changes but stays below 100", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); });
  const step1 = [quotaItem({ display_windows: { "5h": { remaining_percent: 40 }, "1week": { remaining_percent: 40 } } })];
  const step2 = [quotaItem({ display_windows: { "5h": { remaining_percent: 60 }, "1week": { remaining_percent: 40 } } })];

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(step1)})`);
  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(step2)})`);

  assert.equal(harness.notifications.length, 0);
});

test("checkQuotaFullNotifications ignores stale readings and does not fire off them", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); });
  const low = [quotaItem({ display_windows: { "5h": { remaining_percent: 60 }, "1week": { remaining_percent: 60 } } })];
  const staleFull = [quotaItem({ display_windows_stale: true, display_windows: { "5h": { remaining_percent: 100 }, "1week": { remaining_percent: 60 } } })];
  const full = [quotaItem({ display_windows: { "5h": { remaining_percent: 100 }, "1week": { remaining_percent: 60 } } })];

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(low)})`);
  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(staleFull)})`);
  assert.equal(harness.notifications.length, 0, "stale reading must not fire");

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(full)})`);
  assert.equal(harness.notifications.length, 1, "fresh 100 reading after the last valid (60) reading must fire");
});

test("checkQuotaFullNotifications ignores unavailable or missing readings", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); });
  const low = [quotaItem({ display_windows: { "5h": { remaining_percent: 60 }, "1week": { remaining_percent: 60 } } })];
  const unavailable = [quotaItem({ display_windows: { "5h": { remaining_percent: null, reset_unavailable_reason: "auth_token_expired" }, "1week": { remaining_percent: 60 } } })];
  const full = [quotaItem({ display_windows: { "5h": { remaining_percent: 100 }, "1week": { remaining_percent: 60 } } })];

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(low)})`);
  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(unavailable)})`);
  assert.equal(harness.notifications.length, 0);

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(full)})`);
  assert.equal(harness.notifications.length, 1);
});

test("checkQuotaFullNotifications ignores a reading with reset_unavailable_reason even when remaining_percent is present", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); });
  const low = [quotaItem({ display_windows: { "5h": { remaining_percent: 60 }, "1week": { remaining_percent: 60 } } })];
  const unavailableButPresent = [quotaItem({ display_windows: { "5h": { remaining_percent: 100, reset_unavailable_reason: "quota_window_expired" }, "1week": { remaining_percent: 60 } } })];
  const full = [quotaItem({ display_windows: { "5h": { remaining_percent: 100 }, "1week": { remaining_percent: 60 } } })];

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(low)})`);
  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(unavailableButPresent)})`);
  assert.equal(harness.notifications.length, 0, "a reading marked reset_unavailable_reason must not fire even with remaining_percent 100");

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(full)})`);
  assert.equal(harness.notifications.length, 1, "the prior valid (60) baseline must still be intact so a later genuine 100 reading fires");
});

test("checkQuotaFullNotifications handles Codex accounts with no 5h window", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); });
  const low = [{ source: "codex", account_id: "codex-1", email: "bob@example.com", display_windows: { "1week": { remaining_percent: 60 } } }];
  const full = [{ source: "codex", account_id: "codex-1", email: "bob@example.com", display_windows: { "1week": { remaining_percent: 100 } } }];

  assert.doesNotThrow(() => {
    harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(low)})`);
    harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(full)})`);
  });

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].options.tag, "codex:codex-1:1week");
});

test("checkQuotaFullNotifications treats a reappearing account as a fresh baseline", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); });
  const low = [quotaItem({ display_windows: { "5h": { remaining_percent: 60 }, "1week": { remaining_percent: 60 } } })];
  const full = [quotaItem({ display_windows: { "5h": { remaining_percent: 100 }, "1week": { remaining_percent: 60 } } })];

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(low)})`);
  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify([])})`);
  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(full)})`);

  assert.equal(harness.notifications.length, 0, "reappearing already-full must not fire immediately");
});

test("checkQuotaFullNotifications fires again after a reappearance establishes a new baseline and then recovers", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); });
  const low = [quotaItem({ display_windows: { "5h": { remaining_percent: 60 }, "1week": { remaining_percent: 60 } } })];
  const reappearedLow = [quotaItem({ display_windows: { "5h": { remaining_percent: 40 }, "1week": { remaining_percent: 60 } } })];
  const reappearedFull = [quotaItem({ display_windows: { "5h": { remaining_percent: 100 }, "1week": { remaining_percent: 60 } } })];

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(low)})`);
  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify([])})`);
  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(reappearedLow)})`);
  assert.equal(harness.notifications.length, 0, "fresh baseline after reappearance must not fire by itself");

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(reappearedFull)})`);
  assert.equal(harness.notifications.length, 1, "a genuine transition after the new baseline must fire");
});

test("checkQuotaFullNotifications does not construct a notification when permission is not granted", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); }, "old-token", { notificationPermission: "denied" });
  const low = [quotaItem({ display_windows: { "5h": { remaining_percent: 60 }, "1week": { remaining_percent: 60 } } })];
  const full = [quotaItem({ display_windows: { "5h": { remaining_percent: 100 }, "1week": { remaining_percent: 60 } } })];

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(low)})`);
  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(full)})`);

  assert.equal(harness.notifications.length, 0);
});

test("checkQuotaFullNotifications does not throw when notification construction fails", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); });
  harness.evaluate(`
    window.Notification = function() { throw new Error("boom"); };
    window.Notification.permission = "granted";
  `);
  const low = [quotaItem({ display_windows: { "5h": { remaining_percent: 60 }, "1week": { remaining_percent: 60 } } })];
  const full = [quotaItem({ display_windows: { "5h": { remaining_percent: 100 }, "1week": { remaining_percent: 60 } } })];

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(low)})`);
  assert.doesNotThrow(() => {
    harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(full)})`);
  });
});

test("clicking a fired notification focuses the window", async () => {
  const harness = await dashboardHarness(async () => { throw new Error("unexpected fetch"); });
  const low = [quotaItem({ display_windows: { "5h": { remaining_percent: 60 }, "1week": { remaining_percent: 60 } } })];
  const full = [quotaItem({ display_windows: { "5h": { remaining_percent: 100 }, "1week": { remaining_percent: 60 } } })];

  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(low)})`);
  harness.evaluate(`checkQuotaFullNotifications(${JSON.stringify(full)})`);

  assert.equal(harness.notifications.length, 1);
  harness.notifications[0].onclick();
  assert.equal(harness.getWindowFocusCalls(), 1);
});

test("dashboard init requests notification permission when it is in the default state", async () => {
  const harness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    throw new Error(`unexpected request ${url}`);
  }, "old-token", { notificationPermission: "default" });

  assert.equal(harness.getRequestPermissionCalls(), 1);
});

test("dashboard init does not request notification permission when already decided", async () => {
  const grantedHarness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    throw new Error(`unexpected request ${url}`);
  }, "old-token", { notificationPermission: "granted" });
  assert.equal(grantedHarness.getRequestPermissionCalls(), 0);

  const deniedHarness = await dashboardHarness(async (url) => {
    if (url === "/api/status") return response(200, statusPayload(1, "revision-ticket"));
    throw new Error(`unexpected request ${url}`);
  }, "old-token", { notificationPermission: "denied" });
  assert.equal(deniedHarness.getRequestPermissionCalls(), 0);
});
