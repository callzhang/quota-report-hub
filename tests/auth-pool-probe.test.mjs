import test from "node:test";
import assert from "node:assert/strict";
import { probeAuthJson } from "../lib/auth-pool-probe.js";

function fakeCodexAuthJson() {
  const idPayload = Buffer.from(
    JSON.stringify({
      email: "a@example.com",
      name: "A",
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "prolite",
      },
    })
  ).toString("base64url");

  return JSON.stringify({
    tokens: {
      account_id: "acct-1",
      access_token: "access-token",
      id_token: `x.${idPayload}.y`,
    },
    last_refresh: "2026-04-22T00:00:00Z",
  });
}

function fakeClaudeAuthJson() {
  return JSON.stringify({
    schema: "claude_credentials_v1",
    account_id: "claude-a@example.com",
    email: "a@example.com",
    name: "Org A",
    plan_name: "Max",
    auth_last_refresh: "1776668828033",
    credentials: {
      claudeAiOauth: {
        accessToken: "token",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        expiresAt: "2026-04-23T12:00:00Z",
      },
    },
  });
}

test("probeAuthJson parses codex backend usage windows", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer access-token");
    return new Response(
      JSON.stringify({
        plan_type: "prolite",
        rate_limit: {
          primary_window: {
            used_percent: 5,
            limit_window_seconds: 18000,
            reset_after_seconds: 100,
            reset_at: 1776925899,
          },
          secondary_window: {
            used_percent: 34,
            limit_window_seconds: 604800,
            reset_after_seconds: 200,
            reset_at: 1777401012,
          },
        },
        credits: { balance: "0" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const report = await probeAuthJson("codex", fakeCodexAuthJson());
    assert.equal(report.status, "ok");
    assert.equal(report.plan_name, "Pro Lite");
    assert.equal(report.windows["5h"].remaining_percent, 95);
    assert.equal(report.windows["1week"].remaining_percent, 66);
  } finally {
    global.fetch = originalFetch;
  }
});

test("probeAuthJson reports non-json codex responses as errors instead of crashing", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("<html>login</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

  try {
    const report = await probeAuthJson("codex", fakeCodexAuthJson());
    assert.equal(report.status, "error");
    assert.equal(report.error, "codex usage probe returned non-json response");
  } finally {
    global.fetch = originalFetch;
  }
});

test("probeAuthJson rejects codex usage windows without reset times", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        plan_type: "prolite",
        rate_limit: {
          primary_window: {
            used_percent: 100,
            limit_window_seconds: 18000,
          },
          secondary_window: {
            used_percent: 100,
            limit_window_seconds: 604800,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  try {
    const report = await probeAuthJson("codex", fakeCodexAuthJson());
    assert.equal(report.status, "error");
    assert.equal(report.error, "codex usage response was missing reset times");
    assert.equal(report.windows["5h"], null);
    assert.equal(report.windows["1week"], null);
  } finally {
    global.fetch = originalFetch;
  }
});

test("probeAuthJson parses claude unified ratelimit headers", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({ ok: true }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-utilization": "0.25",
          "anthropic-ratelimit-unified-5h-reset": "1776672000",
          "anthropic-ratelimit-unified-7d-utilization": "0.60",
          "anthropic-ratelimit-unified-7d-reset": "1776970800",
        },
      }
    );

  try {
    const report = await probeAuthJson("claude", fakeClaudeAuthJson());
    assert.equal(report.status, "ok");
    assert.equal(report.windows["5h"].remaining_percent, 75);
    assert.equal(report.windows["1week"].remaining_percent, 40);
    assert.equal(report.usage_summary.subscription_type, "max");
  } finally {
    global.fetch = originalFetch;
  }
});
