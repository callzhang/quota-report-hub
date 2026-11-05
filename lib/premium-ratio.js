import { PREMIUM_MODEL_IDS, SUGGESTED_STANDARD_MODEL_IDS, isPremiumModel, modelCostSql } from "./model-tiers.js";
import { SCARCITY_BURN_WINDOW_DAYS } from "./pool-scarcity.js";

// The premium share only ever advises. It is a proxy for "you are expensive", and once usage is
// priced there is no reason to enforce a proxy instead of the thing itself: a user at 90% premium on
// a tiny volume costs the pool nothing and should never be held back. What the share is still good
// for is telling somebody the one concrete action that would make them cheaper.
export const PREMIUM_RATIO_THRESHOLD = 0.5;
export const PREMIUM_RATIO_WINDOW_DAYS = 7;

// Below this much spend in the window the share is noise, not a habit.
export const PREMIUM_RATIO_MIN_COST = 1.0;

// Refusal targets the actual failure: the pool running dry. While it is, each user may spend up to
// the fair-share cap (`fairShareCap`, lib/pool-scarcity.js) over the scarcity window, and the pool
// stops handing new capacity to whoever is over it. Not an absolute cap -- those punish finishing a
// task in one conversation, since every turn replays the whole context -- and not a rank: the cap is
// whatever the pool's supply can actually cover, so it widens by itself as quota arrives and nobody
// is held at all while there is enough to go round.
//
// One flat cooldown, no per-path or per-severity multipliers. Severity is already encoded in how
// long a user stays above the line.
//
// This throttles how often a non-contributor may draw on the pool; it does not stop them working.
// The upper bound is set by the codex id_token, which goes stale about an hour after issue: past that
// a held user cannot refresh at all and stops outright, turning a rate limit into an outage. Thirty
// minutes leaves a full margin under that, while cutting a fetch every five minutes to one every
// thirty.
export const PREMIUM_RATIO_COOLDOWN_MINUTES = 30;

// The floor tracks the shipped client exactly: whatever version this commit's reporter is, that is
// what the hub demands. Anything older is refused on both the write paths and the fetch path, and
// the refusal drives the client's own updater (see enforce_hub_upgrade_demand in quota_guard.py),
// so "too old to be trusted" and "must upgrade now" are the same statement. A test binds this to
// reporter_version.py; the pair moves together or the suite fails.
//
// A client NEWER than the hub is allowed through. During a deploy the two halves of a single commit
// land seconds apart, and refusing the half that arrived first would take the fleet down over a
// race with itself.
//
// 2.4.0 was the first client that could not charge a cumulative counter as fresh usage, and the
// first whose heartbeat said whether its own updater was working. 2.5.0 is the first that repairs
// the history the old ones got wrong, which is why the floor moves with it: a machine kept on an
// older client is a machine whose months of bad numbers nobody can correct.
export const MIN_REPORTER_CLIENT_VERSION = "2.5.0";

// How long after the pool hands over a NEW account a user has to account for what they did with it.
// The clock starts on a `served` event only, never on `refreshed_current`: an idle user's guard keeps
// refreshing to hold the token alive, so charging refreshes would run the debt up on somebody who is
// not working -- and they cannot repay it without working. Being given new capacity and reporting
// nothing is the actual offence.
export const REPORTING_DEBT_GRACE_HOURS = 24;

