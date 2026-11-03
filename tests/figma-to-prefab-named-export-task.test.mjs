import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import * as tasks from "../dist/figmaPrefabImportTask.js";
import { parseArgs, SERVER_VERSION } from "../dist/config.js";
import { UnityProjectRegistry } from "../dist/unityProjectRegistry.js";

const config = parseArgs([]);

function fixture(t, { folder = "Assets/Exports", nodeName = "登录/弹窗:? " } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-named-export-"));
  const projectPath = path.join(root, "UnityProject");
  fs.mkdirSync(path.join(projectPath, "Assets/Editor/FigmaBridge"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, "ProjectSettings"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, folder), { recursive: true });
  fs.writeFileSync(path.join(projectPath, folder, "keep.txt"), "existing parent asset");
  fs.mkdirSync(path.join(projectPath, "Assets/Fonts"));
  for (const ext of ["asset", "mat"]) fs.writeFileSync(path.join(projectPath, `Assets/Fonts/CommonFont.${ext}`), "font");
  fs.writeFileSync(path.join(projectPath, "ProjectSettings/FigmaBridgeImportSettings.json"), JSON.stringify({ commonFontAsset: "Assets/Fonts/CommonFont.asset" }));
  const registry = new UnityProjectRegistry(path.join(root, "projects.json"));
  const project = registry.add(projectPath);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("figma-named-export-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, projectPath, registry, payload: {
    clientRequestId: "named-export-" + randomUUID(), outputMode: "named-export", projectId: project.id,
    gatewayProjectPath: projectPath, targetFolder: folder, sessionId: "session-1", fileKey: "FILE_key",
    nodeId: "10:20", nodeName, nodeWidth: 750, nodeHeight: 1334,
  } };
}

function valueAfter(args, flag) { const index = args.indexOf(flag); assert.ok(index >= 0, `missing ${flag}`); return args[index + 1]; }
function summary(folder, name, extra = {}) {
  return "[SUMMARY_JSON]\n" + JSON.stringify({ status: "completed", prefab: `${folder}/Prefab/${name}.prefab`, targetImageDir: `${folder}/Texture/`, atlasDir: "", atlasPath: "", verifyAllPass: true, ...extra });
}
function writeOutputs(projectPath, folder, name) {
  fs.mkdirSync(path.join(projectPath, folder, "Prefab"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, folder, "Texture"), { recursive: true });
  fs.writeFileSync(path.join(projectPath, folder, "Prefab", `${name}.prefab`), "prefab");
}
async function terminal(taskId) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = tasks.getFigmaPrefabImportTask(taskId);
    if (value && ["completed", "error"].includes(value.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("named export did not finish");
}

test("named export normalizes a single safe Unicode filename without changing legacy target normalization", () => {
  assert.equal(tasks.normalizeFigmaPrefabExportName(" 登录/弹窗:? . "), "登录_弹窗__");
  assert.equal(tasks.normalizeFigmaPrefabExportName("CON.txt"), "_CON.txt");
  assert.equal(tasks.normalizeFigmaPrefabExportName("..."), "FigmaExport");
  assert.equal(tasks.normalizeFigmaPrefabExportName("[cat_header｜顶部白猫｜原图插画]"), "cat_header");
  assert.equal(tasks.normalizeFigmaPrefabExportName("[cat_header|顶部白猫|原图插画]"), "cat_header");
  assert.equal(Array.from(tasks.normalizeFigmaPrefabExportName("弹".repeat(200))).length, 120);
  assert.throws(() => tasks.normalizeFigmaPrefabTargetFolder("Assets"), /child folder/);
});

test("annotated root names use the English file identity while preserving the Figma snapshot", async (t) => {
  const original = "[cat_header｜顶部白猫｜原图插画]";
  const f = fixture(t, { nodeName: original });
  let capturedArgs;
  const started = tasks.startFigmaPrefabImportTask(config, f.registry, f.payload, {
    probeUnityGateway: async () => {},
    executePython: async (task, _script, args) => {
      capturedArgs = args;
      writeOutputs(f.projectPath, task.targetFolder, "cat_header");
      return { exitCode: 0, stdout: summary(task.targetFolder, "cat_header"), stderr: "" };
    },
  });
  const done = await terminal(started.taskId);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.targetFolder, "Assets/Exports/cat_header");
  assert.equal(valueAfter(capturedArgs, "--prefab-name"), "cat_header");
  assert.equal(valueAfter(capturedArgs, "--expect-root-name"), original);
});

