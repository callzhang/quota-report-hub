import test from "node:test";
import assert from "node:assert/strict";
import { invalidatedEntryToRepairAuth } from "../lib/fetch-best.js";

test("fetch-best exposes invalidated uploader auth as repair_auth, not replacement", () => {
  const repairAuth = invalidatedEntryToRepairAuth({
    source: "codex",
    account_id: "derek@preseen.ai",
    session_id: null,
    email: "derek@preseen.ai",
    name: "Derek",
    plan_name: "Pro",
    auth_last_refresh: "2026-05-10T23:15:55Z",
    digest: "digest-1",
    uploaded_at: "2026-05-13T02:47:07Z",
    reporter_name: "derek@gpu4",
    hostname: "gpu4",
    auth_json: "{\"tokens\":{}}",
  });

  assert.equal(repairAuth.account_id, "derek@preseen.ai");
  assert.equal(repairAuth.session_id, "");
  assert.equal(repairAuth.latest_report, null);
  assert.equal(repairAuth.auth_json, "{\"tokens\":{}}");
});

test("fetch-best has no repair_auth when the uploader has no invalidated auth", () => {
  assert.equal(invalidatedEntryToRepairAuth(null), null);
});
