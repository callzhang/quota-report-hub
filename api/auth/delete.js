import { authPoolConfigured, bearerTokenFromHeaders } from "../../lib/company-auth.js";
import { authenticateApiToken, dbConfigured, deleteAuthPoolEntry } from "../../lib/db.js";
import { readJsonBody } from "../../lib/http.js";

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

  const authContext = await authenticateApiToken(bearerTokenFromHeaders(req.headers));
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

  const body = await readJsonBody(req);
  if (!body?.source || !body?.account_id) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "source and account_id are required" }));
    return;
  }

  const result = await deleteAuthPoolEntry({
    source: body.source,
    accountId: body.account_id,
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      ok: true,
      requested_by: authContext.email,
      source: result.source,
      account_id: result.account_id,
      deleted: result.deleted,
    })
  );
}
