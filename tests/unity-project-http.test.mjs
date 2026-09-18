import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../dist/config.js";
import { createRelayHttpServer } from "../dist/httpServer.js";
import { createRelayControlHandler } from "../dist/relayControl.js";
import { UnityProjectRegistry } from "../dist/unityProjectRegistry.js";

test("Unity project HTTP routes only report upgrade and cannot mutate the registry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-project-http-"));
  const registry = new UnityProjectRegistry(path.join(root, "projects.json"));
  const server = createRelayHttpServer(parseArgs([]), {}, registry);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const suffix of ["", "/missing/gateway"]) {
    assert.equal((await fetch(base + "/unity-projects" + suffix)).status, 410);
  }
  for (const suffix of ["add", "select", "remove", "install-bridge"]) {
    const response = await fetch(base + "/unity-projects/" + suffix, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
    assert.equal(response.status, 410);
  }
  assert.deepEqual(registry.list().projects, []);
});

test("shared Unity controls retain registry and project-scoped discovery validation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-project-control-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const projectPath = path.join(root, "ProjectA");
  fs.mkdirSync(path.join(projectPath, "Assets"), {recursive: true});
  fs.mkdirSync(path.join(projectPath, "ProjectSettings"));
  const registry = new UnityProjectRegistry(path.join(root, "projects.json"));
  const control = createRelayControlHandler({}, {}, undefined, registry);
  assert.deepEqual((await control("unity.projects.list", {})).projects, []);
  const added = await control("unity.projects.add", {path: projectPath});
  const id = added.project.id;
  assert.equal(added.project.path, projectPath);
  assert.equal((await control("unity.projects.add", {path: projectPath})).projects.length, 1);
  await assert.rejects(control("unity.bridge.install", {}), /explicit Unity project id/);
  await assert.rejects(control("unity.gateway.get", {id: "missing"}), /Unknown Unity project/);
  assert.equal((await control("unity.projects.select", {id})).lastSelectedProjectId, id);
  const installed = await control("unity.bridge.install", {id});
  assert.equal(installed.project.bridgeInstalled, true);
  const discovery = path.join(projectPath, "Library", "FigmaBridge", "gateways");
  fs.mkdirSync(discovery, {recursive: true});
  function record(pid, url, updatedAtUtc, project = projectPath) {
    fs.writeFileSync(path.join(discovery, `${pid}.json`), JSON.stringify({version: 1,
      projectPath: project, gatewayUrl: url, processId: pid, updatedAtUtc}));
  }
  const gateway = () => control("unity.gateway.get", {id});
  record(11111, "http://localhost:32131", "2026-07-15T09:19:00.000Z");
  record(12345, "http://localhost:32132", "2026-07-15T09:20:00.000Z");
  assert.equal((await gateway()).gatewayUrl, "http://localhost:32132");
  fs.unlinkSync(path.join(discovery, "12345.json"));
  assert.equal((await gateway()).gatewayUrl, "http://localhost:32131");
  record(12345, "http://localhost:32132", "2026-07-15T09:20:00.000Z", path.join(root, "WrongProject"));
  assert.equal((await gateway()).gatewayUrl, "http://localhost:32131");
  record(99999, "https://example.com:32132", "not-a-date");
  fs.unlinkSync(path.join(discovery, "11111.json"));
  assert.deepEqual(await gateway(), {found: false});
  record(77777, "http://localhost:32133", "2026-07-15T09:21:00.000Z");
  fs.rmSync(path.join(projectPath, "Assets"), {recursive: true});
  assert.deepEqual(await gateway(), {found: false});
  assert.deepEqual((await control("unity.projects.remove", {id})).projects, []);
  assert.equal(fs.existsSync(path.join(projectPath, "ProjectSettings")), true);
});