// How often a client re-shows a notice. Sent by the hub rather than compiled into the client so the
// cadence can be re-tuned without waiting for a release to propagate to every machine. Two cadences,
// chosen by the notice itself: a notice about something that is holding the user back right now
// (an outdated client, a live cooldown, a refused fetch) is worth repeating within the day, because
// acting on it changes their situation within the hour. A warning that refuses nothing and measures
// a seven-day rolling share cannot be acted on any faster than the window it measures moves --
// re-toasting the same percentage four times a day is exactly the nagging that gets a warning
// dismissed unread (2026-09-09: two advisories, eight toasts a day, no change in the number).
export const NOTICE_REPEAT_SECONDS = 6 * 60 * 60;
export const ADVISORY_NOTICE_REPEAT_SECONDS = 24 * 60 * 60;

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
// Drawing on the pool without supplying it is cooled down from this date.
export const PHASE_COOLDOWN_AT = phaseDate("POOL_COOLDOWN_AT", "2026-09-21T00:00:00.000Z");
// The fair-share cap replaced the 80th-percentile demand-share cooldown on 2026-11-04. Its notices
// flow from the first request; refusals wait for this date so the new rule is read before it bites.
export const PHASE_FAIR_SHARE_AT = phaseDate("POOL_FAIR_SHARE_AT", "2026-11-09T00:00:00.000Z");

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
    cooldown: phaseActive(nowMs, PHASE_COOLDOWN_AT),
    fair_share: phaseActive(nowMs, PHASE_FAIR_SHARE_AT),
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
// earns nor loses premium headroom. input_tokens includes the cache for every provider, so the
// cost expression subtracts it back out to price fresh input.
// Re-exported so callers have one import for the whole policy, and so the JS and SQL forms of the
// same arithmetic stay visibly paired. Tests assert they agree on identical rows.
export { modelCost } from "./model-tiers.js";

export const MODEL_COST_SQL = modelCostSql();

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
    repeat_seconds: NOTICE_REPEAT_SECONDS,
    message:
      `你已从共享池取用 auth，但超过 ${humanDuration(debtHours)}没有上报任何用量，` +
      `Hub 无法统计你的模型使用情况。${suffix}` +
      "请确认 quota_guard 的 15 分钟定时任务在运行，或重新执行一次安装脚本。",
  };
}

export function upgradeNotice() {
  return {
    code: "reporter_upgrade_required",
    title: "额度守护需要升级",
    repeat_seconds: NOTICE_REPEAT_SECONDS,
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
    repeat_seconds: ADVISORY_NOTICE_REPEAT_SECONDS,
    message:
      `你近 ${PREMIUM_RATIO_WINDOW_DAYS} 天高级模型（${PREMIUM_EXAMPLES} 等）占了金额开销的 ` +
      `${Math.round(share * 1000) / 10}%，目标 ≤ ${Math.round(PREMIUM_RATIO_THRESHOLD * 100)}%。` +
      `把默认模型换成 ${SUGGESTED_EXAMPLES} 能显著降低对共享池的消耗。这条只是提醒，不影响取号。`,
  };
}

const SOURCE_LABELS = { codex: "Codex", claude: "Claude" };

function fairShareNotice({ source, spendUsd, capUsd, blocking }) {
  const label = SOURCE_LABELS[source] || source;
  const standing =
    `共享池的 ${label} 账号当前供不应求，按池子剩余额度公平分配，每人近 ${SCARCITY_BURN_WINDOW_DAYS} 天最多用 ` +
    `$${Math.floor(capUsd)}，你用了 $${Math.round(spendUsd)}（含你自己上传的账号，它也在共享池里）。`;
  const recovery =
    `近 ${SCARCITY_BURN_WINDOW_DAYS} 天的用量逐日滚出、或池子补进新额度后自动恢复；` +
    `把默认模型换成 ${SUGGESTED_EXAMPLES} 能更快回到额度以内。`;
  if (blocking) {
    return {
      code: "fair_share_cap",
      title: "取号已暂停",
      repeat_seconds: NOTICE_REPEAT_SECONDS,
      message:
        standing +
        "在回到额度以内之前，不再给你换号，也不再续期你借用的账号——" +
        "你手上正在用的账号不受影响，你自己上传的账号照常续期。" +
        recovery,
    };
  }
  return {
    code: "fair_share_warning",
    title: "超出公平额度",
    // Refuses nothing, so it takes the advisory cadence like every other warning.
    repeat_seconds: ADVISORY_NOTICE_REPEAT_SECONDS,
    message:
      standing +
      `${PHASE_FAIR_SHARE_AT.slice(0, 10)} 起，这种情况下不会再给你换号或续期借用的账号` +
      "（你自己上传的账号照常续期）。" +
      recovery,
  };
}

