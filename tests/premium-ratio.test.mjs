import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  isPremiumModel,
  modelCost,
  modelPrice,
  pricedModelIds,
  PREMIUM_MODEL_IDS,
  SUGGESTED_STANDARD_MODEL_IDS,
} from "../lib/model-tiers.js";
import { PHASE_COOLDOWN_AT, PHASE_FAIR_SHARE_AT, PHASE_REPORTER_GATE_AT, PREMIUM_RATIO_COOLDOWN_MINUTES, PREMIUM_RATIO_MIN_COST, NOTICE_REPEAT_SECONDS, ADVISORY_NOTICE_REPEAT_SECONDS, compareVersions, evaluateFetchPolicy, MIN_REPORTER_CLIENT_VERSION } from "../lib/premium-ratio.js";
import { SCARCITY_BURN_WINDOW_DAYS } from "../lib/pool-scarcity.js";

const BIG = PREMIUM_RATIO_MIN_COST * 10;
// Every rule is live from here on: the cooldown and reporter gates are older than the cap.
const NOW = PHASE_FAIR_SHARE_AT;

function inputs(overrides = {}) {
  return {
    now: new Date(NOW),
    lastReportAt: NOW,
    requestClientVersion: MIN_REPORTER_CLIENT_VERSION,
    premiumCost: BIG * 0.9,
    totalCost: BIG,
    // Ten times over a cap the short pool can cover for everyone.
    fairShareSpendUsd: BIG,
    fairShareCapUsd: BIG * 0.1,
    cooldownStartedAt: null,
    poolScarce: true,
    ...overrides,
  };
}

// Comfortably inside the cap, so only the rules other than the cap can say anything.
const light = { premiumCost: 0, totalCost: BIG * 0.01, fairShareSpendUsd: BIG * 0.01 };

function at(iso, minutesAfter) {
  return new Date(Date.parse(iso) + minutesAfter * 60 * 1000).toISOString();
}

test("premium is a blacklist, because it only ever drives a hint", () => {
  for (const modelId of PREMIUM_MODEL_IDS) assert.equal(isPremiumModel(modelId), true, modelId);
  assert.equal(isPremiumModel("gpt-5.6-terra"), false);
  assert.equal(isPremiumModel("GPT-5.6-SOL"), true, "case must not matter");
  assert.equal(isPremiumModel("  claude-opus-5  "), true, "whitespace must not matter");
  // Every flagship-tier model on the rate card earns the hint, not only the ones that existed when
  // the list was first written.
  for (const modelId of ["gpt-6-astra", "claude-opus-5-5", "claude-fable-5-1", "claude-opus-4-8"]) {
    assert.equal(isPremiumModel(modelId), true, modelId);
  }
  // A model nobody has classified misses a hint, not a refusal -- cost decides who is held back.
  assert.equal(isPremiumModel("gpt-7-whatever-ships-next"), false);
});

test("models the pool does not pay for cost nothing, and unpriced pooled models cost the most", () => {
  const counters = { input_tokens: 1e6, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 };
  // Somebody's own API key or a self-hosted box drains no pooled account, so it adds no demand.
  for (const offPool of ["deepseek-v4-pro", "qwen3.8-27b", "llama-4"]) {
    assert.equal(modelPrice(offPool), null, offPool);
    assert.equal(modelCost(offPool, counters), 0, offPool);
  }
  // But a new model in a live pooled family must not read as free just because nobody priced it.
  const unpriced = modelCost("gpt-5.9-nova", counters);
  const dearest = Math.max(...pricedModelIds().filter((id) => id.startsWith("gpt-")).map((id) => modelCost(id, counters)));
  assert.equal(unpriced, dearest, "an unrecognised pooled model is charged its family's top rate");
});

