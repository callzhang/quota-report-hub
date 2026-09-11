import { isAuthInvalidationError, refreshValidityFromReport } from "./auth-status.js";
import { deriveAccountAvailability } from "./account-availability.js";
import { windowEvidenceLive } from "./report-freshness.js";

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// "Account unusable until T" is account-level evidence from a limit-hit response, not a window
// measurement — the client reports it instead of fabricating per-window zeros (a codex Pro
// account meters no 5h window; a synthesized "5h 0%" once outlived its reset by five days and
// blocked selection of a 96%-weekly account). Normalized to ISO or null; consumers compare it to
// a clock, so a stale value in the past is inert by construction. Only strings are accepted, and a
// bare-number string is rejected too: Date.parse of a number (or a numeric string) reads it as a
// calendar year (3600 -> year 3600), so a plausible client bug — sending a duration instead of a
// timestamp — must fail closed to null, not become a multi-century future deadline.
export function normalizeExhaustedUntil(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  if (Number.isFinite(Number(value))) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sanitizeWindow(input, defaultMinutes, capturedAt) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const usedPercent = toFiniteNumber(input.used_percent);
  const remainingPercent = toFiniteNumber(input.remaining_percent);
  const resetInSeconds = toFiniteNumber(input.reset_in_seconds);
  const windowMinutes = toFiniteNumber(input.window_minutes) ?? defaultMinutes;
  const resetAt = input.reset_at ? String(input.reset_at) : null;

  if (
    usedPercent === null &&
    remainingPercent === null &&
    resetInSeconds === null &&
    resetAt === null
  ) {
    return null;
  }

  return {
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    window_minutes: windowMinutes,
    reset_in_seconds: resetInSeconds,
    reset_at: resetAt,
    captured_at: capturedAt,
  };
}

function isExpiredClaudeClientStatuslineWindow(input, window) {
  if (!window) {
    return false;
  }
  if (String(input?.source || "") !== "claude") {
    return false;
  }
  if (normalizeReportOrigin(input) !== "client") {
    return false;
  }
  if (input?.usage_summary?.quota_source !== "statusline_snapshot") {
    return false;
  }
  const resetAt = Date.parse(window.reset_at || "");
  const reportedAt = Date.parse(input?.reported_at || "");
  return Number.isFinite(resetAt) && Number.isFinite(reportedAt) && resetAt <= reportedAt;
}

function normalizeReportOrigin(input) {
  const explicit = String(input?.report_origin || "").trim().toLowerCase();
  if (explicit === "client" || explicit === "worker") {
    return explicit;
  }
  if (input?.usage_summary?.probe_source === "github_actions_worker") {
    return "worker";
  }
  return "unknown";
}

export function sanitizeReport(input) {
  const now = new Date().toISOString();
  const reportedAtInput = input.reported_at ?? now;
  const reportedAtMs = Date.parse(String(reportedAtInput));
  if (!Number.isFinite(reportedAtMs)) {
    throw new TypeError("reported_at must be a valid timestamp");
  }
  const reportedAt = String(reportedAtInput);
  const rawFiveHour = sanitizeWindow(input.windows?.["5h"], 300, reportedAt);
  const rawOneWeek = sanitizeWindow(input.windows?.["1week"], 10080, reportedAt);
  const fiveHour = isExpiredClaudeClientStatuslineWindow(input, rawFiveHour) ? null : rawFiveHour;
  const oneWeek = isExpiredClaudeClientStatuslineWindow(input, rawOneWeek) ? null : rawOneWeek;
  return {
    source: String(input.source || "unknown"),
    hostname: String(input.hostname || "unknown-host"),
    reporter_name: String(input.reporter_name || "unknown"),
    reported_at: reportedAt,
    account_id: String(input.account_id || "unknown-account"),
    email: input.email ? String(input.email) : null,
    name: input.name ? String(input.name) : null,
    plan_name: input.plan_name ? String(input.plan_name) : null,
    auth_path: input.auth_path ? String(input.auth_path) : null,
    auth_last_refresh: input.auth_last_refresh ? String(input.auth_last_refresh) : null,
    status: String(input.status || "ok"),
    error: input.error ? String(input.error) : null,
    model_context_window: input.model_context_window || null,
    usage_summary: input.usage_summary && typeof input.usage_summary === "object" ? input.usage_summary : null,
    report_origin: normalizeReportOrigin(input),
    windows_stale: Boolean(input.windows_stale),
    exhausted_until: normalizeExhaustedUntil(input.exhausted_until),
    windows: {
      "5h": fiveHour,
      "1week": oneWeek,
    },
  };
}