function contributionNotice({ cooldownActive }) {
  const standing = "共享池里的账号都是同事上传的，而你没有一个可用账号在池子里。";
  if (cooldownActive) {
    return {
      code: "contribution_cooldown",
      title: "取号已限速",
      repeat_seconds: NOTICE_REPEAT_SECONDS,
      message:
        `共享池当前供不应求，而${standing}` +
        `取号被暂缓，最多 ${PREMIUM_RATIO_COOLDOWN_MINUTES} 分钟后自动恢复——` +
        "这是限速，不是封禁，你手上正在用的账号在此期间仍然有效。" +
        "让额度守护把你自己的 Codex 或 Claude 账号同步进池子（账号被登出、或是 Free 版都不算可用），" +
        "或等池子供给恢复，限速即解除。",
    };
  }
  return {
    code: "contribution_warning",
    title: "你没有向共享池供给账号",
    repeat_seconds: ADVISORY_NOTICE_REPEAT_SECONDS,
    message:
      standing +
      `${PHASE_COOLDOWN_AT.slice(0, 10)} 起，池子供不应求时，这种情况会把取号限速到每 ` +
      `${PREMIUM_RATIO_COOLDOWN_MINUTES} 分钟一次（限速会自动恢复，不影响已在使用的账号）。` +
      "让额度守护把你自己的 Codex 或 Claude 账号同步进池子即可避免。",
  };
}

