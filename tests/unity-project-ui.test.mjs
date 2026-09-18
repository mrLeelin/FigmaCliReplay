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

test("Prefab-to-Figma import sends the selected Unity project root", () => {
  const functionStart = ui.indexOf("async function startPrefabImportToFigma(");
  const functionEnd = ui.indexOf("async function subscribePrefabImportTask()", functionStart);
  const source = ui.slice(functionStart, functionEnd);

  assert.match(source, /unityProjectPath:\s*selectedUnityProject\.path/);
});

test("nine-slice crop sends the selected Unity project root", () => {
  const functionStart = ui.indexOf("async function handleUnityImageExport(message)");
  const functionEnd = ui.indexOf("function renderUnityImportResult", functionStart);
  const source = ui.slice(functionStart, functionEnd);

  assert.match(source, /sendRelaySocketRequest\("image\.crop"/);
  assert.match(source, /var unityProjectPath = selectedUnityProject\s*\?\s*selectedUnityProject\.path\s*:\s*unityGatewayProjectPath/);
  assert.match(source, /unityProjectPath:\s*unityProjectPath/);
  assert.match(source, /if \(!unityProjectPath\)/);
});

test("Prefab-to-Figma import records terminal task errors in the live log", () => {
  const functionStart = ui.indexOf("function handlePrefabImportEvent(message)");
  const functionEnd = ui.indexOf("function renderPrefabImportTaskStatus", functionStart);
  const source = ui.slice(functionStart, functionEnd);

  assert.match(source, /data\.status === "error"[\s\S]*?appendLog\(/);
  assert.match(source, /data\.errors/);
});

test("adding a Unity project gives immediate progress and always restores the button", () => {
  const functionStart = ui.indexOf("async function addUnityProject()");
  const functionEnd = ui.indexOf("async function selectUnityProject()", functionStart);
  const source = ui.slice(functionStart, functionEnd);
  const progressIndex = source.indexOf('unityProjectStatus.textContent = "正在添加 Unity 工程');
  const fetchIndex = source.indexOf('sendRelaySocketRequest("unity.projects.add"');

  assert.ok(progressIndex >= 0, "add flow should show progress immediately");
  assert.ok(fetchIndex > progressIndex, "progress should be visible before the network request starts");
  assert.match(source, /addUnityProjectBtn\.disabled = true/);
  assert.match(source, /finally\s*\{[\s\S]*?addUnityProjectBtn\.disabled = false/);
  assert.match(source, /本地 Relay 未连接，无法添加 Unity 工程/);
});