test("every pooled model seen in production is priced at its own rate card, not a family fallback", () => {
  // Each of these reported real usage in the 30 days to 2026-09-24. Before they were priced they
  // fell through to the family fallback: Opus 5.5 read at Fable rates (2.5x its real price) and
  // GPT-6 Sol at GPT-5.6 Sol's (2.5x input, 3x output), so the spend column overstated exactly the
  // cheaper models people had moved to.
  const perMillion = (modelId) => ({
    input: modelCost(modelId, { input_tokens: 1e6, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 }),
    cache_read: modelCost(modelId, { input_tokens: 1e6, cache_read_tokens: 1e6, cache_write_tokens: 0, output_tokens: 0 }),
    cache_write: modelCost(modelId, { input_tokens: 1e6, cache_read_tokens: 0, cache_write_tokens: 1e6, output_tokens: 0 }),
    output: modelCost(modelId, { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 1e6 }),
  });
  const expected = {
    // The rate OpenAI charges today, promotion included (Derek, 2026-09-24): the spend column
    // should read what the pool is burning now, not what it will burn after November.
    "gpt-5.6-sol": { input: 4, cache_read: 0.4, cache_write: 5, output: 20 },
    "gpt-6-astra": { input: 10, cache_read: 1, cache_write: 12.5, output: 50 },
    "gpt-6-sol": { input: 2, cache_read: 0.2, cache_write: 2.5, output: 10 },
    "gpt-6-luna": { input: 0.1, cache_read: 0.01, cache_write: 0.125, output: 0.5 },
    "claude-opus-5-5": { input: 4, cache_read: 0.2, cache_write: 5, output: 20 },
    "claude-fable-5-1": { input: 10, cache_read: 0.25, cache_write: 12.5, output: 50 },
    "claude-opus-4-8": { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 },
    "claude-haiku-4-5-20251001": { input: 1, cache_read: 0.1, cache_write: 1.25, output: 5 },
  };
  for (const [modelId, rates] of Object.entries(expected)) {
    const actual = perMillion(modelId);
    for (const field of Object.keys(rates)) {
      assert.ok(Math.abs(actual[field] - rates[field]) < 1e-9, `${modelId} ${field} was ${actual[field]}, expected ${rates[field]}`);
    }
  }
});

test("cache reads and writes are subsets of input, priced once at their own rate", () => {
  // A Claude turn as the hub stores it: 1M input tokens, of which 900K replayed from cache and 50K
  // written to it, leaving 50K fresh. Charging the cache write as fresh input too would bill those
  // 50K twice; charging nothing for the fresh 50K would make uncached Claude input free.
  const cost = modelCost("claude-opus-5", {
    input_tokens: 1_000_000, cache_read_tokens: 900_000, cache_write_tokens: 50_000, output_tokens: 0,
  });
  const expected = (50_000 * 5.00 + 900_000 * 0.50 + 50_000 * 6.25) / 1e6;
  assert.ok(Math.abs(cost - expected) < 1e-9, `cost was ${cost}, expected ${expected}`);
});

test("output is priced far above input, as every rate card has it", () => {
  const million = (field) => ({
    input_tokens: field === "input" ? 1e6 : 0,
    output_tokens: field === "output" ? 1e6 : 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "claude-opus-5", "claude-sonnet-5"]) {
    const ratio = modelCost(modelId, million("output")) / modelCost(modelId, million("input"));
    assert.ok(ratio >= 5, `${modelId} output/input was ${ratio}, expected >= 5`);
  }
});

test("the notices recommend GPT-6 Luna", () => {
  assert.ok(SUGGESTED_STANDARD_MODEL_IDS.includes("gpt-6-luna"));
  assert.ok(!SUGGESTED_STANDARD_MODEL_IDS.includes("gpt-5.6-terra"), "Luna replaces Terra as the Codex suggestion");
});

test("the models the notices recommend are cheaper than every premium model", () => {
  const counters = { input_tokens: 1e6, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 1e5 };
  const dearestSuggested = Math.max(...SUGGESTED_STANDARD_MODEL_IDS.map((id) => modelCost(id, counters)));
  const cheapestPremium = Math.min(...PREMIUM_MODEL_IDS.map((id) => modelCost(id, counters)));
  assert.ok(dearestSuggested < cheapestPremium, "advice that costs as much as the problem is not advice");
});

test("replayed context is discounted to a tenth, as the rate cards price it", () => {
  // Cached input is a tenth of fresh input on every vendor's card. That discount is what keeps a
  // long conversation from being punished for replaying its own context on every turn.
  for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "claude-opus-5"]) {
    const fresh = modelCost(modelId, { input_tokens: 1e6, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 });
    const replayed = modelCost(modelId, { input_tokens: 1e6, cache_read_tokens: 1e6, cache_write_tokens: 0, output_tokens: 0 });
    assert.ok(Math.abs(replayed / fresh - 0.1) < 1e-9, `${modelId} replay discount was ${replayed / fresh}`);
  }
});

test("phase 1 warns about a high premium share but refuses nothing", () => {
  const result = evaluateFetchPolicy(inputs({
    now: new Date("2026-08-25T00:00:00.000Z"),
    lastReportAt: "2026-08-25T00:00:00.000Z",
    cooldownStartedAt: "2026-08-25T00:00:00.000Z",
  }));
  assert.equal(result.allowed, true);
  assert.equal(result.notices[0].code, "premium_ratio_warning");
});

