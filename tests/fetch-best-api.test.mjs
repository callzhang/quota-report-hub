import test from "node:test";
import assert from "node:assert/strict";
import { invalidatedEntryToRepairAuth, repairAuthOnlyPayload, stripRefreshToken } from "../lib/fetch-best.js";

test("stripRefreshToken replaces the codex refresh token with a well-formed placeholder", () => {
  const blob = JSON.stringify({ tokens: { access_token: "AT", refresh_token: "rt.1.REALSECRET", account_id: "x" }, last_refresh: "t" });
  const out = JSON.parse(stripRefreshToken(blob, "codex"));
  assert.equal(out.tokens.access_token, "AT");
  assert.notEqual(out.tokens.refresh_token, "rt.1.REALSECRET");
  assert.match(out.tokens.refresh_token, /^rt\.1\./); // present + well-formed, as codex requires
});

test("stripRefreshToken replaces the claude refresh token, keeping the access token", () => {
  const blob = JSON.stringify({ credentials: { claudeAiOauth: { accessToken: "AT", refreshToken: "RT_REALSECRET" } } });
  const out = JSON.parse(stripRefreshToken(blob, "claude"));
  assert.equal(out.credentials.claudeAiOauth.accessToken, "AT");
  assert.notEqual(out.credentials.claudeAiOauth.refreshToken, "RT_REALSECRET");
});

test("stripRefreshToken leaves malformed / null blobs untouched", () => {
  assert.equal(stripRefreshToken("not json", "codex"), "not json");
  assert.equal(stripRefreshToken(null, "codex"), null);
});

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

test("fetch-best returns repair auth without a shared replacement", () => {
  const repairAuth = {
    source: "codex",
    account_id: "junjie.zhou@stardust.ai",
    auth_json: "{\"tokens\":{}}",
  };

  const payload = repairAuthOnlyPayload(repairAuth);

  assert.equal(payload.replacement, null);
  assert.equal(payload.repair_auth, repairAuth);
  assert.equal(payload.reason, "uploaded_auth_requires_reauth");
});