function mergeWindow(previousWindow, incomingWindow) {
  return incomingWindow ?? previousWindow ?? null;
}

function resetAtMs(window) {
  const value = Date.parse(window?.reset_at || "");
  return Number.isFinite(value) ? value : null;
}

function reportAtMs(report) {
  const value = Date.parse(report?.reported_at || "");
  return Number.isFinite(value) ? value : null;
}

const ANCHOR_TOLERANCE_MS = 5 * 60 * 1000;

// Two reports describe the same window when their reset times agree; a difference either way means
// one of them is talking about a different window.
function anchorMoved(previousWindow, incomingWindow) {
  const previousResetMs = resetAtMs(previousWindow);
  const incomingResetMs = resetAtMs(incomingWindow);
  if (previousResetMs === null || incomingResetMs === null) {
    return false;
  }
  return Math.abs(incomingResetMs - previousResetMs) > ANCHOR_TOLERANCE_MS;
}

// The anchor a client last asked to move to, carried on the row so the next report can confirm it.
// Kept in usage_summary rather than a column: it is per-window bookkeeping about one row's merge
// history, and mergeLatestReport must stay pure -- no clock, no database, no second query.
function proposedAnchor(report, windowName) {
  return report?.usage_summary?.anchor_candidate?.[windowName] ?? null;
}

// Who may move a window's anchor.
//
// The rule this replaces asked whether the incoming reset_at jumped forward before the stored one
// expired, and preserved the stored window if so. That is unsound in both directions. Forward: a
// codex "Full reset" credit grants a brand-new weekly window on the spot, which is a supported
// product action and looks identical to the fabrication the rule was written for -- so the stored
// window became its own comparison baseline and nothing could lift it until the *preserved* reset
// passed, up to a week away (ceshi@stardust.ai showed 100% used for 37 hours while its own usage
// screen read 36% left). Backward: the rule only tested forward jumps, so a lone misattributed
// report that moved the anchor EARLIER sailed through -- and then poisoned the baseline that
// refused every later correct report. Measured over 82,703 events: 481 correct refusals against
// 560 wrong ones.
//
// What the same month says about origin is unambiguous. Correct refusals were 393 client / 2
// worker; wrong refusals were 248 worker / 98 client. The worker probes a pooled blob in an
// isolated CODEX_HOME on a clean runner (55ddeae); the client population is the entire threat.
// So: a worker report re-anchors immediately, and a client report must be confirmed by the next
// report before its anchor applies. Measured on the same data, that holds 1,409 client outliers
// out and admits 919 real re-anchors at a median delay of 2.8 minutes (p90 15.6).
//
// Refusing client re-anchors outright was measured and rejected: the worker SKIPS probing an
// account whose client just reported (probeSkipReason, SYSTEM_DESIGN §7.2), so waiting for a worker
// report on exactly those accounts costs a median 4.6 hours.
function mergeTrustedWindow(previousReport, incomingReport, windowName) {
  const previousWindow = previousReport.windows?.[windowName];
  const incomingWindow = incomingReport.windows?.[windowName];
  if (!incomingWindow || !previousWindow) {
    return mergeWindow(previousWindow, incomingWindow);
  }
  if (!anchorMoved(previousWindow, incomingWindow)) {
    return incomingWindow;
  }
  // The stored window is over. There is nothing left to protect: any anchor now describes a window
  // that started after the old one closed, so no corroboration is required and demanding it would
  // just delay every ordinary weekly rollover.
  const previousResetMs = resetAtMs(previousWindow);
  const incomingReportedMs = reportAtMs(incomingReport);
  if (previousResetMs !== null && incomingReportedMs !== null && incomingReportedMs >= previousResetMs) {
    return incomingWindow;
  }
  if (reportOrigin(incomingReport) === "worker") {
    return incomingWindow;
  }
  const confirmsItsOwnProposal =
    proposedAnchor(previousReport, windowName) === incomingWindow.reset_at;
  return confirmsItsOwnProposal ? incomingWindow : previousWindow;
}

