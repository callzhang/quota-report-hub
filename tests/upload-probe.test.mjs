import test from "node:test";
import assert from "node:assert/strict";
import { probeClaudeAccessToken } from "../lib/token-refresh.js";

const blob = (at) => JSON.stringify({ credentials: { claudeAiOauth: { accessToken: at, refreshToken: "sk-ant-ort01-REAL" } } });

test("a live access token is proof the refresh token beside it is unspent", async () => {
  // Verifying by refresh revokes what the uploader is using and starts the re-mint loop. A refresh
  // is also the ONLY thing that could have spent the refresh token — and it would have killed this
  // access token on the way. So a 200 here means nobody has refreshed this grant since.
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, auth: init.headers.Authorization };
    return { ok: true, status: 200 };
  };
  const out = await probeClaudeAccessToken(blob("AT_LIVE"), fetchImpl);
  assert.equal(out.ok, true);
  assert.equal(out.rejected, undefined === out.rejected ? undefined : false);
  assert.match(seen.url, /oauth\/profile$/);
  assert.equal(seen.auth, "Bearer AT_LIVE");
});

test("only 401 condemns the credential; a bad day upstream does not", async () => {
  const at401 = await probeClaudeAccessToken(blob("AT"), async () => ({ ok: false, status: 401 }));
  assert.equal(at401.rejected, true);

  for (const status of [429, 500, 503]) {
    const out = await probeClaudeAccessToken(blob("AT"), async () => ({ ok: false, status }));
    assert.equal(out.ok, false);
    assert.equal(out.rejected, false, `status ${status} must not read as a dead account`);
  }
  const thrown = await probeClaudeAccessToken(blob("AT"), async () => { throw new Error("dns"); });
  assert.equal(thrown.ok, false);
  assert.notEqual(thrown.rejected, true);
});

test("a malformed or tokenless blob is refused without a network call", async () => {
  let called = false;
  const spy = async () => { called = true; return { ok: true, status: 200 }; };
  assert.equal((await probeClaudeAccessToken("not json", spy)).reason, "unparseable");
  assert.equal((await probeClaudeAccessToken(JSON.stringify({ credentials: {} }), spy)).reason, "no_access_token");
  assert.equal(called, false);
});
