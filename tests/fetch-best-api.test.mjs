import test from "node:test";
import assert from "node:assert/strict";
import { shouldReturnInvalidatedUploaderEntry } from "../lib/fetch-best.js";

test("fetch-best returns invalidated uploader auth by default so the user can repair it", () => {
  assert.equal(
    shouldReturnInvalidatedUploaderEntry(
      { account_id: "derek@preseen.ai" },
      { allowInvalidatedReauth: true }
    ),
    true
  );
});

test("fetch-best skips invalidated uploader auth when the caller is doing automatic rotation", () => {
  assert.equal(
    shouldReturnInvalidatedUploaderEntry(
      { account_id: "pre-sales@stardust.ai" },
      { allowInvalidatedReauth: false }
    ),
    false
  );
});