test("named export creates only Name/Prefab and Name/Texture below a nonempty selected parent", async (t) => {
  const f = fixture(t);
  const probes = [];
  let capturedArgs;
  const name = "登录_弹窗__", output = `Assets/Exports/${name}`;
  const started = tasks.startFigmaPrefabImportTask(config, f.registry, f.payload, {
    probeUnityGateway: async (_project, expected, options) => { probes.push({ expected, options }); },
    executePython: async (task, _script, args) => {
      capturedArgs = args;
      assert.equal(task.outputMode, "named-export");
      assert.equal(task.selectedFolder, "Assets/Exports");
      assert.equal(task.targetFolder, output);
      writeOutputs(f.projectPath, output, name);
      return { exitCode: 0, stdout: summary(output, name), stderr: "" };
    },
  });
  const done = await terminal(started.taskId);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.targetFolder, output);
  assert.equal(probes.length, 2);
  assert.ok(probes.every((probe) => probe.expected === "Assets/Exports" && probe.options.requireEmptyFolder === false && probe.options.requirePrefabExportWithoutAtlas === true));
  assert.equal(valueAfter(capturedArgs, "--target-prefab"), `${output}/Prefab/${name}.prefab`);
  assert.equal(valueAfter(capturedArgs, "--target-image-dir"), `${output}/Texture`);
  assert.equal(valueAfter(capturedArgs, "--prefab-name"), name);
  assert.ok(capturedArgs.includes("--no-atlas"));
  assert.ok(!capturedArgs.includes("--infer-formal-names"));
  assert.deepEqual(fs.readdirSync(path.join(f.projectPath, output)).sort(), ["Prefab", "Texture"]);
  assert.equal(fs.readFileSync(path.join(f.projectPath, "Assets/Exports/keep.txt"), "utf8"), "existing parent asset");
});

test("named export permits the Assets root while reserving a new named child", async (t) => {
  const f = fixture(t, { folder: "Assets", nodeName: "Root" });
  const task = tasks.startFigmaPrefabImportTask(config, f.registry, f.payload, {
    probeUnityGateway: async (_p, expected) => { assert.equal(expected, "Assets"); },
    executePython: async (task) => { writeOutputs(f.projectPath, task.targetFolder, "Root"); return { exitCode: 0, stdout: summary(task.targetFolder, "Root"), stderr: "" }; },
  });
  const done = await terminal(task.taskId);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.targetFolder, "Assets/Root");
});

test("existing named directory or sibling meta is rejected without overwriting", (t) => {
  const f = fixture(t, { nodeName: "Root" });
  const output = path.join(f.projectPath, "Assets/Exports/Root");
  fs.mkdirSync(output);
  assert.throws(() => tasks.startFigmaPrefabImportTask(config, f.registry, f.payload), /already exists|conflict/);
  fs.rmdirSync(output);
  fs.writeFileSync(output + ".meta", "existing guid");
  assert.throws(() => tasks.startFigmaPrefabImportTask(config, f.registry, f.payload), /already exists|conflict/);
  assert.equal(fs.readFileSync(output + ".meta", "utf8"), "existing guid");
});

test("unsupported Bridge fails before reserving the output or launching the writer", async (t) => {
  const f = fixture(t, { nodeName: "Root" });
  let writes = 0;
  const started = tasks.startFigmaPrefabImportTask(config, f.registry, f.payload, {
    probeUnityGateway: async () => { throw new Error("Update Unity Bridge: named Prefab export without atlas is not supported"); },
    executePython: async () => { writes++; throw new Error("must not execute"); },
  });
  const done = await terminal(started.taskId);
  assert.equal(done.status, "error");
  assert.match(done.error, /Update Unity Bridge/);
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(path.join(f.projectPath, "Assets/Exports/Root")), false);
});

test("output directory appearing during the health probe is never reused", async (t) => {
  const f = fixture(t, { nodeName: "Root" });
  const output = path.join(f.projectPath, "Assets/Exports/Root");
  let writes = 0;
  const task = tasks.startFigmaPrefabImportTask(config, f.registry, f.payload, {
    probeUnityGateway: async () => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, "keep.txt"), "race owner"); },
    executePython: async () => { writes++; throw new Error("must not execute"); },
  });
  const done = await terminal(task.taskId);
  assert.equal(done.status, "error");
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(path.join(output, "keep.txt"), "utf8"), "race owner");
});

test("named export identity includes output mode and deduplicates the same request", async (t) => {
  const f = fixture(t, { nodeName: "Root" });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const deps = { probeUnityGateway: async () => { await held; }, executePython: async () => ({ exitCode: 2, stdout: "", stderr: "fixture failure" }) };
  const task = tasks.startFigmaPrefabImportTask(config, f.registry, f.payload, deps);
  assert.equal(tasks.startFigmaPrefabImportTask(config, f.registry, f.payload, deps).taskId, task.taskId);
  assert.throws(() => tasks.startFigmaPrefabImportTask(config, f.registry, { ...f.payload, outputMode: undefined }, deps), /identity conflict/);
  release();
  await terminal(task.taskId);
});

