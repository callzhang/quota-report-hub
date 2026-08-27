import { PREMIUM_MODEL_IDS, SUGGESTED_STANDARD_MODEL_IDS, isPremiumModel, modelCostSql } from "./model-tiers.js";

// The premium share only ever advises. It is a proxy for "you are expensive", and once usage is
// priced there is no reason to enforce a proxy instead of the thing itself: a user at 90% premium on
// a tiny volume costs the pool nothing and should never be held back. What the share is still good
// for is telling somebody the one concrete action that would make them cheaper.
export const PREMIUM_RATIO_THRESHOLD = 0.5;
export const PREMIUM_RATIO_WINDOW_DAYS = 7;

// Below this much spend in the window the share is noise, not a habit.
export const PREMIUM_RATIO_MIN_COST = 1.0;

// Refusal targets the actual failure: the pool running dry, with this user a main reason why. Not an
// absolute cap -- those punish finishing a task in one conversation, since every turn replays the
// whole context and that replay is a mechanical consequence of not discarding it, never a choice.
// A share of total demand needs no threshold in dollars and rescales itself as the team and the pool
// change size. The tolerance is 1.0 -- the line is simply the average, and when quota has run out
// everyone above average yields. A wider tolerance bought nothing on real data: spend is steep
// enough (top three at 90%, everyone else under 3.5%) that 1.0 and 2.5 selected the same people,
// so the wider line only moved the threshold into an empty stretch while being harder to explain.
export const DEMAND_SHARE_TOLERANCE = 1.0;

// "Fair share" presupposes somebody to be fair to. A sole consumer holds nobody else back, so
// throttling them frees capacity for no one -- the pool drains at the same rate and the only effect
// is that work stops sooner. A shortage one person drives alone is a signal to add accounts.
export const DEMAND_SHARE_MIN_ACTIVE_USERS = 2;

// One flat cooldown, no per-path or per-severity multipliers. Severity is already encoded in how
// long a user stays above the line.
//
// This throttles how often somebody may draw on the pool; it does not stop them working. The upper
// bound is set by the codex id_token, which goes stale about an hour after issue: past that a held
// user cannot refresh at all and stops outright, turning a rate limit into an outage. Thirty minutes
// leaves a full margin under that, while cutting the heaviest users from a fetch every five minutes
// to one every thirty.
export const PREMIUM_RATIO_COOLDOWN_MINUTES = 30;

export const MIN_REPORTER_CLIENT_VERSION = "2.0.0";

// How long after the pool hands over a NEW account a user has to account for what they did with it.
// The clock starts on a `served` event only, never on `refreshed_current`: an idle user's guard keeps
// refreshing to hold the token alive, so charging refreshes would run the debt up on somebody who is
// not working -- and they cannot repay it without working. Being given new capacity and reporting
// nothing is the actual offence.
export const REPORTING_DEBT_GRACE_HOURS = 24;

// How often a client re-shows a notice. Sent by the hub rather than compiled into the client so the
// cadence can be re-tuned without waiting for a release to propagate to every machine.
export const NOTICE_REPEAT_SECONDS = 6 * 60 * 60;

// Phases are cumulative and fire on wall-clock dates so the schedule is visible in the code rather
// than living in an admin's head. Each date is a Monday. The env override exists so a phase can be
// pulled forward for a canary or pushed back in an emergency, and so tests can reach a phase that
// has not arrived yet; leaving it unset is the normal state.
function phaseDate(envKey, hardcoded) {
  const override = process.env[envKey];
  return override && Number.isFinite(Date.parse(override)) ? override : hardcoded;
}

export const PHASE_NOTICE_AT = "1970-01-01T00:00:00.000Z";
export const PHASE_REPORTER_GATE_AT = phaseDate("PREMIUM_RATIO_REPORTER_GATE_AT", "2026-09-07T00:00:00.000Z");
export const PHASE_RATIO_COOLDOWN_AT = phaseDate("PREMIUM_RATIO_COOLDOWN_AT", "2026-09-21T00:00:00.000Z");

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function msSince(nowMs, isoTimestamp) {
  const parsed = Date.parse(isoTimestamp || "");
  return Number.isFinite(parsed) ? nowMs - parsed : null;
}

function phaseActive(nowMs, phaseIso) {
  return nowMs >= Date.parse(phaseIso);
}

