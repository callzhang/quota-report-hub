import { authMailConfigured, authPoolConfigured } from "../../lib/company-auth.js";
import { dbConfigured } from "../../lib/db.js";
import { notifyInvalidatedAuthOwners } from "../../lib/invalidated-auth-notifications.js";

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return false;
  }
  return req.headers.authorization === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return;
  }

  if (!authorized(req)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  if (!dbConfigured() || !authPoolConfigured() || !authMailConfigured()) {
    json(res, 500, { error: "Invalidated auth notifications are not configured" });
    return;
  }

  const result = await notifyInvalidatedAuthOwners();
  json(res, 200, result);
}
