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
import {
  PHASE_COOLDOWN_AT,
  PHASE_REPORTER_GATE_AT,
  PREMIUM_RATIO_COOLDOWN_MINUTES,
  PREMIUM_RATIO_MIN_COST,
  DEMAND_SHARE_TOLERANCE,
  DEMAND_SHARE_MIN_ACTIVE_USERS,
  NOTICE_REPEAT_SECONDS,
  PREMIUM_RATIO_THRESHOLD,
  compareVersions,
  evaluateFetchPolicy,
} from "../lib/premium-ratio.js";

const BIG = PREMIUM_RATIO_MIN_COST * 10;

function inputs(overrides = {}) {
  return {
    now: new Date(PHASE_COOLDOWN_AT),
    lastReportAt: PHASE_COOLDOWN_AT,
    requestClientVersion: "2.0.0",
    premiumCost: BIG * 0.9,
    totalCost: BIG,
    // One user carrying the whole team's spend: far over any fair share.
    teamCost: BIG,
    activeUsers: 10,
    lastServedAt: null,
    // Most of these exercise the cooldown, which only bites while the pool is actually scarce.
    poolScarce: true,
    ...overrides,
  };
}

function at(iso, minutesAfter) {
  return new Date(Date.parse(iso) + minutesAfter * 60 * 1000).toISOString();
}

test("premium is a blacklist, because it only ever drives a hint", () => {
  for (const modelId of PREMIUM_MODEL_IDS) assert.equal(isPremiumModel(modelId), true, modelId);
  assert.equal(isPremiumModel("gpt-5.6-terra"), false);
  assert.equal(isPremiumModel("GPT-5.6-SOL"), true, "case must not matter");
  assert.equal(isPremiumModel("  claude-opus-5  "), true, "whitespace must not matter");
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
    lastServedAt: "2026-08-25T00:00:00.000Z",
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
    teamCost: 0,
    activeUsers: 0,
  }));
  assert.equal(result.allowed, true);
  assert.deepEqual(result.notices, []);
});

test("a fresh install is served before it has any usage to report", () => {
  const result = evaluateFetchPolicy({
    now: new Date(PHASE_COOLDOWN_AT),
    requestClientVersion: "2.0.0",
    lastReportAt: null,
    premiumCost: 0,
    totalCost: 0,
    lastServedAt: null,
  });
  assert.equal(result.allowed, true);
});

test("phase 2 does not yet cool down an over-share user whose meter is on", () => {
  const now = new Date(PHASE_REPORTER_GATE_AT);
  const result = evaluateFetchPolicy(inputs({
    now,
    lastReportAt: PHASE_REPORTER_GATE_AT,
    lastServedAt: PHASE_REPORTER_GATE_AT,
  }));
  assert.equal(result.allowed, true);
  assert.equal(result.notices[0].code, "premium_ratio_warning");
});