// Record an unconfirmed client proposal so the next report can confirm it, and clear it once the
// anchor is settled. Only the proposal is kept -- never the numbers, which would be a second place
// for quota to live.
function anchorCandidates(previousReport, incomingReport, mergedByWindow) {
  const candidate = {};
  for (const windowName of ["5h", "1week"]) {
    const incomingWindow = incomingReport.windows?.[windowName];
    if (
      incomingWindow &&
      mergedByWindow[windowName] !== incomingWindow &&
      anchorMoved(previousReport.windows?.[windowName], incomingWindow)
    ) {
      candidate[windowName] = incomingWindow.reset_at;
    }
  }
  return Object.keys(candidate).length ? candidate : null;
}

function hasCompleteWindow(window) {
  return Boolean(
    window &&
    window.remaining_percent !== null &&
    window.remaining_percent !== undefined &&
    window.reset_at
  );
}

function reportSource(report) {
  return String(report?.source || "").trim().toLowerCase();
}

function liveQuotaWindowNames(report) {
  return reportSource(report) === "codex" ? ["1week"] : ["5h", "1week"];
}

function hasCompleteQuotaWindows(report) {
  return (
    report?.status === "ok" &&
    liveQuotaWindowNames(report).every((windowName) => hasCompleteWindow(report?.windows?.[windowName]))
  );
}

function hasAnyUnexpiredWindow(report, referenceReport) {
  const referenceMs = reportAtMs(referenceReport);
  if (referenceMs === null) {
    return false;
  }
  return liveQuotaWindowNames(report).some((windowName) => {
    const resetMs = resetAtMs(report?.windows?.[windowName]);
    return resetMs !== null && resetMs > referenceMs;
  });
}

function reportOrigin(report) {
  return normalizeReportOrigin(report || {});
}

function isHardInvalidation(report) {
  return (
    report.status === "error" &&
    refreshValidityFromReport(report) === "rejected"
  );
}

function isAccountIneligible(report) {
  return report?.plan_name === "Free";
}

// auth_last_refresh carries TWO formats: codex writes an ISO timestamp, claude writes a ms-epoch
// string (it mirrors claudeAiOauth.expiresAt). Date.parse returns NaN for the numeric form, so this
// silently returned null for every claude report and isOlderAuthReport below could never fire —
// the staleness guard was dead code for half the pool. Accept both.
function reportAuthRefreshMs(report) {
  const raw = report?.auth_last_refresh;
  if (raw === null || raw === undefined) {
    return null;
  }
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) {
    const epoch = Number(text);
    return Number.isFinite(epoch) ? epoch : null;
  }
  const value = Date.parse(text);
  return Number.isFinite(value) ? value : null;
}

// A central-refresh rejection is the worker actually presenting the POOLED refresh token to the
// provider and being refused. It is the only direct test of the credential the pool will hand out,
// and it cannot be stale in the sense the freshness guard below cares about — it was just run.
function isCentralRefreshRejection(report) {
  return report?.usage_summary?.central_refresh?.auth_rejected === true;
}

// What may lift a standing central-refresh rejection. Both are proof about the POOLED blob itself:
// an upload whose refresh token the hub just presented and had accepted, or a central refresh that
// succeeded. A client's own healthy probe is not on this list — see mergeLatestReport.
function clearsCentralRefreshRejection(report) {
  return (
    report?.usage_summary?.central_refresh?.ok === true ||
    report?.usage_summary?.token_refresh?.source === "upload"
  );
}

function isOlderAuthReport(incoming, previous) {
  const incomingRefresh = reportAuthRefreshMs(incoming);
  const previousRefresh = reportAuthRefreshMs(previous);
  return incomingRefresh !== null && previousRefresh !== null && incomingRefresh < previousRefresh;
}

