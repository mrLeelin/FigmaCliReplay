import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
function functionSource(name) {
  const start = ui.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `missing function ${name}`);
  const end = ui.indexOf("\n    }", start) + "\n    }".length;
  return ui.slice(start, end);
}

function harness(overrides = {}) {
  const element = () => {
    const classes = new Set();
    return {
      hidden: true, textContent: "", style: {}, attributes: {}, inert: false, isConnected: true,
      focus() { this.focused = true; },
      setAttribute(key, value) { this.attributes[key] = value; },
      classList: {
        toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
        add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
    };
  };
  const background = [element(), element()];
  background[1].inert = true;
  const priorFocus = element();
  const sandbox = vm.createContext({
    psdImportProgressOverlay: element(), psdImportProgressFile: element(),
    psdImportProgressStage: element(), psdImportProgressPercent: element(),
    psdImportProgressTrack: element(), psdImportProgressBar: element(),
    pluginMiniBar: element(), miniPsdProgress: element(), miniPsdProgressStage: element(),
    miniPsdProgressPercent: element(), miniPsdProgressTrack: element(), miniPsdProgressBar: element(),
    psdImportProgressBackground: [], psdImportProgressPreviousFocus: null,
    psdImportBusy: false, psdImportQueueActive: false, psdImportCurrentContext: null,
    aiPromptPsdDragDepth: 0, aiPromptTemplateSelect: {},
    psdImportTaskId: "", psdImportLastRenderedLog: "",
    psdImportCompletionResolve: null, psdImportCompletionReject: null,
    aiPromptPsdDropZone: element(), psdWindowDropOverlay: element(),
    document: { activeElement: priorFocus, querySelectorAll: () => background, body: element() },
    PSD_PREVIEW_TERMINAL_STATUSES: new Set(["preview-ready", "preview-blocked", "preview-no-changes", "preview-baseline-required"]),
    setAiPromptStatus(text) { sandbox.status = text; }, appendLog() {},
    formatPsdImportContext: (context) => context.fileName,
    querySelectionForPsdImport: async () => ({ fileKey: "file" }),
    resolvePsdDropMode: () => ({ mode: "initial" }),
    buildPsdImportTarget: () => ({ fileKey: "file" }),
    clearPsdImportPollTimer() {}, finishPsdImportTaskPromise() {},
    ...overrides,
  });
  vm.runInContext([
    "updatePsdImportProgress", "hidePsdImportProgress", "setPsdImportProgressMessage",
    "setAiPromptPsdDropDragging", "startPsdImportQueue", "renderPsdImportTaskStatus",
    "isAiPromptPsdDropAvailable", "isFileDragEvent", "handleAiPromptPsdWindowDragEnter",
    "handleAiPromptPsdWindowDragOver", "handleAiPromptPsdWindowDragLeave",
    "handleAiPromptPsdWindowDrop", "resetAiPromptPsdDropDragging", "getDraggedFiles",
  ].map(functionSource).join("\n"), sandbox);
  return { sandbox, background, priorFocus };
}

test("minimized file hover highlights the bar without flickering across child elements", () => {
  const { sandbox: s } = harness();
  const event = { dataTransfer: { types: ["Files"] }, preventDefault() {} };
  s.handleAiPromptPsdWindowDragEnter(event);
  assert.equal(s.pluginMiniBar.classList.contains("is-file-dragging"), true);
  s.handleAiPromptPsdWindowDragEnter(event);
  s.handleAiPromptPsdWindowDragLeave(event);
  assert.equal(s.pluginMiniBar.classList.contains("is-file-dragging"), true);
  s.handleAiPromptPsdWindowDragLeave(event);
  assert.equal(s.pluginMiniBar.classList.contains("is-file-dragging"), false);
});

test("drop clears minimized hover before passing files to the import handler", () => {
  const { sandbox: s } = harness();
  const file = { name: "输入.psd" };
  const event = { dataTransfer: { types: ["Files"], files: [file] }, preventDefault() {} };
  s.handleAiPromptPsdWindowDragEnter(event);
  let received;
  s.handleDroppedFiles = (files) => {
    assert.equal(s.pluginMiniBar.classList.contains("is-file-dragging"), false);
    assert.equal(s.aiPromptPsdDragDepth, 0);
    received = files[0];
  };
  s.handleAiPromptPsdWindowDrop(event);
  assert.equal(received, file);
});

test("cancelled file drags clear feedback and busy imports retain their progress", () => {
  const { sandbox: s } = harness();
  const event = { dataTransfer: { types: ["Files"] }, preventDefault() {} };
  s.handleAiPromptPsdWindowDragEnter(event);
  s.resetAiPromptPsdDropDragging();
  assert.equal(s.pluginMiniBar.classList.contains("is-file-dragging"), false);
  assert.equal(s.aiPromptPsdDragDepth, 0);
  s.psdImportBusy = true;
  s.handleAiPromptPsdWindowDragOver(event);
  assert.equal(s.pluginMiniBar.classList.contains("is-file-dragging"), false);
  s.psdImportBusy = false;
  s.handleAiPromptPsdWindowDragEnter({ dataTransfer: { types: ["text/plain"] }, preventDefault() {} });
  assert.equal(s.pluginMiniBar.classList.contains("is-file-dragging"), false);
});

test("PSD progress covers the viewport above plugin resize controls and starts hidden", () => {
  assert.match(ui, /\.psd-import-progress-overlay\s*\{[^}]*position: fixed;[^}]*inset: 0;[^}]*z-index: 10060;/);
  assert.match(ui, /id="psdImportProgressOverlay"[^>]*aria-modal="true"[^>]*hidden/);
  assert.match(ui, /id="psdImportProgressTrack"[^>]*role="progressbar"/);
});

