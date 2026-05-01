import { bearerTokenFromHeaders } from "../lib/company-auth.js";
import {
  authPoolFetchLog,
  authUsersList,
  authenticateApiToken,
  dbConfigured,
} from "../lib/db.js";

function unauthorized(res) {
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export default async function handler(req, res) {
  const authContext = await authenticateApiToken(bearerTokenFromHeaders(req.headers));
  if (!authContext) {
    unauthorized(res);
    return;
  }

  if (!dbConfigured()) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        viewer_email: authContext.email,
        generated_at: new Date().toISOString(),
        users: [],
        fetch_log: [],
      })
    );
    return;
  }

  const limitParam = Number(new URL(req.url, "http://placeholder").searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 200;

  const [users, fetchLog] = await Promise.all([
    authUsersList(),
    authPoolFetchLog({ limit }),
  ]);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      viewer_email: authContext.email,
      generated_at: new Date().toISOString(),
      users,
      fetch_log: fetchLog,
    })
  );
}
