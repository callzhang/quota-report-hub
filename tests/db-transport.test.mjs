import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createClient } from "@libsql/client";

test("database queries succeed when the peer closes a previously used HTTP connection", async () => {
  const seenSockets = new WeakSet();
  const executions = [];
  const authorization = [];
  const server = createServer(async (request, response) => {
    // Model the upstream dropping a pooled socket before it accepts the next statement.
    // A fresh connection still works; replaying a failed statement is not part of this fixture.
    if (seenSockets.has(request.socket)) {
      request.socket.destroy();
      return;
    }
    seenSockets.add(request.socket);
    authorization.push(request.headers.authorization);
    let body = "";
    for await (const chunk of request) body += chunk;
    const pipeline = JSON.parse(body);
    const results = pipeline.requests.map((item) => {
      if (item.type === "close") return { type: "ok", response: { type: "close" } };
      executions.push(item.stmt.sql);
      return {
        type: "ok",
        response: {
          type: "execute",
          result: {
            cols: [{ name: "reachable", decltype: "INTEGER" }],
            rows: [[{ type: "integer", value: "1" }]],
            affected_row_count: 0,
            last_insert_rowid: null,
          },
        },
      };
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ baton: null, base_url: null, results }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const previousUrl = process.env.TURSO_DATABASE_URL;
  process.env.TURSO_DATABASE_URL = "file::memory:";
  const db = await import(`../lib/db.js?transport=${Date.now()}`);
  if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL;
  else process.env.TURSO_DATABASE_URL = previousUrl;

  const client = createClient({
    url: `http://127.0.0.1:${server.address().port}`,
    authToken: "fixture-token",
    fetch: db.fetchDatabase,
  });
  try {
    for (let query = 0; query < 3; query++) {
      assert.deepEqual((await client.execute("SELECT 1 AS reachable")).rows, [{ reachable: 1 }]);
      await new Promise(setImmediate);
    }
    assert.deepEqual(executions, Array(3).fill("SELECT 1 AS reachable"));
    assert.deepEqual(authorization, Array(3).fill("Bearer fixture-token"));
  } finally {
    client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a database transport failure is surfaced without replaying the statement", async () => {
  let requests = 0;
  const server = createServer((request) => {
    requests++;
    request.socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const previousUrl = process.env.TURSO_DATABASE_URL;
  process.env.TURSO_DATABASE_URL = "file::memory:";
  const { fetchDatabase } = await import(`../lib/db.js?failure=${Date.now()}`);
  if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL;
  else process.env.TURSO_DATABASE_URL = previousUrl;
  const client = createClient({
    url: `http://127.0.0.1:${server.address().port}`,
    authToken: "fixture-token",
    fetch: fetchDatabase,
  });
  try {
    await assert.rejects(client.execute("INSERT INTO fixture VALUES (1)"), (error) =>
      error.cause?.code === "UND_ERR_SOCKET");
    assert.equal(requests, 1);
  } finally {
    client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
