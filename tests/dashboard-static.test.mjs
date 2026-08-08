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
  assert.match(html, /quota snapshot expired/);
  assert.match(html, /item\.quota_snapshot_state/);
  assert.match(html, /item\.refresh_validity/);
  assert.match(html, /function refreshStateLabel\(status\)/);
  assert.match(html, /return stateLine\("Refresh", escapeHtml\(refreshStateLabel\(status\)\), tone\)/);
  assert.doesNotMatch(html, /escapeHtml\(refresh\.label \|\| "refresh not verified"\)/);
  assert.match(html, /item\.token_state/);
  assert.match(html, /access token expired/);
  assert.match(html, /item\.display_windows_stale \?\? item\.windows_stale/);
  assert.doesNotMatch(html, /ready now/);
  assert.doesNotMatch(html, />token expired</);
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
