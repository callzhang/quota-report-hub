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

function emailShell({ eyebrow, title, intro, details = [], action, footer }) {
  const detailRows = details
    .map(
      ({ label, value }) => `
        <tr>
          <td style="padding:10px 0;color:#6b7280;font-size:13px;line-height:18px;vertical-align:top;">${label}</td>
          <td style="padding:10px 0;color:#111827;font-size:14px;line-height:20px;font-weight:600;text-align:right;vertical-align:top;">${value}</td>
        </tr>`
    )
    .join("");
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:20px;overflow:hidden;box-shadow:0 18px 50px rgba(15,23,42,0.08);">
            <tr>
              <td style="padding:28px 30px 22px;background:linear-gradient(135deg,#111827 0%,#334155 100%);">
                <div style="color:#cbd5e1;font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">${eyebrow}</div>
                <h1 style="margin:10px 0 0;color:#ffffff;font-size:24px;line-height:30px;font-weight:750;">${title}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 30px 30px;">
                <p style="margin:0 0 18px;color:#374151;font-size:15px;line-height:24px;">${intro}</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:6px 0 22px;border-top:1px solid #eef2f7;border-bottom:1px solid #eef2f7;">
                  ${detailRows}
                </table>
                <div style="padding:16px 18px;border-radius:14px;background:#f9fafb;border:1px solid #e5e7eb;color:#374151;font-size:14px;line-height:22px;">
                  ${action}
                </div>
                <p style="margin:22px 0 0;color:#9ca3af;font-size:12px;line-height:18px;">${footer}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
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
  const safeAccount = escapeHtml(accountEmail);
  const safePlan = escapeHtml(entry?.plan_name || "unknown");
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
  const html = emailShell({
    eyebrow: "Quota Report Hub",
    title: `${safeSource} login required`,
    intro: "This saved auth has been invalidated for more than 24 hours. It will stay out of rotation until the owner logs in again.",
    details: [
      { label: "Account", value: safeAccount },
      { label: "Plan", value: safePlan },
      { label: "Invalidated since", value: safeInvalidatedSince },
    ],
    action: "Please log in again on a machine with the quota-reporter skill installed. The next guard run will upload the refreshed auth automatically.",
    footer: "This reminder is sent at most once per 24 hours for the same account.",
  });
  return sendMailgunEmail({ to: email, subject, text, html });
}