test("named summary accepts no atlas but rejects extra atlas outputs or wrong child paths", () => {
  const folder = "Assets/Exports/Root";
  assert.equal(tasks.parseFigmaPrefabImportSummary(summary(folder, "Root"), folder, { requireAtlas: false }).verifyAllPass, true);
  assert.throws(() => tasks.parseFigmaPrefabImportSummary(summary(folder, "Root"), folder), /missing/);
  assert.throws(() => tasks.parseFigmaPrefabImportSummary(summary(folder, "Root", { atlasDir: `${folder}/UiAtlas/`, atlasPath: `${folder}/UiAtlas/Root.spriteatlasv2` }), folder, { requireAtlas: false }), /atlas|Atlas/);
  assert.throws(() => tasks.parseFigmaPrefabImportSummary(summary("Assets/Exports/Elsewhere", "Root"), folder, { requireAtlas: false }), /not beneath/);
  assert.throws(() => tasks.parseFigmaPrefabImportSummary(summary(folder, "Other"), folder, { requireAtlas: false }), /reserved design name/);
});

test("selected parents escaping Assets through junctions are rejected before creating output", (t) => {
  const f = fixture(t, { nodeName: "Root" });
  const outside = path.join(f.root, "Outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.projectPath, "Assets/OutsideLink"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => tasks.startFigmaPrefabImportTask(config, f.registry, { ...f.payload, targetFolder: "Assets/OutsideLink" }), /symlink or junction/);
  assert.equal(fs.existsSync(path.join(outside, "Root")), false);
});

test("a second Unity parent probe failure never reaches the writer and leaves its reservation diagnosable", async (t) => {
  const f = fixture(t, { nodeName: "Root" });
  let probes = 0, writes = 0;
  const started = tasks.startFigmaPrefabImportTask(config, f.registry, f.payload, {
    probeUnityGateway: async () => { if (++probes === 2) throw new Error("Unity selection changed"); },
    executePython: async () => { writes++; throw new Error("must not execute"); },
  });
  const done = await terminal(started.taskId);
  assert.equal(done.status, "error");
  assert.match(done.error, /selection changed/);
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(path.join(f.projectPath, "Assets/Exports/Root")), true);
});

test("project mutex is shared by named export and the legacy direct import", async (t) => {
  const f = fixture(t, { nodeName: "Root" });
  fs.mkdirSync(path.join(f.projectPath, "Assets/LegacyEmpty"));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const deps = { probeUnityGateway: async () => { await held; }, executePython: async () => ({ exitCode: 2, stdout: "", stderr: "fixture failure" }) };
  const task = tasks.startFigmaPrefabImportTask(config, f.registry, f.payload, deps);
  assert.throws(() => tasks.startFigmaPrefabImportTask(config, f.registry, { ...f.payload, clientRequestId: randomUUID(), outputMode: undefined, targetFolder: "Assets/LegacyEmpty" }, deps), /in flight/);
  release(); await terminal(task.taskId);
});

test("unexpected Atlas directory cannot be hidden by an atlas-free success summary", async (t) => {
  const f = fixture(t, { nodeName: "Root" });
  const task = tasks.startFigmaPrefabImportTask(config, f.registry, f.payload, {
    probeUnityGateway: async () => {},
    executePython: async (task) => {
      writeOutputs(f.projectPath, task.targetFolder, "Root");
      fs.mkdirSync(path.join(f.projectPath, task.targetFolder, "UiAtlas"));
      return { exitCode: 0, stdout: summary(task.targetFolder, "Root"), stderr: "" };
    },
  });
  const done = await terminal(task.taskId);
  assert.equal(done.status, "error");
  assert.match(done.error, /unexpected outputs/);
});

test("gateway named-export probe checks new capability, actual parent and folder type without requiring emptiness", async () => {
  const project = { path: "E:/Project/Test" };
  const commands = [];
  const command = async (_path, action) => { commands.push(action); return action === "unity.health" ? { projectPath: project.path, version: SERVER_VERSION, supportsPrefabExportWithoutAtlas: true } : { selectedFolder: "Assets", selectedObjectIsFolder: true, selectedFolderIsEmpty: false }; };
  await tasks.probeUnityGateway(project, "Assets", command, { requireEmptyFolder: false, requirePrefabExportWithoutAtlas: true });
  assert.deepEqual(commands, ["unity.health", "unity.selected-folder"]);
  await assert.rejects(tasks.probeUnityGateway(project, "Assets", async () => ({ projectPath: project.path, version: SERVER_VERSION }), { requireEmptyFolder: false, requirePrefabExportWithoutAtlas: true }), /Bridge.*update|Update.*Bridge|supportsPrefabExportWithoutAtlas/);
});

test("named export refuses PlayMode and compilation before any folder query", async () => {
  const project = { path: "E:/Project/Test" };
  for (const state of ["isPlaying", "isCompiling", "isChangingPlayMode"]) {
    const actions = [];
    const command = async (_path, action) => {
      actions.push(action);
      return { projectPath: project.path, version: SERVER_VERSION, supportsPrefabExportWithoutAtlas: true, [state]: true };
    };
    await assert.rejects(tasks.probeUnityGateway(project, "Assets", command,
      { requireEmptyFolder: false, requirePrefabExportWithoutAtlas: true }), /EditMode|compil|PlayMode/);
    assert.deepEqual(actions, ["unity.health"]);
  }
});
