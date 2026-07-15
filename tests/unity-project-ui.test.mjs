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
