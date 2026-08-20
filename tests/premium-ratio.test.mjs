import test from "node:test";
import assert from "node:assert/strict";

import { isPremiumModel, STANDARD_MODEL_IDS, PREMIUM_MODEL_IDS, SUGGESTED_STANDARD_MODEL_IDS } from "../lib/model-tiers.js";
import {
  PHASE_RATIO_COOLDOWN_AT,
  PHASE_REPORTER_GATE_AT,
  PREMIUM_RATIO_COOLDOWN_MINUTES,
  PREMIUM_RATIO_MIN_WEIGHTED_TOKENS,
  PREMIUM_RATIO_THRESHOLD,
  compareVersions,
  evaluateFetchPolicy,
  weightedTokens,
} from "../lib/premium-ratio.js";

const BIG = PREMIUM_RATIO_MIN_WEIGHTED_TOKENS * 10;

function inputs(overrides = {}) {
  return {
    now: new Date(PHASE_RATIO_COOLDOWN_AT),
    lastReportAt: PHASE_RATIO_COOLDOWN_AT,
    requestClientVersion: "2.0.0",
    premiumWeighted: BIG * 0.9,
    totalWeighted: BIG,
    lastServedAt: null,
    ...overrides,
  };
}

function at(iso, minutesAfter) {
  return new Date(Date.parse(iso) + minutesAfter * 60 * 1000).toISOString();
}

test("unknown models count as premium so a new release cannot open a silent loophole", () => {
  for (const modelId of PREMIUM_MODEL_IDS) assert.equal(isPremiumModel(modelId), true, modelId);
  for (const modelId of STANDARD_MODEL_IDS) assert.equal(isPremiumModel(modelId), false, modelId);
  assert.equal(isPremiumModel("gpt-7-whatever-ships-next"), true);
  assert.equal(isPremiumModel("GPT-5.6-SOL"), true);
  assert.equal(isPremiumModel("  gpt-5.5  "), false);
});

test("replayed context is discounted to a tenth for both providers", () => {
  // Codex folds cache_read into input_tokens; Claude reports it alongside. Both must reduce to
  // the same weighting of fresh input, or the ratio would mean different things per provider.
  const codex = weightedTokens({
    provider: "codex", input_tokens: 1000, cache_read_tokens: 800, cache_write_tokens: 0, output_tokens: 100,
  });
  const claude = weightedTokens({
    provider: "claude", input_tokens: 200, cache_read_tokens: 800, cache_write_tokens: 0, output_tokens: 100,
  });
  assert.equal(codex, 200 + 80 + 100);
  assert.equal(claude, codex);
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

test("a current client that has simply been idle is warned, never refused", () => {
  // The collector only posts when there IS usage, so silence is indistinguishable from a day off.
  // Refusing on it would deadlock anyone back from leave: no auth, so no usage, so no report to
  // lift the refusal with.
  const result = evaluateFetchPolicy(inputs({
    lastReportAt: null,
    premiumWeighted: 0,
    totalWeighted: 0,
  }));
  assert.equal(result.allowed, true);
  assert.equal(result.notices[0].code, "reporter_upgrade_required");
});

test("a fresh install is served before it has any usage to report", () => {
  const result = evaluateFetchPolicy({
    now: new Date(PHASE_RATIO_COOLDOWN_AT),
    requestClientVersion: "2.0.0",
    lastReportAt: null,
    premiumWeighted: 0,
    totalWeighted: 0,
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

test("phase 3 cools down an over-share user and reports the exact wait", () => {
  const result = evaluateFetchPolicy(inputs({
    lastServedAt: at(PHASE_RATIO_COOLDOWN_AT, -10),
  }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "premium_ratio_cooldown");
  assert.equal(result.retry_after_seconds, (PREMIUM_RATIO_COOLDOWN_MINUTES - 10) * 60);
});

test("phase 3 serves again once the cooldown has elapsed", () => {
  const result = evaluateFetchPolicy(inputs({
    lastServedAt: at(PHASE_RATIO_COOLDOWN_AT, -(PREMIUM_RATIO_COOLDOWN_MINUTES + 1)),
  }));
  assert.equal(result.allowed, true);
});

test("a share at or below the threshold is never cooled down", () => {
  const result = evaluateFetchPolicy(inputs({
    premiumWeighted: BIG * PREMIUM_RATIO_THRESHOLD,
    lastServedAt: PHASE_RATIO_COOLDOWN_AT,
  }));
  assert.equal(result.allowed, true);
  assert.deepEqual(result.notices, []);
});

test("a user below the volume floor is not judged on a noisy share", () => {
  const result = evaluateFetchPolicy(inputs({
    premiumWeighted: PREMIUM_RATIO_MIN_WEIGHTED_TOKENS - 1,
    totalWeighted: PREMIUM_RATIO_MIN_WEIGHTED_TOKENS - 1,
    lastServedAt: PHASE_RATIO_COOLDOWN_AT,
  }));
  assert.equal(result.allowed, true);
  assert.equal(result.premium_share, null);
  assert.deepEqual(result.notices, []);
});

test("a user who has never been served is not held by a cooldown", () => {
  const result = evaluateFetchPolicy(inputs({ lastServedAt: null }));
  assert.equal(result.allowed, true);
});

test("the reporter gate outranks the cooldown so the fix is always the same one", () => {
  const result = evaluateFetchPolicy(inputs({
    requestClientVersion: "1.9.9",
    lastServedAt: PHASE_RATIO_COOLDOWN_AT,
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
  const shared = { premiumWeighted: BIG * 0.9, totalWeighted: BIG, lastServedAt: null };
  const warning = evaluateFetchPolicy({ ...inputs(shared), now: new Date(PHASE_REPORTER_GATE_AT) });
  const cooldown = evaluateFetchPolicy({ ...inputs(shared), now: new Date(PHASE_RATIO_COOLDOWN_AT) });
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
