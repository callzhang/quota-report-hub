export const MAX_REPORT_AGE_SECONDS = 3600;

export function reportIsFresh(report, options = {}) {
  const reportedAtMs = Date.parse(report?.reported_at || "");
  if (!Number.isFinite(reportedAtMs)) {
    return false;
  }
  const nowMs = options.now ? Date.parse(options.now) : Date.now();
  if (!Number.isFinite(nowMs)) {
    return false;
  }
  const maxAgeSeconds = Number(options.max_report_age_seconds ?? MAX_REPORT_AGE_SECONDS);
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    return true;
  }
  return nowMs - reportedAtMs <= maxAgeSeconds * 1000;
}

// How long each quota window runs, taken from the key that names it. The key is the length: the
// client maps the provider's `window_minutes` onto it (codex_window_key_for_minutes), so there is
// no second place for this fact to drift.
const WINDOW_LENGTH_MS = {
  "5h": 5 * 60 * 60 * 1000,
  "1week": 7 * 24 * 60 * 60 * 1000,
};

// Whether a window's stored numbers can still be describing the window that is running now.
//
// A reading older than the window's own length cannot: at least one full window has started and
// finished since it was taken, so whatever it measured is spent. `reset_at` normally catches that,
// but only when it is right. It is not always right — an out-of-credits probe on client 2.1.0
// fabricated a 5-hour window and stamped it with the WEEKLY reset time, and because the merge
// carries a window forward whenever a newer report omits it (a Pro account reports no 5-hour
// window at all), leizhang0121@gmail.com kept a 2026-09-06 "5h 0%" dated 2026-09-12. Selection read
// it as a live window and held the account out of rotation for four and a half days while its own
// weekly window sat at 98%.
//
// Judging the reading by its own age closes that without trusting the provider's timestamp, and it
// is scale-correct: 5-hour evidence dies in 5 hours, weekly evidence lasts a week. A window with no
// capture time on record cannot be judged this way and keeps its value.
export function windowEvidenceLive(window, windowName, nowMs) {
  const capturedMs = Date.parse(window?.captured_at || "");
  const lengthMs = WINDOW_LENGTH_MS[windowName];
  if (!Number.isFinite(capturedMs) || !lengthMs || !Number.isFinite(nowMs)) {
    return true;
  }
  return nowMs - capturedMs <= lengthMs;
}
