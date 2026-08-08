import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard unlock shows non-auth status failures instead of failing silently", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /async function readResponsePayload\(response\)/);
  assert.match(html, /function statusErrorMessage\(response, payload\)/);
  assert.match(html, /if \(!response\.ok\) \{/);
  assert.match(html, /setLockedView\(statusErrorMessage\(response, payload\)\)/);
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

test("dashboard refreshes visible data promptly and immediately after returning to the tab", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /const DASHBOARD_REFRESH_MS = 60 \* 1000/);
  assert.match(html, /document\.visibilityState === "visible"/);
  assert.match(html, /document\.addEventListener\("visibilitychange", refreshWhenVisible\)/);
  assert.match(html, /function refreshWhenVisible\(\)/);
  assert.match(html, /if \(document\.visibilityState === "visible"\) \{\s*load\(\);\s*\}/);
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