function contributionRequiredNotice() {
  return {
    code: "contribution_required",
    title: "取号需要先向共享池供给账号",
    repeat_seconds: NOTICE_REPEAT_SECONDS,
    message:
      "管理员已开启共享池的供给要求：只有向池子供给了可用账号的成员才能从池子取号。" +
      "共享池里的账号都是同事上传的，而你没有一个可用账号在池子里。" +
      "让额度守护把你自己的 Codex 或 Claude 账号同步进池子（账号被登出、或是 Free 版都不算可用）即可恢复取号。" +
      "这不会立刻中断你正在用的账号，但它的访问令牌到期后，续期同样需要先供给账号；" +
      "你自己上传后失效的账号仍会交还给你重新登录。",
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
  source = "codex",
  fairShareSpendUsd = 0,
  fairShareCapUsd = null,
  cooldownStartedAt = null,
  hasHealthyUpload = true,
  poolScarce = false,
  requireContribution = false,
  enforcementEnabled = true,
  forced = false,
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
    if (phases.reporter_gate && enforcementEnabled) {
      return {
        allowed: false,
        reason: "reporter_upgrade_required",
        retry_after_seconds: null,
        premium_share: null,
        notices,
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
    const reportingBlocked = phases.reporter_gate && enforcementEnabled;
    notices.push(reportingDebtNotice({ debtHours, blocking: reportingBlocked }));
    if (reportingBlocked) {
      return {
        allowed: false,
        reason: "usage_reporting_required",
        retry_after_seconds: null,
        premium_share: null,
        notices,
      };
    }
  }

  // Advisory only: tells somebody how to get cheaper, never holds them back.
  const share = premiumShare({ premiumCost, totalCost });
  const measurable = Number(totalCost || 0) >= PREMIUM_RATIO_MIN_COST;
  if (measurable && share > PREMIUM_RATIO_THRESHOLD) {
    notices.push(ratioNotice({ share }));
  }

  // Refusal targets the real failure: the pool is projected to run dry and this user has spent more
  // than the supply can cover for everyone. The cap exists only while the pool is scarce (null
  // otherwise), so a heavy user during abundance is never even warned. Not liftable by `forced`:
  // the shortcut skips a wait, and this is not a wait -- a flag any client can send would otherwise
  // make the cap optional for exactly the people it exists for.
  const overFairShare = fairShareCapUsd !== null && Number(fairShareSpendUsd || 0) > fairShareCapUsd;
  if (overFairShare) {
    const blocking = phases.fair_share && enforcementEnabled;
    notices.push(fairShareNotice({ source, spendUsd: fairShareSpendUsd, capUsd: fairShareCapUsd, blocking }));
    if (blocking) {
      return {
        allowed: false,
        reason: "fair_share_cap",
        retry_after_seconds: null,
        premium_share: measurable ? share : null,
        fair_share_cap_usd: fairShareCapUsd,
        notices,
      };
    }
  }

  // Scarcity is the condition the contribution cooldown below exists to address.
  const cooldownConfigured = phases.cooldown && poolScarce;
  const cooldownAgeMs = msSince(nowMs, cooldownStartedAt);
  const cooldownMs = PREMIUM_RATIO_COOLDOWN_MINUTES * MINUTE_MS;
  // Entering a cooldown is itself a refusal: the first request starts the clock, retries leave that
  // clock alone, and the first request after the full interval is served. A successful serve clears
  // the completed cycle in the store, so the next request starts a new one rather than borrowing the
  // elapsed interval forever.
  //
  // `forced` is the person at the keyboard asking for this one fetch to go through (the desktop
  // "refresh codex account" shortcut). It lifts the wait for that request only: the notices still
  // say where the user stands, and it never touches the version or reporting gates, which are
  // measurement preconditions rather than rationing.
  const cooldownBlocked = enforcementEnabled
    && cooldownConfigured
    && !forced
    && (cooldownAgeMs === null || cooldownAgeMs < cooldownMs);
  const cooldownRetrySeconds = Math.ceil((cooldownMs - (cooldownAgeMs ?? 0)) / 1000);

  // The pool has one supply: accounts colleagues put into it. Every rule above rations demand, and
  // rationing demand cannot create a single point of quota -- when the pool runs dry the only remedy
  // is another account in it. So supply gets the same treatment demand does: draw on the pool without
  // supplying it and, while it is short, you draw more slowly than the people who do.
  //
  // Not payment for access. Somebody with nothing poolable (a Free plan, a dead login) is never
  // locked out -- one fetch per cooldown, still holding the account they
  // have, and still handed their own invalidated auth back to re-login, which is precisely how a
  // non-contributor stops being one. Warn as soon as the condition holds so people can act, throttle
  // only once there is something to ration. Ordered after the fair-share cap, so a user who is both
  // hears about the spend first -- that is the one costing the pool priced demand today.
  if (!hasHealthyUpload) {
    // The admin's hard mode, distinct from the scarcity cooldown below: with the
    // require_contribution flag on, supplying the pool is a precondition for drawing on it,
    // abundance or not. The flag itself is the kill switch (default OFF), and the repair path
    // stays open in the handler, so a non-contributor can always recover their own account.
    if (requireContribution) {
      notices.push(contributionRequiredNotice());
      return {
        allowed: false,
        reason: "contribution_required",
        retry_after_seconds: null,
        premium_share: measurable ? share : null,
        fair_share_cap_usd: fairShareCapUsd,
        notices,
      };
    }
    notices.push(contributionNotice({ cooldownActive: cooldownBlocked }));
    if (cooldownBlocked) {
      return {
        allowed: false,
        reason: "contribution_cooldown",
        retry_after_seconds: cooldownRetrySeconds,
        premium_share: measurable ? share : null,
        fair_share_cap_usd: fairShareCapUsd,
        notices,
      };
    }
  }

  return {
    allowed: true,
    reason: null,
    retry_after_seconds: null,
    fair_share_cap_usd: fairShareCapUsd,
    premium_share: measurable ? share : null,
    notices,
  };
}

export { isPremiumModel };