test("phase 1 warns an unreported client but still serves it", () => {
  const result = evaluateFetchPolicy(inputs({
    now: new Date("2026-08-25T00:00:00.000Z"),
    lastReportAt: null,
    requestClientVersion: null,
  }));
  assert.equal(result.allowed, true);
  assert.ok(result.notices.some((notice) => notice.code === "reporter_upgrade_required"));
});

test("phase 2 refuses an outdated client and names the upgrade as the fix", () => {
  const result = evaluateFetchPolicy(inputs({
    now: new Date(PHASE_REPORTER_GATE_AT),
    requestClientVersion: "1.9.9",
  }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "reporter_upgrade_required");
  assert.equal(result.notices[0].code, "reporter_upgrade_required");
});

test("a current client that has simply been idle is left alone entirely", () => {
  // Silence is not a signal: the collector only posts when there IS usage, so "has not reported" is
  // indistinguishable from "took the day off". Only an unpaid debt -- given an account, accounted
  // for nothing -- says anything, and an idle user has none. Nagging on silence would mean nagging
  // everybody on leave every six hours.
  const result = evaluateFetchPolicy(inputs({
    lastReportAt: null,
    lastNewAccountAt: null,
    premiumCost: 0,
    totalCost: 0,
    fairShareSpendUsd: 0,
  }));
  assert.equal(result.allowed, true);
  assert.deepEqual(result.notices, []);
});

test("a fresh install is served before it has any usage to report", () => {
  const result = evaluateFetchPolicy({
    now: new Date(NOW),
    requestClientVersion: MIN_REPORTER_CLIENT_VERSION,
    lastReportAt: null,
    premiumCost: 0,
    totalCost: 0,
    cooldownStartedAt: null,
  });
  assert.equal(result.allowed, true);
});

test("before its phase the fair-share cap warns and refuses nothing", () => {
  const result = evaluateFetchPolicy(inputs({ now: new Date(at(NOW, -1)), lastReportAt: at(NOW, -1) }));
  assert.equal(result.allowed, true);
  assert.deepEqual(result.notices.map((notice) => notice.code), ["premium_ratio_warning", "fair_share_warning"]);
  const warning = result.notices.at(-1);
  assert.match(warning.message, new RegExp(PHASE_FAIR_SHARE_AT.slice(0, 10)), "names when it starts biting");
  assert.doesNotMatch(warning.title, /暂停/, "a served request must not claim it was refused");
});

test("over the fair-share cap while the pool is short, the pool stops handing out capacity", () => {
  const result = evaluateFetchPolicy(inputs());
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "fair_share_cap");
  // Not a wait: it lasts exactly as long as the user is over the cap, which every request recomputes.
  assert.equal(result.retry_after_seconds, null);
  assert.equal(result.fair_share_cap_usd, BIG * 0.1);
  const notice = result.notices.at(-1);
  assert.equal(notice.code, "fair_share_cap");
  assert.equal(notice.title, "取号已暂停");
  assert.equal(notice.repeat_seconds, NOTICE_REPEAT_SECONDS, "a live hold is worth repeating within the day");
});

test("a past cooldown cycle does not let an over-cap user through", () => {
  // The 30-minute cycle belongs to the contribution rule. Under the P80 rule it let the heaviest
  // user draw once every half hour indefinitely; the cap must not inherit that leak.
  for (const cooldownStartedAt of [null, at(NOW, -10), at(NOW, -(PREMIUM_RATIO_COOLDOWN_MINUTES + 1)), at(NOW, -24 * 60)]) {
    assert.equal(evaluateFetchPolicy(inputs({ cooldownStartedAt })).reason, "fair_share_cap", String(cooldownStartedAt));
  }
});

test("at or under the cap nobody is held, however scarce the pool", () => {
  // Expensive taste is not the offence, overdrawing a short pool is: this user spends every cent on
  // premium models and gets the advisory hint and nothing else.
  for (const fairShareSpendUsd of [BIG * 0.05, BIG * 0.1]) {
    const result = evaluateFetchPolicy(inputs({ fairShareSpendUsd }));
    assert.equal(result.allowed, true, `spend ${fairShareSpendUsd}`);
    assert.deepEqual(result.notices.map((notice) => notice.code), ["premium_ratio_warning"]);
  }
});