function cloneWindow(window) {
  if (!window) {
    return null;
  }
  return {
    used_percent: window.used_percent,
    remaining_percent: window.remaining_percent,
    window_minutes: window.window_minutes,
    reset_in_seconds: window.reset_in_seconds,
    reset_at: window.reset_at,
    captured_at: window.captured_at || null,
  };
}

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function authExpiryFields(row, generatedAt) {
  const expiresAtMs = timestampMs(row.auth_expires_at);
  const generatedAtMs = timestampMs(generatedAt);
  if (expiresAtMs === null || generatedAtMs === null) {
    return {
      auth_expired: false,
      auth_expires_in_seconds: null,
      auth_expiry_metadata_stale: false,
    };
  }
  const seconds = Math.floor((expiresAtMs - generatedAtMs) / 1000);
  const reportedAtMs = timestampMs(row.reported_at);
  const metadataStale =
    seconds <= 0 &&
    row.status === "ok" &&
    reportedAtMs !== null &&
    reportedAtMs > expiresAtMs;
  return {
    auth_expired: seconds <= 0 && !metadataStale,
    auth_expires_in_seconds: metadataStale ? null : seconds,
    auth_expiry_metadata_stale: metadataStale,
  };
}

function deriveDisplayWindow(window, report, generatedAt, windowName) {
  if (!window) {
    return null;
  }

  // A reading older than the window it describes is not evidence about anything current, and the
  // reporter that would replace it has stopped carrying the window at all: a codex Pro account
  // meters no 5-hour window, so nothing will ever supersede the one a 2.1.0 client fabricated for
  // leizhang0121@gmail.com on 2026-09-06. Rendering it with the reset-expired wording ("quota
  // snapshot expired / waiting for fresh quota") promised a refresh that is never coming, on a row
  // whose own state reads available. What is true is what every other Pro row already shows: this
  // account has no 5-hour window. Decisions drop it on this same test, so all three layers agree.
  if (!windowEvidenceLive(window, windowName, timestampMs(generatedAt))) {
    return null;
  }

  const displayWindow = cloneWindow(window);
  const invalidatedStale = (isHardInvalidation(report) || isAccountIneligible(report)) && window !== null;
  // A window with nothing consumed has no reset time because the provider has not started the
  // clock yet - that is a full window, not a probe that failed to read one.
  const unstarted = Number(window.remaining_percent) === 100;
  const missingReset =
    window.remaining_percent !== null && window.remaining_percent !== undefined && !window.reset_at && !unstarted;
  const resetAtMs = timestampMs(window.reset_at);
  const generatedAtMs = timestampMs(generatedAt);
  const resetExpired = resetAtMs !== null && generatedAtMs !== null && resetAtMs <= generatedAtMs;
  const authExpired = authExpiryFields(report, generatedAt).auth_expired;
  let resetUnavailableReason = null;

  if (invalidatedStale) {
    resetUnavailableReason = "auth_invalidated";
  } else if (authExpired) {
    resetUnavailableReason = "auth_token_expired";
  } else if (missingReset) {
    resetUnavailableReason = "probe_missing_reset";
  } else if (resetExpired) {
    resetUnavailableReason = report.status === "error" ? "stale_error_probe" : "quota_window_expired";
  }

  return {
    ...displayWindow,
    invalidated_stale: invalidatedStale,
    inferred_ready: false,
    reset_unavailable_reason: resetUnavailableReason,
  };
}

// Every window the merged report carries is shown, whatever the source. This used to null the
// codex 5h window on the belief that codex had stopped metering one; measured 2026-09-10, Plus and
// Team accounts report a live 5h window every cycle (only Pro does not), and hiding it meant the
// dashboard showed a Plus account as available while its own probe read 5h=2%.
function deriveDisplayWindows(report, generatedAt) {
  return {
    "5h": deriveDisplayWindow(report.windows?.["5h"], report, generatedAt, "5h"),
    "1week": deriveDisplayWindow(report.windows?.["1week"], report, generatedAt, "1week"),
  };
}

