import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard unlock shows non-auth status failures instead of failing silently", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /async function readResponsePayload\(response\)/);
  assert.match(html, /function statusErrorMessage\(response, payload\)/);
  assert.match(html, /function setStatusUnavailable\(message\)/);
  assert.match(html, /setStatusUnavailable\("Cannot reach the hub\. Keeping the last loaded data; the page will retry automatically\."\)/);
  assert.match(html, /setStatusUnavailable\(statusErrorMessage\(response, payload\)\)/);
  assert.match(html, /if \(!response\.ok\) \{/);
  assert.doesNotMatch(html, /setLockedView\(statusErrorMessage\(response, payload\)\)/);
  assert.match(html, /saveTokenButton\.disabled = true/);
  assert.match(html, /authMessage\.textContent = "Checking token…"/);
  assert.match(html, /function safeDecodeCookieValue\(value\)/);
  assert.match(html, /return safeDecodeCookieValue\(getCookie\(COOKIE_NAME\)\)/);
  assert.match(html, /item\.availability/);
  assert.match(html, /Access token expiry/);
  assert.doesNotMatch(html, /ready now/);
  assert.doesNotMatch(html, />token expired</);
});

test("dashboard restores quota progress columns while keeping availability details", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<th>5H \(Claude\)<\/th>[\s\S]*<th>1week<\/th>[\s\S]*<th>Fetched By<\/th>[\s\S]*<th>Availability<\/th>/);
  assert.match(html, /<th>Availability<\/th>/);
  assert.doesNotMatch(html, /<th>Cloud Status<\/th>/);
  assert.match(html, /function progressCell\(window, isStale = false\)/);
  assert.match(html, /class="progress/);
  assert.match(html, /class="track"><div class="fill \$\{level\}" style="width: \$\{remaining\}%"/);
  assert.match(html, /formatResetCountdown\(window\.reset_at\)/);
  assert.match(html, /item\.display_windows\?\.\["5h"\]/);
  assert.match(html, /item\.display_windows\?\.\["1week"\]/);
  assert.match(html, /quotaWindowFallback\(\)/);
  assert.match(html, /\.progress\.inferred/);
  assert.match(html, /function availabilityCell\(item\)/);
  assert.match(html, /availability\.summary/);
  assert.match(html, /formatAvailabilitySummary\(availability, item\)/);
  assert.match(html, /remaining quota/);
  assert.match(html, /Next automatic check/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="false"/);
  assert.match(html, /Latest quota snapshot/);
  assert.match(html, /Diagnostics/);
  assert.doesNotMatch(html, /function tokenStateLine|function quotaSnapshotLine|function refreshValidityLine|function usageCell/);
});

test("active and archived account tables keep independent column layouts", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<table id="active-entries-table">/);
  assert.match(html, /<table id="archived-entries-table">/);
  assert.match(html, /#active-entries-table th:nth-child\(6\)/);
  assert.match(html, /#archived-entries-table th:nth-child\(5\)/);
  assert.doesNotMatch(html, /^\s*th:nth-child/m);
});

