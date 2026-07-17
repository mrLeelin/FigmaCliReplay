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
  assert.match(ui, /\/apply/);
  assert.match(ui, /取消/);
  assert.match(ui, /source-file-renamed/);
  assert.match(ui, /Layer ID 重合/);
});

test("updated plugin UI script remains syntactically valid", () => {
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  assert.ok(script.length > 0);
  assert.doesNotThrow(() => new Function(script));
});
