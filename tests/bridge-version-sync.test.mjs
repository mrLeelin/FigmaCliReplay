import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { SERVER_VERSION as compiledRelayVersion } from "../dist/config.js";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
const bridge = fs.readFileSync(new URL("../unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs", import.meta.url), "utf8");
const relayConfig = fs.readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const buildScript = fs.readFileSync(new URL("../scripts/build.py", import.meta.url), "utf8");
const packageReleaseScript = fs.readFileSync(new URL("../scripts/package_release.ps1", import.meta.url), "utf8");

test("package version is synchronized to the UI, Unity Bridge, and MCP relay", () => {
  const uiMatch = ui.match(/<!-- BEGIN_RELEASE_VERSION -->v([^<]+)<!-- END_RELEASE_VERSION -->/);
  const bridgeMatch = bridge.match(/\/\/ BEGIN_RELEASE_VERSION\s+private const string Version = "([^"]+)";\s+\/\/ END_RELEASE_VERSION/);

  assert.ok(uiMatch, "UI release marker should exist exactly once");
  assert.ok(bridgeMatch, "Bridge release marker should exist exactly once");
  const relayMatch = relayConfig.match(/\/\/ BEGIN_RELEASE_VERSION\s+export const SERVER_VERSION = "([^\"]+)";\s+\/\/ END_RELEASE_VERSION/);
  assert.ok(relayMatch, "MCP relay release marker should exist exactly once");
  assert.equal(ui.match(/BEGIN_RELEASE_VERSION/g)?.length, 1);
  assert.equal(bridge.match(/BEGIN_RELEASE_VERSION/g)?.length, 1);
  assert.equal(relayConfig.match(/BEGIN_RELEASE_VERSION/g)?.length, 1);
  assert.equal(uiMatch[1], packageJson.version);
  assert.equal(bridgeMatch[1], packageJson.version);
  assert.equal(relayMatch[1], packageJson.version);
  assert.equal(compiledRelayVersion, packageJson.version, "compiled MCP relay should expose the package release version");
  assert.match(buildScript, /BRIDGE_SERVER\s*=/);
  assert.match(buildScript, /BRIDGE_RELEASE_VERSION_MARKER\s*=/);
  assert.match(buildScript, /RELAY_CONFIG\s*=/);
  assert.match(buildScript, /RELAY_RELEASE_VERSION_MARKER\s*=/);
  assert.match(buildScript, /sync_marked_release_version\(UI_HTML/);
  assert.match(buildScript, /sync_marked_release_version\(BRIDGE_SERVER/);
  assert.match(buildScript, /sync_marked_release_version\(RELAY_CONFIG/);
});

test("release package synchronizes source versions before compiling the relay", () => {
  const syncIndex = packageReleaseScript.indexOf('scripts/build.py", "--sync-release-version');
  const compileIndex = packageReleaseScript.indexOf('Invoke-Checked -FilePath "npm" -Arguments @("run", "build")');

  assert.ok(syncIndex >= 0, "release packaging should run the release-version sync command");
  assert.ok(compileIndex >= 0, "release packaging should compile the relay");
  assert.ok(syncIndex < compileIndex, "the compiled MCP server must receive the synchronized release version");
});

test("Bridge version comparison requires an exact reported release version", () => {
  const functionMatch = ui.match(/function evaluateBridgeVersion\(pluginVersion, bridgeVersion\) \{[\s\S]*?\n    \}/);
  assert.ok(functionMatch, "UI should define an executable Bridge version comparison helper");

  const context = {};
  vm.runInNewContext(`${functionMatch[0]}; this.evaluateBridgeVersion = evaluateBridgeVersion;`, context);

  assert.deepEqual(
    { ...context.evaluateBridgeVersion("0.1.37", "0.1.37") },
    { matches: true, pluginVersion: "0.1.37", bridgeVersion: "0.1.37" },
  );
  assert.deepEqual(
    { ...context.evaluateBridgeVersion("0.1.37", "1.0.0") },
    { matches: false, pluginVersion: "0.1.37", bridgeVersion: "1.0.0" },
  );
  assert.deepEqual(
    { ...context.evaluateBridgeVersion("0.1.37", "v0.1.37") },
    { matches: false, pluginVersion: "0.1.37", bridgeVersion: "v0.1.37" },
  );
  assert.deepEqual(
    { ...context.evaluateBridgeVersion("0.1.37", "") },
    { matches: false, pluginVersion: "0.1.37", bridgeVersion: "未报告" },
  );
});

test("Bridge version mismatch is terminal for configured and scanned gateways", () => {
  const scanStart = ui.indexOf("async function scanUnityGateways(preferredUrl)");
  const connectStart = ui.indexOf("async function connectUnity()", scanStart);
  const disconnectStart = ui.indexOf("function disconnectUnity()", connectStart);
  const scanSource = ui.slice(scanStart, connectStart);
  const connectSource = ui.slice(connectStart, disconnectStart);

  assert.match(scanSource, /if \(error && error\.bridgeVersionMismatch\) throw error/);
  assert.match(connectSource, /probeUnityUrl\(configuredUrl\)[\s\S]*?if \(error && error\.bridgeVersionMismatch\) throw error/);
  assert.match(connectSource, /unityBridgeVersionMismatch = error && error\.bridgeVersionMismatch \? error : null/);
});

test("top Bridge badge renders disconnected, connected, mismatch, and missing versions", () => {
  const functionMatch = ui.match(/function getBridgeVersionBadgeState\(bridgeVersion, status\) \{[\s\S]*?\n    \}/);
  assert.ok(functionMatch, "UI should define a Bridge badge state helper");
  const context = {};
  vm.runInNewContext(`${functionMatch[0]}; this.getBridgeVersionBadgeState = getBridgeVersionBadgeState;`, context);

  assert.deepEqual({ ...context.getBridgeVersionBadgeState("", "disconnected") }, { text: "Bridge --", state: "idle" });
  assert.deepEqual({ ...context.getBridgeVersionBadgeState("0.1.37", "connected") }, { text: "Bridge 0.1.37", state: "online" });
  assert.deepEqual({ ...context.getBridgeVersionBadgeState("1.0.0", "mismatch") }, { text: "Bridge 1.0.0", state: "error" });
  assert.deepEqual({ ...context.getBridgeVersionBadgeState("", "mismatch") }, { text: "Bridge 未报告", state: "error" });
});

test("Bridge badge follows the Unity connection lifecycle", () => {
  assert.match(ui, /setBridgeVersionBadge\(data\.version, "mismatch"\)[\s\S]*?throw createBridgeVersionMismatchError/);
  assert.match(ui, /unityConnected = true;[\s\S]*?setBridgeVersionBadge\(data\.version, "connected"\)/);

  const connectStart = ui.indexOf("async function connectUnity()");
  const disconnectStart = ui.indexOf("function disconnectUnity()", connectStart);
  const controlsStart = ui.indexOf("function refreshUnityControls()", disconnectStart);
  assert.match(ui.slice(connectStart, disconnectStart), /setBridgeVersionBadge\("", "disconnected"\)/);
  assert.match(ui.slice(disconnectStart, controlsStart), /setBridgeVersionBadge\("", "disconnected"\)/);

  const selectStart = ui.indexOf("async function selectUnityProject()");
  const removeStart = ui.indexOf("async function removeUnityProject()", selectStart);
  assert.match(ui.slice(selectStart, removeStart), /setBridgeVersionBadge\("", "disconnected"\)/);
});
