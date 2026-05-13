import test from "node:test";
import assert from "node:assert/strict";
import { shouldReturnInvalidatedUploaderEntry } from "../lib/fetch-best.js";

test("fetch-best does not return the same invalidated auth already installed locally", () => {
  assert.equal(
    shouldReturnInvalidatedUploaderEntry(
      { account_id: "derek@preseen.ai" },
      "derek@preseen.ai"
    ),
    false
  );
});

test("fetch-best can still return another invalidated uploader auth for re-login", () => {
  assert.equal(
    shouldReturnInvalidatedUploaderEntry(
      { account_id: "pre-sales@stardust.ai" },
      "derek@preseen.ai"
    ),
    true
  );
});
