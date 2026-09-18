import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { probeUnityGateway } from "../dist/figmaPrefabImportTask.js";
import { SERVER_VERSION } from "../dist/config.js";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
function getFunction(name) {
  const match = ui.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    \\}`));
  assert.ok(match, name);
  return match[0];
}
function context(send) {
  const sandbox = vm.createContext({ selectedUnityProject: { id: "project-a" }, sendRelaySocketRequest: send });
  vm.runInContext(getFunction("requestUnityCommand"), sandbox);
  return sandbox;
}

test("UI scripts parse and Unity business requests have no direct HTTP fallback", () => {
  for (const match of ui.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  assert.doesNotMatch(ui, /unityEndpoint|scanUnityGateways|buildUnityProbeUrls/);
  for (const action of ["health", "selected-folder", "prefab-import-canvas", "import-selected-images", "sync-prefab-hierarchy", "sync-selected-text-style"]) {
    assert.ok(ui.includes(`requestUnityCommand("unity.${action}"`), action);
  }
});

test("UI freezes the registered project and sends exactly one command", async () => {
  const calls = [];
  const sandbox = context(async (...args) => { calls.push(args); return { ok: true, result: { ok: true, count: 2 } }; });
  const result = await sandbox.requestUnityCommand("unity.import-selected-images", { images: ["image"] }, 15000);
  assert.equal(result.count, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "unity.command");
  assert.equal(calls[0][1].id, "project-a");
  assert.equal(calls[0][1].timeoutMs, 15000);
  assert.match(calls[0][1].requestId, /^unity-/);
  assert.equal(calls[0][3], 17000);
});

test("UI rejects absent targets and stale project results", async () => {
  let finish;
  let calls = 0;
  const sandbox = context(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  sandbox.selectedUnityProject = null;
  await assert.rejects(sandbox.requestUnityCommand("unity.health"), /选择 Unity/);
  assert.equal(calls, 0);
  sandbox.selectedUnityProject = { id: "project-a" };
  const pending = sandbox.requestUnityCommand("unity.health");
  sandbox.selectedUnityProject = { id: "project-b" };
  finish({ ok: true, result: { ok: true } });
  await assert.rejects(pending, /工程已切换.*projectId=project-a.*requestId=unity-/);
  assert.equal(calls, 1);
});

test("UI failure exposes request identity and never replays a write", async () => {
  let calls = 0;
  const sandbox = context(async () => { calls++; throw new Error("timeout"); });
  await assert.rejects(sandbox.requestUnityCommand("unity.sync-prefab-hierarchy"), /timeout.*projectId=project-a.*requestId=unity-/);
  assert.equal(calls, 1);
});

test("Prefab preflight checks the frozen project and empty target over WS", async () => {
  const project = { path: "E:/test-project" };
  const actions = [];
  const command = async (target, action) => {
    assert.equal(target, project.path);
    actions.push(action);
    return action === "unity.health" ? { projectPath: target, version: SERVER_VERSION } :
      { ok: true, selectedFolder: "Assets/Target", selectedObjectIsFolder: true, selectedFolderIsEmpty: true };
  };
  await probeUnityGateway(project, "Assets/Target", command);
  assert.deepEqual(actions, ["unity.health", "unity.selected-folder"]);
  await assert.rejects(probeUnityGateway(project, "Assets/Other", command), /does not match/);
  await assert.rejects(probeUnityGateway(project, "", async () => ({ projectPath: "E:/other", version: SERVER_VERSION })), /different project/);
  await assert.rejects(probeUnityGateway(project, "", async () => ({ projectPath: project.path, version: "old" })), /version mismatch/);
});
