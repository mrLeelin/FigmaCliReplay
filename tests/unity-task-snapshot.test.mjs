import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { UnityProjectRegistry } from "../dist/unityProjectRegistry.js";

const runnerModulePath = path.resolve("dist/localAiRunner.js");
assert.match(fs.readFileSync(runnerModulePath, "utf8"), /export function resolveUnityProjectSnapshot/);
const { resolveUnityProjectSnapshot } = await import(pathToFileURL(runnerModulePath));

function createUnityProject(root, name) {
  const projectPath = path.join(root, name);
  fs.mkdirSync(path.join(projectPath, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, "ProjectSettings"), { recursive: true });
  return projectPath;
}

test("Unity task snapshot is resolved by registered id and survives later selection changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-task-"));
  const registry = new UnityProjectRegistry(path.join(root, "projects.json"));
  const projectA = registry.add(createUnityProject(root, "ProjectA"));
  const projectB = registry.add(createUnityProject(root, "ProjectB"));

  const snapshot = resolveUnityProjectSnapshot({
    template: "unity",
    unityProject: { id: projectA.id, path: "C:/tampered/path" }
  }, registry);
  registry.select(projectB.id);

  assert.equal(snapshot.path, projectA.path);
  assert.equal(snapshot.id, projectA.id);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("Unity task requires a registered project id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-task-"));
  const registry = new UnityProjectRegistry(path.join(root, "projects.json"));
  assert.throws(
    () => resolveUnityProjectSnapshot({ template: "unity", unityProject: { id: "missing" } }, registry),
    /unknown Unity project/
  );
});
