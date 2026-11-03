import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
const marker = "// ─── 导出 Unity Prefab ───";

function harness(overrides = {}) {
  const calls = [];
  const element = () => ({ disabled: false, hidden: false, textContent: "", className: "", style: {}, classList: { toggle() {} } });
  const sandbox = vm.createContext({
    Date, Math, Array, Number, String,
    unityConnected: true, unityBridgeVersionMismatch: false, unityGatewayProjectPath: "E:/UnityProject",
    selectedUnityProject: { id: "project", path: "E:/UnityProject", name: "UnityProject", valid: true, bridgeInstalled: true, settingsConfigured: true },
    selectedUnityFolder: "Assets/UI", selectedUnityObjectIsFolder: true, selectedUnityFolderIsEmpty: false, selectedUnityImageTargetMode: "folder",
    relaySessionId: "figma-session", relaySocketRegistered: true,
    lastSelectionData: { fileKey: "figma-file", nodes: [{ id: "1:2", name: "我的界面", width: 750, height: 1334 }] },
    figmaPrefabImportTaskId: "", figmaPrefabImportBusy: false, figmaPrefabSubscriptionId: "", figmaPrefabEventSequence: 0,
    isExecuting: false, exportingHierarchy: false,
    exportUnityPrefabBtn: element(), exportPrefabReadFolderBtn: element(), exportPrefabFolderEl: element(),
    exportPrefabSelectionEl: element(), exportPrefabProjectEl: element(), exportPrefabPreviewEl: element(),
    exportPrefabStatusEl: element(), exportPrefabResultEl: element(), exportPrefabProgressBar: element(),
    appendLog() {}, refreshUnityControls() { sandbox.refreshUnityPrefabExportControls(); },
    setHierarchyExportStatus(message) { sandbox.hierarchyStatus = message; },
    async fetchSelectedUnityFolder() { calls.push(["read-folder"]); return sandbox.selectedUnityFolder; },
    subscribeFigmaPrefabImportTask() { calls.push(["subscribe", sandbox.figmaPrefabImportTaskId]); },
    async sendRelaySocketRequest(action, payload) {
      calls.push([action, payload]);
      return { ok: true, task: { taskId: payload.clientRequestId, outputMode: "named-export", targetFolder: "Assets/UI/我的界面" } };
    },
    ...overrides,
  });
  const start = ui.indexOf(marker);
  assert.ok(start >= 0, "Prefab export UI implementation should exist");
  vm.runInContext(ui.slice(start, ui.indexOf("// ─── 导出 PSD ───", start)), sandbox);
  return { sandbox, calls };
}

test("export tab exposes Prefab and a folder-read control alongside PSD", () => {
  assert.match(ui, /data-export-tab="export-prefab-tab"/);
  assert.match(ui, /id="exportUnityPrefabBtn"/);
  assert.match(ui, /id="exportPrefabReadFolderBtn"/);
  assert.doesNotMatch(ui, /id="export-placeholder-tab"/);
});

