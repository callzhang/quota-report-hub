import test from "node:test";
import assert from "node:assert/strict";
import { isAbuseClassError, ABUSE_ERROR_PATTERNS } from "../lib/abuse-errors.js";

test("isAbuseClassError flags ban/abuse/rate-limit wording", () => {
  for (const s of [
    "rate limit exceeded",
    "suspicious activity detected",
    "account locked",
    "account suspended",
    "403 forbidden",
    "Too Many Requests",
  ]) {
    assert.equal(isAbuseClassError(s), true, s);
  }
});

test("isAbuseClassError does NOT flag ordinary RT-failure errors", () => {
  for (const s of [
    "auth invalidated (token_invalidated)",
    "auth failed (401 unauthorized)",
    "claude auth invalid (authentication_error)",
    "claude auth email unavailable",
    null,
    "",
  ]) {
    assert.equal(isAbuseClassError(s), false, String(s));
  }
});

test("ABUSE_ERROR_PATTERNS is a non-empty array of RegExp", () => {
  assert.ok(Array.isArray(ABUSE_ERROR_PATTERNS) && ABUSE_ERROR_PATTERNS.length > 0);
  for (const p of ABUSE_ERROR_PATTERNS) assert.ok(p instanceof RegExp);
});
