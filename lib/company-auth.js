import crypto from "node:crypto";

const DEFAULT_ALLOWED_DOMAIN = "stardust.ai";

function allowedDomain() {
  return (process.env.AUTH_ALLOWED_EMAIL_DOMAIN || DEFAULT_ALLOWED_DOMAIN).toLowerCase();
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function companyEmailAllowed(email) {
  const normalized = normalizeEmail(email);
  return normalized.endsWith(`@${allowedDomain()}`);
}

export function authMailConfigured() {
  return Boolean(
    process.env.MAILGUN_API_KEY &&
    process.env.MAILGUN_DOMAIN &&
    process.env.MAILGUN_FROM
  );
}

export function authPoolConfigured() {
  return Boolean(
    process.env.TURSO_DATABASE_URL &&
    process.env.TURSO_AUTH_TOKEN &&
    process.env.AUTH_POOL_ENCRYPTION_KEY
  );
}

export function opaqueToken(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
}

export function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function bearerTokenFromHeaders(headers = {}) {
  const header =
    headers.authorization ||
    headers.Authorization ||
    "";
  return String(header).replace(/^Bearer\s+/i, "").trim();
}

async function sendMailgunEmail({ to, subject, text, html }) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.MAILGUN_FROM;
  const baseUrl = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net";

  const form = new FormData();
  form.set("from", from);
  form.set("to", to);
  form.set("subject", subject);
  form.set("text", text);
  form.set("html", html);

  const response = await fetch(`${baseUrl}/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
    },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mailgun send failed: ${response.status} ${body}`);
  }

  return response.json();
}

export async function sendAccessTokenEmail({ email, token }) {
  return sendMailgunEmail({
    to: email,
    subject: "Quota Report Hub access token",
    text: [
      "Your Quota Report Hub personal access token:",
      token,
      "",
      "Paste this token back into Codex to finish setup.",
      "Keep it secret. Anyone with this token can upload and fetch auth pool entries as you.",
    ].join("\n"),
    html: `<p>Your Quota Report Hub personal access token:</p><pre>${token}</pre><p>Paste this token back into Codex to finish setup.</p><p>Keep it secret. Anyone with this token can upload and fetch auth pool entries as you.</p>`,
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function sendAuthInvalidatedEmail({ email, entry, invalidatedSince }) {
  const source = entry?.source || "auth";
  const accountEmail = entry?.email || entry?.account_id || "unknown account";
  const plan = entry?.plan_name ? ` (${entry.plan_name})` : "";
  const safeSource = escapeHtml(source);
  const safeAccount = escapeHtml(`${accountEmail}${plan}`);
  const safeInvalidatedSince = escapeHtml(invalidatedSince);
  const subject = `Quota Report Hub: ${source} auth needs login`;
  const text = [
    `Your ${source} auth in Quota Report Hub has been invalidated for more than 24 hours.`,
    "",
    `Account: ${accountEmail}${plan}`,
    `Invalidated since: ${invalidatedSince}`,
    "",
    "Please log in again on a machine with the quota-reporter skill installed so the hub can upload a refreshed auth.",
  ].join("\n");
  const html = [
    `<p>Your <strong>${safeSource}</strong> auth in Quota Report Hub has been invalidated for more than 24 hours.</p>`,
    `<p><strong>Account:</strong> ${safeAccount}<br/><strong>Invalidated since:</strong> ${safeInvalidatedSince}</p>`,
    "<p>Please log in again on a machine with the quota-reporter skill installed so the hub can upload a refreshed auth.</p>",
  ].join("");
  return sendMailgunEmail({ to: email, subject, text, html });
}
