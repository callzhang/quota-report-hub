import { authMailConfigured, authPoolConfigured, companyEmailAllowed, normalizeEmail, sendAccessTokenEmail } from "../../lib/company-auth.js";
import { dbConfigured, issueApiToken } from "../../lib/db.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  if (!dbConfigured() || !authPoolConfigured() || !authMailConfigured()) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Auth issuance is not configured" }));
    return;
  }

  const email = normalizeEmail(req.body?.email);
  if (!email) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "email is required" }));
    return;
  }

  if (!companyEmailAllowed(email)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Only company email addresses are allowed" }));
    return;
  }

  const token = await issueApiToken(email);
  await sendAccessTokenEmail({ email, token: token.token });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      ok: true,
      email,
      message: "Access token sent by email",
    })
  );
}
