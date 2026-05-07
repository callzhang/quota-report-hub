import test from "node:test";
import assert from "node:assert/strict";
import {
  bearerTokenFromHeaders,
  companyEmailAllowed,
  normalizeEmail,
  sendAuthInvalidatedEmail,
} from "../lib/company-auth.js";

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail(" Derek@Stardust.ai "), "derek@stardust.ai");
});

test("companyEmailAllowed only permits company domain", () => {
  assert.equal(companyEmailAllowed("derek@stardust.ai"), true);
  assert.equal(companyEmailAllowed("derek@gmail.com"), false);
});

test("companyEmailAllowed respects AUTH_ALLOWED_EMAIL_DOMAIN override", () => {
  const previous = process.env.AUTH_ALLOWED_EMAIL_DOMAIN;
  process.env.AUTH_ALLOWED_EMAIL_DOMAIN = "preseen.ai";

  try {
    assert.equal(companyEmailAllowed("hello@preseen.ai"), true);
    assert.equal(companyEmailAllowed("hello@stardust.ai"), false);
  } finally {
    if (previous === undefined) {
      delete process.env.AUTH_ALLOWED_EMAIL_DOMAIN;
    } else {
      process.env.AUTH_ALLOWED_EMAIL_DOMAIN = previous;
    }
  }
});

test("bearerTokenFromHeaders extracts bearer token case-insensitively", () => {
  assert.equal(
    bearerTokenFromHeaders({ authorization: "Bearer qrp_example" }),
    "qrp_example"
  );
  assert.equal(
    bearerTokenFromHeaders({ Authorization: "bearer qrp_other" }),
    "qrp_other"
  );
  assert.equal(
    bearerTokenFromHeaders({}),
    ""
  );
});

test("sendAuthInvalidatedEmail sends a compact HTML card through Mailgun", async () => {
  const previousEnv = {
    MAILGUN_API_KEY: process.env.MAILGUN_API_KEY,
    MAILGUN_DOMAIN: process.env.MAILGUN_DOMAIN,
    MAILGUN_FROM: process.env.MAILGUN_FROM,
  };
  const previousFetch = globalThis.fetch;
  let capturedRequest = null;
  process.env.MAILGUN_API_KEY = "test-key";
  process.env.MAILGUN_DOMAIN = "mg.example.com";
  process.env.MAILGUN_FROM = "hello@example.com";
  globalThis.fetch = async (url, options) => {
    capturedRequest = { url, options };
    return Response.json({ ok: true });
  };

  try {
    await sendAuthInvalidatedEmail({
      email: "owner@stardust.ai",
      entry: {
        source: "codex",
        email: "shared<acct>@stardust.ai",
        plan_name: "Team",
      },
      invalidatedSince: "2026-05-06T11:00:00Z",
    });

    assert.equal(capturedRequest.url, "https://api.mailgun.net/v3/mg.example.com/messages");
    const fields = Object.fromEntries(capturedRequest.options.body.entries());
    assert.equal(fields.to, "owner@stardust.ai");
    assert.equal(fields.subject, "Quota Report Hub: codex auth needs login");
    assert.match(fields.html, /^<!doctype html>/);
    assert.match(fields.html, /max-width:560px/);
    assert.match(fields.html, /codex login required/);
    assert.match(fields.html, /shared&lt;acct&gt;@stardust\.ai/);
    assert.match(fields.html, /This reminder is sent at most once per 24 hours/);
    assert.match(fields.text, /Please log in again/);
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    globalThis.fetch = previousFetch;
  }
});