export function activePhases(now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  return {
    notice: phaseActive(nowMs, PHASE_NOTICE_AT),
    reporter_gate: phaseActive(nowMs, PHASE_REPORTER_GATE_AT),
    ratio_cooldown: phaseActive(nowMs, PHASE_RATIO_COOLDOWN_AT),
  };
}

export function compareVersions(left, right) {
  const parse = (value) => String(value ?? "").trim().split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function clientNeedsUpgrade(clientVersion) {
  if (!clientVersion) return true;
  return compareVersions(clientVersion, MIN_REPORTER_CLIENT_VERSION) < 0;
}

// Replayed context is discounted to a tenth: re-sending a conversation is the price of finishing
// a task, and the same discount applies to numerator and denominator so a long session neither
// earns nor loses premium headroom. Codex folds cache_read into input_tokens; Claude reports it
// alongside. Normalise to fresh input before weighting.
// Re-exported so callers have one import for the whole policy, and so the JS and SQL forms of the
// same arithmetic stay visibly paired. Tests assert they agree on identical rows.
export { modelCost } from "./model-tiers.js";

export const MODEL_COST_SQL = modelCostSql();

function withRepeatIntervals(notices) {
  return notices.map((notice) => ({ ...notice, repeat_seconds: NOTICE_REPEAT_SECONDS }));
}

export function premiumShare({ premiumCost, totalCost }) {
  const total = Number(totalCost || 0);
  if (!(total > 0)) return 0;
  return Number(premiumCost || 0) / total;
}

function humanDuration(hours) {
  return hours >= 48 ? `${Math.floor(hours / 24)} 天` : `${Math.floor(hours)} 小时`;
}

function reportingDebtNotice({ debtHours, blocking }) {
  const suffix = blocking
    ? "现在已停止发放 auth，恢复上报后自动解除。"
    : `${PHASE_REPORTER_GATE_AT.slice(0, 10)} 起将停止发放 auth（含续期），恢复上报后自动解除。`;
  return {
    code: "usage_reporting_required",
    title: "用量未上报",
    message:
      `你已从共享池取用 auth，但超过 ${humanDuration(debtHours)}没有上报任何用量，` +
      `Hub 无法统计你的模型使用情况。${suffix}` +
      "请确认 quota_guard 的 15 分钟定时任务在运行，或重新执行一次安装脚本。",
  };
}

function upgradeNotice() {
  return {
    code: "reporter_upgrade_required",
    title: "额度守护需要升级",
    message:
      "你的额度守护版本过旧，Hub 无法识别它。" +
      `${PHASE_REPORTER_GATE_AT.slice(0, 10)} 起将停止为未上报的客户端续发 auth。` +
      "请运行 quota_guard 让它自动升级，或重新执行安装脚本。",
  };
}

// Both notices name the models on each side of the line. "高级模型" on its own is not actionable --
// a user cannot comply with a rule whose subject they have to guess at.
const PREMIUM_EXAMPLES = PREMIUM_MODEL_IDS.slice(0, 2).join("、");
const SUGGESTED_EXAMPLES = SUGGESTED_STANDARD_MODEL_IDS.join(" 或 ");

function ratioNotice({ share }) {
  return {
    code: "premium_ratio_warning",
    title: "高级模型占比偏高",
    message:
      `你近 ${PREMIUM_RATIO_WINDOW_DAYS} 天高级模型（${PREMIUM_EXAMPLES} 等）占了开销的 ` +
      `${Math.round(share * 1000) / 10}%，目标 ≤ ${Math.round(PREMIUM_RATIO_THRESHOLD * 100)}%。` +
      `把默认模型换成 ${SUGGESTED_EXAMPLES} 能显著降低对共享池的消耗。这条只是提醒，不影响取号。`,
  };
}

function demandShareNotice({ demandShare, fairShare, cooldownActive }) {
  const mine = Math.round(demandShare * 1000) / 10;
  const line = Math.round(fairShare * 1000) / 10;
  const head = `共享池当前供不应求，而你占了全队开销的 ${mine}%（阈值 ${line}%）。`;
  if (cooldownActive) {
    return {
      code: "demand_share_cooldown",
      title: "取号冷却中",
      message: head + `现在每 ${PREMIUM_RATIO_COOLDOWN_MINUTES} 分钟才能取一次号，占比回落或池子恢复即解除。`,
    };
  }
  return {
    code: "demand_share_warning",
    title: "消耗占比过高",
    message: head + `${PHASE_RATIO_COOLDOWN_AT.slice(0, 10)} 起这种情况会限制取号频率。`,
  };
}

// Decides whether this fetch-best request may be served, and what to tell the user either way.
// Pure: every input is passed in, so the whole policy is testable without a database or a clock.
export function evaluateFetchPolicy({
  now = new Date(),
  lastReportAt = null,
  lastNewAccountAt = null,
  requestClientVersion = null,
  premiumCost = 0,
  totalCost = 0,
  teamCost = 0,
  activeUsers = 0,
  lastServedAt = null,
  poolScarce = false,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const phases = activePhases(new Date(nowMs));
  const notices = [];

  // The gate reads the version off the request being gated. Inferring it from the last usage batch
  // would lock out a fresh install permanently: its first act is to fetch auth, before it has any
  // usage to report, so it would have no recorded version and no way to earn one.
  const outdated = clientNeedsUpgrade(requestClientVersion);

  if (outdated) {
    notices.push(upgradeNotice());
    if (phases.reporter_gate) {
      return {
        allowed: false,
        reason: "reporter_upgrade_required",
        retry_after_seconds: null,
        premium_share: null,
        notices: withRepeatIntervals(notices),
      };
    }
  }

  // Unreported consumption. Measured as a debt owed since the last new account was handed over, not
  // as report recency: "has not reported lately" is indistinguishable from "took the day off", while
  // "was given a new account and never accounted for it" is unambiguous and cannot fire on an idle
  // user, whose last serve is exactly as old as their last report.
  const newAccountAgeMs = msSince(nowMs, lastNewAccountAt);
  const debtHours = newAccountAgeMs === null
    ? null
    : (lastReportAt === null
      ? newAccountAgeMs / HOUR_MS
      : (Date.parse(lastNewAccountAt) - Date.parse(lastReportAt)) / HOUR_MS);
  const inReportingDebt = debtHours !== null && debtHours > REPORTING_DEBT_GRACE_HOURS;

  if (inReportingDebt) {
    notices.push(reportingDebtNotice({ debtHours, blocking: phases.reporter_gate }));
    if (phases.reporter_gate) {
      return {
        allowed: false,
        reason: "usage_reporting_required",
        retry_after_seconds: null,
        premium_share: null,
        notices: withRepeatIntervals(notices),
      };
    }
  }

  // Advisory only: tells somebody how to get cheaper, never holds them back.
  const share = premiumShare({ premiumCost, totalCost });
  const measurable = Number(totalCost || 0) >= PREMIUM_RATIO_MIN_COST;
  if (measurable && share > PREMIUM_RATIO_THRESHOLD) {
    notices.push(ratioNotice({ share }));
  }

  // Refusal targets the real failure. Both halves must hold: the pool is projected to run dry, AND
  // this user is a main reason why. Either alone is not a problem worth throttling somebody over --
  // a shortage nobody is driving needs more accounts, not less work, and a heavy user during
  // abundance is just somebody getting their job done.
  const fairShare = activeUsers >= DEMAND_SHARE_MIN_ACTIVE_USERS
    ? DEMAND_SHARE_TOLERANCE / activeUsers
    : Infinity;
  const demandShare = Number(teamCost || 0) > 0 ? Number(totalCost || 0) / Number(teamCost) : 0;
  const overFairShare = Number.isFinite(fairShare) && demandShare > fairShare;

  // The cooldown only bites while there is something to ration, but the warning goes out as soon as
  // somebody is over the line -- that is what gives them time to change before the pool tightens.
  const cooldownActive = phases.ratio_cooldown && poolScarce;

  if (overFairShare) {
    notices.push(demandShareNotice({ demandShare, fairShare, cooldownActive }));
    if (cooldownActive) {
      const servedAgeMs = msSince(nowMs, lastServedAt);
      const cooldownMs = PREMIUM_RATIO_COOLDOWN_MINUTES * MINUTE_MS;
      if (servedAgeMs !== null && servedAgeMs < cooldownMs) {
        return {
          allowed: false,
          reason: "demand_share_cooldown",
          retry_after_seconds: Math.ceil((cooldownMs - servedAgeMs) / 1000),
          premium_share: measurable ? share : null,
          demand_share: demandShare,
          notices: withRepeatIntervals(notices),
        };
      }
    }
  }

  return {
    allowed: true,
    reason: null,
    retry_after_seconds: null,
    demand_share: demandShare,
    premium_share: measurable ? share : null,
    notices: withRepeatIntervals(notices),
  };
}

export { isPremiumModel };
