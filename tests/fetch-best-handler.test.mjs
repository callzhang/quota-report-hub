import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeAuthJson({ accountId, email, name = "Test User", plan = "team", lastRefresh = "2026-05-06T00:00:00Z", exp = null }) {
  const claims = {
    email,
    name,
    "https://api.openai.com/auth": {
      chatgpt_plan_type: plan,
    },
  };
  if (exp !== null) claims.exp = exp; // codex AT expiry is read from the id_token exp
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");

  return JSON.stringify({
    last_refresh: lastRefresh,
    tokens: {
      account_id: accountId,
      id_token: `x.${payload}.y`,
      access_token: "access-" + accountId,
      refresh_token: "rt.1.REAL-" + accountId,
    },
  });
}

async function withTempEnv(fn) {
  const tempDir = mkdtempSync(join(tmpdir(), "qrh-fetch-best-test-"));
  const previous = {
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
    AUTH_POOL_ENCRYPTION_KEY: process.env.AUTH_POOL_ENCRYPTION_KEY,
    TOKEN_ISSUE_KEY: process.env.TOKEN_ISSUE_KEY,
  };
  process.env.TURSO_DATABASE_URL = `file:${join(tempDir, "fetch-best.db")}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.AUTH_POOL_ENCRYPTION_KEY = "0".repeat(64);
  process.env.TOKEN_ISSUE_KEY = "test-token-issue-key-32-bytes!!!";
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function mockJsonRequest({ token, body }) {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
    },
    async on() {},
    [Symbol.asyncIterator]: async function* iterator() {
      yield Buffer.from(JSON.stringify(body), "utf8");
    },
  };
}

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(value) {
      this.body = value || "";
    },
  };
}

test("fetch-best serves a replacement (never a failed auth) when the requester has a valid upload", async () => {
  await withTempEnv(async () => {
    const db = await import(`../lib/db.js?ts=${Date.now()}`);
    const { default: handler } = await import(`../api/auth/fetch-best.js?ts=${Date.now()}`);
    const token = (await db.issueApiToken("derek@stardust.ai")).token;

    await db.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({
        accountId: "current-provider",
        email: "current@stardust.ai",
        lastRefresh: "2026-05-06T00:00:00Z",
      }),
      uploader_email: "derek@stardust.ai",
      reporter_name: "derek@gpu4",
      hostname: "gpu4",
    });
    await db.upsertAuthPoolQuota({
      source: "codex",
      hostname: "github-actions",
      reporter_name: "worker",
      reported_at: "2026-05-06T01:00:00Z",
      account_id: "current@stardust.ai",
      email: "current@stardust.ai",
      plan_name: "Team",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows: { "5h": null, "1week": null },
    });

    await db.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({
        accountId: "healthy-provider",
        email: "healthy@stardust.ai",
        lastRefresh: "2026-05-06T02:00:00Z",
      }),
      uploader_email: "derek@stardust.ai",
      reporter_name: "derek@mac",
      hostname: "mac",
    });
    await db.upsertAuthPoolQuota({
      source: "codex",
      hostname: "github-actions",
      reporter_name: "worker",
      reported_at: new Date().toISOString(),
      account_id: "healthy@stardust.ai",
      email: "healthy@stardust.ai",
      plan_name: "Team",
      status: "ok",
      windows: {
        "5h": { used_percent: 20, remaining_percent: 80, reset_at: "2099-05-06T07:00:00Z" },
        "1week": { used_percent: 10, remaining_percent: 90, reset_at: "2099-05-13T02:00:00Z" },
      },
    });

    const req = mockJsonRequest({
      token,
      body: {
        source: "codex",
        requester_id: "derek@gpu4",
        current_account_id: "borrowed@stardust.ai",
        current_quota: {
          five_h_remaining_percent: -1,
          one_week_remaining_percent: -1,
        },
      },
    });
    // disabled_refresh_token on -> the served auth must have its refresh token stripped.
    await db.setFeatureFlag("disabled_refresh_token", true, "derek@stardust.ai");

    const res = mockResponse();

    await handler(req, res);
    const payload = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    // derek has a valid uploaded auth, so they get a replacement — never the dead one.
    assert.equal(payload.replacement.account_id, "healthy@stardust.ai");
    assert.equal(payload.repair_auth, undefined);
    assert.equal(payload.disabled_refresh_token, true);

    // The served credential keeps the access token but has a stripped (well-formed) RT.
    const served = JSON.parse(payload.replacement.auth_json);
    assert.equal(served.tokens.access_token, "access-healthy-provider");
    assert.notEqual(served.tokens.refresh_token, "rt.1.REAL-healthy-provider");
    assert.match(served.tokens.refresh_token, /^rt\.1\./);

    // No handback while a valid auth exists; the fetch is recorded as a normal serve.
    const log = await db.authPoolFetchLog({ limit: 5 });
    assert.ok(!log.some((row) => row.reason === "repair_returned"), "must not hand back a dead auth when a valid one exists");
    assert.ok(log.some((row) => row.reason === "served"));

    // Phase 2: refresh_current returns the SAME account's fresh blob (stripped, flag still on),
    // not a different account — a near-expiry client refreshes its access token in place.
    const refreshReq = mockJsonRequest({
      token,
      body: { source: "codex", requester_id: "derek@gpu4", current_account_id: "healthy@stardust.ai", refresh_current: true },
    });
    const refreshRes = mockResponse();
    await handler(refreshReq, refreshRes);
    const refreshPayload = JSON.parse(refreshRes.body);
    assert.equal(refreshPayload.refreshed_current, true);
    assert.equal(refreshPayload.replacement.account_id, "healthy@stardust.ai");
    const refreshedServed = JSON.parse(refreshPayload.replacement.auth_json);
    assert.equal(refreshedServed.tokens.access_token, "access-healthy-provider");
    assert.match(refreshedServed.tokens.refresh_token, /^rt\.1\./);
    assert.ok((await db.authPoolFetchLog({ limit: 8 })).some((row) => row.reason === "refreshed_current"));

    // Fallback: refresh_current on an account whose pooled copy has an ALREADY-EXPIRED AT must NOT
    // serve that stale same-account copy (it would dead-lock the owner) — it falls through to a
    // normal replacement instead.
    await db.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({ accountId: "stale-provider", email: "stale@stardust.ai", exp: 1000000000 }),
      uploader_email: "derek@stardust.ai",
      reporter_name: "derek@mac",
      hostname: "mac",
    });
    const staleReq = mockJsonRequest({
      token,
      body: { source: "codex", requester_id: "derek@gpu4", current_account_id: "stale@stardust.ai", refresh_current: true },
    });
    const staleRes = mockResponse();
    await handler(staleReq, staleRes);
    const stalePayload = JSON.parse(staleRes.body);
    assert.notEqual(stalePayload.refreshed_current, true);
    assert.notEqual(stalePayload.replacement?.account_id, "stale@stardust.ai");

    const xinToken = (await db.issueApiToken("xin.jiang@stardust.ai")).token;

    await db.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({
        accountId: "xin-provider",
        email: "xin.jiang@stardust.ai",
        lastRefresh: "2026-05-06T00:00:00Z",
      }),
      uploader_email: "xin.jiang@stardust.ai",
      reporter_name: "xin@mac",
      hostname: "mac",
    });
    await db.upsertAuthPoolQuota({
      source: "codex",
      hostname: "github-actions",
      reporter_name: "worker",
      reported_at: "2026-05-06T01:00:00Z",
      account_id: "xin.jiang@stardust.ai",
      email: "xin.jiang@stardust.ai",
      plan_name: "Team",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows: { "5h": null, "1week": null },
    });

    await db.upsertAuthPoolEntry({
      source: "codex",
      auth_json: fakeAuthJson({
        accountId: "healthy-provider",
        email: "healthy@stardust.ai",
        lastRefresh: "2026-05-06T02:00:00Z",
      }),
      uploader_email: "healthy.owner@stardust.ai",
      reporter_name: "healthy@gpu",
      hostname: "gpu",
    });
    await db.upsertAuthPoolQuota({
      source: "codex",
      hostname: "github-actions",
      reporter_name: "worker",
      reported_at: new Date().toISOString(),
      account_id: "healthy@stardust.ai",
      email: "healthy@stardust.ai",
      plan_name: "Team",
      status: "ok",
      windows: {
        "5h": { used_percent: 15, remaining_percent: 85, reset_at: "2099-05-06T07:00:00Z" },
        "1week": { used_percent: 8, remaining_percent: 92, reset_at: "2099-05-13T02:00:00Z" },
      },
    });

    const xinReq = mockJsonRequest({
      token: xinToken,
      body: {
        source: "codex",
        requester_id: "xin@mac",
        current_account_id: "xin.jiang@stardust.ai",
        current_quota: {
          five_h_remaining_percent: -1,
          one_week_remaining_percent: -1,
        },
      },
    });
    const xinRes = mockResponse();

    await handler(xinReq, xinRes);
    const xinPayload = JSON.parse(xinRes.body);

    assert.equal(xinRes.statusCode, 200);
    assert.equal(xinPayload.replacement.account_id, "healthy@stardust.ai");
    assert.equal(xinPayload.repair_auth, undefined);

    const xinLog = await db.authPoolFetchLog({ limit: 5 });
    assert.ok(xinLog.some((row) => row.reason === "served"));
    assert.ok(!xinLog.some((row) => row.reason === "repair_returned"), "healthy shared auth should be served before repair handback");

    // Phase 3: refresh_current must force a real upstream refresh when codex's id_token has gone
    // stale even though its access_token is still fresh for days. The codex CLI/app key their own
    // self-refresh trigger off id_token (~1h exp), not access_token (~10-day exp); a pooled/AT-only
    // borrower's local refresh_token is a stripped placeholder, so once id_token goes stale, the
    // local client's own refresh attempt always 400s ("Invalid refresh token") — this is a
    // reproduction of exactly that: quota_guard reporting "replacement best_auth_already_installed"
    // while the local CLI/app kept failing every ~40-60 minutes. Reuses this test's own db/handler
    // (not fresh imports) so the handler's internally-cached lib/db.js client stays pointed at the
    // SAME sqlite file this test has been writing to all along.
    const { decryptAuthJson } = await import(`../lib/auth-pool.js?ts=${Date.now()}`);

    const now = Date.now();
    function jwt(claims) {
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `x.${payload}.y`;
    }
    function jwtExp(jwtStr) {
      return JSON.parse(Buffer.from(jwtStr.split(".")[1], "base64url").toString("utf8")).exp;
    }
    // The pool's canonical account_id is the id_token's email claim (see canonicalCodexAccountId
    // in lib/auth-pool.js), not the raw tokens.account_id field — keep them matching here.
    const accountId = "borrowed@stardust.ai";

    // access_token has a real ~10-day exp (far in the future); id_token — what the codex CLI/app
    // actually key their own self-refresh trigger off — already expired 5 minutes ago. This is
    // exactly what quota_guard observed: "quota reported | replacement best_auth_already_installed"
    // while the local CLI/app kept hitting "400 Bad Request: Invalid refresh token" every ~40-60min.
    await db.upsertAuthPoolEntry({
      source: "codex",
      auth_json: JSON.stringify({
        last_refresh: "2026-05-06T00:00:00Z",
        tokens: {
          account_id: "borrowed-provider",
          id_token: jwt({ email: accountId, exp: Math.floor((now - 5 * 60 * 1000) / 1000) }),
          access_token: jwt({ exp: Math.floor((now + 10 * 24 * 60 * 60 * 1000) / 1000) }),
          refresh_token: "rt.1.REAL-" + accountId,
        },
      }),
      uploader_email: "derek@stardust.ai",
      reporter_name: "derek@mac",
      hostname: "mac",
    });

    const originalFetch = globalThis.fetch;
    let refreshCalled = false;
    globalThis.fetch = async (url, opts) => {
      refreshCalled = true;
      assert.match(String(url), /auth\.openai\.com\/oauth\/token/);
      const body = JSON.parse(opts.body);
      assert.equal(body.refresh_token, "rt.1.REAL-" + accountId, "must use the real server-held RT, not a placeholder");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: jwt({ exp: Math.floor((now + 10 * 24 * 60 * 60 * 1000) / 1000) }),
            id_token: jwt({ email: "borrowed@stardust.ai", exp: Math.floor((now + 60 * 60 * 1000) / 1000) }),
            refresh_token: "rt.1.REAL-ROTATED-" + accountId,
            expires_in: 864000,
          };
        },
      };
    };

    try {
      const req = mockJsonRequest({
        token,
        body: { source: "codex", requester_id: "derek@mac", current_account_id: accountId, refresh_current: true },
      });
      const res = mockResponse();
      await handler(req, res);
      const payload = JSON.parse(res.body);

      assert.equal(refreshCalled, true, "must call OpenAI's refresh endpoint when id_token is stale, even though access_token is fresh");
      assert.equal(res.statusCode, 200);
      assert.equal(payload.refreshed_current, true);
      assert.equal(payload.replacement.account_id, accountId, "must refresh the SAME account, not switch to a different one");

      const served = JSON.parse(payload.replacement.auth_json);
      assert.ok(jwtExp(served.tokens.id_token) * 1000 > now, "served id_token must be freshly minted, not the stale original");

      // The pool entry itself must be persisted with the rotated tokens, not just handed back once.
      const persistedEntry = await db.authPoolEntry("codex", accountId);
      const persisted = JSON.parse(await decryptAuthJson(persistedEntry));
      assert.equal(persisted.tokens.refresh_token, "rt.1.REAL-ROTATED-" + accountId);
      assert.ok(jwtExp(persisted.tokens.id_token) * 1000 > now);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
