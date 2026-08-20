# Quota Full Browser Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a browser (Web Notification API) popup on the main dashboard when a coding account's `5h` or `1week` quota window recovers from below 100% to 100%, while it stays open and correct across the account disappearing/reappearing in the table.

**Architecture:** All logic lives inline in `index.html`'s existing dashboard `<script>`, alongside the code it must react to. A new `Map` (`quotaFullNotifyState`) tracks the last valid `remaining_percent` per `source:account_id:windowKey`. A new `checkQuotaFullNotifications(items)` function — called once per dashboard load from inside the existing `loadDashboard()` — compares each valid reading against the map, fires `window.Notification` on a `<100 → 100` transition, and prunes state for accounts no longer present so a reappearance starts from a fresh baseline. A separate `requestQuotaFullNotificationPermission()` runs once at script init to request permission if it's still in the default state. Full spec: [2026-08-20-quota-full-browser-notification-design.md](../specs/2026-08-20-quota-full-browser-notification-design.md).

**Tech Stack:** Plain browser JS (no build step, no framework) inside `index.html`. Tests use Node's built-in `node --test` runner with the existing `vm`-based harness in `tests/dashboard-refresh-behavior.test.mjs` that executes the dashboard's inline `<script>` in a sandboxed context.

---

## Task 1: Quota-full transition detection and notification firing

**Files:**
- Modify: `tests/dashboard-refresh-behavior.test.mjs` (harness + new tests)
- Modify: `index.html:526` (state map), `index.html:692-694` (new functions), `index.html:1146-1147` (wire into `loadDashboard`)

- [ ] **Step 1: Extend the test harness with a `Notification` mock and add the failing tests**

In `tests/dashboard-refresh-behavior.test.mjs`, add a `quotaItem` fixture helper right after the existing `statusPayload` function (after line 32):

```js
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
```

Replace the `dashboardHarness` function (currently lines 34-104) with this version, which adds an optional `notificationPermission` option and a `window.Notification` / `window.focus` mock:

```js
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
```

Append these tests at the end of the file (after the current last line, 353):

```js
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
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test tests/dashboard-refresh-behavior.test.mjs`
Expected: FAIL — errors like `ReferenceError: checkQuotaFullNotifications is not defined` from inside the `vm` context for every new test.

- [ ] **Step 3: Implement the state map and functions in `index.html`**

In `index.html`, find this line (currently line 526):

```js
      const accountItems = new Map();
```

Change it to:

```js
      const accountItems = new Map();
      const quotaFullNotifyState = new Map();
```

Find this block (currently lines 683-694, the end of `progressCell` followed by `statusChip`):

