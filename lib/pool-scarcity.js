// Whether the shared pool is on track to run dry, in the pool's own unit: percentage points of
// weekly quota. Token counts cannot answer this -- supply is only ever observable as "how much of
// each account's week is left" -- so demand is measured the same way, as observed decline.
//
// Enforcement that bites during abundance is pure friction: nobody gains from throttling a heavy
// user while there is quota to spare. This is the switch that keeps the fair-share cap off until it
// would actually protect something.

export const SCARCITY_HORIZON_DAYS = 7;      // these are weekly windows; a shorter horizon would
                                             // call every Monday a crisis and every Friday a feast
// Three days, not one. The burn rate is the denominator of the supply ratio the fair-share cap is
// cut from, and a single day of it is mostly noise: replayed over 2026-10-20..11-05 a 24h burn moved
// the codex cap between $2.4k and $26k inside a week, while the 3-day mean kept it within
// $2.6k-$7.3k. The same window measures each user's spend, so both sides of the ratio describe the
// same stretch of time.
export const SCARCITY_BURN_WINDOW_DAYS = 3;
export const SCARCITY_STATE_MAX_AGE_HOURS = 6;

// Only declines count. A window reset sends remaining_percent back up, and that is supply arriving,
// not consumption -- summing raw deltas would net the two against each other and report a pool that
// never burns anything.
export const BURN_POINTS_SQL = `SUM(CASE WHEN prev > wk THEN prev - wk ELSE 0 END)`;

// A reset restores the account's whole weekly allowance, so it contributes a full 100 points rather
// than the gap to full. This overcounts slightly for a reset landing late in the horizon, which errs
// toward declaring the pool healthy -- the safe direction, since the cost of a wrong "scarce" is
// throttling people who did not need throttling.
export const UNLOCK_POINTS_SQL = `SUM(CASE WHEN one_week_reset_at IS NOT NULL AND one_week_reset_at <= ? THEN 100 ELSE 0 END)`;

export function projectScarcity({
  burnPoints = 0,
  burnWindowDays = SCARCITY_BURN_WINDOW_DAYS,
  supplyNowPoints = 0,
  unlockPoints = 0,
  horizonDays = SCARCITY_HORIZON_DAYS,
} = {}) {
  const burnPerDay = Math.max(0, Number(burnPoints) || 0) / burnWindowDays;
  const available = Math.max(0, Number(supplyNowPoints) || 0) + Math.max(0, Number(unlockPoints) || 0);
  const demand = burnPerDay * horizonDays;
  return {
    burn_points_per_day: burnPerDay,
    available_points: available,
    demand_points: demand,
    horizon_days: horizonDays,
    // Infinite runway when nothing is burning: a quiet pool is not a scarce one.
    runway_days: burnPerDay > 0 ? available / burnPerDay : Infinity,
    scarce: burnPerDay > 0 && demand > available,
  };
}

// Missing or stale state means the pool's health is unknown, and unknown must never enforce.
// Throttling people on the strength of a broken cron is worse than letting a busy week through.
export function scarcityFromState(state, { now = new Date(), maxAgeHours = SCARCITY_STATE_MAX_AGE_HOURS } = {}) {
  if (!state || !state.computed_at) {
    return { scarce: false, reason: "no_scarcity_state", supplyRatio: null };
  }
  const computedMs = Date.parse(state.computed_at);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(computedMs) || nowMs - computedMs > maxAgeHours * 60 * 60 * 1000) {
    return { scarce: false, reason: "scarcity_state_stale", supplyRatio: null };
  }
  const demand = Number(state.demand_points);
  const supplyRatio = demand > 0 ? Number(state.available_points || 0) / demand : null;
  return { scarce: Boolean(state.scarce), reason: state.scarce ? "pool_scarce" : "pool_healthy", supplyRatio };
}

// The most any one user may spend over the window while the pool is short, cut so that the pool's
// supply covers everyone's demand up to it: the largest c with sum(min(spend_i, c)) <= ratio * total.
// Max-min fairness -- whoever spends less than the cap is untouched, and the shortfall is taken
// entirely from the people above it, in proportion to how far above it they are.
//
// `supplyRatio` is available over projected demand, both in quota points, so it applies to dollars
// unchanged: the units cancel, and no points-to-dollars conversion has to be invented. It assumes the
// team's next week looks like its last few days, which is the same assumption the scarcity verdict
// already makes.
//
// null means no cap: the pool covers demand, or nobody has spent anything to divide.
export function fairShareCap({ userCosts, supplyRatio }) {
  // Not Number(): that reads a missing ratio as 0, which would cap everybody at nothing.
  if (typeof supplyRatio !== "number" || !Number.isFinite(supplyRatio) || supplyRatio >= 1) return null;
  const ratio = supplyRatio;
  const costs = userCosts.map(Number).filter((cost) => Number.isFinite(cost) && cost > 0).sort((a, b) => a - b);
  let budget = Math.max(0, ratio) * costs.reduce((sum, cost) => sum + cost, 0);
  for (let index = 0; index < costs.length; index += 1) {
    const remaining = costs.length - index;
    if (costs[index] * remaining > budget) return budget / remaining;
    budget -= costs[index];
  }
  return null;
}

// One place turns the stored verdict plus everybody's spend into the cap, so the fetch gate and the
// users dashboard cannot describe different rules.
export function fairShareFromState(state, userCosts, { now = new Date() } = {}) {
  const scarcity = scarcityFromState(state, { now });
  const capUsd = scarcity.scarce ? fairShareCap({ userCosts, supplyRatio: scarcity.supplyRatio }) : null;
  return { ...scarcity, capUsd };
}
