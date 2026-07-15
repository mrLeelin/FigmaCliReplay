import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const installerModulePath = path.resolve("dist/unityBridgeInstaller.js");
assert.equal(fs.existsSync(installerModulePath), true, "unityBridgeInstaller module must be built");
const { installUnityBridge } = await import(pathToFileURL(installerModulePath));

test("bridge installer copies editor files and preserves project settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-bridge-install-"));
  const sourceEditor = path.join(root, "source", "Assets", "Editor");
  const sourceBridge = path.join(sourceEditor, "FigmaBridge");
  fs.mkdirSync(sourceBridge, { recursive: true });
  fs.writeFileSync(path.join(sourceBridge, "Bridge.cs"), "source", "utf8");
  fs.writeFileSync(path.join(sourceEditor, "FigmaBridge.meta"), "guid: source", "utf8");

  const projectPath = path.join(root, "UnityProject");
  fs.mkdirSync(path.join(projectPath, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, "ProjectSettings"), { recursive: true });
  const settingsPath = path.join(projectPath, "ProjectSettings", "FigmaBridgeImportSettings.json");
  fs.writeFileSync(settingsPath, "keep-me", "utf8");

  const result = installUnityBridge(projectPath, sourceEditor);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(projectPath, "Assets", "Editor", "FigmaBridge", "Bridge.cs"), "utf8"), "source");
  assert.equal(fs.readFileSync(settingsPath, "utf8"), "keep-me");
});
