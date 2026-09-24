import { authPoolDeathEvents, listAdmins } from "./db.js";
import { authMailConfigured, sendDeathDigestEmail } from "./company-auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function hours(seconds) {
  return Number.isFinite(seconds) ? seconds / 3600 : null;
}

// How long the refresh token sat between being minted and dying. Only codex can say (see
// refreshTokenAgeSeconds); `hub_last_refresh_at` is null for claude rows, so this is null there and
// the digest simply omits the figure instead of printing a made-up one.
export function idleHours(event) {
  const minted = Date.parse(event?.hub_last_refresh_at || "");
  const died = Date.parse(event?.observed_at || "");
  if (!Number.isFinite(minted) || !Number.isFinite(died) || died < minted) {
    return null;
  }
  return hours((died - minted) / 1000);
}

// A death is worth an email when the hub actually presented the refresh token and the provider said
// why: that is the one reading `refresh_error_code` exists to produce. Deaths seen only through an
// access-token probe carry no code and, at ~2 a day with most of them flapping, would turn a digest
// into noise; they are counted, not listed.
export function buildDeathDigest(events, { sinceIso }) {
  const deaths = events.filter((event) => event.event === "death" && event.observed_at >= sinceIso);
  const explained = deaths
    .filter((event) => event.refresh_error_code)
    .map((event) => ({
      account_id: event.account_id,
      source: event.source,
      plan_name: event.plan_name,
      observed_at: event.observed_at,
      refresh_error_code: event.refresh_error_code,
      central_refresh_verdict: event.central_refresh_verdict,
      idle_hours: idleHours(event),
    }));
  return { sinceIso, explained, unexplained: deaths.length - explained.length };
}

export function digestIsEmpty(digest) {
  return digest.explained.length === 0;
}

// Owners only, not every admin: this is diagnostic detail for whoever is investigating the pool, not
// something the wider admin list asked to receive.
export async function sendDeathDigest({
  now = new Date(),
  eventsImpl = () => authPoolDeathEvents({ since: new Date(now.getTime() - DAY_MS).toISOString(), limit: 500 }),
  ownersImpl = async () => (await listAdmins()).filter((admin) => admin.role === "owner").map((admin) => admin.email),
  sendImpl = sendDeathDigestEmail,
  mailConfigured = authMailConfigured,
} = {}) {
  const sinceIso = new Date(now.getTime() - DAY_MS).toISOString();
  const digest = buildDeathDigest(await eventsImpl(), { sinceIso });
  if (digestIsEmpty(digest)) {
    return { ok: true, sent: 0, reason: "no_deaths_with_a_refusal_code", unexplained: digest.unexplained };
  }
  if (!mailConfigured()) {
    return { ok: false, sent: 0, reason: "mail_not_configured" };
  }
  const owners = await ownersImpl();
  for (const to of owners) {
    await sendImpl({ to, digest });
  }
  return { ok: true, sent: owners.length, deaths: digest.explained.length, unexplained: digest.unexplained };
}
