import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readJsonBody } from "../lib/http.js";

test("readJsonBody returns object bodies unchanged", async () => {
  const body = { email: "derek@stardust.ai" };
  assert.deepEqual(await readJsonBody({ body }), body);
});

test("readJsonBody parses string bodies", async () => {
  assert.deepEqual(await readJsonBody({ body: '{"source":"codex"}' }), { source: "codex" });
});

test("readJsonBody parses streamed request bodies", async () => {
  const req = Readable.from([JSON.stringify({ quota_payload: { windows: { "5h": { remaining_percent: 80 } } } })]);
  assert.deepEqual(await readJsonBody(req), {
    quota_payload: { windows: { "5h": { remaining_percent: 80 } } },
  });
});
