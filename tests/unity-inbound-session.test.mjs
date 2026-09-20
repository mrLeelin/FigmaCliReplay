import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";

import { SERVER_VERSION } from "../dist/config.js";
import { createRelayControlHandler } from "../dist/relayControl.js";
import { WebSocketGateway } from "../dist/websocketGateway.js";
import { callUnityBridge } from "../dist/unityBridgeClient.js";

const projectPath = "E:\\Project\\Test\\JellybeanUnity";
const bridgeToken = "test-bridge-token";
// 拨入路径必然失败：命令还能成功，就说明它确实走了 Unity 连入的会话。
const noDiscovery = () => ({ found: false });

async function startGateway(t) {
  const gateway = new WebSocketGateway(undefined, bridgeToken);
  const server = createServer();
  gateway.attachServer(server);
  const clients = [];
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    // t.after 按注册顺序执行，所以把"终止所有客户端 → 关网关 → 关服务器"放在同一个钩子里；
    // 已升级的 WebSocket 连接不会被 closeAllConnections 关闭，必须先自行终止。
    for (const socket of clients) { try { socket.terminate(); } catch { /* 已断开 */ } }
    gateway.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { gateway, port: server.address().port, clients };
}

/** 一个最小 Unity Bridge 客户端：连入 /unity 并按脚本回应。 */
function connectUnity(port, clients, options = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/unity`);
  clients.push(socket);
  const frames = [];
  const calls = [];
  const history = [];
  const ready = new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      frames.push(message);
      if (message.type === "bridge.registered") { resolve(message); return; }
      if (message.type === "bridge.error") { reject(new Error(message.error)); return; }
      if (message.type === "bridge.request" || message.type === "bridge.get") {
        calls.push(message);
        const scripted = history.shift();
        if (scripted) scripted(message, (reply) => socket.send(JSON.stringify(reply)));
      }
    });
    socket.on("open", () => socket.send(JSON.stringify({
      type: "bridge.register", role: "unity", projectPath: options.projectPath ?? projectPath,
      clientVersion: options.clientVersion ?? SERVER_VERSION, protocolVersion: options.protocolVersion ?? 1,
      bridgeToken: options.bridgeToken ?? bridgeToken,
      capabilities: ["unity.command"],
    })));
  });
  return { socket, frames, calls, history, ready };
}

test("commands route over an outbound Unity session instead of dialing the discovery file", { timeout: 10000 }, async (t) => {
  const { port, clients } = await startGateway(t);

  await assert.rejects(
    callUnityBridge(projectPath, "unity.health", {}, {}, noDiscovery),
    /Unity is not connected/,
    "没有会话时行为不变：仍走拨入并报发现失败",
  );

  const unity = connectUnity(port, clients);
  const registered = await unity.ready;
  assert.equal(registered.serverVersion, SERVER_VERSION);
  assert.equal(registered.protocolVersion, 1);

  unity.history.push((message, reply) => reply({
    type: "bridge.response", requestId: message.requestId, status: "completed",
    statusCode: 200, body: JSON.stringify({ ok: true, action: "/health" }),
  }));
  const result = await callUnityBridge(projectPath, "unity.health", { probe: 1 }, {}, noDiscovery);
  assert.deepEqual(result, { ok: true, action: "/health" });

  const request = unity.calls.at(-1);
  assert.equal(request.type, "bridge.request");
  assert.equal(request.action, "unity.health");
  assert.equal(request.body, JSON.stringify({ probe: 1 }), "负载仍保持二次编码，Unity 侧协议不变");
  assert.ok(request.requestId, "requestId 用于关联响应");
});

test("an unauthenticated Unity Bridge cannot register a session", { timeout: 10000 }, async (t) => {
  const { port, clients } = await startGateway(t);
  const rejected = connectUnity(port, clients, { bridgeToken: "wrong-token" });
  await assert.rejects(rejected.ready, /authentication failed/);
  await assert.rejects(callUnityBridge(projectPath, "unity.health", {}, {}, noDiscovery), /Unity is not connected/);
});

test("a stale Unity version is rejected and never becomes a session", { timeout: 10000 }, async (t) => {
  const { port, clients } = await startGateway(t);
  const stale = connectUnity(port, clients, { clientVersion: "0.0.1" });
  await assert.rejects(stale.ready, /version mismatch/);
  await assert.rejects(callUnityBridge(projectPath, "unity.health", {}, {}, noDiscovery), /Unity is not connected/);
});

test("progress polls with bridge.get and unknown/failed states keep their exact wording", { timeout: 15000 }, async (t) => {
  const { port, clients } = await startGateway(t);
  const unity = connectUnity(port, clients);
  await unity.ready;

  // queued → running → completed：中继用 bridge.get 轮询，语义与拨入路径一致。
  unity.history.push((message, reply) => reply({
    type: "bridge.response", requestId: message.requestId, status: "queued",
  }));
  unity.history.push((message, reply) => reply({
    type: "bridge.response", requestId: message.requestId, status: "completed",
    statusCode: 200, body: JSON.stringify({ ok: true, polled: true }),
  }));
  const polled = await callUnityBridge(projectPath, "unity.logs", { limit: 1 }, {}, noDiscovery);
  assert.deepEqual(polled, { ok: true, polled: true });
  assert.equal(unity.calls.filter((call) => call.type === "bridge.get").length, 1, "进度用 bridge.get 查询");

  unity.history.push((message, reply) => reply({
    type: "bridge.response", requestId: message.requestId, status: "unknown",
  }));
  await assert.rejects(callUnityBridge(projectPath, "unity.logs", {}, {}, noDiscovery), /Unknown Unity task; do not replay/);

  unity.history.push((message, reply) => reply({
    type: "bridge.response", requestId: message.requestId, status: "failed",
    statusCode: 400, body: JSON.stringify({ error: "prefab not selected" }),
  }));
  await assert.rejects(callUnityBridge(projectPath, "unity.logs", {}, {}, noDiscovery), /prefab not selected/);
});

test("a dropped session and a silent session both refuse to claim success", { timeout: 15000 }, async (t) => {
  const { port, clients } = await startGateway(t);
  const unity = connectUnity(port, clients);
  await unity.ready;

  const inFlight = callUnityBridge(projectPath, "unity.import-selected-images", {}, {}, noDiscovery);
  const disconnected = assert.rejects(inFlight, /unknown outcome; do not replay/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  unity.socket.terminate();
  await disconnected;
  assert.equal(unity.calls.at(-1).type, "bridge.request", "写入命令确实已派发");

  const rejoined = connectUnity(port, clients);
  await rejoined.ready;
  await assert.rejects(
    callUnityBridge(projectPath, "unity.health", {}, { timeoutMs: 200 }, noDiscovery),
    /may have executed; do not replay/,
  );
});

test("status-only queries resolve the raw Unity snapshot over the session", { timeout: 10000 }, async (t) => {  const { port, clients } = await startGateway(t);
  const unity = connectUnity(port, clients);
  await unity.ready;

  unity.history.push((message, reply) => reply({
    type: "bridge.response", requestId: message.requestId, status: "completed", statusCode: 200,
    body: JSON.stringify({ ok: true, replayed: false }),
  }));
  const snapshot = await callUnityBridge(projectPath, "unity.import-selected-images", {}, {
    statusOnly: true, requestId: "query-only",
  }, noDiscovery);
  assert.equal(snapshot.requestId, "query-only");
  assert.equal(snapshot.status, "completed");
  assert.equal(unity.calls.at(-1).type, "bridge.get", "查询不派发 bridge.request");
});

test("unity.gateway.get reports the outbound session when there is no discovery record", { timeout: 10000 }, async (t) => {
  const { port, clients } = await startGateway(t);
  const unity = connectUnity(port, clients);
  await unity.ready;

  const project = { id: "p1", name: "JellybeanUnity", path: projectPath, valid: true, lastSeenAt: new Date().toISOString() };
  const control = createRelayControlHandler({}, { controller: {} }, {}, {
    list: () => ({ projects: [project], lastSelectedProjectId: project.id }),
  });
  const info = await control("unity.gateway.get", { id: "p1" });
  assert.equal(info.found, true, "纯出站模式没有发现文件，也要能报出网关信息");
  assert.equal(info.transport, "inbound");
  assert.equal(info.gatewayUrl, "relay-session://inbound");
  assert.equal(info.clientVersion, SERVER_VERSION);
  assert.ok(info.updatedAtUtc, "带会话心跳时间，便于 UI 显示");

  // 没有会话的其他工程仍然回落到发现记录（此处没有记录 → found:false）
  const other = { ...project, id: "p2", path: "E:\\Project\\Test\\OtherProject" };
  const control2 = createRelayControlHandler({}, { controller: {} }, {}, {
    list: () => ({ projects: [other], lastSelectedProjectId: other.id }),
  });
  const missing = await control2("unity.gateway.get", { id: "p2" });
  assert.equal(missing.found, false);
});
