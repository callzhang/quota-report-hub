import { STANDARD_MODEL_IDS, isPremiumModel } from "./model-tiers.js";

// A user's premium share is capped, not their absolute volume. Absolute caps punish finishing a
// task in one conversation: every turn replays the whole context, so a long session costs 33x its
// own new tokens, and that ratio is a mechanical consequence of not throwing the context away —
// not a choice. Model selection IS a choice, made fresh on every turn. Cap the choice.
export const PREMIUM_RATIO_THRESHOLD = 0.5;
export const PREMIUM_RATIO_WINDOW_DAYS = 7;

// Below this much weighted usage in the window the share is noise, not a habit.
export const PREMIUM_RATIO_MIN_WEIGHTED_TOKENS = 10_000_000;

// One flat cooldown, no per-path or per-severity multipliers. Severity is already encoded in how
// long a user stays above the line: at 95% every request hits the cooldown, at 55% they drop back
// under within a day or two. Scaling the individual wait on top of that just adds a second dial
// nobody can reason about.
export const PREMIUM_RATIO_COOLDOWN_MINUTES = 30;

// A user with no usage report at all this window gets told so, but is never refused for it. The
// collector only posts when there IS usage, so "no recent report" is indistinguishable from "took
// the afternoon off" -- and refusing on it would deadlock anyone returning from leave: no auth
// means no usage, and no usage means no report to lift the refusal with.
export const REPORTER_STALE_HOURS = 48;

export const MIN_REPORTER_CLIENT_VERSION = "2.0.0";

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
export function weightedTokens(row) {
  const input = Number(row?.input_tokens || 0);
  const output = Number(row?.output_tokens || 0);
  const cacheRead = Number(row?.cache_read_tokens || 0);
  const cacheWrite = Number(row?.cache_write_tokens || 0);
  const freshInput = String(row?.provider) === "codex" ? input - cacheRead : input;
  return Math.max(0, freshInput) + 0.1 * cacheRead + cacheWrite + output;
}

// The SQL twin of weightedTokens. Kept beside it so the two cannot drift apart unnoticed;
// tests assert they agree on the same rows.
export const WEIGHTED_TOKENS_SQL = `(
  MAX(0, CASE WHEN provider = 'codex' THEN input_tokens - cache_read_tokens ELSE input_tokens END)
  + 0.1 * cache_read_tokens
  + cache_write_tokens
  + output_tokens
)`;

export function premiumShare({ premiumWeighted, totalWeighted }) {
  const total = Number(totalWeighted || 0);
  if (!(total > 0)) return 0;
  return Number(premiumWeighted || 0) / total;
}

function upgradeNotice() {
  return {
    code: "reporter_upgrade_required",
    title: "额度守护需要升级",
    message:
      "你的额度守护版本过旧或未上报用量，Hub 无法统计你的模型使用占比。" +
      `${PHASE_REPORTER_GATE_AT.slice(0, 10)} 起将停止为未上报的客户端续发 auth。` +
      "请运行 quota_guard 让它自动升级，或重新执行安装脚本。",
  };
}

function ratioNotice({ share, cooldownActive }) {
  const percent = Math.round(share * 1000) / 10;
  const target = Math.round(PREMIUM_RATIO_THRESHOLD * 100);
  const suffix = cooldownActive
    ? `已超过 ${target}%，每次取号需间隔 ${PREMIUM_RATIO_COOLDOWN_MINUTES} 分钟。`
    : `${PHASE_RATIO_COOLDOWN_AT.slice(0, 10)} 起超过 ${target}% 将进入 ${PREMIUM_RATIO_COOLDOWN_MINUTES} 分钟取号冷却。`;
  return {
    code: cooldownActive ? "premium_ratio_cooldown" : "premium_ratio_warning",
    title: "高级模型占比偏高",
    message:
      `你近 ${PREMIUM_RATIO_WINDOW_DAYS} 天的高级模型占比为 ${percent}%（目标 ≤ ${target}%）。${suffix}` +
      "把日常任务的默认模型改为 gpt-5.5 即可回到目标区间。",
  };
}

// Decides whether this fetch-best request may be served, and what to tell the user either way.
// Pure: every input is passed in, so the whole policy is testable without a database or a clock.
export function evaluateFetchPolicy({
  now = new Date(),
  lastReportAt = null,
  requestClientVersion = null,
  premiumWeighted = 0,
  totalWeighted = 0,
  lastServedAt = null,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const phases = activePhases(new Date(nowMs));
  const notices = [];

  // The gate reads the version off the request being gated. Inferring it from the last usage batch
  // would lock out a fresh install permanently: its first act is to fetch auth, before it has any
  // usage to report, so it would have no recorded version and no way to earn one.
  const outdated = clientNeedsUpgrade(requestClientVersion);
  const reportAgeMs = msSince(nowMs, lastReportAt);
  const reporterSilent = reportAgeMs === null || reportAgeMs > REPORTER_STALE_HOURS * HOUR_MS;

  if (outdated || reporterSilent) {
    notices.push(upgradeNotice());
    if (outdated && phases.reporter_gate) {
      return {
        allowed: false,
        reason: "reporter_upgrade_required",
        retry_after_seconds: null,
        premium_share: null,
        notices,
      };
    }
  }

  const share = premiumShare({ premiumWeighted, totalWeighted });
  const measurable = Number(totalWeighted || 0) >= PREMIUM_RATIO_MIN_WEIGHTED_TOKENS;
  const overThreshold = measurable && share > PREMIUM_RATIO_THRESHOLD;

  if (overThreshold) {
    notices.push(ratioNotice({ share, cooldownActive: phases.ratio_cooldown }));
    if (phases.ratio_cooldown) {
      const servedAgeMs = msSince(nowMs, lastServedAt);
      const cooldownMs = PREMIUM_RATIO_COOLDOWN_MINUTES * MINUTE_MS;
      if (servedAgeMs !== null && servedAgeMs < cooldownMs) {
        return {
          allowed: false,
          reason: "premium_ratio_cooldown",
          retry_after_seconds: Math.ceil((cooldownMs - servedAgeMs) / 1000),
          premium_share: share,
          notices,
        };
      }
    }
  }

  return { allowed: true, reason: null, retry_after_seconds: null, premium_share: measurable ? share : null, notices };
}

export const STANDARD_MODEL_ID_LIST = STANDARD_MODEL_IDS;
export { isPremiumModel };