test("annotated English root identity is used consistently in output previews", () => {
  const { sandbox } = harness();
  sandbox.lastSelectionData.nodes[0].name = "[cat_header｜顶部白猫｜原图插画]";
  sandbox.refreshUnityPrefabExportControls();
  assert.equal(sandbox.normalizeUnityPrefabExportName(sandbox.lastSelectionData.nodes[0].name), "cat_header");
  assert.match(sandbox.exportPrefabPreviewEl.textContent, /Assets\/UI\/cat_header\/Prefab\/cat_header\.prefab/);
  assert.match(sandbox.exportPrefabPreviewEl.textContent, /Assets\/UI\/cat_header\/Texture\//);
  assert.doesNotMatch(sandbox.exportPrefabPreviewEl.textContent, /顶部白猫|原图插画|\[|\]/);
});

test("named Prefab export permits a nonempty folder and Assets root and previews both directories", () => {
  const { sandbox } = harness();
  sandbox.refreshUnityPrefabExportControls();
  assert.equal(sandbox.exportUnityPrefabBtn.disabled, false);
  assert.match(sandbox.exportPrefabPreviewEl.textContent, /Assets\/UI\/我的界面\/Prefab\/我的界面.prefab/);
  assert.match(sandbox.exportPrefabPreviewEl.textContent, /Assets\/UI\/我的界面\/Texture/);
  sandbox.selectedUnityFolder = "Assets";
  sandbox.refreshUnityPrefabExportControls();
  assert.equal(sandbox.exportUnityPrefabBtn.disabled, false);
  assert.match(sandbox.exportPrefabPreviewEl.textContent, /Assets\/我的界面\/Prefab/);
  sandbox.selectedUnityImageTargetMode = "replaceImage";
  sandbox.refreshUnityPrefabExportControls();
  assert.equal(sandbox.exportUnityPrefabBtn.disabled, true);
  sandbox.selectedUnityImageTargetMode = "folder";
  sandbox.lastSelectionData.nodes.push({ id: "1:3", name: "Other" });
  sandbox.refreshUnityPrefabExportControls();
  assert.equal(sandbox.exportUnityPrefabBtn.disabled, true);
});

test("export naming keeps Chinese and agrees with safe Windows filename rules", () => {
  const { sandbox } = harness();
  assert.equal(sandbox.normalizeUnityPrefabExportName(' 我的/界面:*?. '), "我的_界面___");
  assert.equal(sandbox.normalizeUnityPrefabExportName("CON.txt"), "_CON.txt");
  assert.equal(sandbox.normalizeUnityPrefabExportName("..."), "FigmaExport");
  assert.equal(sandbox.normalizeUnityPrefabExportName("e\u0301"), "é");
  assert.equal(Array.from(sandbox.normalizeUnityPrefabExportName("😀".repeat(121))).length, 120);
});

test("export reads Unity folder once then submits the locked Figma and project snapshot", async () => {
  const { sandbox, calls } = harness();
  await sandbox.startUnityPrefabExport();
  const submit = calls.find(([action]) => action === "figma.prefab.start");
  assert.ok(submit);
  assert.equal(calls.filter(([action]) => action === "read-folder").length, 1);
  assert.equal(submit[1].outputMode, "named-export");
  assert.equal(submit[1].targetFolder, "Assets/UI");
  assert.equal(submit[1].nodeId, "1:2");
  assert.equal(submit[1].nodeName, "我的界面");
  assert.equal(submit[1].projectId, "project");
  assert.equal(submit[1].sessionId, "figma-session");
  assert.equal(sandbox.figmaPrefabImportBusy, true);
  assert.equal(sandbox.figmaPrefabTaskOutputMode, "named-export");
  assert.equal(calls.at(-1)[0], "subscribe");
});

test("project switches during folder reading cannot submit or retain a busy task", async () => {
  let resolveFolder;
  const { sandbox, calls } = harness({ fetchSelectedUnityFolder: () => new Promise((resolve) => { resolveFolder = resolve; }) });
  const pending = sandbox.startUnityPrefabExport();
  sandbox.selectedUnityProject = { ...sandbox.selectedUnityProject, id: "other", path: "E:/Other" };
  resolveFolder("Assets/UI");
  await pending;
  assert.equal(calls.some(([action]) => action === "figma.prefab.start"), false);
  assert.equal(sandbox.figmaPrefabImportBusy, false);
  assert.equal(sandbox.figmaPrefabImportTaskId, "");
  assert.match(sandbox.exportPrefabStatusEl.textContent, /工程已切换/);
});

test("a changed Figma selection keeps the originally requested root snapshot", async () => {
  let resolveFolder;
  const { sandbox, calls } = harness({ fetchSelectedUnityFolder: () => new Promise((resolve) => { resolveFolder = resolve; }) });
  const pending = sandbox.startUnityPrefabExport();
  sandbox.lastSelectionData.nodes = [{ id: "9:9", name: "后来选择的节点", width: 100, height: 100 }];
  resolveFolder("Assets/UI");
  await pending;
  const submit = calls.find(([action]) => action === "figma.prefab.start");
  assert.equal(submit[1].nodeId, "1:2");
  assert.equal(submit[1].nodeName, "我的界面");
  assert.equal(submit[1].nodeWidth, 750);
});

test("a Figma file switch during folder reading stops before submission", async () => {
  let resolveFolder;
  const { sandbox, calls } = harness({ fetchSelectedUnityFolder: () => new Promise((resolve) => { resolveFolder = resolve; }) });
  const pending = sandbox.startUnityPrefabExport();
  sandbox.lastSelectionData.fileKey = "different-file";
  resolveFolder("Assets/UI");
  await pending;
  assert.equal(calls.some(([action]) => action === "figma.prefab.start"), false);
  assert.equal(sandbox.figmaPrefabImportBusy, false);
  assert.match(sandbox.exportPrefabStatusEl.textContent, /文件已切换/);
});

test("explicit rejection releases controls while an uncertain submission preserves its identity", async () => {
  const refused = harness({ async sendRelaySocketRequest() { return { ok: false, error: "同名目录已存在" }; } });
  await refused.sandbox.startUnityPrefabExport();
  assert.equal(refused.sandbox.figmaPrefabImportBusy, false);
  assert.equal(refused.sandbox.figmaPrefabImportTaskId, "");
  assert.match(refused.sandbox.exportPrefabStatusEl.textContent, /同名目录已存在/);
  const unknown = harness({ async sendRelaySocketRequest() { const error = new Error("timeout"); error.relayTransportFailure = true; throw error; } });
  await unknown.sandbox.startUnityPrefabExport();
  assert.equal(unknown.sandbox.figmaPrefabImportBusy, true);
  assert.ok(unknown.sandbox.figmaPrefabImportTaskId);
  assert.equal(unknown.calls.filter(([action]) => action === "subscribe").length, 1);
  const offline = harness({ async sendRelaySocketRequest() {
    const error = new Error("not connected"); error.relayTransportFailure = true; error.relayRequestSent = false; throw error;
  } });
  await offline.sandbox.startUnityPrefabExport();
  assert.equal(offline.sandbox.figmaPrefabImportBusy, false);
  assert.equal(offline.sandbox.figmaPrefabImportTaskId, "");
});

test("the existing direct-import entry also releases a request explicitly rejected by Relay", async () => {
  const { sandbox, calls } = harness({
    selectedUnityFolderIsEmpty: true,
    async sendRelaySocketRequest() { return { ok: false, error: "Import target already exists" }; },
  });
  vm.runInContext(ui.match(/async function exportHierarchyToUnity\([^]*?\n    \}/)[0], sandbox);
  await sandbox.exportHierarchyToUnity(false);
  assert.equal(sandbox.figmaPrefabImportBusy, false);
  assert.equal(sandbox.figmaPrefabImportTaskId, "");
  assert.equal(calls.some(([action]) => action === "subscribe"), false);
  assert.match(sandbox.hierarchyStatus, /Import target already exists/);
});

test("read-folder uses the shared Unity folder query and recovers its controls on failure", async () => {
  const loaded = harness();
  await loaded.sandbox.readUnityPrefabExportFolder();
  assert.equal(loaded.calls.filter(([action]) => action === "read-folder").length, 1);
  assert.match(loaded.sandbox.exportPrefabStatusEl.textContent, /已读取.*Assets\/UI/);
  assert.equal(loaded.sandbox.prefabExportReadingFolder, false);
  const failed = harness({ async fetchSelectedUnityFolder() { throw new Error("Unity unavailable"); } });
  await failed.sandbox.readUnityPrefabExportFolder();
  assert.equal(failed.sandbox.prefabExportReadingFolder, false);
  assert.equal(failed.sandbox.exportPrefabReadFolderBtn.disabled, false);
  assert.match(failed.sandbox.exportPrefabStatusEl.textContent, /Unity unavailable/);
});

test("named export progress and verified result are rendered without an Atlas output", () => {
  const { sandbox, calls } = harness();
  sandbox.figmaPrefabTaskOutputMode = "named-export";
  sandbox.figmaPrefabImportBusy = true;
  sandbox.figmaPrefabImportTaskId = "task";
  sandbox.handleNamedPrefabExportEvent({ result: { task: { status: "running", percent: 45, stage: "generating_prefab" } } });
  assert.equal(sandbox.exportPrefabProgressBar.style.width, "45%");
  sandbox.handleNamedPrefabExportEvent({ result: { task: { status: "completed", projectId: "project", targetFolder: "Assets/UI/我的界面", summary: {
    verifyAllPass: true, prefab: "Assets/UI/我的界面/Prefab/我的界面.prefab", targetImageDir: "Assets/UI/我的界面/Texture/", atlasDir: "",
  } } } });
  assert.equal(sandbox.figmaPrefabImportBusy, false);
  assert.equal(sandbox.figmaPrefabImportTaskId, "");
  assert.equal(sandbox.exportPrefabProgressBar.style.width, "100%");
  assert.match(sandbox.exportPrefabResultEl.textContent, /我的界面\/Prefab\/我的界面.prefab/);
  assert.match(sandbox.exportPrefabResultEl.textContent, /我的界面\/Texture/);
  assert.doesNotMatch(sandbox.exportPrefabResultEl.textContent, /Atlas/);
  assert.equal(calls.at(-1)[0], "figma.prefab.unsubscribe");
});

test("shared import subscription dispatches named export events and refreshes selection controls", () => {
  const { sandbox } = harness();
  sandbox.figmaPrefabTaskOutputMode = "named-export";
  sandbox.figmaPrefabImportTaskId = "task";
  sandbox.figmaPrefabSubscriptionId = "sub";
  const source = ui.match(/function handleFigmaPrefabImportEvent\([^]*?\n    \}/)[0];
  vm.runInContext(source, sandbox);
  sandbox.handleFigmaPrefabImportEvent({ taskId: "task", subscriptionId: "old", sequence: 1, result: { task: { status: "running", percent: 10 } } });
  assert.notEqual(sandbox.exportPrefabProgressBar.style.width, "10%");
  sandbox.handleFigmaPrefabImportEvent({ taskId: "task", subscriptionId: "sub", sequence: 1, result: { task: { status: "running", percent: 25 } } });
  assert.equal(sandbox.exportPrefabProgressBar.style.width, "25%");
  assert.match(ui.match(/function handleSelectionChanged\([^]*?\n    \}/)[0], /refreshUnityPrefabExportControls\(\)/);
  assert.match(ui.match(/function refreshUnityControls\([^]*?\n    \}/)[0], /refreshUnityPrefabExportControls\(\)/);
});