test("without a cap nobody is held or warned, however much they spend", () => {
  // A cap exists only while supply cannot cover demand. A heavy user during abundance is just
  // somebody getting their job done.
  for (const poolScarce of [true, false]) {
    const result = evaluateFetchPolicy(inputs({ fairShareSpendUsd: BIG * 1000, fairShareCapUsd: null, poolScarce }));
    assert.equal(result.allowed, true);
    assert.ok(!result.notices.some((notice) => notice.code.startsWith("fair_share")), `poolScarce=${poolScarce}`);
  }
});

test("a forced fetch does not lift the cap, only the contribution wait", () => {
  // The desktop shortcut skips a wait. The cap is not one, and a flag any client can send would
  // otherwise make it optional for exactly the people it exists for.
  const forced = evaluateFetchPolicy(inputs({ forced: true }));
  assert.equal(forced.reason, "fair_share_cap");

  const forcedNonContributor = evaluateFetchPolicy(inputs({ ...light, hasHealthyUpload: false, forced: true }));
  assert.equal(forcedNonContributor.allowed, true);

  // The measurement preconditions are not rationing and stay in force.
  const outdated = evaluateFetchPolicy(inputs({ forced: true, requestClientVersion: "1.0.0" }));
  assert.equal(outdated.reason, "reporter_upgrade_required");
  // And the admin's hard mode is an access decision, not a wait.
  const required = evaluateFetchPolicy(inputs({ ...light, hasHealthyUpload: false, requireContribution: true, forced: true }));
  assert.equal(required.reason, "contribution_required");
});

test("the kill switch stops the refusal but keeps telling the user where they stand", () => {
  const result = evaluateFetchPolicy(inputs({ enforcementEnabled: false }));
  assert.equal(result.allowed, true);
  assert.equal(result.notices.at(-1).code, "fair_share_warning");
});

test("the fair-share notice states dollars, the cap, and which pool", () => {
  const result = evaluateFetchPolicy(inputs({ source: "claude", fairShareSpendUsd: 4383.4, fairShareCapUsd: 4258.9 }));
  const notice = result.notices.find((item) => item.code === "fair_share_cap");
  assert.match(notice.message, /Claude/);
  assert.match(notice.message, /最多用 \$4258/, "the cap is rounded down, never promised higher than it is");
  assert.match(notice.message, /你用了 \$4383/);
  assert.match(notice.message, new RegExp(`近 ${SCARCITY_BURN_WINDOW_DAYS} 天`));
  // Own uploads count toward the cap, so the notice has to say so or the number looks wrong.
  assert.match(notice.message, /自己上传的账号/);
  assert.match(notice.message, /照常续期/, "own renewals are exempt and the user must know it");
  for (const suggestion of SUGGESTED_STANDARD_MODEL_IDS) {
    assert.ok(notice.message.includes(suggestion), `does not offer ${suggestion}`);
  }
});

test("a user below the spend floor is not judged on a noisy share", () => {
  const result = evaluateFetchPolicy(inputs({
    ...light,
    premiumCost: PREMIUM_RATIO_MIN_COST * 0.99,
    totalCost: PREMIUM_RATIO_MIN_COST * 0.99,
  }));
  assert.equal(result.allowed, true);
  assert.equal(result.premium_share, null, "a few cents of usage says nothing about habits");
  assert.deepEqual(result.notices, []);
});

test("the reporter gate outranks the cap so the fix is always the same one", () => {
  const result = evaluateFetchPolicy(inputs({ requestClientVersion: "1.9.9" }));
  assert.equal(result.reason, "reporter_upgrade_required");
});

test("version comparison orders by numeric component, not string", () => {
  assert.equal(compareVersions("2.10.0", "2.9.0"), 1);
  assert.equal(compareVersions(MIN_REPORTER_CLIENT_VERSION, MIN_REPORTER_CLIENT_VERSION), 0);
  assert.equal(compareVersions("1.9.9", MIN_REPORTER_CLIENT_VERSION), -1);
});

test("the models the notice recommends are themselves non-premium", () => {
  // Copy that tells a user to switch to a model which also counts against them is worse than no
  // advice: they follow it, nothing improves, and they stop trusting the notice.
  for (const modelId of SUGGESTED_STANDARD_MODEL_IDS) {
    assert.equal(isPremiumModel(modelId), false, `${modelId} is recommended but counts as premium`);
  }
});

