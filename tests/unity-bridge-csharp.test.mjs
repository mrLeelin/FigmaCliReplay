import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { WebSocket } from "ws";
import { SERVER_VERSION } from "../dist/config.js";
import { callUnityBridge } from "../dist/unityBridgeClient.js";

const hostDll = process.env.UNITY_BRIDGE_TEST_HOST;

test("production C# WebSocket transport interoperates and deduplicates across reconnects", {
  skip: !hostDll && "Set UNITY_BRIDGE_TEST_HOST to the compiled BridgeHost.dll (requires .NET 8)", timeout: 20000,
}, async t => {
  const project = path.resolve(".tmp/bridge-host-project");
  const host = spawn("dotnet", [hostDll, SERVER_VERSION, project], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  host.stderr.on("data", chunk => { diagnostics += chunk; });
  const exited = once(host, "exit");
  t.after(async () => { if (host.exitCode === null) host.kill(); await exited; });
  const reader = createInterface({ input: host.stdout });
  const ready = await Promise.race([
    once(reader, "line").then(([line]) => JSON.parse(line)),
    exited.then(() => { throw new Error(`C# host exited before ready: ${diagnostics}`); }),
  ]);
  const url = `ws://127.0.0.1:${ready.port}/bridge`;
  const discover = () => ({ found: true, gatewayUrl: `http://127.0.0.1:${ready.port}`, bridgeToken: ready.token });
  async function connect(hello = {}) {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${ready.token}` } });
    t.after(() => socket.terminate());
    socket.on("error", () => {});
    await once(socket, "open");
    const greeting = once(socket, "message");
    socket.send(JSON.stringify({ type: "bridge.hello", role: "relay", protocolVersion: 1, clientVersion: SERVER_VERSION, projectPath: project, ...hello }));
    assert.equal(JSON.parse(String((await greeting)[0])).type, "bridge.ready");
    return socket;
  }
  const first = await callUnityBridge(project, "unity.logs", {}, { requestId: "first", operationId: "shared-op", query: "limit=7" }, discover);
  assert.deepEqual(first, { count: 1, action: "/logs", body: "{}", limit: "7", operationId: "shared-op" });
  const duplicate = await callUnityBridge(project, "unity.logs", {}, { requestId: "first", query: "limit=7" }, discover);
  assert.deepEqual(duplicate, first);
  await assert.rejects(callUnityBridge(project, "unity.logs", { different: true }, { requestId: "first", query: "limit=7" }, discover), /disconnected/);

  const socket = await connect();
  const accepted = once(socket, "message");
  socket.send(JSON.stringify({ type: "bridge.request", requestId: "disconnect-write", action: "unity.import-selected-images", body: "{}" }));
  assert.equal(JSON.parse(String((await accepted)[0])).status, "queued");
  socket.terminate();
  const recovered = await callUnityBridge(project, "unity.import-selected-images", {}, { requestId: "disconnect-write" }, discover);
  assert.equal(recovered.count, 2);
  const status = await callUnityBridge(project, "", {}, { requestId: "disconnect-write", statusOnly: true }, discover);
  assert.equal(status.status, "completed");
  assert.equal(JSON.parse(status.body).count, 2);
  const unknown = await callUnityBridge(project, "", {}, { requestId: "never-submitted", statusOnly: true }, discover);
  assert.equal(unknown.status, "unknown");

  const querySocket = await connect();
  for (let batch = 0; batch < 11; batch++) {
    await new Promise((resolve, reject) => {
      const pending = new Set(Array.from({ length: 100 }, (_, i) => `read-${batch}-${i}`));
      const onClose = () => reject(new Error("Read cache capacity unexpectedly closed the connection"));
      const onMessage = raw => {
        const message = JSON.parse(String(raw));
        if (message.status === "completed") pending.delete(message.requestId);
        if (!pending.size) {
          querySocket.off("message", onMessage);
          querySocket.off("close", onClose);
          resolve();
        }
      };
      querySocket.on("message", onMessage);
      querySocket.once("close", onClose);
      for (const requestId of pending) querySocket.send(JSON.stringify({ type: "bridge.request", requestId, action: "unity.health", body: "{}" }));
    });
  }
  const retainedWrite = await callUnityBridge(project, "unity.import-selected-images", {}, { requestId: "disconnect-write" }, discover);
  assert.equal(retainedWrite.count, 2, "read cache eviction must not forget or replay a write");

  const incompatible = new WebSocket(url, { headers: { Authorization: `Bearer ${ready.token}` } });
  incompatible.on("error", () => {});
  await once(incompatible, "open");
  const refused = once(incompatible, "message");
  incompatible.send(JSON.stringify({ type: "bridge.hello", role: "relay", protocolVersion: 1, clientVersion: "old", projectPath: project }));
  const error = JSON.parse(String((await refused)[0]));
  assert.equal(error.type, "bridge.error");
  assert.match(error.error, /Unity Bridge version mismatch/);
  incompatible.terminate();

  for (const headers of [{}, { Authorization: `Bearer ${ready.token}`, Origin: "https://example.com" }]) {
    const forbidden = new WebSocket(url, { headers });
    forbidden.on("error", () => {});
    const [error] = await once(forbidden, "error");
    assert.match(error.message, /403/);
  }
  assert.match(diagnostics, /Request identity conflict/);
});
