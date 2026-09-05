import crypto from "node:crypto";
import { readAuthBlob } from "./auth-blob-storage.js";
import { isHardAuthError } from "./auth-status.js";
import { reportIsFresh } from "./report-freshness.js";

function decodeJwtPayload(token) {
  const payload = token.split(".")[1];
  const normalized = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(normalized, "base64url").toString("utf8"));
}

function jwtExpiresAt(token) {
  if (!token) {
    return null;
  }
  const parts = String(token).split(".");
  if (parts.length < 2 || !parts[1]) {
    return null;
  }
  const payload = decodeJwtPayload(token);
  return payload?.exp ? new Date(payload.exp * 1000).toISOString() : null;
}

function humanPlanName(planType) {
  if (!planType) {
    return null;
  }
  return {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    max: "Max",
  }[planType] || planType;
}

export { humanPlanName };

function canonicalCodexAccountId(rawAccountId, email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (normalizedEmail) {
    return normalizedEmail;
  }
  return String(rawAccountId || "codex-email-missing");
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  let date;
  if (typeof value === "number") {
    date = new Date(value);
  } else if (/^\d+$/.test(String(value))) {
    date = new Date(Number(value));
  } else {
    date = new Date(String(value));
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function encryptionKey() {
  const raw = process.env.AUTH_POOL_ENCRYPTION_KEY || "";
  if (!raw) {
    throw new Error("AUTH_POOL_ENCRYPTION_KEY is not configured");
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) {
    return decoded;
  }
  throw new Error("AUTH_POOL_ENCRYPTION_KEY must be 32 bytes in base64 or 64 hex characters");
}

function deriveCodexAuthPoolEntry(authJsonText, reporter = {}) {
  const payload = JSON.parse(authJsonText);
  const rawAccountId = payload?.tokens?.account_id;
  const identity = decodeJwtPayload(payload?.tokens?.id_token || "");
  const authClaim = identity?.["https://api.openai.com/auth"] || {};
  const accessTokenExpiresAt = jwtExpiresAt(payload?.tokens?.access_token || "");

  if (!rawAccountId) {
    throw new Error("auth json is missing tokens.account_id");
  }

  return {
    source: "codex",
    account_id: canonicalCodexAccountId(rawAccountId, identity?.email),
    session_id: identity?.sid ? String(identity.sid) : null,
    email: identity?.email ? String(identity.email) : null,
    name: identity?.name ? String(identity.name) : null,
    plan_name: humanPlanName(authClaim?.chatgpt_plan_type),
    auth_last_refresh: payload?.last_refresh ? String(payload.last_refresh) : null,
    auth_expires_at: accessTokenExpiresAt || jwtExpiresAt(payload?.tokens?.id_token || ""),
    has_refresh_token: Boolean(String(payload?.tokens?.refresh_token || "").trim()),
    digest: crypto.createHash("sha256").update(authJsonText).digest("hex"),
    reporter_name: reporter.reporter_name ? String(reporter.reporter_name) : null,
    hostname: reporter.hostname ? String(reporter.hostname) : null,
    auth_json: authJsonText,
  };
}

function deriveClaudeAuthPoolEntry(authJsonText, reporter = {}) {
  const payload = JSON.parse(authJsonText);
  if (payload?.schema !== "claude_credentials_v1") {
    throw new Error("claude auth payload must use schema claude_credentials_v1");
  }
  if (!payload?.account_id || !payload?.email || !payload?.credentials) {
    throw new Error("claude auth payload is missing account_id, email, or credentials");
  }

  return {
    source: "claude",
    account_id: String(payload.account_id),
    session_id: payload.session_id ? String(payload.session_id) : null,
    email: String(payload.email),
    name: payload.name ? String(payload.name) : null,
    plan_name: payload.plan_name ? String(payload.plan_name) : null,
    auth_last_refresh: payload.auth_last_refresh ? String(payload.auth_last_refresh) : null,
    auth_expires_at: normalizeTimestamp(payload?.credentials?.claudeAiOauth?.expiresAt),
    has_refresh_token: Boolean(String(payload?.credentials?.claudeAiOauth?.refreshToken || "").trim()),
    digest: crypto.createHash("sha256").update(authJsonText).digest("hex"),
    reporter_name: reporter.reporter_name ? String(reporter.reporter_name) : null,
    hostname: reporter.hostname ? String(reporter.hostname) : null,
    auth_json: authJsonText,
  };
}

export function deriveAuthPoolEntry(source, authJsonText, reporter = {}) {
  if (source === "codex") {
    return deriveCodexAuthPoolEntry(authJsonText, reporter);
  }
  if (source === "claude") {
    return deriveClaudeAuthPoolEntry(authJsonText, reporter);
  }
  throw new Error(`unsupported auth pool source: ${source}`);
}

export function encryptAuthJson(authJsonText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(authJsonText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted_auth_json: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: tag.toString("base64"),
  };
}

export function decryptEncryptedAuthJson(entry) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(entry.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(entry.auth_tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(entry.encrypted_auth_json, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export async function decryptAuthJson(entry) {
  if (entry?.auth_blob_key) {
    return decryptEncryptedAuthJson(await readAuthBlob(entry.auth_blob_key));
  }
  return decryptEncryptedAuthJson(entry);
}

// A window whose reset_at is behind the report's own timestamp is a spent period: the provider has
// rolled it over, and any probe still metering that window would have reported the new one. Treat
// it as "not reported" (-1) so each source's missing-window policy applies — codex reads missing as
// unconstrained, claude as not shareable. Without this, a carried-forward snapshot outlives its
// window: codex Pro probes stopped reporting a 5h window on 2026-08-29, and the last synthesized
// "5h 0%" (paired with a weekly exhaustion) kept failing the 5h≥20% share threshold for five days
// while the account's live weekly window sat at 96%. The merge layer deliberately keeps such
// windows for the dashboard's stale-evidence display (§6.4), so expiry belongs here, at the
// decision boundary. A window without reset_at cannot be judged and keeps its value.
function windowRemainingPercent(report, key) {
  const window = report?.windows?.[key];
  const value = window?.remaining_percent;
  if (value === null || value === undefined) {
    return -1;
  }
  const resetMs = Date.parse(window.reset_at || "");
  const reportedMs = Date.parse(report?.reported_at || "");
  if (Number.isFinite(resetMs) && Number.isFinite(reportedMs) && resetMs <= reportedMs) {
    return -1;
  }
  return Number(value);
}

function recentServedCount(report, options = {}) {
  const counts = options.recent_served_counts || {};
  const value = counts?.[report.account_id] ?? counts?.[String(report.account_id)];
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

// Codex Plus-tier accounts still meter a 5-hour window; only some higher tiers omit it. A missing
// window means "unconstrained", not "exhausted" — treating it as exhausted would zero the account's
// weight and silently evict every windowless account from the pool.
function codexFiveHourOrUnconstrained(value) {
  return value >= 0 ? value : 100;
}

function candidateQuotaWeight(report) {
  const fiveHour = windowRemainingPercent(report, "5h");
  const weekly = windowRemainingPercent(report, "1week");
  const remaining = report?.source === "codex"
    ? Math.min(codexFiveHourOrUnconstrained(fiveHour), weekly)
    : Math.min(fiveHour, weekly);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return 0;
  }
  return Math.pow(remaining, 0.25);
}

function deterministicUnitInterval(seed) {
  const digest = crypto.createHash("sha256").update(seed).digest();
  const value = digest.readUInt32BE(0);
  return (value + 1) / 0x100000001;
}

function projectedWeightedLoad(report, options = {}) {
  const weight = candidateQuotaWeight(report);
  if (weight <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const selectionKey = String(options.selection_key || "");
  const weightedSample = selectionKey
    ? -Math.log(deterministicUnitInterval(`${selectionKey}:${report.source}:${report.account_id}`))
    : 1;
  const recentPenaltyDivisor = Number(options.recent_count_penalty_divisor ?? 25);
  const recentPenalty = recentPenaltyDivisor > 0
    ? recentServedCount(report, options) / recentPenaltyDivisor
    : 0;
  return (weightedSample + recentPenalty) / weight;
}

function isHardInvalidation(report) {
  return (
    report?.status === "error" &&
    isHardAuthError(report?.error, { includeNonRefresh: true })
  );
}

function accessTokenExpired(entry, options = {}) {
  const expiresMs = Date.parse(entry?.auth_expires_at || "");
  if (!Number.isFinite(expiresMs)) {
    return false;
  }
  const nowMs = options.now ? Date.parse(options.now) : Date.now();
  return Number.isFinite(nowMs) && expiresMs <= nowMs;
}

function isPoolIneligible(report) {
  return isHardInvalidation(report) || report?.plan_name === "Free";
}

// "Unusable until T" from a limit-hit probe. Compared against options.now (the reportIsFresh
// pattern) so the policy layer stays clock-free; a past deadline makes the field inert.
function isExhausted(report, options = {}) {
  const untilMs = Date.parse(report?.exhausted_until || "");
  if (!Number.isFinite(untilMs)) {
    return false;
  }
  const nowMs = options.now ? Date.parse(options.now) : Date.now();
  return Number.isFinite(nowMs) && untilMs > nowMs;
}

function candidateBeatsCurrent(report, current) {
  const candidateFiveHour = windowRemainingPercent(report, "5h");
  const candidateWeekly = windowRemainingPercent(report, "1week");

  if (report?.source === "codex") {
    // Same 5H x 1week product rule as Claude, except a missing 5h window (either side) counts as
    // unconstrained: the client sends -1 for a window its probe did not see.
    if (candidateWeekly <= 0 || codexFiveHourOrUnconstrained(candidateFiveHour) <= 0) {
      return false;
    }
    const currentWeekly = Number(current?.one_week_remaining_percent ?? -1);
    if (currentWeekly < 0) {
      return true;
    }
    const currentFiveHour = codexFiveHourOrUnconstrained(Number(current?.five_h_remaining_percent ?? -1));
    return codexFiveHourOrUnconstrained(candidateFiveHour) * candidateWeekly > currentFiveHour * currentWeekly;
  }

  if (candidateFiveHour <= 0 || candidateWeekly <= 0) {
    return false;
  }

  const currentFiveHour = Number(current?.five_h_remaining_percent ?? -1);
  const currentWeekly = Number(current?.one_week_remaining_percent ?? -1);
  if (currentFiveHour < 0 || currentWeekly < 0) {
    return true;
  }

  return candidateFiveHour * candidateWeekly > currentFiveHour * currentWeekly;
}

function candidateMeetsShareThreshold(report, options = {}) {
  const minFiveHour = Number(options.min_candidate_five_h_remaining_percent ?? 20);
  const minWeekly = Number(options.min_candidate_one_week_remaining_percent ?? 5);
  const fiveHour = windowRemainingPercent(report, "5h");
  if (report?.source === "codex") {
    return (
      windowRemainingPercent(report, "1week") >= minWeekly &&
      codexFiveHourOrUnconstrained(fiveHour) >= minFiveHour
    );
  }
  return fiveHour >= minFiveHour && windowRemainingPercent(report, "1week") >= minWeekly;
}

export function pickBestAuthPoolCandidate(reports, authPoolEntries, options = {}) {
  const exclude = new Set(options.exclude_account_ids || []);
  if (options.current_account_id) {
    exclude.add(String(options.current_account_id));
  }
  const source = String(options.source || "codex");
  const entryByAccount = new Map();
  for (const entry of authPoolEntries) {
    if (!entryByAccount.has(entry.account_id)) {
      entryByAccount.set(entry.account_id, entry);
    }
  }

  const eligibleCandidates = reports
    .filter((report) => report.source === source)
    .filter((report) => !exclude.has(report.account_id))
    .filter((report) => !isPoolIneligible(report))
    .filter((report) => !isExhausted(report, options))
    .filter((report) => reportIsFresh(report, options))
    .filter((report) => entryByAccount.has(report.account_id))
    // A dead refresh token no longer disqualifies an account (isPoolIneligible reads the probe, not
    // the verdict): a live access token is still worth lending. What does disqualify it is that token
    // having run out -- nobody can renew it, so serving it hands the borrower a dead credential.
    .filter((report) => !accessTokenExpired(entryByAccount.get(report.account_id), options))
    .filter((report) => candidateMeetsShareThreshold(report, options))
    .filter((report) => candidateBeatsCurrent(report, options.current_quota));

  const candidates = eligibleCandidates
    .sort((left, right) => {
      const loadDelta = projectedWeightedLoad(left, options) - projectedWeightedLoad(right, options);
      if (loadDelta !== 0) {
        return loadDelta;
      }
      const weightDelta = candidateQuotaWeight(right) - candidateQuotaWeight(left);
      if (weightDelta !== 0) {
        return weightDelta;
      }
      if (source === "codex") {
        const weeklyDelta = windowRemainingPercent(right, "1week") - windowRemainingPercent(left, "1week");
        if (weeklyDelta !== 0) {
          return weeklyDelta;
        }
        const fiveHourDelta = windowRemainingPercent(right, "5h") - windowRemainingPercent(left, "5h");
        if (fiveHourDelta !== 0) {
          return fiveHourDelta;
        }
        return String(right.reported_at || "").localeCompare(String(left.reported_at || ""));
      }
      const fiveHourDelta = windowRemainingPercent(right, "5h") - windowRemainingPercent(left, "5h");
      if (fiveHourDelta !== 0) {
        return fiveHourDelta;
      }
      const weeklyDelta = windowRemainingPercent(right, "1week") - windowRemainingPercent(left, "1week");
      if (weeklyDelta !== 0) {
        return weeklyDelta;
      }
      return String(right.reported_at || "").localeCompare(String(left.reported_at || ""));
    });

  if (!candidates.length) {
    return null;
  }

  const report = candidates[0];
  return {
    entry: entryByAccount.get(report.account_id),
    report,
  };
}

export function shouldReplaceAuthPoolEntry(existingEntry, incomingEntry) {
  if (!existingEntry) {
    return true;
  }
  if (existingEntry.source !== incomingEntry.source || existingEntry.account_id !== incomingEntry.account_id) {
    return true;
  }

  const existingRefresh = String(existingEntry.auth_last_refresh || "");
  const incomingRefresh = String(incomingEntry.auth_last_refresh || "");

  if (existingRefresh && incomingRefresh) {
    return incomingRefresh > existingRefresh;
  }

  if (existingRefresh && !incomingRefresh) {
    return false;
  }

  if (!existingRefresh && incomingRefresh) {
    return true;
  }

  return existingEntry.digest !== incomingEntry.digest;
}