test("the ratio notice names the models on each side of the line", () => {
  const result = evaluateFetchPolicy(inputs({ premiumCost: BIG * 0.9, totalCost: BIG }));
  const notice = result.notices.find((item) => item.code === "premium_ratio_warning");
  assert.ok(notice);
  // A rule whose subject the reader has to guess at cannot be complied with.
  assert.match(notice.message, /gpt-5\.6-sol/);
  for (const suggestion of SUGGESTED_STANDARD_MODEL_IDS) {
    assert.ok(notice.message.includes(suggestion), `does not offer ${suggestion}`);
  }
  assert.match(notice.message, /90%/, "does not state the user's own share");
  assert.match(notice.message, /50%/, "does not state the target");
});

test("unreported consumption is measured as a debt from the last new account, not report recency", () => {
  const base = {
    now: new Date(PHASE_REPORTER_GATE_AT),
    requestClientVersion: MIN_REPORTER_CLIENT_VERSION,
    premiumCost: 0,
    totalCost: 0,
    cooldownStartedAt: null,
  };
  const hoursBefore = (count) =>
    new Date(Date.parse(PHASE_REPORTER_GATE_AT) - count * 60 * 60 * 1000).toISOString();

  // Took a new account and never accounted for any of it.
  const delinquent = evaluateFetchPolicy({ ...base, lastNewAccountAt: hoursBefore(30), lastReportAt: null });
  assert.equal(delinquent.allowed, false);
  assert.equal(delinquent.reason, "usage_reporting_required");

  // On leave: the last serve is exactly as old as the last report, so no debt accrued while away.
  const onLeave = evaluateFetchPolicy({
    ...base,
    lastNewAccountAt: hoursBefore(24 * 9),
    lastReportAt: hoursBefore(24 * 9 - 1),
  });
  assert.equal(onLeave.allowed, true, "an idle user accrues no debt");

  // Reported within the grace window after being served.
  const current = evaluateFetchPolicy({ ...base, lastNewAccountAt: hoursBefore(30), lastReportAt: hoursBefore(20) });
  assert.equal(current.allowed, true);

  // Never handed a new account at all -- a fresh install has nothing to account for.
  const fresh = evaluateFetchPolicy({ ...base, lastNewAccountAt: null, lastReportAt: null });
  assert.equal(fresh.allowed, true);
});

test("a refresh never starts the debt clock, only a new account does", async () => {
  // An idle user's guard keeps refreshing to hold the token alive. Charging those would run the debt
  // up on somebody who is not working, and they cannot repay it without working.
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");
  assert.match(source, /const NEW_ACCOUNT_REASON = "served"/);
  assert.match(source, /String\(reason\) === NEW_ACCOUNT_REASON \? fetchedAt : null/);
});

test("a warning repeats daily, a hold repeats within the day", () => {
  // Regression for 2026-09-09: advisories re-toasted every six hours on a machine whose seven-day
  // share had not moved -- eight toasts a day saying the same percentage. A notice that refuses
  // nothing repeats daily; one that is holding the user back right now repeats sooner.
  assert.ok(ADVISORY_NOTICE_REPEAT_SECONDS >= 24 * 60 * 60, "an advisory repeats at most once a day");
  assert.ok(NOTICE_REPEAT_SECONDS < ADVISORY_NOTICE_REPEAT_SECONDS, "a hold repeats more often than an advisory");

  const warned = evaluateFetchPolicy(inputs({ enforcementEnabled: false }));
  assert.deepEqual(warned.notices.map((notice) => notice.code), ["premium_ratio_warning", "fair_share_warning"]);
  for (const notice of warned.notices) {
    assert.equal(notice.repeat_seconds, ADVISORY_NOTICE_REPEAT_SECONDS, `${notice.code} nags within the day`);
  }

  const held = evaluateFetchPolicy(inputs());
  assert.equal(held.reason, "fair_share_cap");
  assert.equal(held.notices.at(-1).repeat_seconds, NOTICE_REPEAT_SECONDS);
});

test("the hub sets the repeat interval rather than the client compiling one in", () => {
  const result = evaluateFetchPolicy({
    now: new Date("2026-08-25T00:00:00.000Z"),
    requestClientVersion: MIN_REPORTER_CLIENT_VERSION,
    lastNewAccountAt: "2026-08-20T00:00:00.000Z",
    lastReportAt: null,
    premiumCost: BIG * 0.9,
    totalCost: BIG,
    cooldownStartedAt: null,
  });
  assert.equal(result.allowed, true, "before the gate date this only warns");
  const reminder = result.notices.find((notice) => notice.code === "usage_reporting_required");
  assert.ok(reminder, "a user in reporting debt gets the reminder");
  assert.equal(reminder.repeat_seconds, NOTICE_REPEAT_SECONDS);
  for (const notice of result.notices) {
    assert.ok(Number.isFinite(notice.repeat_seconds), `${notice.code} carries no repeat interval`);
  }
});

