import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

test("connection settings live behind a dedicated settings tab", () => {
  const settingsButtonIndex = ui.indexOf('data-tab="settings-tab"');
  const settingsPageIndex = ui.indexOf('class="tab-page" id="settings-tab"');
  const mcpSectionIndex = ui.indexOf('id="ai-section"');
  const unitySectionIndex = ui.indexOf('id="unity-section"');
  const settingsPageEndIndex = ui.indexOf("<!-- SETTINGS_TAB_END -->");

  assert.notEqual(settingsButtonIndex, -1, "main navigation should expose the settings tab");
  assert.notEqual(settingsPageIndex, -1, "settings tab page should exist");
  assert.match(ui, /data-tab="settings-tab"[^>]*>设置<\/button>/);
  assert.ok(settingsPageIndex < mcpSectionIndex, "MCP Companion should be inside settings");
  assert.ok(mcpSectionIndex < unitySectionIndex, "Unity gateway should follow MCP Companion");
  assert.ok(unitySectionIndex < settingsPageEndIndex, "Unity gateway should remain inside settings");
  assert.match(ui, /\.tabs\s*\{[\s\S]*?display:\s*flex/);
  assert.match(ui, /\.tab-button\s*\{[\s\S]*?flex:\s*1/);
});

test("Figma location stays on the main screen before feature navigation", () => {
  const locationIndex = ui.indexOf('id="figma-location-section"');
  const tabsIndex = ui.indexOf('<div class="tabs" role="tablist">');

  assert.ok(locationIndex >= 0 && locationIndex < tabsIndex);
});

test("top bar shows Bridge version immediately after the plugin release version", () => {
  assert.match(ui, /BEGIN_RELEASE_VERSION[\s\S]*?END_RELEASE_VERSION[\s\S]*?id="bridgeVersionBadge"[^>]*>Bridge --<\/span>/);
});

test("Unity gateway address is auto-discovered instead of manually edited", () => {
  assert.match(ui, /<input id="unityUrl"[^>]*\sreadonly(?:\s|\/?>)/);
  assert.match(ui, /<button id="unityConnectBtn">自动连接<\/button>/);
  assert.doesNotMatch(ui, /unityPortMin|unityPortMax|buildUnityProbeUrls/);
  assert.match(ui, /actualProjectPath !== expectedProjectPath/);
});

test("settings tab reports every disconnected required service", () => {
  assert.match(ui, /id="settingsTabBtn"[^>]*data-tab="settings-tab"/);
  assert.match(ui, /\.tab-button\.connection-error::after\s*\{/);
  assert.match(ui, /function refreshSettingsConnectionAlert\(\)/);
  assert.match(ui, /if \(!relayConnected\) missing\.push\("本地 Relay"\)/);
  assert.match(ui, /if \(!unityConnected\) missing\.push\("Unity 网关"\)/);
  assert.match(ui, /settingsTabBtn\.title = message/);
  assert.match(ui, /function setAiBadge\(online\)[\s\S]*?refreshSettingsConnectionAlert\(\)/);
  assert.match(ui, /function setUnityBadge\(online\)[\s\S]*?refreshSettingsConnectionAlert\(\)/);
});

test("Unity connection uses only the selected project discovery and WebSocket", () => {
  assert.match(ui, /async function readSelectedUnityGatewayConfig\(\)/);
  assert.match(ui, /sendRelaySocketRequest\("unity\.gateway\.get", \{ id: selectedUnityProject\.id \}/);
  assert.match(ui, /async function probeUnityUrl\(url\)/);
  assert.doesNotMatch(ui, /scanUnityGateways/);

  const connectStart = ui.indexOf("async function connectUnity()");
  const connectEnd = ui.indexOf("function disconnectUnity()", connectStart);
  const connectSource = ui.slice(connectStart, connectEnd);
  const readIndex = connectSource.indexOf("readSelectedUnityGatewayConfig()");
  const configuredProbeIndex = connectSource.indexOf("probeUnityUrl(configuredUrl)");

  assert.match(connectSource, /正在读取 Unity 网关配置/);
  assert.match(connectSource, /if \(!configuredUrl\) throw/);
  assert.ok(readIndex >= 0 && readIndex < configuredProbeIndex);
  assert.match(ui, /requestUnityCommand\("unity\.health"\)/);
});

test("Bridge version mismatch is surfaced in settings with an explicit sync action", () => {
  assert.match(ui, /if \(unityBridgeVersionMismatch\) missing\.push\("Unity Bridge 版本不一致"\)/);
  assert.match(ui, /unityBadge\.textContent = "版本错误"/);
  assert.match(ui, /installUnityBridgeBtn\.textContent = hasVersionMismatch \? "同步 Bridge" : "安装\/更新 Bridge"/);
  assert.match(ui, /installUnityBridgeBtn\.classList\.toggle\("danger", hasVersionMismatch\)/);
  assert.match(ui, /Bridge 已同步到 " \+ pluginReleaseVersion \+ "，等待 Unity 编译后重新连接。/);

  const installStart = ui.indexOf("async function installSelectedUnityBridge()");
  const installEnd = ui.indexOf("async function requestUnityCommand(", installStart);
  const installSource = ui.slice(installStart, installEnd);
  assert.doesNotMatch(installSource, /unityBridgeVersionMismatch\s*=\s*null/);
});