test("opening blocks background interaction; closing restores prior inert state and focus", () => {
  const { sandbox: s, background, priorFocus } = harness();
  s.updatePsdImportProgress(30, "解析图层", { index: 1, total: 1, fileName: "中文.psd" });
  assert.equal(s.psdImportProgressOverlay.hidden, false);
  assert.equal(s.psdImportProgressOverlay.focused, true);
  assert.ok(background.every((item) => item.inert));
  s.updatePsdImportProgress(55, "导入 Figma");
  s.hidePsdImportProgress();
  assert.equal(s.psdImportProgressOverlay.hidden, true);
  assert.equal(background[0].inert, false);
  assert.equal(background[1].inert, true);
  assert.equal(priorFocus.focused, true);
});

test("batch percentage includes completed files and matches accessible progress", () => {
  const { sandbox: s } = harness();
  s.updatePsdImportProgress(50, "导入图层", { index: 2, total: 3, fileName: "第二个.psd" });
  assert.equal(s.psdImportProgressPercent.textContent, "50%");
  assert.equal(s.psdImportProgressBar.style.width, "50%");
  assert.equal(s.psdImportProgressTrack.attributes["aria-valuenow"], "50");
  assert.equal(s.psdImportProgressFile.textContent, "[2/3] 第二个.psd");
  s.updatePsdImportProgress(900, "完成", { index: 3, total: 3 });
  assert.equal(s.psdImportProgressPercent.textContent, "100%");
});

test("minimized import shows the same batch progress and keeps restore controls interactive", () => {
  const { sandbox: s } = harness();
  s.document.body.classList.contains = (name) => name === "is-minimized";
  s.document.querySelectorAll = (selector) => {
    assert.doesNotMatch(selector, /plugin-mini-bar/);
    return [];
  };
  s.updatePsdImportProgress(50, "正在导入图层…", { index: 2, total: 3, fileName: "任务.psd" });
  assert.equal(s.miniPsdProgress.hidden, false);
  assert.equal(s.miniPsdProgressPercent.textContent, "50%");
  assert.equal(s.miniPsdProgressBar.style.width, "50%");
  assert.equal(s.miniPsdProgressTrack.attributes["aria-valuenow"], "50");
  assert.match(s.miniPsdProgress.title, /\[2\/3\] 任务.psd/);
  assert.equal(s.psdImportProgressOverlay.focused, undefined);
  assert.equal(s.pluginMiniBar.inert, false);
  s.setPsdImportProgressMessage("等待 Relay 重连…");
  assert.equal(s.miniPsdProgressStage.textContent, "等待 Relay 重连…");
  assert.equal(s.miniPsdProgressPercent.textContent, "50%");
  s.hidePsdImportProgress();
  assert.equal(s.miniPsdProgress.hidden, true);
});

test("overlay opens before selection resolves and always closes on selection failure", async () => {
  let rejectSelection;
  const { sandbox: s } = harness({ querySelectionForPsdImport: () => new Promise((_resolve, reject) => { rejectSelection = reject; }) });
  const pending = s.startPsdImportQueue([{ name: "输入.psd" }]);
  assert.equal(s.psdImportProgressOverlay.hidden, false);
  assert.match(s.psdImportProgressStage.textContent, /Figma 目标/);
  rejectSelection(new Error("selection timeout"));
  await assert.rejects(pending, /selection timeout/);
  assert.equal(s.psdImportProgressOverlay.hidden, true);
  assert.equal(s.psdImportQueueActive, false);
});

