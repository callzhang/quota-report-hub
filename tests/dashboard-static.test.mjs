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

test("dashboard presents one availability status and moves technical evidence into details", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<th>Availability<\/th>/);
  assert.doesNotMatch(html, /<th>5H \(Claude\)<\/th>|<th>1week<\/th>|<th>Cloud Status<\/th>/);
  assert.match(html, /function availabilityCell\(item\)/);
  assert.match(html, /availability\.summary/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="false"/);
  assert.match(html, /Latest quota snapshot/);
  assert.match(html, /Diagnostics/);
  assert.doesNotMatch(html, /function tokenStateLine|function quotaSnapshotLine|function refreshValidityLine|function usageCell/);
});

test("availability details are keyboard, pointer, and touch accessible", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /function openAvailabilityPopover\(trigger\)/);
  assert.match(html, /function closeAvailabilityPopover\(\{ restoreFocus = false \} = \{\}\)/);
  assert.match(html, /trigger\.addEventListener\("mouseenter"/);
  assert.match(html, /trigger\.addEventListener\("focus"/);
  assert.match(html, /trigger\.addEventListener\("click"/);
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
});
