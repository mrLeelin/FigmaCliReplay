import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
const exportScript = ui.slice(ui.indexOf("// ─── 导出 PSD ───"), ui.indexOf("// ─── 插件消息 ───"));

function harness(overrides = {}) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const element = () => ({ disabled: false, hidden: false, textContent: "", style: {}, classList: { toggle() {} } });
  const sandbox = vm.createContext({
    TextEncoder, Date, Math, WebSocket: { OPEN: 1 }, relaySocketRegistered: true, relaySocket: { readyState: 1 },
    lastSelectionData: { nodes: [{ id: "1:1", name: "中文面板" }] },
    exportPsdBtn: element(), exportPsdOpenFolderBtn: element(), exportPsdSelectionEl: element(),
    exportPsdScaleSelect: { value: "1" }, exportPsdStatusEl: element(), exportPsdResultEl: element(), exportPsdProgressBar: element(),
    parent: { postMessage(message) { calls.push({ action: "plugin", payload: message.pluginMessage }); } },
    setTimeout(fn, milliseconds) { const id = ++timerId; timers.set(id, { fn, milliseconds }); return id; },
    clearTimeout(id) { timers.delete(id); }, appendLog() {},
    async sendRelaySocketRequest(action, payload, _token, _timeout, requestId) { calls.push({ action, payload, requestId }); return { ok: true }; },
    ...overrides,
  });
  vm.runInContext(exportScript, sandbox);
  return { sandbox, calls, timers };
}

const collected = (nodes = [{ id: "1:2", name: "标题", pngBase64: "AAAA" }]) => ({
  nodes, size: { width: 200, height: 160 }, scale: 2, imagesPrestretched: true,
  imageCount: nodes.length, baseName: "中文面板",
});

test("exported PSD folder opens through the existing Relay socket", async () => {
  const { sandbox, calls } = harness();
  await sandbox.openExportFolder();
  assert.equal(calls[0]?.action, "psd.export.open-folder");
  assert.doesNotMatch(sandbox.exportPsdStatusEl.textContent, /失败/);
  assert.match(sandbox.exportPsdStatusEl.textContent, /已打开/);
});

test("folder opener reports Relay rejection and releases the button", async () => {
  const { sandbox } = harness({ async sendRelaySocketRequest() { return { ok: false, error: "Explorer unavailable" }; } });
  sandbox.exportPsdLastPath = "E:/exports/file.psd";
  await sandbox.openExportFolder();
  assert.match(sandbox.exportPsdStatusEl.textContent, /Explorer unavailable/);
  assert.equal(sandbox.exportPsdOpenFolderBtn.disabled, false);
});

test("collection errors restore export controls and late errors cannot cancel a retry", () => {
  const { sandbox } = harness();
  sandbox.startExportPsd();
  const failedId = sandbox.exportPsdRequestId;
  sandbox.handleExportPsdCollectError({ requestId: failedId, error: "选区超过上限" });
  assert.equal(sandbox.exportPsdBusy, false);
  assert.equal(sandbox.exportPsdBtn.disabled, false);
  assert.match(sandbox.exportPsdStatusEl.textContent, /选区超过上限/);
  sandbox.startExportPsd();
  const retryId = sandbox.exportPsdRequestId;
  sandbox.handleExportPsdCollectError({ requestId: failedId, error: "late" });
  assert.equal(sandbox.exportPsdBusy, true);
  assert.equal(sandbox.exportPsdRequestId, retryId);
  assert.match(ui, /message\.type === "EXPORT_PSD_COLLECT_ERROR"/);
});

test("collection timeout and Relay disconnect release the export button", () => {
  const timed = harness();
  timed.sandbox.startExportPsd();
  const timeout = [...timed.timers.values()].find((timer) => timer.milliseconds === 300000);
  assert.ok(timeout, "collection needs an inactivity timeout");
  timeout.fn();
  assert.equal(timed.sandbox.exportPsdBusy, false);
  assert.match(timed.sandbox.exportPsdStatusEl.textContent, /超时/);

  const disconnected = harness();
  disconnected.sandbox.startExportPsd();
  disconnected.sandbox.relaySocketRegistered = false;
  const connectionCheck = [...disconnected.timers.values()].find((timer) => timer.milliseconds === 1000);
  assert.ok(connectionCheck);
  connectionCheck.fn();
  assert.equal(disconnected.sandbox.exportPsdBusy, false);
  assert.match(disconnected.sandbox.exportPsdStatusEl.textContent, /连接/);
  disconnected.sandbox.startExportPsd();
  assert.equal(disconnected.sandbox.exportPsdBusy, false, "an offline retry must not start collecting");
});

test("PSD transfer keeps every batch at 500 layers and preserves source node IDs", async () => {
  const { sandbox, calls } = harness();
  await sandbox.sendPsdExportToRelay(collected(Array.from({ length: 501 }, (_, i) => ({ id: `1:${i}`, pngBase64: "AAAA" }))));
  const batches = calls.filter((call) => call.action === "psd.export.stage-chunk");
  assert.deepEqual(batches.map((batch) => batch.payload.layers.length), [500, 1]);
  assert.equal(batches[0].payload.layers[0].id, "1:0");
  assert.equal(calls[0].payload.nodes[0].pngBase64, undefined);
});

