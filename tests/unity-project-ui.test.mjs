import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

test("Figma UI exposes multi-project selection controls", () => {
  for (const id of [
    "unityProjectSelect",
    "unityProjectPathInput",
    "addUnityProjectBtn",
    "installUnityBridgeBtn",
    "removeUnityProjectBtn",
    "refreshUnityProjectsBtn",
    "unityProjectStatus"
  ]) {
    assert.match(ui, new RegExp(`id=["']${id}["']`));
  }
  assert.match(ui, /function refreshUnityProjects\s*\(/);
  assert.match(ui, /function selectUnityProject\s*\(/);
  assert.match(ui, /function installSelectedUnityBridge\s*\(/);
  assert.match(ui, /data\.projectPath/);
  assert.match(ui, /selectedUnityProject\.path/);
});

test("Unity AI task carries the selected project snapshot and explicit script path", () => {
  assert.match(ui, /unityProject:\s*selectedUnityProject/);
  assert.match(ui, /--unity-project\s+\\?"?\{\{unityProjectPath\}\}/);
});

test("adding a Unity project gives immediate progress and always restores the button", () => {
  const functionStart = ui.indexOf("async function addUnityProject()");
  const functionEnd = ui.indexOf("async function selectUnityProject()", functionStart);
  const source = ui.slice(functionStart, functionEnd);
  const progressIndex = source.indexOf('unityProjectStatus.textContent = "正在添加 Unity 工程');
  const fetchIndex = source.indexOf('fetchWithTimeout(relayEndpoint("/unity-projects/add")');

  assert.ok(progressIndex >= 0, "add flow should show progress immediately");
  assert.ok(fetchIndex > progressIndex, "progress should be visible before the network request starts");
  assert.match(source, /addUnityProjectBtn\.disabled = true/);
  assert.match(source, /finally\s*\{[\s\S]*?addUnityProjectBtn\.disabled = false/);
  assert.match(source, /本地 MCP Companion 未连接，无法添加 Unity 工程/);
});