function displayWindowsStale(report, displayWindows) {
  if (!report?.windows_stale) {
    return false;
  }
  if (reportSource(report) !== "codex") {
    return true;
  }
  const weekly = displayWindows?.["1week"];
  return !(report.status === "ok" && weekly && !weekly.reset_unavailable_reason);
}

// A central-refresh rejection is STICKY, and deliberately so.
//
// The first version of this rule lived inside one merge branch and read the marker off `previous`.
// That only works while every consecutive report carries it: let a third kind of report through in
// between — one that neither rejects nor clears — and the evidence is gone from `previous`, so the
// next client "ok" sails past. That is exactly how claude-qpt0311@uw.edu came back as `ok` on
// 2026-08-31 with a pooled access token 782 hours expired, re-entering rotation and resetting the
// owner's invalidation clock along with it.
//
// So carry the verdict at the OUTER edge, after whichever branch ran. Only proof about the pooled
// blob lifts it — a verified upload, or a central refresh that succeeded.
export function mergeLatestReport(previous, incoming) {
  const merged = mergeReportFields(previous, incoming);
  if (!isCentralRefreshRejection(previous) || clearsCentralRefreshRejection(incoming)) {
    return merged;
  }
  // The refresh-token verdict is sticky; the row's status is not. status/error describe what happened
  // the last time the ACCESS token was used, and the incoming probe knows that better than a standing
  // rejection does -- an account whose pooled RT is dead can still carry a live 30-day access token,
  // and that token working is a fact worth showing. Only the evidence is carried forward: it keeps
  // refresh_validity at "rejected" (and the archive and owner-notification clocks on their basis)
  // until real proof about the pooled blob lifts it.
  return {
    ...merged,
    usage_summary: {
      ...(merged?.usage_summary || {}),
      central_refresh: previous.usage_summary.central_refresh,
    },
  };
}

function mergeReportFields(previous, incoming) {
  if (!previous) {
    return incoming;
  }

  // The freshness guard keeps a stale hard-invalidation from clobbering fresher client quota — but a
  // central-refresh rejection must be exempt. The worker reports the POOLED blob's auth_last_refresh,
  // so a client that keeps its own credential fresh WITHOUT re-uploading always looks newer, and the
  // one verdict that actually tested the pooled RT was discarded every cycle. Observed on
  // claude-qpt0311@uw.edu: pooled AT 726 h expired, central refresh rejected every ~13 min for a
  // month, entry still status=ok and still being served to borrowers.
  if (
    isHardInvalidation(incoming) &&
    !isCentralRefreshRejection(incoming) &&
    hasCompleteQuotaWindows(previous) &&
    isOlderAuthReport(incoming, previous)
  ) {
    return previous;
  }

  if (isHardInvalidation(incoming) || isAccountIneligible(incoming)) {
    const mergedFiveHour = mergeWindow(previous.windows?.["5h"], incoming.windows?.["5h"]);
    const mergedOneWeek = mergeWindow(previous.windows?.["1week"], incoming.windows?.["1week"]);
    return {
      ...previous,
      ...incoming,
      windows_stale: mergedFiveHour !== null || mergedOneWeek !== null,
      windows: {
        "5h": mergedFiveHour,
        "1week": mergedOneWeek,
      },
    };
  }

  if (
    reportOrigin(previous) === "client" &&
    hasCompleteQuotaWindows(previous) &&
    reportOrigin(incoming) === "worker" &&
    !hasCompleteQuotaWindows(incoming) &&
    hasAnyUnexpiredWindow(previous, incoming)
  ) {
    return previous;
  }

  // A complete client report lifts a stale carry-forward -- but its ANCHOR still goes through
  // mergeTrustedWindow below. Returning `incoming` wholesale here was a second path to re-anchor
  // that skipped every check the merge applies.
  const liftsStaleness =
    previous.windows_stale && reportOrigin(incoming) === "client" && hasCompleteQuotaWindows(incoming);

  const mergedFiveHour = mergeTrustedWindow(previous, incoming, "5h");
  const mergedOneWeek = mergeTrustedWindow(previous, incoming, "1week");
  const preservedFiveHour = mergedFiveHour === previous.windows?.["5h"] && incoming.windows?.["5h"] !== previous.windows?.["5h"];
  const preservedOneWeek = mergedOneWeek === previous.windows?.["1week"] && incoming.windows?.["1week"] !== previous.windows?.["1week"];
  const preservedByWindow = { "5h": preservedFiveHour, "1week": preservedOneWeek };
  const mergedByWindow = { "5h": mergedFiveHour, "1week": mergedOneWeek };
  const windowsStale = liveQuotaWindowNames(incoming).some(
    (windowName) =>
      (incoming.windows?.[windowName] === null && mergedByWindow[windowName] !== null) ||
      preservedByWindow[windowName]
  );

  const candidate = anchorCandidates(previous, incoming, mergedByWindow);
  const usageSummary = incoming.usage_summary ?? previous.usage_summary ?? null;
  return {
    ...previous,
    ...incoming,
    windows_stale: liftsStaleness ? false : windowsStale,
    usage_summary: candidate
      ? { ...(usageSummary || {}), anchor_candidate: candidate }
      : usageSummary,
    windows: {
      "5h": mergedFiveHour,
      "1week": mergedOneWeek,
    },
  };
}