test("debt stops growing the moment a user goes dormant", () => {
  // The debt is the gap between being handed an account and accounting for it -- a fixed distance,
  // not a running clock. This is the whole reason dormancy is harmless: an idle month adds nothing.
  const base = {
    requestClientVersion: MIN_REPORTER_CLIENT_VERSION,
    premiumCost: 0,
    totalCost: 0,
    cooldownStartedAt: null,
    lastReportAt: "2026-06-01T00:00:00.000Z",
    lastNewAccountAt: "2026-06-01T01:00:00.000Z",   // reported, then served an hour later
  };
  for (const now of ["2026-06-02T00:00:00.000Z", "2026-07-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"]) {
    const result = evaluateFetchPolicy({ ...base, now: new Date(now) });
    assert.equal(result.allowed, true, `dormant until ${now} must stay allowed`);
    assert.deepEqual(result.notices, [], `dormant until ${now} must not even be nagged`);
  }
});

test("a single report clears the debt on the very next fetch", () => {
  const servedAt = "2026-09-08T00:00:00.000Z";
  const now = new Date("2026-09-10T00:00:00.000Z");
  const base = {
    now,
    requestClientVersion: MIN_REPORTER_CLIENT_VERSION,
    premiumCost: 0,
    totalCost: 0,
    cooldownStartedAt: null,
    lastNewAccountAt: servedAt,
  };

  const before = evaluateFetchPolicy({ ...base, lastReportAt: null });
  assert.equal(before.allowed, false);
  assert.equal(before.reason, "usage_reporting_required");

  // The guard backfills local session logs on its first run, so this report needs no working auth.
  const after = evaluateFetchPolicy({ ...base, lastReportAt: "2026-09-09T23:00:00.000Z" });
  assert.equal(after.allowed, true, "reporting once must lift the refusal immediately");
  assert.deepEqual(after.notices, [], "and stop the nagging with it");
});

test("scarcity never excuses an unmetered client", () => {
  // The reporting gate is a measurement precondition, not a rationing rule. Gating it on scarcity
  // would mean nobody fixes their reporter during abundance, so when the pool does tighten those
  // users still have no measurable spend and the cap cannot reach them.
  const base = {
    now: new Date(NOW),
    premiumCost: 0,
    totalCost: 0,
    cooldownStartedAt: null,
    lastNewAccountAt: "2026-09-01T00:00:00.000Z",
    lastReportAt: null,
  };
  for (const poolScarce of [true, false]) {
    const result = evaluateFetchPolicy({ ...base, requestClientVersion: MIN_REPORTER_CLIENT_VERSION, poolScarce });
    assert.equal(result.reason, "usage_reporting_required", `poolScarce=${poolScarce}`);
  }
  for (const poolScarce of [true, false]) {
    const result = evaluateFetchPolicy({ ...base, requestClientVersion: "1.0.0", poolScarce, lastNewAccountAt: null });
    assert.equal(result.reason, "reporter_upgrade_required", `poolScarce=${poolScarce}`);
  }
});

test("the contribution cooldown releases itself, and says so", () => {
  const startedAt = NOW;
  const after = (minutes) => evaluateFetchPolicy(inputs({
    ...light,
    hasHealthyUpload: false,
    now: new Date(Date.parse(startedAt) + minutes * 60 * 1000),
    cooldownStartedAt: startedAt,
  }));

  // A rate limit, not a ban: the wait counts down and clears on its own.
  assert.equal(after(1).allowed, false);
  assert.equal(after(PREMIUM_RATIO_COOLDOWN_MINUTES - 1).allowed, false);
  assert.ok(after(1).retry_after_seconds > after(PREMIUM_RATIO_COOLDOWN_MINUTES - 1).retry_after_seconds);
  assert.equal(after(PREMIUM_RATIO_COOLDOWN_MINUTES).allowed, true, "the hold must lift on its own");
  assert.ok(
    !after(PREMIUM_RATIO_COOLDOWN_MINUTES).notices.some((notice) => notice.code === "contribution_cooldown"),
    "the blocking notice is only truthful on a fetch that was actually refused",
  );

  // And the person reading the toast has to be able to tell that without asking anyone.
  const message = after(1).notices.find((notice) => notice.code === "contribution_cooldown").message;
  assert.match(message, new RegExp(`${PREMIUM_RATIO_COOLDOWN_MINUTES} 分钟`), "names the bound on the wait");
  assert.match(message, /自动恢复/, "says the hold lifts by itself");
  assert.match(message, /不是封禁/, "distinguishes a rate limit from a ban");
  // The client re-shows a cached notice for hours, so a live countdown in the text would be stale
  // by the time most people read it. The exact wait travels in retry_after_seconds instead.
  assert.doesNotMatch(message, /还需|剩余/, "no countdown baked into cached text");
});

