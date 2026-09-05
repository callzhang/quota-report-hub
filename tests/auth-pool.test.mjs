import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveAuthPoolEntry,
  pickBestAuthPoolCandidate,
  shouldReplaceAuthPoolEntry,
} from "../lib/auth-pool.js";

function fakeJwt(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

function fakeAuthJson({
  accountId,
  email,
  name,
  plan = "pro",
  lastRefresh = "2026-04-22T00:00:00Z",
  idExp,
  accessExp,
}) {
  const idPayload = {
    email,
    name,
    exp: idExp,
    "https://api.openai.com/auth": {
      chatgpt_plan_type: plan,
    },
  };
  const accessPayload = {
    exp: accessExp,
  };

  return JSON.stringify({
    tokens: {
      account_id: accountId,
      id_token: fakeJwt(idPayload),
      access_token: fakeJwt(accessPayload),
      refresh_token: "rt.1.REALFIXTURETOKEN",
    },
    last_refresh: lastRefresh,
  });
}

function legacyFakeAuthJson({ accountId, email, name, plan = "pro", lastRefresh = "2026-04-22T00:00:00Z" }) {
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
      refresh_token: "rt.1.REALFIXTURETOKEN",
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

test("deriveAuthPoolEntry records refresh recovery capability without exposing the token", () => {
  const idToken = fakeJwt({ email: "member@stardust.ai", sid: "session" });
  const withRefresh = deriveAuthPoolEntry("codex", JSON.stringify({
    tokens: { account_id: "acct", id_token: idToken, access_token: fakeJwt({ exp: 1 }), refresh_token: "rt-secret" },
  }));
  const atOnly = deriveAuthPoolEntry("codex", JSON.stringify({
    tokens: { account_id: "acct", id_token: idToken, access_token: fakeJwt({ exp: 1 }) },
  }));

  assert.equal(withRefresh.has_refresh_token, true);
  assert.equal(atOnly.has_refresh_token, false);
  assert.equal("refresh_token" in withRefresh, false);
});

test("deriveAuthPoolEntry uses codex access token expiry before stale id token expiry", () => {
  const entry = deriveAuthPoolEntry(
    "codex",
    fakeAuthJson({
      accountId: "acct-1",
      email: "a@example.com",
      name: "A",
      idExp: 1776668828,
      accessExp: 1776933220,
    })
  );

  assert.equal(entry.auth_expires_at, "2026-04-23T08:33:40.000Z");
});

test("deriveAuthPoolEntry falls back to codex id token expiry for older auth blobs", () => {
  const entry = deriveAuthPoolEntry(
    "codex",
    legacyFakeAuthJson({
      accountId: "acct-1",
      email: "a@example.com",
      name: "A",
    })
  );

  assert.equal(entry.auth_expires_at, null);
});

test("deriveAuthPoolEntry extracts claude auth metadata", () => {
  const entry = deriveAuthPoolEntry(
    "claude",
    JSON.stringify({
      schema: "claude_credentials_v1",
      account_id: "claude-a@example.com",
      session_id: "claude-session-a",
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
  assert.equal(entry.session_id, "claude-session-a");
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

test("pickBestAuthPoolCandidate weighs codex 5H headroom alongside weekly quota", () => {
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

  // marginal's 5h=25% caps its quota weight below hot's min(98, 70), so hot carries the fetch
  // despite marginal's better weekly window.
  assert.equal(candidate.entry.account_id, "hot");
});

test("pickBestAuthPoolCandidate treats a codex 5h window expired before its report as unconstrained", () => {
  // Production case (codex leizhang0121, 2026-09-03): a Pro account whose probes stopped reporting
  // a 5h window carried a merged "5h 0%" snapshot whose reset_at had passed days earlier, while its
  // live weekly window sat at 96%. The spent snapshot must not fail the 5h share threshold.
  const reports = [
    {
      source: "codex",
      account_id: "zombie-5h",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 0, reset_at: "2026-09-03T16:26:00Z" },
        "1week": { remaining_percent: 96, reset_at: "2026-09-07T05:26:08Z" },
      },
      reported_at: "2026-09-03T21:45:21Z",
    },
  ];
  const pool = [{ account_id: "zombie-5h" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_quota: {
      five_h_remaining_percent: 0,
      one_week_remaining_percent: 0,
    },
    now: "2026-09-03T21:50:00Z",
  });

  assert.equal(candidate?.entry?.account_id, "zombie-5h");
});

test("pickBestAuthPoolCandidate withholds a claude account whose 5h window expired unreplaced", () => {
  // Same expiry rule, claude semantics: a missing 5h window means the quota is unknown, and an
  // unknown claude account is not shareable — unlike codex, where missing means unconstrained.
  const reports = [
    {
      source: "claude",
      account_id: "claude-stale",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 95, reset_at: "2026-09-03T18:00:00Z" },
        "1week": { remaining_percent: 84, reset_at: "2026-09-07T05:26:08Z" },
      },
      reported_at: "2026-09-03T21:45:21Z",
    },
  ];
  const pool = [{ account_id: "claude-stale" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "claude",
    current_quota: {
      five_h_remaining_percent: 1,
      one_week_remaining_percent: 1,
    },
    now: "2026-09-03T21:50:00Z",
  });

  assert.equal(candidate, null);
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
        "5h": { remaining_percent: 95 },
        "1week": { remaining_percent: 45 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
  ];
  const pool = [{ account_id: "same-level" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 95,
      one_week_remaining_percent: 50,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate, null);
});

test("pickBestAuthPoolCandidate rejects near-exhausted candidates even when current quota is zero", () => {
  const reports = [
    {
      source: "codex",
      account_id: "near-empty",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 99 },
        "1week": { remaining_percent: 3 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
  ];
  const pool = [{ account_id: "near-empty" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 0,
      one_week_remaining_percent: 0,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate, null);
});

test("pickBestAuthPoolCandidate ignores better codex 5H when weekly quota is worse", () => {
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

  assert.equal(candidate, null);
});

test("pickBestAuthPoolCandidate withholds codex candidates below the 5H share threshold", () => {
  // Plus-tier Codex accounts still meter a 5h window; sharing one that is nearly drained just
  // burns the requester's fetch on an account about to trip its own rotation.
  const reports = [
    {
      source: "codex",
      account_id: "drained-5h",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 10 },
        "1week": { remaining_percent: 90 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
  ];
  const pool = [{ account_id: "drained-5h" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 0,
      one_week_remaining_percent: 0,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate, null);
});

test("pickBestAuthPoolCandidate treats a codex current without a 5H window as unconstrained", () => {
  const reports = [
    {
      source: "codex",
      account_id: "worse-weekly",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 95 },
        "1week": { remaining_percent: 45 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
  ];
  const pool = [{ account_id: "worse-weekly" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: -1,
      one_week_remaining_percent: 50,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate, null);
});

test("pickBestAuthPoolCandidate swaps in a lower-5H codex candidate when weekly quota is higher", () => {
  const reports = [
    {
      source: "codex",
      account_id: "bigger-product",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 24 },
        "1week": { remaining_percent: 90 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
  ];
  const pool = [{ account_id: "bigger-product" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 30,
      one_week_remaining_percent: 50,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate.entry.account_id, "bigger-product");
});

test("pickBestAuthPoolCandidate accepts codex weekly quota even when 5H is absent", () => {
  const reports = [
    {
      source: "codex",
      account_id: "weekly-only",
      status: "ok",
      error: null,
      windows: {
        "5h": null,
        "1week": { remaining_percent: 80 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
  ];
  const pool = [{ account_id: "weekly-only" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 90,
      one_week_remaining_percent: 10,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate.entry.account_id, "weekly-only");
});

test("pickBestAuthPoolCandidate still requires Claude 5H quota", () => {
  const reports = [
    {
      source: "claude",
      account_id: "claude-low-5h",
      status: "ok",
      error: null,
      windows: {
        "5h": { remaining_percent: 7 },
        "1week": { remaining_percent: 90 },
      },
      reported_at: "2026-04-22T08:02:00Z",
    },
  ];
  const pool = [{ account_id: "claude-low-5h" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "claude",
    current_account_id: "current",
    current_quota: {
      five_h_remaining_percent: 0,
      one_week_remaining_percent: 0,
    },
    now: "2026-04-22T08:30:00Z",
  });

  assert.equal(candidate, null);
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

test("pickBestAuthPoolCandidate readmits an account once its exhaustion deadline passes", () => {
  // Pins the deadline COMPARISON itself: same shape as the exclusion test below, but now is after
  // the deadline, the report is fresh, and the weekly window is healthy and unexpired — so the
  // only thing that could exclude this account is a broken isExhausted that ignores the clock.
  const reports = [
    {
      source: "codex",
      account_id: "recovered",
      status: "ok",
      error: null,
      exhausted_until: "2026-09-07T05:26:08Z",
      windows: {
        "5h": null,
        "1week": { remaining_percent: 96, reset_at: "2026-09-14T00:00:00Z" },
      },
      reported_at: "2026-09-07T05:30:00Z",
    },
  ];
  const pool = [{ account_id: "recovered" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_quota: { five_h_remaining_percent: 0, one_week_remaining_percent: 0 },
    now: "2026-09-07T06:00:00Z",
  });

  assert.equal(candidate?.entry?.account_id, "recovered");
});

test("pickBestAuthPoolCandidate excludes an exhausted account even when stale windows look healthy", () => {
  const reports = [
    {
      source: "codex",
      account_id: "drained-with-windows",
      status: "ok",
      error: null,
      exhausted_until: "2026-09-07T05:26:08Z",
      windows: {
        "5h": null,
        "1week": { remaining_percent: 96, reset_at: "2026-09-07T05:26:08Z" },
      },
      reported_at: "2026-09-03T21:45:21Z",
    },
  ];
  const pool = [{ account_id: "drained-with-windows" }];

  const candidate = pickBestAuthPoolCandidate(reports, pool, {
    source: "codex",
    current_quota: { five_h_remaining_percent: 0, one_week_remaining_percent: 0 },
    now: "2026-09-03T22:00:00Z",
  });

  assert.equal(candidate, null);
});

// Serving decisions read the access token, not the refresh token. An account the pool can no longer
// refresh is still worth lending while its access token lives; one whose access token has run out is
// not, however healthy its last probe looked.
test("pickBestAuthPoolCandidate lends a dead-refresh-token account while its access token lives, and skips an expired one", () => {
  const now = "2026-09-10T01:00:00Z";
  const reports = [
    {
      source: "claude",
      account_id: "rt-dead-at-live",
      status: "ok",
      error: null,
      windows: { "5h": { remaining_percent: 90, reset_at: "2026-09-10T03:00:00Z" }, "1week": { remaining_percent: 70, reset_at: "2026-09-14T00:00:00Z" } },
      usage_summary: { central_refresh: { attempted: true, ok: false, auth_rejected: true, status: 400 } },
      reported_at: "2026-09-10T00:58:00Z",
    },
    {
      source: "claude",
      account_id: "at-expired",
      status: "ok",
      error: null,
      windows: { "5h": { remaining_percent: 99, reset_at: "2026-09-10T03:00:00Z" }, "1week": { remaining_percent: 99, reset_at: "2026-09-14T00:00:00Z" } },
      reported_at: "2026-09-10T00:58:00Z",
    },
  ];
  const pool = [
    { account_id: "rt-dead-at-live", auth_expires_at: "2026-09-29T18:59:06.219Z" },
    { account_id: "at-expired", auth_expires_at: "2026-09-09T00:00:00Z" },
  ];

  const candidate = pickBestAuthPoolCandidate(reports, pool, { source: "claude", current_account_id: "current", now });
  assert.equal(candidate.report.account_id, "rt-dead-at-live", "the better-looking candidate is the one nobody can use any more");
});
