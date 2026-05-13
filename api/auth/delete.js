import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import { dbConfigured, deleteAuthPoolEntry } from "../../lib/db.js";
import { readJsonBody } from "../../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  const authContext = await authenticateApiRequest(req);
  if (!authContext) {
    sendUnauthorized(res);
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
    sessionId: body.session_id || null,
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify(withTokenUpgrade({
      ok: true,
      requested_by: authContext.email,
      source: result.source,
      account_id: result.account_id,
      session_id: result.session_id,
      deleted: result.deleted,
    }, authContext))
  );
}