test("batch stays covered between files and closes after mixed success and failure", async () => {
  const { sandbox: s } = harness();
  let count = 0;
  s.startPsdImportFromDroppedFile = async (_file, context) => {
    assert.equal(s.psdImportProgressOverlay.hidden, false);
    s.updatePsdImportProgress(0, "读取", context);
    assert.equal(s.psdImportProgressPercent.textContent, count === 0 ? "0%" : "50%");
    if (++count === 1) throw new Error("bad PSD");
    return { status: "completed" };
  };
  await s.startPsdImportQueue([{ name: "bad.psd" }, { name: "good.psd" }]);
  assert.equal(count, 2);
  assert.match(s.status, /失败 1\/2/);
  assert.equal(s.psdImportProgressOverlay.hidden, true);
});

test("server stages drive progress and preview releases overlay for confirmation", () => {
  const { sandbox: s } = harness();
  s.psdImportQueueActive = true;
  s.renderPsdImportTaskStatus({ status: "running", stage: "exporting_psd_layers", percent: 10 });
  assert.match(s.psdImportProgressStage.textContent, /解析 PSD/);
  assert.equal(s.psdImportProgressPercent.textContent, "15%");
  s.renderPsdImportTaskStatus({ status: "running", stage: "submitting_figma_import", percent: 55 });
  assert.match(s.psdImportProgressStage.textContent, /导入 Figma/);
  for (const status of s.PSD_PREVIEW_TERMINAL_STATUSES) {
    s.updatePsdImportProgress(80, "处理中");
    s.renderPsdImportTaskStatus({ status, percent: 100 });
    assert.equal(s.psdImportProgressOverlay.hidden, true, status);
  }
});

test("standalone completion, failure and cancellation all release the overlay", () => {
  const { sandbox: s } = harness();
  for (const status of ["completed", "error", "cancelled", "baseline-adopted"]) {
    s.renderPsdImportTaskStatus({ status, percent: 100 });
    assert.equal(s.psdImportProgressOverlay.hidden, true, status);
  }
});

test("disconnect message retains known progress while waiting for reconnection", () => {
  const { sandbox: s } = harness();
  s.updatePsdImportProgress(55, "导入图层");
  s.setPsdImportProgressMessage("Relay 连接已断开，等待重连后继续查询进度…");
  assert.equal(s.psdImportProgressPercent.textContent, "55%");
  assert.equal(s.psdImportProgressOverlay.hidden, false);
  assert.match(s.psdImportProgressStage.textContent, /等待重连/);
});

test("file reading reports bytes and rejects aborts", async () => {
  let reader;
  const { sandbox: s } = harness({ FileReader: class { constructor() { reader = this; } readAsDataURL() {} } });
  vm.runInContext(functionSource("readFileAsBase64"), s);
  const progress = [];
  const pending = s.readFileAsBase64({}, (...values) => progress.push(values));
  reader.onprogress({ loaded: 40, total: 80, lengthComputable: true });
  reader.result = "data:application/octet-stream;base64,YWJj";
  reader.onload();
  assert.equal(await pending, "YWJj");
  assert.deepEqual(progress, [[40, 80]]);
  const aborted = s.readFileAsBase64({});
  reader.onabort();
  await assert.rejects(aborted, /已中止/);
});

test("failed file reads release standalone busy state and overlay", async () => {
  const { sandbox: s } = harness({ readFileAsBase64: async () => { throw new Error("read failed"); } });
  vm.runInContext(functionSource("startPsdImportFromDroppedFile"), s);
  await assert.rejects(s.startPsdImportFromDroppedFile({ name: "bad.psd" }), /read failed/);
  assert.equal(s.psdImportBusy, false);
  assert.equal(s.psdImportProgressOverlay.hidden, true);
});

test("an offline request that was never sent releases the queue and overlay", async () => {
  const offline = Object.assign(new Error("Relay WebSocket is not registered"), {
    relayTransportFailure: true, relayRequestSent: false,
  });
  const { sandbox: s } = harness({
    readFileAsBase64: async () => "YWJj",
    sendRelaySocketRequest: async () => { throw offline; },
    waitForPsdImportTaskCompletion() { throw new Error("An unsent task must not wait for completion"); },
    relaySocketRegistered: false,
  });
  vm.runInContext(functionSource("startPsdImportFromDroppedFile"), s);
  await s.startPsdImportQueue([{ name: "offline.psd" }]);
  assert.match(s.status, /失败 1\/1/);
  assert.equal(s.psdImportBusy, false);
  assert.equal(s.psdImportQueueActive, false);
  assert.equal(s.psdImportProgressOverlay.hidden, true);
  assert.equal(s.psdImportProgressBackground.length, 0);
});
