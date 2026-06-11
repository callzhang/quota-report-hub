import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeAuthJson({ accountId, email, name = "Test User", plan = "team", lastRefresh = "2026-05-06T00:00:00Z" }) {
  const payload = Buffer.from(
    JSON.stringify({
      email,
      name,
      "https://api.openai.com/auth": {
        chatgpt_plan_type: plan,
      },
    })
  ).toString("base64url");

  return JSON.stringify({
    last_refresh: lastRefresh,
    tokens: {
      account_id: accountId,
      id_token: `x.${payload}.y`,
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
    const res = mockResponse();

    await handler(req, res);
    const payload = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    // derek has a valid uploaded auth, so they get a replacement — never the dead one.
    assert.equal(payload.replacement.account_id, "healthy@stardust.ai");
    assert.equal(payload.repair_auth, undefined);

    // No handback while a valid auth exists; the fetch is recorded as a normal serve.
    const log = await db.authPoolFetchLog({ limit: 5 });
    assert.ok(!log.some((row) => row.reason === "repair_returned"), "must not hand back a dead auth when a valid one exists");
    assert.ok(log.some((row) => row.reason === "served"));
  });
});