function deriveStatus(row) {
  const rateLimitProbe = row.usage_summary?.rate_limit_probe;
  if (row.source === "claude" && rateLimitProbe?.status_code === 429) {
    return "rate_limited";
  }
  return row.status;
}

function annotateFreshness(row, generatedAt) {
  const reportedAtMs = Date.parse(row.reported_at || "");
  const generatedAtMs = Date.parse(generatedAt);
  const ageSeconds = Number.isFinite(reportedAtMs)
    ? Math.max(Math.floor((generatedAtMs - reportedAtMs) / 1000), 0)
    : null;
  const isStale = ageSeconds !== null && ageSeconds > 3600;
  const displayWindows = deriveDisplayWindows(row, generatedAt);
  const quotaSnapshotState = deriveQuotaSnapshotState(row, displayWindows, isStale);
  const refreshStatus = row.first_invalidated_at ? "rejected" : refreshValidityFromReport(row);

  const annotated = {
    ...row,
    ...authExpiryFields(row, generatedAt),
    age_seconds: ageSeconds,
    stale_after_seconds: 3600,
    is_stale: isStale,
    effective_status: deriveStatus(row),
    display_windows: displayWindows,
    display_windows_stale: displayWindowsStale(row, displayWindows),
    token_state: deriveTokenState(row),
    quota_snapshot_state: quotaSnapshotState,
    refresh_validity: {
      status: refreshStatus,
      label: refreshValidityLabel(refreshStatus),
      checked_at: refreshStatus === "unverified" ? null : row.reported_at,
      // A dead refresh token is a warning with a deadline, not a death: nobody can renew the access
      // token, so the account is usable exactly until that token expires and not a minute longer.
      deadline: refreshStatus === "rejected" ? row.auth_expires_at || null : null,
    },
  };

  return {
    ...annotated,
    availability: deriveAccountAvailability(annotated, generatedAt),
  };
}

function deriveTokenState(row) {
  if (!row.uploaded_at) {
    return {
      status: "missing",
      label: "token not uploaded",
      uploaded_at: null,
      uploader_email: row.uploader_email || null,
    };
  }
  return {
    status: "uploaded",
    label: "token uploaded",
    uploaded_at: row.uploaded_at,
    uploader_email: row.uploader_email || null,
  };
}

function refreshValidityLabel(status) {
  if (status === "confirmed") {
    return "refresh verified";
  }
  if (status === "rejected") {
    return "refresh rejected";
  }
  return "refresh not verified";
}

function deriveQuotaSnapshotState(row, displayWindows, isStale) {
  const liveNames = liveQuotaWindowNames(row);
  const availableCount = liveNames.filter((windowName) => {
    const window = displayWindows?.[windowName];
    return Boolean(window && !window.reset_unavailable_reason && window.remaining_percent !== null && window.remaining_percent !== undefined);
  }).length;

  if (availableCount === liveNames.length) {
    return {
      status: isStale ? "stale" : "fresh",
      label: isStale ? "quota snapshot stale" : "quota snapshot fresh",
      reported_at: row.reported_at || null,
    };
  }
  if (availableCount > 0) {
    return {
      status: "partial",
      label: "quota snapshot partial",
      reported_at: row.reported_at || null,
    };
  }
  return {
    status: "unavailable",
    label: "quota unavailable",
    reported_at: row.reported_at || null,
  };
}

