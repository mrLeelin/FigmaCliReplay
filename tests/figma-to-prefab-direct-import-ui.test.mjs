import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

test("import events ignore stale subscriptions and preserve uncertain writes", () => {
  const calls = [];
  const sandbox = vm.createContext({
    figmaPrefabImportTaskId: "task", figmaPrefabSubscriptionId: "sub", figmaPrefabEventSequence: 3,
    figmaPrefabImportBusy: true, selectedUnityProject: { id: "new-project" }, selectedUnityFolderIsEmpty: true,
    setHierarchyExportStatus: () => {}, appendLog: () => {}, refreshUnityControls: () => {},
    sendRelaySocketRequest: async (...args) => { calls.push(args); }
  });
  const source = ui.match(/function handleFigmaPrefabImportEvent\([^]*?\n    \}/)[0];
  vm.runInContext(source, sandbox);
  sandbox.handleFigmaPrefabImportEvent({ taskId: "task", subscriptionId: "old", sequence: 4, error: "late" });
  assert.equal(sandbox.figmaPrefabEventSequence, 3);
  sandbox.handleFigmaPrefabImportEvent({ taskId: "task", subscriptionId: "sub", sequence: 2, error: "late" });
  assert.equal(sandbox.figmaPrefabEventSequence, 3);
  sandbox.handleFigmaPrefabImportEvent({ taskId: "task", subscriptionId: "sub", sequence: 4, error: "unknown" });
  assert.equal(sandbox.figmaPrefabImportTaskId, "task");
  assert.equal(sandbox.figmaPrefabImportBusy, true);
  assert.equal(calls.length, 0);
  sandbox.handleFigmaPrefabImportEvent({ taskId: "task", subscriptionId: "sub", sequence: 5, result: { task: { status: "completed", projectId: "old-project", summary: { verifyAllPass: true } } } });
  assert.equal(sandbox.figmaPrefabImportBusy, false);
  assert.equal(sandbox.selectedUnityFolderIsEmpty, true);
  assert.equal(calls[0][0], "figma.prefab.unsubscribe");
});

test("dropped Prefab resolution rejects results after a project switch", async () => {
  let finish;
  const sandbox = vm.createContext({ selectedUnityProject: { id: "one" }, sendRelaySocketRequest: () => new Promise(resolve => { finish = resolve; }) });
  vm.runInContext(ui.match(/async function resolveDroppedPrefabPaths\([^]*?\n    \}/)[0], sandbox);
  const result = sandbox.resolveDroppedPrefabPaths([{ fileName: "Root.prefab" }]);
  sandbox.selectedUnityProject = { id: "two" };
  finish({ prefabPaths: ["Assets/Root.prefab"] });
  await assert.rejects(result, /工程已切换/);
});

test("Figma to Prefab tab starts and subscribes to the deterministic Relay task", () => {
  const start = ui.indexOf("async function exportHierarchyToUnity(");
  const end = ui.indexOf("async function handleHierarchyExportResult", start);
  const source = ui.slice(start, end);

  assert.doesNotMatch(ui.slice(ui.indexOf('id="hierarchy-export-tab"'), ui.indexOf('id="prefab-import-tab"')), /hierarchyPrefabBox/);
  assert.match(source, /await fetchSelectedUnityFolder\(\)/);
  assert.match(source, /selectedUnityImageTargetMode === "replaceImage"/);
  assert.match(source, /selectedUnityFolderIsEmpty/);
  assert.match(source, /lastSelectionData/);
  assert.match(source, /nodes\.length !== 1/);
  assert.match(source, /sendRelaySocketRequest\("figma.prefab.start"/);
  assert.match(source, /clientRequestId:\s*figmaPrefabImportTaskId/);
  assert.match(source, /projectId:\s*selectedUnityProject\.id/);
  assert.match(source, /gatewayProjectPath:\s*unityGatewayProjectPath/);
  assert.match(source, /targetFolder:\s*(?:selectedUnityFolder|folder)/);
  assert.match(source, /sessionId:\s*relaySessionId/);
  assert.match(source, /subscribeFigmaPrefabImportTask\(\)/);
  assert.doesNotMatch(source, /fetch\(|pollFigmaPrefabImportTask/);
});

test("direct import does not depend on or invoke AI UI and runner code", () => {
  const start = ui.indexOf("async function exportHierarchyToUnity(");
  const end = ui.indexOf("async function handleHierarchyExportResult", start);
  const source = ui.slice(start, end);

  assert.doesNotMatch(source, /requestAiRun|startAiRun|aiPromptTemplateSelect|ai-prompt-tab|ai-execution-tab/);

  const controlsStart = ui.indexOf("function refreshUnityControls(");
  const controlsEnd = ui.indexOf("async function exportHierarchyToUnity(", controlsStart);
  const controlsSource = ui.slice(controlsStart, controlsEnd);
  assert.match(controlsSource, /exportingHierarchy/);
  assert.doesNotMatch(controlsSource, /aiCleanupBusy|generatingAiPrompt/);
});

test("direct import renders deterministic output and verification paths", () => {
  const start = ui.indexOf("function handleFigmaPrefabImportEvent(");
  const end = ui.indexOf("async function handleHierarchyExportResult", start);
  const source = ui.slice(start, end);

  assert.match(source, /message.subscriptionId !== figmaPrefabSubscriptionId/);
  assert.match(source, /message.sequence <= figmaPrefabEventSequence/);
  assert.match(source, /summary\.prefab/);
  assert.match(source, /summary\.targetImageDir/);
  assert.match(source, /summary\.atlasDir/);
  assert.match(source, /summary\.auditReport/);
  assert.match(source, /summary\.imageReport/);
  assert.match(source, /summary\.verifyReport/);
  assert.match(source, /verifyAllPass/);
});

test("Unity selection polling refreshes the direct import button state", () => {
  const start = ui.indexOf("async function fetchUnitySelectionStatus(");
  const end = ui.indexOf("function getCachedUnityPrefabPath", start);
  const source = ui.slice(start, end);

  assert.match(source, /setSelectedImageTargetInfo\(data\)/);
  assert.match(source, /refreshUnityControls\(\)/);
});
