import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sources = ["../code/05_utils.js", "../code/04_hierarchy.js"].map(path =>
  fs.readFileSync(new URL(path, import.meta.url), "utf8"));
function functionSource(name) {
  for (const source of sources) {
    const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
    if (!match) continue;
    const remainder = source.slice(match.index + match[0].length);
    const next = /\n(?:async )?function [A-Za-z]|\n\/\*\*/.exec(remainder);
    return source.slice(match.index, next ? match.index + match[0].length + next.index : undefined);
  }
  assert.fail(`missing runtime function ${name}`);
}

function fixture(selection) {
  const messages = [];
  const context = vm.createContext({
    figma: { currentPage: { selection }, ui: { postMessage: value => messages.push(value) }, notify() {} },
    buildFigmaPrefabNineSliceInfo: node => node.nineSlice || null,
    findFirstImageHash: () => "",
    findNineSliceSourceHash: () => "",
    buildUnityImageName: node => node.name + ".png",
    bytesToBase64: bytes => Buffer.from(bytes).toString("base64")
  });
  vm.runInContext([
    "handleExportImagesToUnity", "collectExportImageNodes", "walkExportImageNodes",
    "hasImageFill", "hasAnyImageFill", "countDirectSliceChildren", "describeExportNode",
    "shouldExportNodeAsImage", "hasRenderablePaint", "hasPositiveBounds", "getNodeBounds"
  ].map(functionSource).join("\n"), context);
  return { context, messages };
}

const solid = { type: "SOLID", color: { r: 1, g: 1, b: 1 } };
function shape(id, type = "ELLIPSE", extra = {}) {
  return { id, name: id, type, width: 32, height: 32, visible: true, fills: [solid],
    exportAsync: async () => new Uint8Array([137, 80, 78, 71]), ...extra };
}

test("two selected solid ellipses export two PNG payloads instead of no-image error", async () => {
  const calls = [];
  const nodes = [shape("33:477"), shape("33:478")];
  for (const node of nodes) {
    node.exportAsync = async options => { calls.push([node.id, options.format]); return new Uint8Array([137, 80, 78, 71]); };
  }
  const { context, messages } = fixture(nodes);
  await context.handleExportImagesToUnity({ requestId: "ellipse-export" });
  assert.deepEqual(calls, [["33:477", "PNG"], ["33:478", "PNG"]]);
  const message = JSON.parse(JSON.stringify(messages[0]));
  assert.equal(message.requestId, "ellipse-export");
  assert.equal(message.result.status, "completed");
  assert.deepEqual(message.result.stats, { selectedCount: 2, imageCount: 2 });
  assert.deepEqual(message.result.images.map(image => [image.nodeId, image.base64]),
    [["33:477", "iVBORw=="], ["33:478", "iVBORw=="]]);
});

test("painted vector leaves support solid, gradient, and stroke-only artwork", () => {
  const nodes = [shape("rect", "RECTANGLE"), shape("vector", "VECTOR"), shape("star", "STAR"),
    shape("polygon", "POLYGON", { fills: [{ type: "GRADIENT_LINEAR" }] }),
    shape("line", "LINE", { fills: [], strokes: [solid], height: 1 })];
  const { context } = fixture(nodes);
  assert.deepEqual(Array.from(context.collectExportImageNodes(nodes, []), item => item.node.id), nodes.map(node => node.id));
});

test("containers still recurse and overlapping selections do not duplicate assets", () => {
  const ellipse = shape("ellipse");
  const image = shape("image", "RECTANGLE", { fills: [{ type: "IMAGE" }] });
  const group = shape("group", "GROUP", { fills: [], children: [ellipse, image, shape("text", "TEXT")] });
  const { context } = fixture([group, ellipse]);
  assert.deepEqual(Array.from(context.collectExportImageNodes([group, ellipse], []), item => item.node.id), ["ellipse", "image"]);
});

test("unpainted, hidden-paint, zero-size and internal slice leaves stay excluded", () => {
  const nodes = [shape("empty", "ELLIPSE", { fills: [] }),
    shape("hidden-paint", "ELLIPSE", { fills: [{ ...solid, visible: false }] }),
    shape("zero", "ELLIPSE", { width: 0 }), shape("__slice_center")];
  const { context } = fixture(nodes);
  assert.equal(context.collectExportImageNodes(nodes, []).length, 0);
});

test("nine-slice parent remains one asset and retains border metadata", () => {
  const nineSlice = { sliceCount: 3, border: { left: 4, right: 4, top: 0, bottom: 0 } };
  const parent = shape("panel", "FRAME", { children: [shape("__slice_left"), shape("__slice_center"), shape("__slice_right")], nineSlice });
  const { context } = fixture([parent]);
  const result = context.collectExportImageNodes([parent], []);
  assert.equal(result.length, 1);
  assert.equal(result[0].node, parent);
  assert.equal(result[0].nineSlice, nineSlice);
});
