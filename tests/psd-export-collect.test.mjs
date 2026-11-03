import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../code/09_export_psd.js", import.meta.url), "utf8");

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function scene() {
  const exports = [];
  const page = { id: "0:1", type: "PAGE", children: [], selection: [], appendChild(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    this.children.push(node); node.parent = this;
  } };
  function node(id, extra = {}) {
    const value = {
      id, name: id, type: "RECTANGLE", children: undefined, parent: page,
      visible: true, opacity: 1, blendMode: "NORMAL", fills: [{ visible: true }], strokes: [], effects: [],
      width: 20, height: 10, x: 10, y: 20,
      absoluteTransform: [[1, 0, 10], [0, 1, 20]],
      absoluteBoundingBox: { x: 10, y: 20, width: 20, height: 10 },
      absoluteRenderBounds: { x: 8, y: 18, width: 24, height: 14 },
      resize(w, h) { this.width = w; this.height = h; },
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; this.removed = true; },
      ...extra,
    };
    value.clone = function () {
      const cloned = node("clone-" + id, { ...value, id: "clone-" + id, clone: undefined, parent: page });
      if (value.children) cloned.children = value.children.map((c) => { const copy = c.clone(); page.children.splice(page.children.indexOf(copy), 1); copy.parent = cloned; return copy; });
      return cloned;
    };
    value.exportAsync = extra.exportAsync || async function (settings) {
      exports.push({ id: this.id, opacity: this.opacity, visible: this.visible, settings });
      const box = this.absoluteRenderBounds || this.absoluteBoundingBox;
      return png(Math.round(box.width * settings.constraint.value), Math.round(box.height * settings.constraint.value));
    };
    page.children.push(value);
    return value;
  }
  function append(parent, child) { page.children.splice(page.children.indexOf(child), 1); parent.children.push(child); child.parent = parent; }
  const messages = [];
  const figma = { currentPage: page, skipInvisibleInstanceChildren: true, ui: { postMessage: (message) => messages.push(message) } };
  const context = vm.createContext({ figma, bytesToBase64: (bytes) => Buffer.from(bytes).toString("base64"), pluginLogger: { warn() {}, info() {} }, Uint8Array, console });
  vm.runInContext(source, context);
  return { node, append, page, figma, messages, context, exports };
}

test("collection exports hidden source layers from disposable clones and keeps render bounds", async () => {
  const s = scene();
  const root = s.node("1:1", { name: "面板", type: "FRAME", children: [], fills: [], opacity: 0.5 });
  const hidden = s.node("I2:3;4:5", { name: "隐藏文字", type: "TEXT", visible: false, opacity: 0 });
  s.append(root, hidden); s.page.selection = [root];
  await s.context.handleExportPsdCollect({ requestId: "collect", scale: 2 });
  const result = s.messages.find((m) => m.type === "EXPORT_PSD_COLLECT_RESULT")?.result;
  assert.ok(result);
  assert.ok(result.nodes[0].synthetic);
  const child = result.nodes.find((n) => n.id === hidden.id);
  assert.equal(child.visible, false);
  assert.equal(child.opacity, 0);
  assert.equal(child.imageExpected, true);
  assert.ok(child.pngBase64);
  assert.deepEqual(JSON.parse(JSON.stringify(child.bbox)), { x: 0, y: 0, width: 48, height: 28 });
  assert.equal(hidden.visible, false);
  assert.equal(hidden.opacity, 0);
  assert.equal(root.opacity, 0.5);
  assert.equal(s.figma.skipInvisibleInstanceChildren, true);
  assert.deepEqual(s.page.children.map((n) => n.id), [root.id]);
  assert.ok(s.exports.every((e) => e.id.startsWith("clone-") && e.opacity === 1 && e.visible === true));
});

test("failed PNG export reports a terminal error and never emits a partial success", async () => {
  const s = scene();
  const root = s.node("3:1", { exportAsync: async () => { throw new Error("renderer failed"); } });
  s.page.selection = [root];
  await s.context.handleExportPsdCollect({ requestId: "fail", scale: 1 });
  const failure = s.messages.find((m) => m.type === "EXPORT_PSD_COLLECT_ERROR");
  assert.ok(failure);
  assert.match(failure.error, /renderer failed/);
  assert.equal(s.messages.some((m) => m.type === "EXPORT_PSD_COLLECT_RESULT"), false);
  assert.deepEqual(s.page.children.map((n) => n.id), [root.id]);
});