test("only a capped pool is described as short", () => {
  const notice = (fairShareCapUsd) => evaluateFetchPolicy(inputs({ fairShareCapUsd }))
    .notices.find((item) => item.code.startsWith("fair_share"));
  assert.match(notice(BIG * 0.1).message, /供不应求/);
  assert.equal(notice(null), undefined, "a healthy pool must not emit a fair-share notice");
});

test("a non-contributor is warned before the phase, and never refused during abundance", () => {
  // Inside their fair share, so only the supply rule can have anything to say about them.
  const beforePhase = evaluateFetchPolicy(inputs({
    ...light,
    hasHealthyUpload: false,
    now: new Date(PHASE_REPORTER_GATE_AT),
    lastReportAt: PHASE_REPORTER_GATE_AT,
    cooldownStartedAt: PHASE_REPORTER_GATE_AT,
  }));
  assert.equal(beforePhase.allowed, true);
  assert.deepEqual(beforePhase.notices.map((notice) => notice.code), ["contribution_warning"]);

  // Phase reached, but there is nothing to ration: throttling here would free capacity for nobody.
  const healthyPool = evaluateFetchPolicy(inputs({
    ...light,
    hasHealthyUpload: false,
    poolScarce: false,
    fairShareCapUsd: null,
    cooldownStartedAt: NOW,
  }));
  assert.equal(healthyPool.allowed, true);
  assert.deepEqual(healthyPool.notices.map((notice) => notice.code), ["contribution_warning"]);
});

test("a scarce pool rate-limits whoever draws on it without supplying it", () => {
  const held = evaluateFetchPolicy(inputs({
    ...light,
    hasHealthyUpload: false,
    cooldownStartedAt: at(NOW, -10),
  }));
  assert.equal(held.allowed, false);
  assert.equal(held.reason, "contribution_cooldown");
  assert.equal(held.retry_after_seconds, (PREMIUM_RATIO_COOLDOWN_MINUTES - 10) * 60);
  assert.equal(held.notices.at(-1).code, "contribution_cooldown");

  // A rate limit, not a lockout: the wait elapses and they are served like anyone else.
  const elapsed = evaluateFetchPolicy(inputs({
    ...light,
    hasHealthyUpload: false,
    cooldownStartedAt: at(NOW, -(PREMIUM_RATIO_COOLDOWN_MINUTES + 1)),
  }));
  assert.equal(elapsed.allowed, true);

  // Entering the rationed lane starts with a full wait, regardless of prior pool history.
  const firstFetch = evaluateFetchPolicy(inputs({ ...light, hasHealthyUpload: false, cooldownStartedAt: null }));
  assert.equal(firstFetch.allowed, false);
  assert.equal(firstFetch.retry_after_seconds, PREMIUM_RATIO_COOLDOWN_MINUTES * 60);
  assert.ok(firstFetch.notices.some((notice) => notice.code === "contribution_cooldown"));
});

test("supplying the pool earns no exemption from the cap", () => {
  const result = evaluateFetchPolicy(inputs({ hasHealthyUpload: true }));
  // Over the cap still holds them -- by the cap, with no word about contribution.
  assert.equal(result.reason, "fair_share_cap");
  assert.ok(!result.notices.some((notice) => notice.code.startsWith("contribution")));
});

test("an over-cap non-contributor is told about the spend, and only that", () => {
  // Both rules would fire. The spend is the one costing the pool today, and two toasts naming two
  // different remedies for one held fetch is how a warning gets dismissed unread.
  const result = evaluateFetchPolicy(inputs({ hasHealthyUpload: false, cooldownStartedAt: at(NOW, -10) }));
  assert.equal(result.reason, "fair_share_cap");
  assert.deepEqual(result.notices.map((notice) => notice.code), ["premium_ratio_warning", "fair_share_cap"]);
});

