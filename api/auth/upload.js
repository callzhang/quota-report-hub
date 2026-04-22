import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiToken, dbConfigured, upsertAuthPoolEntry } from "../../lib/db.js";

function unauthorized(res) {
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const authContext = await authenticateApiToken(provided);
  if (!authContext) {
    unauthorized(res);
    return;
  }

  if (!dbConfigured() || !authPoolConfigured()) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Auth pool is not configured" }));
    return;
  }

  if (!req.body?.auth_json) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "auth_json is required" }));
    return;
  }

  const entry = await upsertAuthPoolEntry({
    ...req.body,
    uploader_email: authContext.email,
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: true, entry }));
}