test("empty selection reports an error to the requesting UI", async () => {
  const s = scene();
  await s.context.handleExportPsdCollect({ requestId: "empty", scale: 1 });
  assert.equal(s.messages.at(-1).type, "EXPORT_PSD_COLLECT_ERROR");
  assert.equal(s.messages.at(-1).requestId, "empty");
});

test("ancestor and descendant multi-selection is deduplicated and sorted in paint order", async () => {
  const s = scene();
  const bottom = s.node("4:1");
  const top = s.node("4:2", { type: "FRAME", children: [], fills: [] });
  const leaf = s.node("4:3"); s.append(top, leaf);
  s.page.selection = [leaf, top, bottom];
  await s.context.handleExportPsdCollect({ requestId: "multi", scale: 1 });
  const result = s.messages.find((m) => m.type === "EXPORT_PSD_COLLECT_RESULT")?.result;
  assert.ok(result);
  assert.deepEqual(Array.from(result.nodes.filter((n) => n.parentId === "__psd_root__"), (n) => n.id), [bottom.id, top.id]);
  assert.equal(result.nodes.filter((n) => n.id === leaf.id).length, 1);
});

test("masked and clipped containers carry a full composite and every source node", async () => {
  const s = scene();
  const root = s.node("5:1", { type: "FRAME", children: [], clipsContent: true });
  const mask = s.node("5:2", { isMask: true }); s.append(root, mask);
  const leaf = s.node("5:3"); s.append(root, leaf);
  s.page.selection = [root];
  await s.context.handleExportPsdCollect({ requestId: "mask", scale: 3 });
  const result = s.messages.find((m) => m.type === "EXPORT_PSD_COLLECT_RESULT")?.result;
  assert.ok(result);
  const container = result.nodes.find((n) => n.id === root.id);
  assert.equal(container.composited, true);
  assert.ok(container.pngBase64);
  assert.equal(result.nodes.filter((n) => !n.synthetic).length, 3);
  assert.equal(result.nodes.filter((n) => n.imageExpected && n.pngBase64).length, 3);
});

test("hidden source pixels outside a clipped frame do not enlarge its visible canvas", async () => {
  const s = scene();
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const root = s.node("6:1", { type: "FRAME", children: [], clipsContent: true, absoluteRenderBounds: box, absoluteBoundingBox: box });
  const overflow = s.node("6:2", { absoluteRenderBounds: { x: 0, y: 0, width: 1000, height: 100 } });
  s.append(root, overflow); s.page.selection = [root];
  await s.context.handleExportPsdCollect({ requestId: "clipped", scale: 2 });
  const result = s.messages.find((m) => m.type === "EXPORT_PSD_COLLECT_RESULT")?.result;
  assert.ok(result);
  assert.deepEqual(JSON.parse(JSON.stringify(result.size)), { width: 200, height: 200 });
  assert.equal(result.nodes.find((n) => n.id === overflow.id).bbox.width, 2000, "complete source pixels are retained outside the document canvas");
});

test("backdrop blur propagates a composite boundary through selected ancestors", async () => {
  const s = scene();
  const root = s.node("7:1", { type: "FRAME", children: [], fills: [] });
  const group = s.node("7:2", { type: "GROUP", children: [], fills: [] });
  const blur = s.node("7:3", { effects: [{ type: "BACKGROUND_BLUR", visible: true, radius: 4 }] });
  s.append(root, group); s.append(group, blur); s.page.selection = [root];
  await s.context.handleExportPsdCollect({ requestId: "blur", scale: 1 });
  const result = s.messages.find((m) => m.type === "EXPORT_PSD_COLLECT_RESULT")?.result;
  assert.ok(result);
  assert.equal(result.nodes.find((n) => n.id === root.id).composited, true);
  assert.match(result.nodes.find((n) => n.id === root.id).compositedReason, /背景模糊/);
});
