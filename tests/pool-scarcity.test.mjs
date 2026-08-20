import test from "node:test";
import assert from "node:assert/strict";

import {
  SCARCITY_HORIZON_DAYS,
  SCARCITY_STATE_MAX_AGE_HOURS,
  projectScarcity,
  scarcityFromState,
} from "../lib/pool-scarcity.js";

test("a pool that burns faster than it is replenished is scarce", () => {
  // The live codex pool on 2026-08-20: 403 points/day against 941 in hand plus 1400 unlocking.
  const result = projectScarcity({ burnPoints24h: 403, supplyNowPoints: 941, unlockPoints: 1400 });
  assert.equal(result.scarce, true);
  assert.equal(result.demand_points, 403 * SCARCITY_HORIZON_DAYS);
  assert.equal(result.available_points, 2341);
  assert.ok(result.runway_days > 5 && result.runway_days < 6);
});

test("a pool with room to spare is not scarce", () => {
  const result = projectScarcity({ burnPoints24h: 6, supplyNowPoints: 96, unlockPoints: 100 });
  assert.equal(result.scarce, false);
});

test("a quiet pool is never scarce, however little is left", () => {
  // Zero burn means infinite runway. Declaring scarcity here would throttle people over a pool that
  // nobody is draining.
  const result = projectScarcity({ burnPoints24h: 0, supplyNowPoints: 1, unlockPoints: 0 });
  assert.equal(result.scarce, false);
  assert.equal(result.runway_days, Infinity);
});

test("resets inside the horizon count as supply", () => {
  const without = projectScarcity({ burnPoints24h: 100, supplyNowPoints: 200, unlockPoints: 0 });
  const with_ = projectScarcity({ burnPoints24h: 100, supplyNowPoints: 200, unlockPoints: 800 });
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
