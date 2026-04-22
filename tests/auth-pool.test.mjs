import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveAuthPoolEntry,
  pickBestAuthPoolCandidate,
  shouldReplaceAuthPoolEntry,
} from "../lib/auth-pool.js";

function fakeAuthJson({ accountId, email, name, plan = "pro", lastRefresh = "2026-04-22T00:00:00Z" }) {
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
    tokens: {
      account_id: accountId,
      id_token: `x.${payload}.y`,
    },
    last_refresh: lastRefresh,
  });
}

test("deriveAuthPoolEntry extracts codex auth metadata", () => {
  const entry = deriveAuthPoolEntry(
    fakeAuthJson({
      accountId: "acct-1",
      email: "a@example.com",
      name: "A",
      plan: "prolite",
    }),
    { reporter_name: "derek@gpu4", hostname: "gpu4" }
  );

  assert.equal(entry.account_id, "acct-1");
  assert.equal(entry.email, "a@example.com");
  assert.equal(entry.name, "A");
  assert.equal(entry.plan_name, "Pro Lite");
  assert.equal(entry.reporter_name, "derek@gpu4");
  assert.equal(entry.hostname, "gpu4");
});

test("pickBestAuthPoolCandidate skips hard-invalidated reports and chooses best usable quota", () => {
  const reports = [
    {
      source: "codex",
      account_id: "bad",
      status: "error",
      error: "auth invalidated (token_invalidated)",
      windows: {
        "5h": { remaining_percent: 99 },
        "1week": { remaining_percent: 99 },
      },
      reported_at: "2026-04-22T08:00:00Z",
    },
    {
      source: "codex",
      account_id: "soft",
      status: "error",
      error: "token_count event was present but missing quota details",
      windows: {
        "5h": { remaining_percent: 82 },
        "1week": { remaining_percent: 71 },
      },
      reported_at: "2026-04-22T08:01:00Z",
    },
    {
      source: "codex",
      account_id: "best",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 91 },
        "1week": { remaining_percent: 65 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
  ];
  const pool = [
    { account_id: "bad" },
    { account_id: "soft" },
    { account_id: "best" },
  ];

  const candidate = pickBestAuthPoolCandidate(reports, pool);

  assert.equal(candidate.entry.account_id, "best");
  assert.equal(candidate.report.account_id, "best");
});

test("shouldReplaceAuthPoolEntry skips duplicate account uploads when incoming refresh is not newer", () => {
  const existing = {
    source: "codex",
    account_id: "acct-1",
    auth_last_refresh: "2026-04-22T09:00:00Z",
    digest: "existing-digest",
  };
  const incoming = {
    source: "codex",
    account_id: "acct-1",
    auth_last_refresh: "2026-04-22T09:00:00Z",
    digest: "different-file-digest",
  };

  assert.equal(shouldReplaceAuthPoolEntry(existing, incoming), false);
});

test("shouldReplaceAuthPoolEntry accepts newer refresh for same account", () => {
  const existing = {
    source: "codex",
    account_id: "acct-1",
    auth_last_refresh: "2026-04-22T09:00:00Z",
    digest: "existing-digest",
  };
  const incoming = {
    source: "codex",
    account_id: "acct-1",
    auth_last_refresh: "2026-04-22T10:00:00Z",
    digest: "newer-digest",
  };

  assert.equal(shouldReplaceAuthPoolEntry(existing, incoming), true);
});