test("phase 3 cools down a user driving a shortage, and reports the exact wait", () => {
  const result = evaluateFetchPolicy(inputs({
    lastServedAt: at(PHASE_COOLDOWN_AT, -10),
  }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "demand_share_cooldown");
  assert.equal(result.retry_after_seconds, (PREMIUM_RATIO_COOLDOWN_MINUTES - 10) * 60);
});

test("phase 3 serves again once the cooldown has elapsed", () => {
  const result = evaluateFetchPolicy(inputs({
    lastServedAt: at(PHASE_COOLDOWN_AT, -(PREMIUM_RATIO_COOLDOWN_MINUTES + 1)),
  }));
  assert.equal(result.allowed, true);
});

test("a user inside their fair share is never cooled down, however scarce the pool", () => {
  // Ten active users, so the line is the 10% average. This user is at 8% and
  // spends every cent of it on premium models -- expensive taste is not the offence, driving the
  // shortage is. They get the advisory hint and nothing else.
  const result = evaluateFetchPolicy(inputs({
    // Well clear of the spend floor, so the advisory notice is genuinely exercised.
    premiumCost: BIG * 0.08 * 100,
    totalCost: BIG * 0.08 * 100,
    teamCost: BIG * 100,
    activeUsers: 10,
    lastServedAt: PHASE_COOLDOWN_AT,
  }));
  assert.equal(result.allowed, true);
  assert.deepEqual(result.notices.map((notice) => notice.code), ["premium_ratio_warning"]);
});

test("the fair-share line scales with how many people are actually drawing on the pool", () => {
  const share = (activeUsers) => evaluateFetchPolicy(inputs({
    premiumCost: 0, totalCost: BIG * 0.2, teamCost: BIG, activeUsers,
    lastServedAt: PHASE_COOLDOWN_AT,
  }));
  // At 20% of team spend: fine among 4 people (line 25%), too much among 10 (line 10%).
  assert.equal(share(4).allowed, true);
  assert.equal(share(10).allowed, false);
  assert.equal(share(10).reason, "demand_share_cooldown");
  assert.equal(DEMAND_SHARE_TOLERANCE, 1.0, "the tolerance the lines above assume");
});

test("a user below the spend floor is not judged on a noisy share", () => {
  const result = evaluateFetchPolicy(inputs({
    premiumCost: PREMIUM_RATIO_MIN_COST * 0.99,
    totalCost: PREMIUM_RATIO_MIN_COST * 0.99,
    teamCost: BIG * 100,
    activeUsers: 10,
    lastServedAt: PHASE_COOLDOWN_AT,
  }));
  assert.equal(result.allowed, true);
  assert.equal(result.premium_share, null, "a few cents of usage says nothing about habits");
  assert.deepEqual(result.notices, []);
});

test("a user who has never been served is not held by a cooldown", () => {
  const result = evaluateFetchPolicy(inputs({ lastServedAt: null }));
  assert.equal(result.allowed, true);
});

test("the reporter gate outranks the cooldown so the fix is always the same one", () => {
  const result = evaluateFetchPolicy(inputs({
    requestClientVersion: "1.9.9",
    lastServedAt: PHASE_COOLDOWN_AT,
  }));
  assert.equal(result.reason, "reporter_upgrade_required");
});

test("version comparison orders by numeric component, not string", () => {
  assert.equal(compareVersions("2.10.0", "2.9.0"), 1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  assert.equal(compareVersions("1.9.9", "2.0.0"), -1);
});

test("the models the notice recommends are themselves non-premium", () => {
  // Copy that tells a user to switch to a model which also counts against them is worse than no
  // advice: they follow it, nothing improves, and they stop trusting the notice.
  for (const modelId of SUGGESTED_STANDARD_MODEL_IDS) {
    assert.equal(isPremiumModel(modelId), false, `${modelId} is recommended but counts as premium`);
  }
});

test("both ratio notices name the models on each side of the line", () => {
  const shared = { premiumCost: BIG * 0.9, totalCost: BIG, lastServedAt: null };
  const warning = evaluateFetchPolicy({ ...inputs(shared), now: new Date(PHASE_REPORTER_GATE_AT) });
  const cooldown = evaluateFetchPolicy({ ...inputs(shared), now: new Date(PHASE_COOLDOWN_AT) });
  for (const [label, result] of [["warning", warning], ["cooldown", cooldown]]) {
    const notice = result.notices.find((item) => item.code.startsWith("premium_ratio"));
    assert.ok(notice, `${label} produced no ratio notice`);
    // A rule whose subject the reader has to guess at cannot be complied with.
    assert.match(notice.message, /gpt-5\.6-sol/, `${label} does not name a premium model`);
    for (const suggestion of SUGGESTED_STANDARD_MODEL_IDS) {
      assert.ok(notice.message.includes(suggestion), `${label} does not offer ${suggestion}`);
    }
    assert.match(notice.message, /90%/, `${label} does not state the user's own share`);
    assert.match(notice.message, /50%/, `${label} does not state the target`);
  }
});

test("unreported consumption is measured as a debt from the last new account, not report recency", () => {
  const base = {
    now: new Date(PHASE_REPORTER_GATE_AT),
    requestClientVersion: "2.0.0",
    premiumCost: 0,
    totalCost: 0,
    lastServedAt: null,
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

test("the hub sets the repeat interval rather than the client compiling one in", () => {
  const result = evaluateFetchPolicy({
    now: new Date("2026-08-25T00:00:00.000Z"),
    requestClientVersion: "2.0.0",
    lastNewAccountAt: "2026-08-20T00:00:00.000Z",
    lastReportAt: null,
    premiumCost: BIG * 0.9,
    totalCost: BIG,
    lastServedAt: null,
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
    requestClientVersion: "2.0.0",
    premiumCost: 0,
    totalCost: 0,
    lastServedAt: null,
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
    requestClientVersion: "2.0.0",
    premiumCost: 0,
    totalCost: 0,
    lastServedAt: null,
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

test("the cooldown holds fire while the pool has room, but the warning still goes out", () => {
  // Throttling during abundance is pure friction -- nobody gains from it. The warning still lands,
  // which is what gives people time to change habits before the pool tightens.
  const shared = inputs({ lastServedAt: PHASE_COOLDOWN_AT, lastNewAccountAt: null });

  const healthy = evaluateFetchPolicy({ ...shared, poolScarce: false });
  assert.equal(healthy.allowed, true);
  assert.equal(healthy.notices[0].code, "premium_ratio_warning");

  const scarce = evaluateFetchPolicy({ ...shared, poolScarce: true });
  assert.equal(scarce.allowed, false);
  assert.equal(scarce.reason, "demand_share_cooldown");
});

test("scarcity never excuses an unmetered client", () => {
  // The reporting gate is a measurement precondition, not a rationing rule. Gating it on scarcity
  // would mean nobody fixes their reporter during abundance, so when the pool does tighten those
  // users still have no measurable share and the cooldown cannot reach them.
  const base = {
    now: new Date(PHASE_COOLDOWN_AT),
    premiumCost: 0,
    totalCost: 0,
    lastServedAt: null,
    lastNewAccountAt: "2026-09-01T00:00:00.000Z",
    lastReportAt: null,
  };
  for (const poolScarce of [true, false]) {
    const result = evaluateFetchPolicy({ ...base, requestClientVersion: "2.0.0", poolScarce });
    assert.equal(result.reason, "usage_reporting_required", `poolScarce=${poolScarce}`);
  }
  for (const poolScarce of [true, false]) {
    const result = evaluateFetchPolicy({ ...base, requestClientVersion: "1.0.0", poolScarce, lastNewAccountAt: null });
    assert.equal(result.reason, "reporter_upgrade_required", `poolScarce=${poolScarce}`);
  }
});


test("nobody is held back when there is nobody to be fair to", () => {
  // Freeing capacity for an empty room drains the pool just as fast and only stops work sooner.
  // A shortage one person drives alone calls for more accounts, not for throttling the only user.
  for (let activeUsers = 0; activeUsers < DEMAND_SHARE_MIN_ACTIVE_USERS; activeUsers += 1) {
    const result = evaluateFetchPolicy(inputs({
      premiumCost: 0, totalCost: BIG, teamCost: BIG, activeUsers,
      lastServedAt: PHASE_COOLDOWN_AT,
    }));
    assert.equal(result.allowed, true, `${activeUsers} active users must not trigger a fair-share hold`);
  }
});

test("the cooldown releases itself, and says so", () => {
  const servedAt = "2026-09-21T10:00:00.000Z";
  const at = (minutes) => evaluateFetchPolicy(inputs({
    now: new Date(Date.parse(servedAt) + minutes * 60 * 1000),
    lastServedAt: servedAt,
  }));

  // A rate limit, not a ban: the wait counts down and clears on its own.
  assert.equal(at(1).allowed, false);
  assert.equal(at(PREMIUM_RATIO_COOLDOWN_MINUTES - 1).allowed, false);
  assert.ok(at(1).retry_after_seconds > at(PREMIUM_RATIO_COOLDOWN_MINUTES - 1).retry_after_seconds);
  assert.equal(at(PREMIUM_RATIO_COOLDOWN_MINUTES).allowed, true, "the hold must lift on its own");
  assert.equal(at(PREMIUM_RATIO_COOLDOWN_MINUTES).reason, null);

  // And the person reading the toast has to be able to tell that without asking anyone.
  const message = at(1).notices.find((notice) => notice.code === "demand_share_cooldown").message;
  assert.match(message, new RegExp(`${PREMIUM_RATIO_COOLDOWN_MINUTES} 分钟`), "names the bound on the wait");
  assert.match(message, /自动恢复/, "says the hold lifts by itself");
  assert.match(message, /不是封禁/, "distinguishes a rate limit from a ban");
  // The client re-shows a cached notice for hours, so a live countdown in the text would be stale
  // by the time most people read it. The exact wait travels in retry_after_seconds instead.
  assert.doesNotMatch(message, /还需|剩余/, "no countdown baked into cached text");
});

test("only the cooldown notice claims the pool is short, because only then is it", () => {
  const shared = { premiumCost: 0, totalCost: 90, teamCost: 100, activeUsers: 10, lastServedAt: PHASE_COOLDOWN_AT };
  const text = (poolScarce) => {
    const result = evaluateFetchPolicy(inputs({ ...shared, poolScarce }));
    return result.notices.find((notice) => notice.code.startsWith("demand_share")).message;
  };
  assert.match(text(true), /供不应求/);
  assert.doesNotMatch(text(false), /当前供不应求/, "a healthy pool must not be described as short");
});

test("a non-contributor is warned before the phase, and never refused during abundance", () => {
  // Inside their fair share, so only the supply rule can have anything to say about them.
  const light = { premiumCost: 0, totalCost: BIG * 0.01, teamCost: BIG * 100, activeUsers: 10 };
  const beforePhase = evaluateFetchPolicy(inputs({
    ...light,
    hasHealthyUpload: false,
    now: new Date(PHASE_REPORTER_GATE_AT),
    lastReportAt: PHASE_REPORTER_GATE_AT,
    lastServedAt: PHASE_REPORTER_GATE_AT,
  }));
  assert.equal(beforePhase.allowed, true);
  assert.deepEqual(beforePhase.notices.map((notice) => notice.code), ["contribution_warning"]);

  // Phase reached, but there is nothing to ration: throttling here would free capacity for nobody.
  const healthyPool = evaluateFetchPolicy(inputs({
    ...light,
    hasHealthyUpload: false,
    poolScarce: false,
    lastServedAt: PHASE_COOLDOWN_AT,
  }));
  assert.equal(healthyPool.allowed, true);
  assert.deepEqual(healthyPool.notices.map((notice) => notice.code), ["contribution_warning"]);
});

test("a scarce pool rate-limits whoever draws on it without supplying it", () => {
  const light = { premiumCost: 0, totalCost: BIG * 0.01, teamCost: BIG * 100, activeUsers: 10 };
  const held = evaluateFetchPolicy(inputs({
    ...light,
    hasHealthyUpload: false,
    lastServedAt: at(PHASE_COOLDOWN_AT, -10),
  }));
  assert.equal(held.allowed, false);
  assert.equal(held.reason, "contribution_cooldown");
  assert.equal(held.retry_after_seconds, (PREMIUM_RATIO_COOLDOWN_MINUTES - 10) * 60);
  assert.equal(held.notices.at(-1).code, "contribution_cooldown");

  // A rate limit, not a lockout: the wait elapses and they are served like anyone else.
  const elapsed = evaluateFetchPolicy(inputs({
    ...light,
    hasHealthyUpload: false,
    lastServedAt: at(PHASE_COOLDOWN_AT, -(PREMIUM_RATIO_COOLDOWN_MINUTES + 1)),
  }));
  assert.equal(elapsed.allowed, true);

  // And never a first-fetch lockout for somebody the pool has never served.
  assert.equal(evaluateFetchPolicy(inputs({ ...light, hasHealthyUpload: false, lastServedAt: null })).allowed, true);
});

test("supplying the pool costs nothing in standing, however much you then consume", () => {
  const result = evaluateFetchPolicy(inputs({ hasHealthyUpload: true, lastServedAt: at(PHASE_COOLDOWN_AT, -10) }));
  // Over-share still holds them -- but by the demand rule, with no word about contribution.
  assert.equal(result.reason, "demand_share_cooldown");
  assert.ok(!result.notices.some((notice) => notice.code.startsWith("contribution")));
});

test("an over-share non-contributor is told about the share, and only that", () => {
  // Both rules would fire. The share is the one costing the pool tokens today, and two toasts naming
  // two different remedies for one held fetch is how a warning gets dismissed unread.
  const result = evaluateFetchPolicy(inputs({
    hasHealthyUpload: false,
    lastServedAt: at(PHASE_COOLDOWN_AT, -10),
  }));
  assert.equal(result.reason, "demand_share_cooldown");
  assert.deepEqual(
    result.notices.map((notice) => notice.code),
    ["premium_ratio_warning", "demand_share_cooldown"]
  );
});

test("the contribution notice says what counts as supplying the pool", () => {
  const light = { premiumCost: 0, totalCost: BIG * 0.01, teamCost: BIG * 100, activeUsers: 10 };
  const warning = evaluateFetchPolicy(inputs({
    ...light, hasHealthyUpload: false, poolScarce: false, lastServedAt: PHASE_COOLDOWN_AT,
  })).notices[0];
  const cooldown = evaluateFetchPolicy(inputs({
    ...light, hasHealthyUpload: false, lastServedAt: at(PHASE_COOLDOWN_AT, -1),
  })).notices.at(-1);
  // Both must name the one action that lifts this, or the rule cannot be complied with.
  for (const [label, notice] of [["warning", warning], ["cooldown", cooldown]]) {
    assert.match(notice.message, /Codex/, `${label} does not say what to contribute`);
    assert.equal(notice.repeat_seconds, NOTICE_REPEAT_SECONDS, `${label} would nag on every 15-minute run`);
  }
  // The cooldown copy must not read as a ban: they keep working on the account in hand.
  assert.match(cooldown.message, new RegExp(`${PREMIUM_RATIO_COOLDOWN_MINUTES} 分钟`));
  assert.match(warning.message, new RegExp(PHASE_COOLDOWN_AT.slice(0, 10)));
});
