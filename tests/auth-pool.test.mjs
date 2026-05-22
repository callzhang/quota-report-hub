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
    "codex",
    fakeAuthJson({
      accountId: "acct-1",
      email: "a@example.com",
      name: "A",
      plan: "prolite",
    }),
    { reporter_name: "derek@gpu4", hostname: "gpu4" }
  );

  assert.equal(entry.account_id, "a@example.com");
  assert.equal(entry.email, "a@example.com");
  assert.equal(entry.name, "A");
  assert.equal(entry.plan_name, "Pro Lite");
  assert.equal(entry.reporter_name, "derek@gpu4");
  assert.equal(entry.hostname, "gpu4");
});

test("deriveAuthPoolEntry extracts claude auth metadata", () => {
  const entry = deriveAuthPoolEntry(
    "claude",
    JSON.stringify({
      schema: "claude_credentials_v1",
      account_id: "claude-a@example.com",
      email: "a@example.com",
      name: "Org A",
      plan_name: "Max",
      auth_last_refresh: "1776668828033",
      credentials: { claudeAiOauth: { accessToken: "token", expiresAt: 1776668828033 } },
    }),
    { reporter_name: "derek@mbp", hostname: "mbp" }
  );

  assert.equal(entry.source, "claude");
  assert.equal(entry.account_id, "claude-a@example.com");
  assert.equal(entry.email, "a@example.com");
  assert.equal(entry.plan_name, "Max");
  assert.equal(entry.auth_expires_at, "2026-04-20T07:07:08.033Z");
});

test("deriveAuthPoolEntry accepts claude ISO auth expiry", () => {
  const entry = deriveAuthPoolEntry(
    "claude",
    JSON.stringify({
      schema: "claude_credentials_v1",
      account_id: "claude-a@example.com",
      email: "a@example.com",
      credentials: {
        claudeAiOauth: {
          accessToken: "token",
          expiresAt: "2026-04-23T12:00:00Z",
        },
      },
    })
  );

  assert.equal(entry.auth_expires_at, "2026-04-23T12:00:00.000Z");
});

test("pickBestAuthPoolCandidate skips hard-invalidated reports and chooses best weighted usable quota", () => {
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

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 20,
      one_week_remaining_percent: 40,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate.entry.account_id, "soft");
  assert.equal(candidate.report.account_id, "soft");
});

