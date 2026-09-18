import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs", import.meta.url), "utf8");
const transport = fs.readFileSync(new URL("../unity/Assets/Editor/FigmaBridge/BridgeWebSocketTransport.cs", import.meta.url), "utf8");
const discoveryPath = new URL("../unity/Assets/Editor/FigmaBridge/FigmaBridgeGatewayDiscovery.cs", import.meta.url);

test("Unity bridge health reports the actual project name and path", () => {
  assert.doesNotMatch(source, /projectName\\\":\\\"JellybeanUnity/);
  assert.match(source, /projectName/);
  assert.match(source, /projectPath/);
  assert.match(source, /Path\.GetDirectoryName\(Application\.dataPath\)/);
});

test("the bridge no longer writes gateway discovery records or listens on a local port", () => {
  assert.equal(fs.existsSync(discoveryPath), false, "发现文件机制应已随出站形态删除");
  assert.doesNotMatch(source, /FigmaBridgeGatewayDiscovery/);
  assert.doesNotMatch(source, /new TcpListener\(/);
  assert.doesNotMatch(source, /TryStartOnPort|StartListenerFallback|PreferredPort|CurrentGatewayUrl/);
  assert.doesNotMatch(transport, /new TcpListener\(|\.AcceptWebSocketAsync\(|WebSocket\.CreateFromStream\(/);
});

test("bridge releases its connection before a domain reload", () => {
  assert.match(source, /using UnityEditor\.Compilation;/);
  assert.match(source, /AssemblyReloadEvents\.beforeAssemblyReload \+= Stop;/);
});

test("the bridge only dials the relay outbound", () => {
  assert.match(source, /private const int DefaultRelayPort = 32130;/);
  assert.match(source, /internal static string RelayClientUrl/);
  assert.match(source, /_webSocketTransport\.StartRelayClient\(RelayClientUrl\);/);
  assert.doesNotMatch(source, /RelayFallbackGraceSeconds|_relayFallbackDeadline/);
  assert.doesNotMatch(source, /FigmaBridgeGatewayDiscovery\.Publish/);
  assert.match(transport, /internal void StartRelayClient\(string relayUrl\)/);
  assert.match(transport, /new ClientWebSocket\(\)/, "ClientWebSocket 在 Unity Mono 上实测可用，出站客户端用它");
  assert.match(transport, /"bridge\.register"/);
  assert.match(transport, /"bridge\.heartbeat"/);
  assert.match(transport, /backoffMs = Math\.Min\(30000, backoffMs \* 2\);/);
  assert.match(transport, /internal bool RelayClientRegistered/, "窗口与状态判断依赖已注册状态");
  assert.match(transport, /if \(string\.IsNullOrWhiteSpace\(relayUrl\) \|\| _relayClientStarted\) return;/, "出站循环只启动一次");
  assert.match(transport, /await ProcessRequests\(socket, sendLock\);/, "命令循环是唯一通路");
});
