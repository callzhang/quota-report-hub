import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  DEFAULT_FRONTEND_PORT,
  assertPortAvailable,
  frontendPortFromEnv,
} from "../scripts/start_frontend.mjs";

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("frontendPortFromEnv defaults to 6088", () => {
  assert.equal(frontendPortFromEnv({}), DEFAULT_FRONTEND_PORT);
});

test("frontendPortFromEnv accepts explicit integer ports", () => {
  assert.equal(frontendPortFromEnv({ FRONTEND_PORT: "7000" }), 7000);
});

test("frontendPortFromEnv rejects invalid ports", () => {
  assert.throws(() => frontendPortFromEnv({ FRONTEND_PORT: "6088abc" }), /FRONTEND_PORT/);
  assert.throws(() => frontendPortFromEnv({ FRONTEND_PORT: "0" }), /FRONTEND_PORT/);
});

test("assertPortAvailable rejects occupied ports instead of allowing fallback", async () => {
  const server = net.createServer();
  await listen(server, 0, "127.0.0.1");
  const address = server.address();
  try {
    await assert.rejects(
      () => assertPortAvailable(address.port, "127.0.0.1"),
      /already in use/,
    );
  } finally {
    await close(server);
  }
});