test("pickBestAuthPoolCandidate spreads fetches across similarly strong accounts", () => {
  const reports = [
    {
      source: "codex",
      account_id: "hot",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 98 },
        "1week": { remaining_percent: 70 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
    {
      source: "codex",
      account_id: "cool",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 91 },
        "1week": { remaining_percent: 68 },
      },
      reported_at: "2026-04-22T08:01:00Z",
    },
  ];
  const pool = [{ account_id: "hot" }, { account_id: "cool" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_quota: {
      five_h_remaining_percent: 10,
      one_week_remaining_percent: 10,
    },
    recent_served_counts: {
      hot: 4,
      cool: 0,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate.entry.account_id, "cool");
});

test("pickBestAuthPoolCandidate weights distribution by remaining quota", () => {
  const reports = [
    {
      source: "codex",
      account_id: "hot",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 98 },
        "1week": { remaining_percent: 70 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
    {
      source: "codex",
      account_id: "marginal",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 25 },
        "1week": { remaining_percent: 90 },
      },
      reported_at: "2026-04-22T08:03:00Z",
    },
  ];
  const pool = [{ account_id: "hot" }, { account_id: "marginal" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_quota: {
      five_h_remaining_percent: 10,
      one_week_remaining_percent: 10,
    },
    recent_served_counts: {
      hot: 2,
      marginal: 0,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate.entry.account_id, "marginal");
});

test("pickBestAuthPoolCandidate lets high-quota accounts carry proportionally more fetches", () => {
  const reports = [
    {
      source: "codex",
      account_id: "hot",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 98 },
        "1week": { remaining_percent: 90 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
    {
      source: "codex",
      account_id: "low",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 30 },
        "1week": { remaining_percent: 30 },
      },
      reported_at: "2026-04-22T08:03:00Z",
    },
  ];
  const pool = [{ account_id: "hot" }, { account_id: "low" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_quota: {
      five_h_remaining_percent: 10,
      one_week_remaining_percent: 10,
    },
    recent_served_counts: {
      hot: 1,
      low: 0,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate.entry.account_id, "hot");
});

test("pickBestAuthPoolCandidate uses requester key to spread concurrent equal-load requests", () => {
  const reports = ["a", "b", "c"].map((accountId) => ({
    source: "codex",
    account_id: accountId,
    status: "ok",
    error: null,
    windows: {
      "5h": { remaining_percent: 80 },
      "1week": { remaining_percent: 80 },
    },
    reported_at: "2026-04-22T08:02:00Z",
  }));
  const pool = reports.map((report) => ({ account_id: report.account_id }));

  const selected = new Set(
    ["alice@stardust.ai", "carol@stardust.ai", "frank@stardust.ai"].map((selectionKey) =>
      pickBestAuthPoolCandidate(reports, pool, {
        source: "codex",
        current_quota: {
          five_h_remaining_percent: 10,
          one_week_remaining_percent: 10,
        },
        selection_key: selectionKey,
        now: "2026-04-22T08:30:00Z",
      }).entry.account_id
    )
  );

  assert.ok(selected.size > 1);
});

test("pickBestAuthPoolCandidate returns null when no candidate beats current quota", () => {
  const reports = [
    {
      source: "codex",
      account_id: "same-level",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 18 },
        "1week": { remaining_percent: 80 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
  ];
  const pool = [{ account_id: "same-level" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 20,
      one_week_remaining_percent: 50,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate, null);
});

test("pickBestAuthPoolCandidate allows lower weekly quota as long as 5H is better and week remains usable", () => {
  const reports = [
    {
      source: "codex",
      account_id: "better-5h",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 42 },
        "1week": { remaining_percent: 15 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
  ];
  const pool = [{ account_id: "better-5h" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 20,
      one_week_remaining_percent: 50,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate.entry.account_id, "better-5h");
});

test("pickBestAuthPoolCandidate does not mix codex and claude sources", () => {
  const reports = [
    {
      source: "claude",
      account_id: "claude-a",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 90 },
        "1week": { remaining_percent: 80 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
  ];
  const pool = [{ account_id: "claude-a" }];

  const codexCandidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 10,
      one_week_remaining_percent: 10,
    },
    now: "2026-04-22T08:30:00Z",
  });
  const claudeCandidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "claude",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 10,
      one_week_remaining_percent: 10,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(codexCandidate, null);
  assert.equal(claudeCandidate.entry.account_id, "claude-a");
});

test("pickBestAuthPoolCandidate skips stale quota reports", () => {
  const reports = [
    {
      source: "codex",
      account_id: "stale-best",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 99 },
        "1week": { remaining_percent: 90 },
      },
      reported_at: "2026-04-21T18:00:00Z",
    },
    {
      source: "codex",
      account_id: "fresh-good",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 60 },
        "1week": { remaining_percent: 50 },
      },
      reported_at: "2026-04-22T07:45:00Z",
    },
  ];
  const pool = [{ account_id: "stale-best" }, { account_id: "fresh-good" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 20,
      one_week_remaining_percent: 20,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate.entry.account_id, "fresh-good");
});

test("pickBestAuthPoolCandidate returns null when all better quota reports are stale", () => {
  const reports = [
    {
      source: "codex",
      account_id: "stale-best",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 99 },
        "1week": { remaining_percent: 90 },
      },
      reported_at: "2026-04-21T18:00:00Z",
    },
  ];
  const pool = [{ account_id: "stale-best" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 20,
      one_week_remaining_percent: 20,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate, null);
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
