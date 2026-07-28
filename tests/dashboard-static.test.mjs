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
});

test("dashboard does not poll full status every minute while hidden", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /const DASHBOARD_REFRESH_MS = 15 \* 60 \* 1000/);
  assert.match(html, /document\.visibilityState === "visible"/);
  assert.doesNotMatch(html, /setInterval\(load, 60000\)/);
});