test("the contribution notice says what counts as supplying the pool", () => {
  const warning = evaluateFetchPolicy(inputs({
    ...light, hasHealthyUpload: false, poolScarce: false, fairShareCapUsd: null, cooldownStartedAt: NOW,
  })).notices[0];
  const cooldown = evaluateFetchPolicy(inputs({
    ...light, hasHealthyUpload: false, cooldownStartedAt: at(NOW, -1),
  })).notices.at(-1);
  // Both must name the one action that lifts this, or the rule cannot be complied with.
  for (const [label, notice] of [["warning", warning], ["cooldown", cooldown]]) {
    assert.match(notice.message, /Codex/, `${label} does not say what to contribute`);
  }
  // The hold is worth repeating within the day; the warning refuses nothing and repeats daily.
  assert.equal(cooldown.repeat_seconds, NOTICE_REPEAT_SECONDS);
  assert.equal(warning.repeat_seconds, ADVISORY_NOTICE_REPEAT_SECONDS);
  // The cooldown copy must not read as a ban: they keep working on the account in hand.
  assert.match(cooldown.message, new RegExp(`${PREMIUM_RATIO_COOLDOWN_MINUTES} 分钟`));
  assert.match(warning.message, new RegExp(PHASE_COOLDOWN_AT.slice(0, 10)));
});

test("require_contribution refuses a non-contributor outright, abundance or not", () => {
  // Abundant pool, never served before — every softer rule would have let this caller through.
  const abundant = { ...light, poolScarce: false, fairShareCapUsd: null, cooldownStartedAt: null };
  const refused = evaluateFetchPolicy(inputs({ ...abundant, hasHealthyUpload: false, requireContribution: true }));
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "contribution_required");
  assert.equal(refused.retry_after_seconds, null);
  const notice = refused.notices.at(-1);
  assert.equal(notice.code, "contribution_required");
  // Must name the one action that lifts it, and not nag on every 15-minute run.
  assert.match(notice.message, /Codex/);
  assert.equal(notice.repeat_seconds, NOTICE_REPEAT_SECONDS);

  // A contributor is untouched by the flag.
  assert.equal(evaluateFetchPolicy(inputs({ ...abundant, hasHealthyUpload: true, requireContribution: true })).allowed, true);

  // Flag off restores the scarcity-only cooldown behavior.
  assert.equal(evaluateFetchPolicy(inputs({
    ...abundant, hasHealthyUpload: false, requireContribution: false, cooldownStartedAt: NOW,
  })).allowed, true);
});

test("the shipped client version is never behind the hub floor", async () => {
  // One direction only. Raising the floor above the shipped client locks the fleet out, so that is
  // asserted against here. The reverse is not a defect but the required order: a client-visible
  // change ships first and the fleet self-updates within a run, and only then may the floor follow
  // (AGENTS.md phasing). Demanding exact equality made the two moves inseparable, which meant every
  // client fix hot-enforced itself against machines that had not updated yet -- and it contradicted
  // tests/test_hub_notices.py, which asserts the >= relation from the Python side.
  const source = await readFile(
    new URL("../skills/quota-reporter/scripts/reporter_version.py", import.meta.url),
    "utf8",
  );
  const shipped = source.match(/^CLIENT_VERSION = "([^"]+)"$/m)?.[1];
  assert.notEqual(shipped, undefined);
  assert.ok(
    compareVersions(shipped, MIN_REPORTER_CLIENT_VERSION) >= 0,
    `shipped client ${shipped} is behind the hub floor ${MIN_REPORTER_CLIENT_VERSION}`,
  );
});

test("a client newer than the hub is not refused", () => {
  // Both halves of a release land in the same commit but reach production seconds apart. A gate
  // that demanded an exact match would take the fleet down over a race with itself.
  const [major, minor, patch] = MIN_REPORTER_CLIENT_VERSION.split(".").map(Number);
  assert.equal(compareVersions(`${major}.${minor + 1}.${patch}`, MIN_REPORTER_CLIENT_VERSION), 1);
  assert.equal(evaluateFetchPolicy({
    now: new Date(PHASE_REPORTER_GATE_AT),
    requestClientVersion: `${major}.${minor + 1}.0`,
    lastReportAt: PHASE_REPORTER_GATE_AT,
    lastNewAccountAt: PHASE_REPORTER_GATE_AT,
  }).reason !== "reporter_upgrade_required", true);
});