```js
          </div>`;
      }

      function statusChip(item) {
```

Change it to:

```js
          </div>`;
      }

      function quotaFullNotifyKey(item, windowKey) {
        return `${item.source}:${item.account_id}:${windowKey}`;
      }

      function fireQuotaFullNotification(item, windowKey) {
        if (typeof window === "undefined" || !("Notification" in window)) return;
        if (window.Notification.permission !== "granted") return;
        const label = item.email || item.account_id;
        const windowLabel = windowKey === "5h" ? "5h" : "1week";
        try {
          const notification = new window.Notification(`${label} (${item.source}) quota is back to 100%`, {
            body: `${windowLabel} window full`,
            tag: quotaFullNotifyKey(item, windowKey),
          });
          notification.onclick = () => { window.focus(); };
        } catch {
          // Some browsers restrict Notification construction (e.g. permission revoked mid-session); ignore.
        }
      }

      function checkQuotaFullNotifications(items) {
        const seenAccounts = new Set();
        for (const item of items || []) {
          const accountKey = `${item.source}:${item.account_id}`;
          seenAccounts.add(accountKey);
          const stale = item.display_windows_stale ?? item.windows_stale;
          if (stale) continue;
          for (const windowKey of ["5h", "1week"]) {
            const windowData = item.display_windows?.[windowKey];
            if (!windowData || windowData.remaining_percent === null || windowData.remaining_percent === undefined) continue;
            if (windowData.reset_unavailable_reason) continue;
            const percent = Number(windowData.remaining_percent);
            const stateKey = quotaFullNotifyKey(item, windowKey);
            const previous = quotaFullNotifyState.get(stateKey);
            quotaFullNotifyState.set(stateKey, percent);
            if (previous !== undefined && previous < 100 && percent >= 100) {
              fireQuotaFullNotification(item, windowKey);
            }
          }
        }
        for (const stateKey of [...quotaFullNotifyState.keys()]) {
          const accountKey = stateKey.slice(0, stateKey.lastIndexOf(":"));
          if (!seenAccounts.has(accountKey)) quotaFullNotifyState.delete(stateKey);
        }
      }

      function statusChip(item) {
```

Find this line in `loadDashboard` (currently lines 1146-1147):

```js
        const items = (payload.items || []).sort((a, b) => (b.uploaded_at || "").localeCompare(a.uploaded_at || ""));
        scheduleDashboardTransition(items);
```

Change it to:

```js
        const items = (payload.items || []).sort((a, b) => (b.uploaded_at || "").localeCompare(a.uploaded_at || ""));
        scheduleDashboardTransition(items);
        checkQuotaFullNotifications(items);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/dashboard-refresh-behavior.test.mjs`
Expected: PASS — all tests in the file, including the new ones, succeed.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/dashboard-refresh-behavior.test.mjs
git commit -m "feat: notify via browser notification when a coding account's quota window refills to 100%"
```

---

## Task 2: Request notification permission once at dashboard init

**Files:**
- Modify: `tests/dashboard-refresh-behavior.test.mjs` (new tests)
- Modify: `index.html:1370-1372` (permission request call), `index.html` (new function, placed next to the Task 1 functions)

- [ ] **Step 1: Write the failing tests**

Append these tests at the end of `tests/dashboard-refresh-behavior.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test tests/dashboard-refresh-behavior.test.mjs`
Expected: FAIL — `harness.getRequestPermissionCalls()` returns `0` for the first test (nothing calls `requestPermission` yet), so the `assert.equal(..., 1)` assertion fails.

- [ ] **Step 3: Implement `requestQuotaFullNotificationPermission` and call it at init**

In `index.html`, add this function right after `checkQuotaFullNotifications` (i.e. immediately before the `function statusChip(item) {` line that Task 1 left in place):

```js
      function requestQuotaFullNotificationPermission() {
        if (typeof window === "undefined" || !("Notification" in window)) return;
        if (window.Notification.permission !== "default") return;
        try {
          const result = window.Notification.requestPermission();
          if (result && typeof result.catch === "function") result.catch(() => {});
        } catch {
          // Older browsers may throw synchronously for unsupported usage; ignore.
        }
      }
```

Find this block (currently lines 1370-1372):

```js
      });
      load();
      async function checkDashboardRevision() {
```

Change it to:

```js
      });
      requestQuotaFullNotificationPermission();
      load();
      async function checkDashboardRevision() {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/dashboard-refresh-behavior.test.mjs`
Expected: PASS — all tests in the file succeed.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/dashboard-refresh-behavior.test.mjs
git commit -m "feat: request browser notification permission once on dashboard init"
```

---

## Task 3: Full regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full JS test suite**

Run: `npm test`
Expected: PASS — every test file under `tests/*.test.mjs` succeeds, including the pre-existing dashboard, status, and quota-history suites, confirming the new code did not change any other rendering or refresh behavior.

- [ ] **Step 2: Manually verify in a real browser (optional but recommended)**

Since headless `node --test` cannot exercise the real `Notification` API or an actual permission prompt: run `npm run dev`, open `http://127.0.0.1:6088` (or the deployed hub) in a real browser, accept the permission prompt, and confirm a notification appears when a watched account's window is observed to cross from below 100% to 100% on a subsequent poll/reload. This step has no pass/fail assertion to check in — it's a sanity check, not a blocking gate.
