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

export async function sendAccessTokenEmail({ email, token }) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.MAILGUN_FROM;
  const baseUrl = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net";

  const form = new FormData();
  form.set("from", from);
  form.set("to", email);
  form.set("subject", "Quota Report Hub access token");
  form.set(
    "text",
    [
      "Your Quota Report Hub personal access token:",
      token,
      "",
      "Paste this token back into Codex to finish setup.",
      "Keep it secret. Anyone with this token can upload and fetch auth pool entries as you.",
    ].join("\n")
  );
  form.set(
    "html",
    `<p>Your Quota Report Hub personal access token:</p><pre>${token}</pre><p>Paste this token back into Codex to finish setup.</p><p>Keep it secret. Anyone with this token can upload and fetch auth pool entries as you.</p>`
  );

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