function payloadFromItems(items, generatedAt) {
  return {
    generated_at: generatedAt,
    report_count: items.length,
    source_count: new Set(items.map((item) => item.source)).size,
    items,
  };
}

export function statusPayload(rows, generatedAt = new Date().toISOString()) {
  return payloadFromItems(rows.map((row) => annotateFreshness(row, generatedAt)), generatedAt);
}

// Whether the access token can still be used, and since when it could not. Expiry is an upper bound
// (a refresh elsewhere revokes it earlier), so a probe that was refused outranks the clock; and an
// entry with no expiry on record has nothing that says its token works, so it is not assumed to.
function accessTokenState(row, generatedAtMs) {
  if (row.status === "error" && isAuthInvalidationError(row.error)) {
    return { usable: false, sinceMs: null };
  }
  const expiresMs = Date.parse(row.auth_expires_at || "");
  if (!Number.isFinite(expiresMs)) {
    return { usable: false, sinceMs: null };
  }
  if (expiresMs <= generatedAtMs) {
    return { usable: false, sinceMs: expiresMs };
  }
  return { usable: true, sinceMs: null };
}

// An invalidated account passes through two stages: listed under Invalidated Accounts from the
// moment it becomes unavailable, then gone from the dashboard entirely. There is no grace period
// in between: an account nobody can use is not an active pool entry, and showing it as one made
// the active table lie about how much the pool actually holds.
const DROP_INVALIDATED_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

// How long this row has been dead, or null when that cannot be dated. Only the retirement clock
// depends on it -- whether a row is dead at all is the availability state's call, not this one.
// A Free plan is dead to the pool from its last report. Otherwise "dead" means BOTH tokens are
// gone: the refresh token rejected (or the invalidation record open) AND the access token
// unusable. The clock starts when the second of the two went.
function deadForMs(row, generatedAt) {
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) {
    return null;
  }
  if (row.plan_name === "Free") {
    const reportedAtMs = Date.parse(row.reported_at || "");
    return Number.isFinite(reportedAtMs) ? generatedAtMs - reportedAtMs : null;
  }
  const refreshTokenDead = Boolean(row.first_invalidated_at) || refreshValidityFromReport(row) === "rejected";
  if (!refreshTokenDead) {
    return null;
  }
  const accessToken = accessTokenState(row, generatedAtMs);
  if (accessToken.usable) {
    return null;
  }
  const firstInvalidatedMs = Date.parse(row.first_invalidated_at || "");
  const refreshDeadSinceMs = Number.isFinite(firstInvalidatedMs) ? firstInvalidatedMs : Date.parse(row.reported_at || "");
  if (!Number.isFinite(refreshDeadSinceMs)) {
    return null;
  }
  const deadSinceMs = accessToken.sinceMs === null ? refreshDeadSinceMs : Math.max(refreshDeadSinceMs, accessToken.sinceMs);
  return generatedAtMs - deadSinceMs;
}

function invalidatedStateKey(state) {
  return `${state.source}:${state.account_id}`;
}

function entryTimeMs(entry, field) {
  const value = Date.parse(entry?.[field] || "");
  return Number.isFinite(value) ? value : 0;
}

function compareAuthPoolEntryRecency(left, right) {
  const refreshDelta = entryTimeMs(left, "auth_last_refresh") - entryTimeMs(right, "auth_last_refresh");
  if (refreshDelta !== 0) {
    return refreshDelta;
  }
  const uploadedDelta = entryTimeMs(left, "uploaded_at") - entryTimeMs(right, "uploaded_at");
  if (uploadedDelta !== 0) {
    return uploadedDelta;
  }
  return String(left?.digest || "").localeCompare(String(right?.digest || ""));
}

