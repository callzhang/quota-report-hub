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
