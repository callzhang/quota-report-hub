import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

process.env.TURSO_DATABASE_URL = "file::memory:";
const { API_ROUTES, MAX_BODY_BYTES, createHubServer } = await import("../server.mjs");
const { readJsonBody } = await import("../lib/http.js");

async function withServer(routes, run) {
  const server = createHubServer(routes);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("every api module and every public data path has a route", () => {
  assert.deepEqual([...API_ROUTES.keys()].sort(), [
    "/api/admin/flags",
    "/api/auth/delete",
    "/api/auth/fetch-best",
    "/api/auth/issue-token",
    "/api/auth/quota",
    "/api/auth/upload",
    "/api/auth/upload-exclusions",
    "/api/cron/invalidated-auth-notifications",
    "/api/cron/probe-auth-pool",
    "/api/cron/token-usage-retention",
    "/api/quota-history",
    "/api/status",
    "/api/status-revision",
    "/api/token-usage",
    "/api/token-usage-query",
    "/api/users",
  ]);
});

test("pages are served and nothing else in the checkout is", async () => {
  await withServer(new Map(), async (base) => {
    const page = await fetch(`${base}/login.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    for (const path of ["/.env.local", "/server.mjs", "/lib/db.js", "/package.json", "/%2e%2e/etc/passwd"]) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
  });
});

test("a handler gets the query string and the posted JSON", async () => {
  const routes = new Map([["/api/echo", async (req, res) => {
    res.end(JSON.stringify({ url: req.url, body: await readJsonBody(req) }));
  }]]);
  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/api/echo?source=codex`, { method: "POST", body: JSON.stringify({ n: "汉" }) });
    assert.deepEqual(await response.json(), { url: "/api/echo?source=codex", body: { n: "汉" } });
  });
});

test("an oversized body is refused before the handler runs", async () => {
  let called = false;
  const routes = new Map([["/api/echo", (req, res) => { called = true; res.end(); }]]);
  await withServer(routes, async (base) => {
    const response = await fetch(`${base}/api/echo`, { method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) });
    assert.equal(response.status, 413);
    assert.equal(called, false);
  });
});

test("a failing handler answers 503 without its internals and the server keeps serving", async () => {
  const routes = new Map([["/api/boom", async () => { throw new Error("secret internals"); }]]);
  const logged = console.error;
  console.error = () => {};
  try {
    await withServer(routes, async (base) => {
      const response = await fetch(`${base}/api/boom`);
      assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /secret internals/);
      assert.equal((await fetch(`${base}/login.html`)).status, 200);
    });
  } finally {
    console.error = logged;
  }
});

test("the image takes only what the server needs, never the checkout's secrets", async () => {
  const ignore = (await readFile(new URL("../.dockerignore", import.meta.url), "utf8"))
    .split("\n").filter((line) => line && !line.startsWith("#"));
  assert.equal(ignore[0], "*");
  assert.ok(ignore.slice(1).every((line) => line.startsWith("!") && !line.includes(".env")));
});