function latestEntriesByAccount(entries) {
  const latestByAccount = new Map();
  for (const entry of entries) {
    const key = `${entry.source}:${entry.account_id}`;
    const previous = latestByAccount.get(key);
    if (!previous || compareAuthPoolEntryRecency(entry, previous) > 0) {
      latestByAccount.set(key, entry);
    }
  }
  return Array.from(latestByAccount.values());
}


export function authPoolStatusPayload(entries, reports, generatedAt = new Date().toISOString(), invalidatedStates = []) {
  const accountKeysWithSession = new Set(
    entries
      .filter((entry) => entry.session_id)
      .map((entry) => `${entry.source}:${entry.account_id}`)
  );
  const visibleEntries = latestEntriesByAccount(entries.filter((entry) => {
    if (entry.session_id) {
      return true;
    }
    return !accountKeysWithSession.has(`${entry.source}:${entry.account_id}`);
  }));
  const reportByKey = new Map(reports.map((report) => [`${report.source}:${report.account_id}`, report]));
  const invalidatedStateByKey = new Map(invalidatedStates.map((state) => [invalidatedStateKey(state), state]));
  const entryKeys = new Set(visibleEntries.map((entry) => `${entry.source}:${entry.account_id}`));
  const rows = visibleEntries.map((entry) => {
    const report = reportByKey.get(`${entry.source}:${entry.account_id}`) || null;
    const invalidatedState = invalidatedStateByKey.get(`${entry.source}:${entry.account_id}`) || null;
    return {
      source: entry.source,
      hostname: entry.hostname,
      reporter_name: entry.reporter_name,
      uploaded_at: entry.uploaded_at,
      uploader_email: entry.uploader_email,
      reported_at: report?.reported_at || entry.uploaded_at,
      account_id: entry.account_id,
      session_id: entry.session_id || '',
      email: entry.email,
      name: entry.name,
      plan_name: entry.plan_name,
      auth_path: null,
      auth_last_refresh: entry.auth_last_refresh,
      auth_expires_at: entry.auth_expires_at,
      has_refresh_token: entry.has_refresh_token ?? null,
      digest: entry.digest,
      status: report?.status || "unknown",
      error: report?.error || null,
      report_origin: report?.report_origin || null,
      first_invalidated_at: invalidatedState?.first_invalidated_at || null,
      last_invalidated_notification_at: invalidatedState?.last_notified_at || null,
      model_context_window: report?.model_context_window || null,
      usage_summary: report?.usage_summary || null,
      windows_stale: Boolean(report?.windows_stale),
      windows: report?.windows || { "5h": null, "1week": null },
    };
  });
  // Three buckets, one pass over rows annotated exactly once. The split reads the availability
  // state the dashboard itself renders, so "unavailable" in the Availability column and "listed
  // under Invalidated Accounts" are the same fact rather than two predicates that can drift.
  //
  // Past DROP_INVALIDATED_AFTER_MS a row lands in neither: an account dead a fortnight is not
  // news, and keeping it listed buries the ones that are. It must be dropped from BOTH lists --
  // excluding it only from the invalidated list would hand it straight back to the active one,
  // which is the opposite of retiring it. An unavailable row whose death cannot be dated stays
  // listed: no date is not evidence of age.
  const activeItems = [];
  const invalidatedItems = [];
  for (const item of statusPayload(rows, generatedAt).items) {
    if (item.availability?.state !== "unavailable") {
      activeItems.push(item);
      continue;
    }
    const deadMs = deadForMs(item, generatedAt);
    if (deadMs === null || deadMs <= DROP_INVALIDATED_AFTER_MS) {
      invalidatedItems.push(item);
    }
  }

  return {
    ...payloadFromItems(activeItems, generatedAt),
    auth_pool_count: activeItems.length,
    orphaned_count: 0,
    archived_invalidated_count: invalidatedItems.length,
    // Wire name kept: deployed guards read `archived_invalidated_items` (quota_guard.py), and a
    // key rename is a client-visible protocol change that would need its own phased rollout.
    archived_invalidated_items: invalidatedItems,
  };
}
