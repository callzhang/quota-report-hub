// Whether the shared pool is on track to run dry, in the pool's own unit: percentage points of
// weekly quota. Token counts cannot answer this -- supply is only ever observable as "how much of
// each account's week is left" -- so demand is measured the same way, as observed decline.
//
// Enforcement that bites during abundance is pure friction: nobody gains from throttling a heavy
// user while there is quota to spare. This is the switch that keeps the premium-share cooldown off
// until it would actually protect something.

export const SCARCITY_HORIZON_DAYS = 7;      // these are weekly windows; a shorter horizon would
                                             // call every Monday a crisis and every Friday a feast
export const SCARCITY_BURN_WINDOW_HOURS = 24;
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
  burnPoints24h = 0,
  supplyNowPoints = 0,
  unlockPoints = 0,
  horizonDays = SCARCITY_HORIZON_DAYS,
} = {}) {
  const burnPerDay = Math.max(0, Number(burnPoints24h) || 0);
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
    return { scarce: false, reason: "no_scarcity_state" };
  }
  const computedMs = Date.parse(state.computed_at);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(computedMs) || nowMs - computedMs > maxAgeHours * 60 * 60 * 1000) {
    return { scarce: false, reason: "scarcity_state_stale" };
  }
  return { scarce: Boolean(state.scarce), reason: state.scarce ? "pool_scarce" : "pool_healthy" };
}
