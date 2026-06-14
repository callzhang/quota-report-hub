import { authPoolConfigured } from "../../lib/company-auth.js";
import { authenticateApiRequest, sendUnauthorized, withTokenUpgrade } from "../../lib/api-auth.js";
import { dbConfigured, getFeatureFlag, upsertAuthPoolEntry } from "../../lib/db.js";
import { ingestClientQuota } from "../../lib/quota-ingest.js";
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

  if (!body?.auth_json) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "auth_json is required" }));
    return;
  }
  if (!body?.source) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "source is required" }));
    return;
  }

  const source = String(body.source);
  const entry = await upsertAuthPoolEntry({
    ...body,
    source,
    uploader_email: authContext.email,
  });

  // If the client bundled its freshly-probed quota with the upload, ingest it in the same request
  // so the dashboard reflects fresh quota immediately — closing the window where a just-uploaded
  // entry shows stale quota until a separate quota report arrives or the worker probes it (which
  // the lazy-probe path may skip for a recently-uploaded entry). Best-effort: a bad or unavailable
  // quota payload never fails the auth upload.
  let quotaIngested = false;
  if (body.quota_payload && typeof body.quota_payload === "object") {
    try {
      const q = await ingestClientQuota({ source, quotaPayload: body.quota_payload, reporterEmail: authContext.email });
      quotaIngested = Boolean(q.ok && !q.ignored);
    } catch (error) {
      console.error("upload: bundled quota ingest failed:", error?.message || error);
    }
  }

  // Surface the flag so a client that just uploaded its real RT knows to go AT-only locally
  // (Phase 4): strip its own refresh token once the hub holds it.
  const disabledRefreshToken = await getFeatureFlag("disabled_refresh_token", false);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(withTokenUpgrade({ ok: true, entry, disabled_refresh_token: disabledRefreshToken, quota_ingested: quotaIngested }, authContext)));
}
