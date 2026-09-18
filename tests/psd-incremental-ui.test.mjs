import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

test("single FRAME or COMPONENT routes PSD drop to incremental preview", () => {
  assert.match(ui, /function resolvePsdDropMode/);
  assert.match(ui, /node\.type === "FRAME" \|\| node\.type === "COMPONENT"/);
  assert.match(ui, /mode: dropMode\.mode/);
});

test("incremental apply is gated by an explicit modal confirmation", () => {
  assert.match(ui, /id="psdIncrementalDialog"/);
  assert.match(ui, /确认增量更新/);
  assert.match(ui, /function showPsdIncrementalPreview/);
  assert.match(ui, /function confirmPsdIncrementalUpdate/);
  assert.match(ui, /psd\.import\.apply/);
  assert.match(ui, /取消/);
  assert.match(ui, /source-file-renamed/);
  assert.match(ui, /Layer ID 重合/);
});

test("subscriptions stop for every preview terminal state", () => {
  assert.match(ui, /PSD_PREVIEW_TERMINAL_STATUSES/);
  for (const status of [
    "preview-ready", "preview-blocked", "preview-no-changes", "preview-baseline-required",
  ]) {
    assert.match(ui, new RegExp(status));
  }
});

test("confirmation is enabled only for preview-ready", () => {
  assert.match(ui, /preview\.status === "preview-ready"/);
  assert.match(ui, /confirmPsdIncrementalBtn\.disabled = !canApply/);
  assert.match(ui, /preview-no-changes/);
  assert.match(ui, /没有可同步的 PSD 变化/);
});

test("baseline adoption uses a distinct button and endpoint", () => {
  assert.match(ui, /id="adoptPsdBaselineBtn"/);
  assert.match(ui, /function adoptPsdIncrementalBaseline/);
  assert.match(ui, /psd\.import\.adopt-baseline/);
});

test("preview renders category totals and before-after field rows", () => {
  for (const field of ["position", "size", "rotation", "display", "textStyle", "nineSlice"]) {
    assert.match(ui, new RegExp(field));
  }
  assert.match(ui, /change\.before/);
  assert.match(ui, /change\.after/);
  assert.match(ui, /change\.delta/);
});

test("updated plugin UI script remains syntactically valid", () => {
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  assert.ok(script.length > 0);
  assert.doesNotThrow(() => new Function(script));
});

test("PSD upload sends source metadata and no-change preview explains identical bytes", () => {
  assert.match(ui, /sourceFile:\s*\{/);
  assert.match(ui, /size:\s*file\.size/);
  assert.match(ui, /lastModified:\s*file\.lastModified/);
  assert.match(ui, /task\.sourceFile/);
  assert.match(ui, /identicalToPreviousUpload/);
  assert.match(ui, /与上一次上传的 PSD 逐字节相同/);
});
