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