test("availability details are keyboard, pointer, and touch accessible", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /function openAvailabilityPopover\(trigger, \{ focusDetails = false \} = \{\}\)/);
  assert.match(html, /function closeAvailabilityPopover\(\{ restoreFocus = false \} = \{\}\)/);
  assert.match(html, /trigger\.addEventListener\("mouseenter"/);
  assert.match(html, /trigger\.addEventListener\("focus"/);
  assert.match(html, /trigger\.addEventListener\("click"/);
  assert.match(html, /trigger\.addEventListener\("keydown"/);
  assert.match(html, /\["Enter", " ", "ArrowDown"\]\.includes\(event\.key\)/);
  assert.match(html, /openAvailabilityPopover\(trigger, \{ focusDetails: true \}\)/);
  assert.match(html, /if \(focusDetails\) closeButton\.focus\(\)/);
  assert.match(html, /event\.key === "Escape"/);
  assert.match(html, /closeAvailabilityPopover\(\{ restoreFocus: true \}\)/);
  assert.match(html, /document\.addEventListener\("pointerdown"/);
  assert.match(html, /aria-expanded/);
});

test("quota history is lazy, cached for five minutes, and deduplicated", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /const HISTORY_CACHE_MS = 5 \* 60 \* 1000/);
  assert.match(html, /const quotaHistoryCache = new Map\(\)/);
  assert.match(html, /const quotaHistoryRequests = new Map\(\)/);
  assert.match(html, /function quotaHistoryKey\(source, accountId\)/);
  assert.match(html, /async function loadQuotaHistory\(source, accountId\)/);
  assert.match(html, /quotaHistoryCache\.get\(key\)/);
  assert.match(html, /Date\.now\(\) - cached\.fetchedAt < HISTORY_CACHE_MS/);
  assert.match(html, /if \(quotaHistoryRequests\.has\(key\)\) return quotaHistoryRequests\.get\(key\)/);
  assert.match(html, /fetch\(`\/api\/quota-history\?source=\$\{encodeURIComponent\(source\)\}&account_id=\$\{encodeURIComponent\(accountId\)\}`/);
  assert.doesNotMatch(html, /loadDashboard[\s\S]{0,500}quota-history/);
  assert.match(html, /const historyToken = currentToken \|\| getStoredToken\(\)/);
  assert.match(html, /historySessionGeneration !== authSessionGeneration \|\| historyToken !== \(currentToken \|\| getStoredToken\(\)\)/);
  assert.match(html, /if \(response\.status === 401\) \{\s*handleUnauthorizedHistory\(historyToken, payload\)/);
  assert.match(html, /function handleUnauthorizedHistory\(token, payload\)/);
});

test("quota details mark historical snapshots and render chart gaps without interpolation", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /Historical - not current quota/);
  assert.match(html, /Captured:/);
  assert.match(html, /Reset:/);
  assert.match(html, /function renderQuotaHistoryChart\(points\)/);
  assert.match(html, /splitQuotaSeries/);
  assert.match(html, /MAX_HISTORY_GAP_MS/);
  assert.match(html, /capturedAt - previousCapture > MAX_HISTORY_GAP_MS/);
  assert.match(html, /<svg[^`]*role="img"/);
  assert.match(html, /No quota history in the last 24 hours/);
  assert.match(html, /History temporarily unavailable/);
  assert.match(html, /history-reset-marker/);
  assert.match(html, /history-historical/);
});

test("dashboard checks a lightweight revision while visible and reloads only changed data", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /const DASHBOARD_REFRESH_MS = 60 \* 1000/);
  assert.match(html, /document\.visibilityState === "visible"/);
  assert.match(html, /async function checkDashboardRevision\(\)/);
  assert.match(html, /fetch\("\/api\/status-revision"/);
  assert.match(html, /if \(payload\.revision !== loadedDashboardRevision\) \{\s*if \(document\.visibilityState !== "visible"\) return;\s*await load\(\);/);
  assert.match(html, /setInterval\(checkDashboardRevision, DASHBOARD_REFRESH_MS\)/);
  assert.match(html, /document\.addEventListener\("visibilitychange", checkDashboardRevision\)/);
  assert.doesNotMatch(html, /setInterval\(refreshWhenVisible/);
  assert.match(html, /function scheduleDashboardTransition\(items\)/);
  assert.match(html, /availability\?\.next_transition_at/);
  assert.match(html, /setTimeout\(load, boundedDelay\)/);
  assert.match(html, /clearTimeout\(dashboardTransitionTimer\)/);
  assert.match(html, /Date\.now\(\) >= nextDashboardTransitionAt/);
  assert.match(html, /return load\(\)/);
});

test("dashboard tracks loaded revision and deduplicates overlapping status requests", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /let loadedDashboardRevision = null/);
  assert.match(html, /loadedDashboardRevision = payload\.dashboard_revision/);
  assert.match(html, /dashboardRevisionToken = payload\.dashboard_revision_token/);
  assert.match(html, /Authorization: `Bearer \$\{dashboardRevisionToken\}`/);
  assert.match(html, /let statusRequest = null/);
  assert.match(html, /let statusRequestToken = ""/);
  assert.match(html, /let statusRequestGeneration = 0/);
  assert.match(html, /statusRequest && statusRequestToken === token/);
  assert.match(html, /statusRequestIsCurrent\(token, requestGeneration\)/);
  assert.match(html, /let revisionRequest = null/);
  assert.match(html, /if \(revisionRequest\) return revisionRequest/);
  assert.match(html, /document\.visibilityState !== "visible"\) return;\s*await load\(\)/);
});

test("dashboard keeps the login panel hidden while restoring a saved session", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<section class="panel section auth-panel" id="auth-panel" hidden>/);
});

test("login page automatically reuses an existing valid hub session", async () => {
  const html = await readFile(new URL("../login.html", import.meta.url), "utf8");

  assert.match(html, /const COOKIE_NAME = "quota_report_hub_token"/);
  assert.match(html, /async function restoreExistingSession\(\)/);
  assert.match(html, /fetch\("\/api\/status", \{[\s\S]*Authorization: "Bearer " \+ token/);
  assert.match(html, /completeLogin\(payload\.auth_pool_user_token \|\| token, payload\.viewer_email \|\| ""\)/);
  assert.match(html, /restoreExistingSession\(\)/);
  assert.match(html, /function safeLoginDestination\(\)/);
  assert.match(html, /target\.origin !== location\.origin/);
  assert.match(html, /location\.replace\(safeLoginDestination\(\)\)/);
});

test("all hub pages share the five-tab top navigation", async () => {
  const [dashboard, usage, users] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../token-usage.html", import.meta.url), "utf8"),
    readFile(new URL("../users.html", import.meta.url), "utf8"),
  ]);

  for (const html of [dashboard, usage, users]) {
    for (const label of ["Accounts", "Devices", "Usages", "Users", "Settings"]) {
      assert.match(html, new RegExp(`>${label}</a>`));
    }
  }

  // index.html switches its own three tabs by location hash
  assert.match(dashboard, /<nav class="tab-nav" id="tab-nav"/);
  assert.match(dashboard, /id="tab-panel-accounts"/);
  assert.match(dashboard, /id="tab-panel-devices"/);
  assert.match(dashboard, /id="tab-panel-settings"/);
  assert.match(dashboard, /window\.addEventListener\("hashchange", applyActiveTab\)/);
  assert.match(dashboard, /const TAB_IDS = \["accounts", "devices", "settings"\]/);
  // the tab bar stays hidden while the dashboard is locked
  assert.match(dashboard, /tabNav\.hidden = dashboardLocked/);

  // sibling pages mark their own tab active and deep-link back into the hash tabs
  assert.match(usage, /class="active" aria-current="page">Usages</);
  assert.match(users, /class="active" aria-current="page">Users</);
  for (const html of [usage, users]) {
    assert.match(html, /href="\.\/#devices"/);
    assert.match(html, /href="\.\/#settings"/);
  }
});

test("accounts and users pages link to the independent token usage page", async () => {
  const [dashboard, users] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../users.html", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /href="\.\/token-usage\.html"/);
  assert.match(users, /href="\.\/token-usage\.html"/);
});

test("dashboard renders the exhaustion deadline in the row summary and popover", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // Row summary: the exhausted state reuses the quota windows' reset-countdown formatting and
  // reads the deadline off the item (current_quota is deliberately null for this state — a
  // snapshot would route into the quota branch and suppress the line entirely).
  assert.match(html, /function formatAvailabilitySummary\(availability, item\)/);
  assert.match(html, /formatAvailabilitySummary\(availability, item\)/);
  assert.match(html, /availability\.reason === "usage_limit_exhausted"/);
  assert.match(html, /Usage limit exhausted · \$\{formatResetCountdown\(item\?\.exhausted_until\)\} · not eligible for rotation/);

  // Popover: a dedicated section shows the countdown plus the absolute reset moment.
  assert.match(html, /<h4>Usage limit<\/h4>/);
  assert.match(html, /formatResetCountdown\(item\.exhausted_until\)/);
  assert.match(html, /resets at \$\{escapeHtml\(formatDate\(item\.exhausted_until\)\)\}/);

  // Snapshot windows with a future reset on an exhausted account are live measurements, not
  // history — labeled per window instead of branding the whole snapshot "Historical".
  assert.match(html, /liveExhaustedWindow/);
});
