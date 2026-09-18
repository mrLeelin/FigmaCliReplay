import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

import { SERVER_VERSION } from "../dist/config.js";
import { closeUnitySessions, unitySessionStatus } from "../dist/unitySessionRegistry.js";
import { WebSocketGateway } from "../dist/websocketGateway.js";
import { callUnityBridge } from "../dist/unityBridgeClient.js";

// 与 C# 互通测试同样的开关方式：默认跳过，显式提供已编译宿主时才跑。
//   UNITY_BRIDGE_CLIENT_HOST = BridgeClientHost.dll 或 MonoClientHost.exe 的路径
//   UNITY_BRIDGE_CLIENT_RUNNER = dotnet(默认) | mono
//   UNITY_MONO_EXE = mono.exe 路径（runner=mono 时必填）
const hostPath = process.env.UNITY_BRIDGE_CLIENT_HOST;
const runner = process.env.UNITY_BRIDGE_CLIENT_RUNNER === "mono" ? "mono" : "dotnet";
const monoExe = process.env.UNITY_MONO_EXE;

const projectPath = "E:\\Project\\Test\\JellybeanUnity";
// 拨入回退必须失败：命令还能成功，就证明走的是 Unity 主动连入的那条会话。
const noDiscovery = () => ({ found: false });

async function startGateway(t) {
  const gateway = new WebSocketGateway();
  const server = createServer();
  gateway.attachServer(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    gateway.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port };
}

async function waitForSession(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessions = unitySessionStatus();
    if (sessions.length > 0) return sessions[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

test("the outbound Unity client registers, serves commands, and survives a dropped session", {
  timeout: 40000,
  skip: !hostPath && "Set UNITY_BRIDGE_CLIENT_HOST to the compiled BridgeClientHost (dotnet) or MonoClientHost.exe (mono)",
}, async (t) => {
  const { port } = await startGateway(t);
  const relayUrl = `ws://127.0.0.1:${port}/unity`;
  const command = runner === "mono" ? [monoExe, hostPath, SERVER_VERSION, projectPath, relayUrl]
    : ["dotnet", hostPath, SERVER_VERSION, projectPath, relayUrl];
  const host = spawn(command[0], command.slice(1), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  host.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
  t.after(() => { try { host.kill(); } catch { /* 已退出 */ } });

  const session = await waitForSession(15000);
  assert.ok(session, `出站会话未在 15s 内注册（runner=${runner}）: ${diagnostics}`);
  assert.equal(session.projectPath, projectPath);
  assert.equal(session.clientVersion, SERVER_VERSION);
  assert.equal(session.protocolVersion, 1);

  const first = await callUnityBridge(projectPath, "unity.health", { probe: 1 }, {}, noDiscovery);
  assert.equal(first.ok, true);
  assert.equal(first.action, "/health");

  // 身份不符的项目必须走不通，且不会误用这条会话
  await assert.rejects(
    callUnityBridge("E:\\Project\\Test\\OtherProject", "unity.health", {}, { timeoutMs: 500 }, noDiscovery),
    /Unity is not connected/,
  );

  // 中继断开会话 → 客户端应自行重连并重新注册
  closeUnitySessions();
  const rejoined = await waitForSession(15000);
  assert.ok(rejoined, `断开后 15s 内未重新注册（runner=${runner}）: ${diagnostics}`);
  const afterReconnect = await callUnityBridge(projectPath, "unity.health", {}, {}, noDiscovery);
  assert.equal(afterReconnect.ok, true, "重连后的命令必须继续可用");
});
