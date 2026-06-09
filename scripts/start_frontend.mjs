#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FRONTEND_PORT = 6088;
export const FRONTEND_HOST = "127.0.0.1";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);

export function frontendPortFromEnv(env = process.env) {
  const raw = env.FRONTEND_PORT || "";
  if (!raw) {
    return DEFAULT_FRONTEND_PORT;
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw.trim()) {
    throw new Error(`FRONTEND_PORT must be an integer from 1 to 65535; got ${JSON.stringify(raw)}`);
  }
  return port;
}

export function assertPortAvailable(port, host = FRONTEND_HOST) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use. Stop that process before starting the frontend.`));
        return;
      }
      reject(error);
    });
    probe.listen(port, host, () => {
      probe.close(resolve);
    });
  });
}

function safePathname(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  if (pathname === "/" || pathname === "") {
    return "index.html";
  }
  return pathname.replace(/^\/+/, "");
}

async function serveStaticFile(req, res, rootDir) {
  const relativePath = safePathname(req.url || "/");
  if (relativePath.startsWith("api/")) {
    res.writeHead(501, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: "API routes are not served by the static frontend script. Use the deployed hub or vercel dev for API testing.",
    }));
    return;
  }

  const filePath = path.resolve(rootDir, relativePath);
  if (!filePath.startsWith(rootDir + path.sep) && filePath !== rootDir) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "content-type": MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream" });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    throw error;
  }
}

export async function startFrontendServer({ port = DEFAULT_FRONTEND_PORT, host = FRONTEND_HOST, rootDir } = {}) {
  const serverRoot = rootDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await assertPortAvailable(port, host);
  const server = http.createServer((req, res) => {
    serveStaticFile(req, res, serverRoot).catch((error) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error.stack || String(error));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

async function main() {
  const port = frontendPortFromEnv();
  try {
    await startFrontendServer({ port });
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
  console.log(`Quota Report Hub frontend: http://${FRONTEND_HOST}:${port}/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
