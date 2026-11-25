#!/usr/bin/env node
// The hub's one process: the four dashboard pages and the API handlers under api/ and lib/. It is
// long-running on purpose -- the schema check and module load are paid once per start, not once per
// cold request (SYSTEM_DESIGN §6).
import http from "node:http";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import flags from "./api/admin/flags.js";
import deleteAuth from "./api/auth/delete.js";
import fetchBest from "./api/auth/fetch-best.js";
import issueToken from "./api/auth/issue-token.js";
import quota from "./api/auth/quota.js";
import upload from "./api/auth/upload.js";
import invalidatedAuthNotifications from "./api/cron/invalidated-auth-notifications.js";
import probeAuthPool from "./api/cron/probe-auth-pool.js";
import status from "./api/status.js";
import statusRevision from "./api/status-revision.js";
import users from "./api/users.js";
import { sendServiceUnavailable } from "./lib/api-auth.js";
import {
  quotaHistoryHandlerImpl,
  tokenUsageHandlerImpl,
  tokenUsageQueryHandlerImpl,
  tokenUsageRetentionHandlerImpl,
  uploadExclusionsHandlerImpl,
} from "./lib/data-api.js";

export const API_ROUTES = new Map([
  ["/api/admin/flags", flags],
  ["/api/auth/delete", deleteAuth],
  ["/api/auth/fetch-best", fetchBest],
  ["/api/auth/issue-token", issueToken],
  ["/api/auth/quota", quota],
  ["/api/auth/upload", upload],
  ["/api/auth/upload-exclusions", (req, res) => uploadExclusionsHandlerImpl(req, res)],
  ["/api/cron/invalidated-auth-notifications", invalidatedAuthNotifications],
  ["/api/cron/probe-auth-pool", probeAuthPool],
  ["/api/cron/token-usage-retention", (req, res) => tokenUsageRetentionHandlerImpl(req, res)],
  ["/api/quota-history", (req, res) => quotaHistoryHandlerImpl(req, res)],
  ["/api/status", status],
  ["/api/status-revision", statusRevision],
  ["/api/token-usage", (req, res) => tokenUsageHandlerImpl(req, res)],
  ["/api/token-usage-query", (req, res) => tokenUsageQueryHandlerImpl(req, res)],
  ["/api/users", users],
]);

// An explicit list, so that nothing else beside the server can ever be downloaded.
const PAGES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/login.html", "login.html"],
  ["/token-usage.html", "token-usage.html"],
  ["/users.html", "users.html"],
]);

// A request body is held in memory before its handler runs, so it is bounded. 4.5 MB is the limit the
// deployed clients were built against.
export const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

function send(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // The rest is still read, and dropped, so the client gets the 413 instead of a reset socket.
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8");
}

export async function handleRequest(req, res, routes = API_ROUTES) {
  res.setHeader("Strict-Transport-Security", "max-age=63072000");
  const { pathname } = new URL(req.url, "http://placeholder");
  const handler = routes.get(pathname);
  if (handler) {
    const body = await readBody(req);
    if (body === null) return send(res, 413, "Payload Too Large");
    req.body = body;
    return handler(req, res);
  }
  const page = PAGES.get(pathname);
  if (!page) return send(res, 404, "Not Found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(await fs.readFile(new URL(page, import.meta.url)));
}

export function createHubServer(routes = API_ROUTES) {
  return http.createServer((req, res) => {
    // One failed request must not take the process, and every other request in it, down.
    handleRequest(req, res, routes).catch((error) => {
      console.error(error);
      if (res.headersSent) res.destroy();
      else sendServiceUnavailable(res, error);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  createHubServer().listen(port, "0.0.0.0", () => console.log(`hub listening on ${port}`));
}
