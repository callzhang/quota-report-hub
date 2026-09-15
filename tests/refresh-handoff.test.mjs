import assert from "node:assert/strict";
import test from "node:test";

import {
  REFRESH_HANDOFF_PENDING,
  isRefreshHandoffPending,
  requestedRefreshHandoffState,
} from "../lib/refresh-handoff.js";

test("only an explicit Codex deferred upload creates a refresh handoff", () => {
  assert.equal(requestedRefreshHandoffState({ source: "codex", deferCodexRefresh: true }), REFRESH_HANDOFF_PENDING);
  assert.equal(requestedRefreshHandoffState({ source: "codex" }), null);
  assert.equal(requestedRefreshHandoffState({ source: "claude", deferCodexRefresh: true }), null);
});

test("only the exact persisted pending state blocks refresh", () => {
  assert.equal(isRefreshHandoffPending({ refresh_handoff_state: REFRESH_HANDOFF_PENDING }), true);
  assert.equal(isRefreshHandoffPending({ refresh_handoff_state: "complete" }), false);
  assert.equal(isRefreshHandoffPending({}), false);
});
