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

test("bridge installer removes the retired gateway discovery writer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-bridge-retired-"));
  const sourceEditor = path.join(root, "source", "Assets", "Editor");
  const sourceBridge = path.join(sourceEditor, "FigmaBridge");
  fs.mkdirSync(sourceBridge, { recursive: true });
  fs.writeFileSync(path.join(sourceBridge, "Bridge.cs"), "source", "utf8");
  fs.writeFileSync(path.join(sourceEditor, "FigmaBridge.meta"), "fileFormatVersion: 2\nguid: 22222222222222222222222222222222\n", "utf8");

  const projectPath = path.join(root, "UnityProject");
  scaffoldProject(projectPath);
  const installedBridge = path.join(projectPath, "Assets", "Editor", "FigmaBridge");
  fs.mkdirSync(installedBridge, { recursive: true });
  fs.writeFileSync(path.join(installedBridge, "FigmaBridgeGatewayDiscovery.cs"), "// retired", "utf8");
  fs.writeFileSync(path.join(installedBridge, "FigmaBridgeGatewayDiscovery.cs.meta"), "guid: 33333333333333333333333333333333", "utf8");

  installUnityBridge(projectPath, sourceEditor);

  assert.equal(fs.existsSync(path.join(installedBridge, "FigmaBridgeGatewayDiscovery.cs")), false);
  assert.equal(fs.existsSync(path.join(installedBridge, "FigmaBridgeGatewayDiscovery.cs.meta")), false);
  assert.equal(fs.readFileSync(path.join(installedBridge, "Bridge.cs"), "utf8"), "source");
});

function scaffoldProject(projectPath) {
  fs.mkdirSync(path.join(projectPath, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, "ProjectSettings"), { recursive: true });
}

test("bridge installer preserves an existing project .meta instead of overwriting its guid", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-bridge-keep-meta-"));
  const sourceEditor = path.join(root, "source", "Assets", "Editor");
  const sourceBridge = path.join(sourceEditor, "FigmaBridge");
  fs.mkdirSync(sourceBridge, { recursive: true });
  fs.writeFileSync(path.join(sourceBridge, "Bridge.cs"), "updated-body", "utf8");
  fs.writeFileSync(path.join(sourceBridge, "Bridge.cs.meta"), "fileFormatVersion: 2\nguid: 11111111111111111111111111111111\n", "utf8");
  fs.writeFileSync(path.join(sourceEditor, "FigmaBridge.meta"), "fileFormatVersion: 2\nguid: 22222222222222222222222222222222\n", "utf8");

  const projectPath = path.join(root, "UnityProject");
  scaffoldProject(projectPath);
  const installedBridge = path.join(projectPath, "Assets", "Editor", "FigmaBridge");
  fs.mkdirSync(installedBridge, { recursive: true });
  const projectGuid = "33333333333333333333333333333333";
  const installedMeta = path.join(installedBridge, "Bridge.cs.meta");
  fs.writeFileSync(installedMeta, `fileFormatVersion: 2\nguid: ${projectGuid}\n`, "utf8");

  installUnityBridge(projectPath, sourceEditor);

  assert.equal(fs.readFileSync(path.join(installedBridge, "Bridge.cs"), "utf8"), "updated-body");
  assert.match(fs.readFileSync(installedMeta, "utf8"), new RegExp(`guid: ${projectGuid}`), "an existing meta keeps the project guid");
  assert.match(
    fs.readFileSync(path.join(projectPath, "Assets", "Editor", "FigmaBridge.meta"), "utf8"),
    /guid: 22222222222222222222222222222222/,
    "a missing meta is still installed from the template",
  );
});

test("bridge installer reallocates a template guid that another project asset already owns", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-bridge-guid-conflict-"));
  const sourceEditor = path.join(root, "source", "Assets", "Editor");
  const sourceBridge = path.join(sourceEditor, "FigmaBridge");
  fs.mkdirSync(sourceBridge, { recursive: true });
  const contestedGuid = "44444444444444444444444444444444";
  fs.writeFileSync(path.join(sourceBridge, "Bridge.cs"), "source", "utf8");
  fs.writeFileSync(path.join(sourceBridge, "Bridge.cs.meta"), `fileFormatVersion: 2\nguid: ${contestedGuid}\n`, "utf8");
  fs.writeFileSync(path.join(sourceEditor, "FigmaBridge.meta"), "fileFormatVersion: 2\nguid: 55555555555555555555555555555555\n", "utf8");

  const projectPath = path.join(root, "UnityProject");
  scaffoldProject(projectPath);
  const ownerMeta = path.join(projectPath, "Assets", "Runtime", "Bridge.cs.meta");
  fs.mkdirSync(path.dirname(ownerMeta), { recursive: true });
  fs.writeFileSync(ownerMeta, `fileFormatVersion: 2\nguid: ${contestedGuid}\n`, "utf8");

  installUnityBridge(projectPath, sourceEditor);

  const installedMeta = fs.readFileSync(path.join(projectPath, "Assets", "Editor", "FigmaBridge", "Bridge.cs.meta"), "utf8");
  assert.match(installedMeta, /^guid: [0-9a-f]{32}$/m);
  assert.doesNotMatch(installedMeta, new RegExp(contestedGuid), "the installed meta must not reuse an owned guid");
  assert.match(fs.readFileSync(ownerMeta, "utf8"), new RegExp(contestedGuid), "the original owner keeps its guid");
});
