import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { callUnityBridge } from "../dist/unityBridgeClient.js";
import { SERVER_VERSION } from "../dist/config.js";
import { readUnityGatewayDiscovery } from "../dist/unityGatewayDiscovery.js";
import { getLoggingRuntime } from "../dist/logging/loggingRuntime.js";

const project = path.resolve(".tmp/ws-unity-project");

async function bridge(t, respond, identity = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const messages = [];
  server.on("connection", (socket, request) => {
    assert.equal(request.url, "/bridge");
    assert.equal(request.headers.authorization, "Bearer test-private-token");
    socket.on("message", raw => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      if (message.type === "bridge.hello") {
        assert.equal(message.role, "relay");
        assert.equal(message.projectPath, project);
        socket.send(JSON.stringify({ type: "bridge.ready", protocolVersion: 1, serverVersion: SERVER_VERSION, projectPath: project, ...identity }));
      } else respond(socket, message);
    });
  });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    messages,
    call: (options = {}, payload = {}) => callUnityBridge(project, "unity.health", payload,
      { requestId: "stable-request", timeoutMs: 1500, ...options }, (target, credentials) => {
        assert.equal(target, project);
        assert.equal(credentials, true);
        return { found: true, gatewayUrl: `http://127.0.0.1:${server.address().port}`, bridgeToken: "test-private-token" };
      }),
  };
}

function reply(socket, request, status, body = {}) {
  socket.send(JSON.stringify({ type: "bridge.response", requestId: request.requestId, status, body: JSON.stringify(body) }));
}

test("Unity WS sends one command and reconciles queued/running results using get", async t => {
  let gets = 0;
  const mock = await bridge(t, (socket, request) => {
    if (request.type === "bridge.request") reply(socket, request, "queued");
    else reply(socket, request, ++gets === 1 ? "running" : "completed", { ok: true });
  });
  assert.deepEqual(await mock.call(), { ok: true });
  assert.equal(mock.messages.filter(m => m.type === "bridge.request").length, 1);
  assert.equal(gets, 2);
});

test("Unity status lookup never resubmits a command", async t => {
  const mock = await bridge(t, (socket, request) => reply(socket, request, "unknown"));
  assert.equal((await mock.call({ statusOnly: true })).status, "unknown");
  assert.deepEqual(mock.messages.map(m => m.type), ["bridge.hello", "bridge.get"]);
});

for (const [label, identity] of [["version", { serverVersion: "0.0.0" }], ["project", { projectPath: project + "-other" }]]) {
  test(`Unity rejects ${label} mismatch before sending any command`, async t => {
    const mock = await bridge(t, () => assert.fail("command must not be sent"), identity);
    await assert.rejects(mock.call(), /handshake version or project mismatch/);
    assert.equal(mock.messages.length, 1);
  });
}

test("Unity disconnect after dispatch preserves uncertain outcome and does not replay", async t => {
  const mock = await bridge(t, socket => socket.close());
  await assert.rejects(mock.call(), /stable-request has an unknown outcome; do not replay/);
  assert.equal(mock.messages.filter(m => m.type === "bridge.request").length, 1);
});

test("Unity timeout does not replay the dispatched command", async t => {
  const mock = await bridge(t, () => {});
  await assert.rejects(mock.call({ timeoutMs: 100 }), /stable-request may have executed; do not replay/);
  assert.equal(mock.messages.filter(m => m.type === "bridge.request").length, 1);
});

test("Unity returns application rejection and rejects mismatched response identity", async t => {
  const failed = await bridge(t, (socket, request) => reply(socket, request, "failed", { error: "Invalid canvas" }));
  await assert.rejects(failed.call(), /Invalid canvas/);
  const wrong = await bridge(t, (socket, request) => reply(socket, { requestId: "other" }, "completed"));
  await assert.rejects(wrong.call(), /response identity mismatch/);
});

test("Unity discovery credentials are private by default", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "unity-ws-discovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, "Library", "FigmaBridge", "gateways");
  fs.mkdirSync(records, { recursive: true });
  fs.writeFileSync(path.join(records, "123.json"), JSON.stringify({
    version: 1, processId: 123, projectPath: directory, gatewayUrl: "http://127.0.0.1:32129",
    updatedAtUtc: new Date().toISOString(), bridgeToken: "private-token",
  }));
  assert.equal(readUnityGatewayDiscovery(directory).found, true);
  assert.equal("bridgeToken" in readUnityGatewayDiscovery(directory), false);
  assert.equal(readUnityGatewayDiscovery(directory, true).bridgeToken, "private-token");
});

test("Unity success and rejection logs preserve correlation without credentials", async t => {
  const mock = await bridge(t, (socket, request) => reply(socket, request,
    request.operationId === "ws-log-success" ? "completed" : "failed", { error: "Rejected payload" }));
  await mock.call({ operationId: "ws-log-success" });
  await assert.rejects(mock.call({ operationId: "ws-log-failure" }), /Rejected payload/);
  const logging = getLoggingRuntime();
  for (const [operationId, terminal] of [["ws-log-success", "succeeded"], ["ws-log-failure", "failed"]]) {
    const { events } = await logging.store.query({ operationId });
    assert.ok(events.some(event => event.status === "started"));
    assert.ok(events.some(event => event.status === "progress"));
    assert.ok(events.some(event => event.status === terminal));
    assert.doesNotMatch(JSON.stringify(events), /test-private-token/);
  }
});
