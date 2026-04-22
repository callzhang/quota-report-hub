import test from "node:test";
import assert from "node:assert/strict";
import { companyEmailAllowed, normalizeEmail } from "../lib/company-auth.js";

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail(" Derek@Stardust.ai "), "derek@stardust.ai");
});

test("companyEmailAllowed only permits company domain", () => {
  assert.equal(companyEmailAllowed("derek@stardust.ai"), true);
  assert.equal(companyEmailAllowed("derek@gmail.com"), false);
});

test("companyEmailAllowed respects AUTH_ALLOWED_EMAIL_DOMAIN override", () => {
  const previous = process.env.AUTH_ALLOWED_EMAIL_DOMAIN;
  process.env.AUTH_ALLOWED_EMAIL_DOMAIN = "preseen.ai";

  try {
    assert.equal(companyEmailAllowed("hello@preseen.ai"), true);
    assert.equal(companyEmailAllowed("hello@stardust.ai"), false);
  } finally {
    if (previous === undefined) {
      delete process.env.AUTH_ALLOWED_EMAIL_DOMAIN;
    } else {
      process.env.AUTH_ALLOWED_EMAIL_DOMAIN = previous;
    }
  }
});