test("large PNGs are streamed in aligned parts within the actual 6 MiB JSON limit", async () => {
  const { sandbox, calls } = harness();
  const image = "QUJD".repeat(3 * 1024 * 1024 + 1);
  await sandbox.sendPsdExportToRelay(collected([
    { id: "中文:3", pngBase64: "QUJD".repeat(1024) },
    { id: "中文:4", pngBase64: image },
  ]));
  const batches = calls.filter((call) => call.action === "psd.export.stage-chunk");
  assert.ok(batches.length >= 3);
  for (const batch of batches) {
    const request = { type: "relay.request", requestId: batch.requestId, action: batch.action, payload: batch.payload, capabilityToken: "" };
    assert.ok(Buffer.byteLength(JSON.stringify(request), "utf8") <= 6 * 1024 * 1024);
    assert.ok(batch.payload.layers.length <= 500);
  }
  const parts = batches.flatMap((batch) => batch.payload.layers).filter((part) => part.id === "中文:4");
  assert.equal(parts.map((part) => part.pngBase64).join(""), image);
  assert.deepEqual(parts.map((part) => part.partIndex), parts.map((_, index) => index));
  assert.ok(parts.every((part) => part.partCount === parts.length && part.pngBase64.length % 4 === 0));
});

test("rejected upload phases and transport failures cannot report PSD export success", async () => {
  for (const failedAction of ["psd.export.stage-meta", "psd.export.stage-chunk", "psd.export.assemble"]) {
    const actions = [];
    const { sandbox } = harness({
      async sendRelaySocketRequest(action) {
        actions.push(action);
        return action === failedAction ? { ok: false, error: "staging rejected" } : { ok: true };
      },
    });
    sandbox.startExportPsd();
    await sandbox.handleExportPsdCollectResult({ requestId: sandbox.exportPsdRequestId, result: collected() });
    assert.equal(sandbox.exportPsdBusy, false);
    assert.equal(sandbox.exportPsdBtn.disabled, false);
    assert.match(sandbox.exportPsdStatusEl.textContent, /staging rejected/);
    assert.doesNotMatch(sandbox.exportPsdStatusEl.textContent, /导出完成/);
    assert.equal(actions.at(-1), failedAction);
  }
  const failed = harness({ async sendRelaySocketRequest() { throw new Error("Relay timeout or disconnected"); } });
  failed.sandbox.startExportPsd();
  await failed.sandbox.handleExportPsdCollectResult({ requestId: failed.sandbox.exportPsdRequestId, result: collected() });
  assert.equal(failed.sandbox.exportPsdBusy, false);
  assert.match(failed.sandbox.exportPsdStatusEl.textContent, /timeout or disconnected/);
});

test("PSD result exposes missing images and both collection and assembly warnings", async () => {
  const { sandbox } = harness({
    async sendRelaySocketRequest(action) {
      return action !== "psd.export.assemble" ? { ok: true } : {
        ok: true, psdPath: "E:/exports/中文.psd", indexPath: "E:/exports/中文.index.json",
        layerCount: 1, groupCount: 1, bytes: 1024,
        coverage: { expectedImages: 2, exportedImages: 1, missingImages: 1, complete: false },
        warnings: ["保留隐藏源图层"],
      };
    },
  });
  sandbox.startExportPsd();
  await sandbox.handleExportPsdCollectResult({
    requestId: sandbox.exportPsdRequestId,
    result: { ...collected(), warnings: ["蒙版已合成像素"] },
  });
  assert.match(sandbox.exportPsdStatusEl.textContent, /导出不完整/);
  assert.match(sandbox.exportPsdResultEl.textContent, /1\s*\/\s*2/);
  assert.match(sandbox.exportPsdResultEl.textContent, /缺失.*1/);
  assert.match(sandbox.exportPsdResultEl.textContent, /蒙版已合成像素/);
  assert.match(sandbox.exportPsdResultEl.textContent, /保留隐藏源图层/);
  assert.equal(sandbox.exportPsdOpenFolderBtn.disabled, false);
});

test("legacy PSD results remain usable while identifying absent completeness evidence", async () => {
  const { sandbox } = harness({
    async sendRelaySocketRequest(action) {
      return action === "psd.export.assemble" ? { ok: true, psdPath: "E:/exports/file.psd", layerCount: 1 } : { ok: true };
    },
  });
  sandbox.startExportPsd();
  await sandbox.handleExportPsdCollectResult({ requestId: sandbox.exportPsdRequestId, result: collected() });
  assert.equal(sandbox.exportPsdBusy, false);
  assert.match(sandbox.exportPsdResultEl.textContent, /未提供.*完整性/);
});
