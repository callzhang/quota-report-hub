import test from "node:test";
import assert from "node:assert/strict";

import {
  SCARCITY_BURN_WINDOW_DAYS,
  SCARCITY_HORIZON_DAYS,
  SCARCITY_STATE_MAX_AGE_HOURS,
  fairShareCap,
  fairShareFromState,
  projectScarcity,
  scarcityFromState,
} from "../lib/pool-scarcity.js";

test("a pool that burns faster than it is replenished is scarce", () => {
  // The live codex pool on 2026-08-20: 403 points/day against 941 in hand plus 1400 unlocking.
  const result = projectScarcity({ burnPoints: 403, burnWindowDays: 1, supplyNowPoints: 941, unlockPoints: 1400 });
  assert.equal(result.scarce, true);
  assert.equal(result.demand_points, 403 * SCARCITY_HORIZON_DAYS);
  assert.equal(result.available_points, 2341);
  assert.ok(result.runway_days > 5 && result.runway_days < 6);
});

test("a pool with room to spare is not scarce", () => {
  const result = projectScarcity({ burnPoints: 6, supplyNowPoints: 96, unlockPoints: 100 });
  assert.equal(result.scarce, false);
});

test("a quiet pool is never scarce, however little is left", () => {
  // Zero burn means infinite runway. Declaring scarcity here would throttle people over a pool that
  // nobody is draining.
  const result = projectScarcity({ burnPoints: 0, supplyNowPoints: 1, unlockPoints: 0 });
  assert.equal(result.scarce, false);
  assert.equal(result.runway_days, Infinity);
});

test("resets inside the horizon count as supply", () => {
  const without = projectScarcity({ burnPoints: 100, burnWindowDays: 1, supplyNowPoints: 200, unlockPoints: 0 });
  const with_ = projectScarcity({ burnPoints: 100, burnWindowDays: 1, supplyNowPoints: 200, unlockPoints: 800 });
  assert.equal(without.scarce, true);
  assert.equal(with_.scarce, false, "quota due to renew must not be counted as already gone");
});

test("unknown pool health never enforces", () => {
  // A broken cron must fail open. Throttling people on the strength of missing data is worse than
  // letting a busy week through, and a stale verdict is missing data wearing a timestamp.
  const now = new Date("2026-09-22T12:00:00.000Z");
  assert.equal(scarcityFromState(null, { now }).scarce, false);
  assert.equal(scarcityFromState({}, { now }).scarce, false);
  assert.equal(scarcityFromState({ computed_at: "not a date", scarce: true }, { now }).scarce, false);

  const stale = new Date(now.getTime() - (SCARCITY_STATE_MAX_AGE_HOURS + 1) * 3600e3).toISOString();
  const staleResult = scarcityFromState({ computed_at: stale, scarce: true }, { now });
  assert.equal(staleResult.scarce, false);
  assert.equal(staleResult.reason, "scarcity_state_stale");

  const fresh = new Date(now.getTime() - 60e3).toISOString();
  assert.equal(scarcityFromState({ computed_at: fresh, scarce: true }, { now }).scarce, true);
  assert.equal(scarcityFromState({ computed_at: fresh, scarce: false }, { now }).scarce, false);
});

test("burn is the mean over the whole window, not the last day", () => {
  // One heavy day in three must not read as a pool burning at that day's rate all week: the cap cut
  // from this number swung $2.4k-$26k inside a week on a 24h window (2026-10-20..11-05).
  assert.equal(SCARCITY_BURN_WINDOW_DAYS, 3);
  const result = projectScarcity({ burnPoints: 300, supplyNowPoints: 1000, unlockPoints: 0 });
  assert.equal(result.burn_points_per_day, 100);
  assert.equal(result.demand_points, 100 * SCARCITY_HORIZON_DAYS);
  assert.equal(result.scarce, false, "700 projected against 1000 available");
});

test("the fair-share cap is the level supply can cover for everyone", () => {
  // Water-filling: the light users are covered in full and the shortfall comes from the top.
  // Budget 0.5 * 100 = 50; 5 and 10 fit (35 left for two), so each of the two heavy users gets 17.5.
  const cap = fairShareCap({ userCosts: [5, 10, 25, 60], supplyRatio: 0.5 });
  assert.equal(cap, 17.5);
  const covered = [5, 10, 25, 60].reduce((sum, cost) => sum + Math.min(cost, cap), 0);
  assert.equal(covered, 50, "everyone at or under the cap uses exactly the supply");
});

test("a tight enough pool caps everyone at an equal share", () => {
  assert.equal(fairShareCap({ userCosts: [10, 20, 30], supplyRatio: 0.3 }), 6);
  assert.equal(fairShareCap({ userCosts: [10, 20, 30], supplyRatio: 0 }), 0, "an empty pool has nothing to share");
});

test("there is no cap while supply covers demand or nobody has spent", () => {
  assert.equal(fairShareCap({ userCosts: [10, 20], supplyRatio: 1 }), null);
  assert.equal(fairShareCap({ userCosts: [10, 20], supplyRatio: 1.4 }), null);
  assert.equal(fairShareCap({ userCosts: [], supplyRatio: 0.5 }), null);
  assert.equal(fairShareCap({ userCosts: [0, 0], supplyRatio: 0.5 }), null);
  assert.equal(fairShareCap({ userCosts: [10], supplyRatio: null }), null, "no ratio is no evidence of scarcity");
});

test("users with no spend do not dilute the cap", () => {
  assert.equal(fairShareCap({ userCosts: [0, 0, 0, 10, 30], supplyRatio: 0.5 }), fairShareCap({ userCosts: [10, 30], supplyRatio: 0.5 }));
});

test("the cap follows the stored verdict and fails open on stale state", () => {
  const now = new Date("2026-11-04T12:00:00.000Z");
  const fresh = { computed_at: "2026-11-04T11:30:00.000Z", scarce: true, available_points: 400, demand_points: 1000 };
  const scarce = fairShareFromState(fresh, [5, 10, 25, 60], { now });
  assert.equal(scarce.supplyRatio, 0.4);
  assert.equal(scarce.capUsd, fairShareCap({ userCosts: [5, 10, 25, 60], supplyRatio: 0.4 }));

  assert.equal(fairShareFromState({ ...fresh, scarce: false, available_points: 1200 }, [5, 60], { now }).capUsd, null);
  assert.equal(fairShareFromState({ ...fresh, computed_at: "2026-11-03T00:00:00.000Z" }, [5, 60], { now }).capUsd, null);
  assert.equal(fairShareFromState(null, [5, 60], { now }).capUsd, null);
});
