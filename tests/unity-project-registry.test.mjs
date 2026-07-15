import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = path.resolve("dist/unityProjectRegistry.js");
assert.ok(fs.existsSync(modulePath), "unityProjectRegistry module must be built");
const { UnityProjectRegistry } = await import(pathToFileURL(modulePath));

function createUnityProject(root, name, withBridge = false) {
  const projectPath = path.join(root, name);
  fs.mkdirSync(path.join(projectPath, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, "ProjectSettings"), { recursive: true });
  if (withBridge) fs.mkdirSync(path.join(projectPath, "Assets", "Editor", "FigmaBridge"), { recursive: true });
  return projectPath;
}

test("registry adds selects and removes multiple Unity projects", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-registry-"));
  const registryPath = path.join(root, "projects.json");
  const projectA = createUnityProject(root, "ProjectA", true);
  const projectB = createUnityProject(root, "ProjectB");
  const registry = new UnityProjectRegistry(registryPath);

  const addedA = registry.add(projectA);
  const addedB = registry.add(projectB);
  assert.equal(registry.list().projects.length, 2);
  assert.equal(addedA.bridgeInstalled, true);
  assert.equal(addedB.bridgeInstalled, false);

  registry.select(addedB.id);
  assert.equal(registry.snapshot().path, path.resolve(projectB));

  registry.remove(addedB.id);
  assert.equal(registry.list().projects.length, 1);
  assert.equal(registry.snapshot().id, addedA.id);
});

test("registry rejects non-Unity directories and deduplicates normalized paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-registry-"));
  const registry = new UnityProjectRegistry(path.join(root, "projects.json"));
  const project = createUnityProject(root, "ProjectA");
  const invalid = path.join(root, "NotUnity");
  fs.mkdirSync(invalid);

  assert.throws(() => registry.add(invalid), /Assets.*ProjectSettings/);
  registry.add(project);
  registry.add(path.join(project, "."));
  assert.equal(registry.list().projects.length, 1);
});
