import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createImageHealth, summarizeImageHealth } from "../code/03_image_health.mjs";

const source = fs.readFileSync(new URL("../code/04_hierarchy.js", import.meta.url), "utf8");
function functionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `missing runtime function ${name}`);
  const remainder = source.slice(match.index + match[0].length);
  const next = /\n(?:async )?function [A-Za-z]/.exec(remainder);
  return source.slice(match.index, next ? match.index + match[0].length + next.index : undefined);
}

// IHDR fixture: only the PNG header is inspected by the plugin; no decoder is mocked.
function pngHeader(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
}

function api(nodes = []) {
  const context = vm.createContext({
    figma: {
      currentPage: { name: "Page" },
      getNodeByIdAsync: async id => nodes.find(node => node.id === id),
      getImageByHash: () => ({
        getSizeAsync: async () => ({ width: 1646, height: 2340 }),
        getBytesAsync: async () => pngHeader(1646, 2340),
      }),
    },
    createImageHealth, summarizeImageHealth,
    setCurrentPageForNode: async () => {},
    validateImageExports: () => [],
    applyImageValidationErrors: () => {},
    validateFigmaPrefabSlicedExports: () => [],
    bytesToBase64: bytes => Buffer.from(bytes).toString("base64"),
    isCleanupRecoveryNode: () => false,
    buildNodePath: node => node.name,
    boundsToManifest: bounds => bounds,
    boundsToRelativeManifest: bounds => bounds,
    serializePaints: paints => paints || [],
    serializeEffects: effects => effects || [],
    readFigmaPrefabConstraints: () => ({}),
    roundNumber: value => value,
    readFigmaFontSize: () => 0,
    buildFigmaPrefabComponentInfo: async () => ({}),
    buildFigmaPrefabNineSliceInfo: () => null,
    findFirstImageHash: node => node.imageHash || "",
    hasRenderablePaint: paints => !!paints?.length,
    hasPositiveBounds: node => node.width > 0 && node.height > 0,
  });
  const names = ["exportFigmaToPrefabJob", "exportFigmaPrefabImages", "buildFigmaPrefabImageExportKey", "exportImageAtFrameSize",
    "collectFigmaPrefabNodes", "shouldExportNodeAsImage", "getNodeBounds", "readFigmaStrokeWeight",
    "readFigmaTextStrokeAlign"];
  for (const name of ["readFigmaPrefabPngSize", "exportFigmaPrefabNodePng", "shouldRasterizeFigmaPrefabMaskGroup", "getFigmaPrefabEffectExportBounds"]) {
    if (new RegExp(`function ${name}\\(`).test(source)) names.push(name);
  }
  vm.runInContext(names.map(functionSource).join("\n"), context);
  return context;
}

test("image fill export uses full node bounds despite clipping ancestors", async () => {
  let settings;
  const node = { id: "33:466", width: 1646, height: 2340,
    exportAsync: async options => {
      settings = options;
      return options.useAbsoluteBounds ? pngHeader(1646, 2340) : pngHeader(1080, 2304);
    } };
  const result = await api([node]).exportFigmaPrefabImages([
    { id: "img_0", nodeId: node.id, source: "imageHash", imageHash: "background" },
  ], []);
  assert.equal(settings.useAbsoluteBounds, true);
  assert.equal(result.exports[0].width, 1646);
  assert.equal(result.exports[0].height, 2340);
  assert.equal(result.exports[0].health.status, "healthy");
});

test("node exports report actual PNG dimensions including pixel rounding", async () => {
  const node = { id: "1:2", width: 94.7, height: 65.49,
    exportAsync: async () => pngHeader(95, 66) };
  const result = await api([node]).exportFigmaPrefabImages([
    { id: "img_0", nodeId: node.id, source: "nodeExport" },
  ], []);
  assert.equal(result.exports[0].width, 95);
  assert.equal(result.exports[0].height, 66);
});

test("undersized frame PNG is blocked rather than declared healthy or replaced by native image", async () => {
  const node = { id: "1:2", width: 95, height: 65,
    exportAsync: async () => pngHeader(1, 1) };
  for (const request of [
    { id: "img_0", nodeId: node.id, source: "nodeExport" },
    { id: "img_0", nodeId: node.id, source: "imageHash", imageHash: "shape" },
  ]) {
    const result = await api([node]).exportFigmaPrefabImages([request], []);
    assert.equal(result.exports[0].health.status, "blocked");
    assert.equal(result.exports[0].base64, "");
  }
});

test("boolean operations export the composed shape without exporting operands", async () => {
  const operand = { id: "33:588", name: "Rectangle 14", type: "RECTANGLE", width: 95, height: 65,
    fills: [{ type: "SOLID" }] };
  const boolean = { id: "33:587", name: "Subtract", type: "BOOLEAN_OPERATION", width: 95, height: 65,
    fills: [{ type: "IMAGE" }], imageHash: "operand-fill", children: [operand] };
  const records = [];
  const requests = [];
  await api().collectFigmaPrefabNodes(boolean, boolean, { x: 0, y: 0, width: 95, height: 65 }, records, requests, []);
  assert.deepEqual(records.map(record => record.id), [boolean.id]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].nodeId, boolean.id);
  assert.equal(requests[0].source, "nodeExport");
  assert.equal(records[0].childIds.length, 0);
});

test("duplicate exports retain the source PNG dimensions", async () => {
  const node = { id: "1:2", width: 10, height: 10,
    exportAsync: async () => pngHeader(11, 10) };
  const result = await api([node]).exportFigmaPrefabImages([
    { id: "img_0", nodeId: node.id, source: "imageHash", imageHash: "shared" },
    { id: "img_1", nodeId: "1:3", source: "imageHash", imageHash: "shared" },
  ], []);
  assert.equal(result.exports[1].duplicateOf, "img_0");
  assert.equal(result.exports[1].width, 11);
  assert.equal(result.exports[1].height, 10);
  assert.equal(result.exports[1].health.status, "repaired");
});

test("nine-slice exports continue using the minimum slice renderer", async () => {
  const context = api();
  let called = false;
  context.exportMinimumNineSliceImage = async () => {
    called = true;
    return { width: 8, height: 12, bytes: pngHeader(8, 12) };
  };
  const result = await context.exportFigmaPrefabImages([
    { id: "img_0", nodeId: "1:2", source: "imageHash", imageHash: "slice", imageType: "Sliced" },
  ], []);
  assert.equal(called, true);
  assert.equal(result.exports[0].width, 8);
  assert.equal(result.exports[0].height, 12);
  assert.equal(result.exports[0].health.status, "healthy");
});

test("instance children remain in the collected manifest", async () => {
  const child = { id: "1:2", name: "Art", type: "RECTANGLE", width: 10, height: 10,
    fills: [{ type: "IMAGE" }], imageHash: "art" };
  const instance = { id: "1:1", name: "Card", type: "INSTANCE", width: 10, height: 10,
    children: [child] };
  const records = [];
  const requests = [];
  await api().collectFigmaPrefabNodes(instance, instance, {}, records, requests, []);
  assert.deepEqual(records.map(record => record.id), [instance.id, child.id]);
  assert.equal(requests[0].source, "imageHash");
  assert.equal(requests[0].nodeId, child.id);
});

test("exporting a boolean as the root is rejected with guidance to select its containing frame", async () => {
  const root = { id: "1:1", type: "BOOLEAN_OPERATION", name: "Subtract", width: 95, height: 66,
    exportAsync: async () => pngHeader(95, 66) };
  await assert.rejects(
    api([root]).exportFigmaToPrefabJob({ target: { nodeId: root.id }, includeScreenshot: false }),
    /BOOLEAN_OPERATION.*select.*containing frame/i,
  );
});

function maskedArt(type = "GROUP") {
  return {
    id: "art:1", name: "Masked artwork", type, width: 120, height: 80,
    imageHash: "background-fill",
    children: [
      { id: "art:2", name: "Ring", type: "ELLIPSE", width: 120, height: 80, fills: [{ type: "SOLID" }] },
      { id: "art:3", name: "Mask", type: "BOOLEAN_OPERATION", isMask: true, width: 100, height: 70 },
      { id: "art:4", name: "Artwork", type: "VECTOR", width: 100, height: 70, fills: [{ type: "SOLID" }] },
    ],
    exportAsync: async () => pngHeader(120, 80),
  };
}

async function collect(context, root) {
  const records = [];
  const requests = [];
  await context.collectFigmaPrefabNodes(root, root, {}, records, requests, []);
  return { records, requests };
}

test("pure visual masked groups and frames export their composition as one leaf", async () => {
  for (const type of ["GROUP", "FRAME"]) {
    const node = maskedArt(type);
    const { records, requests } = await collect(api(), node);
    assert.deepEqual(records.map(record => record.id), [node.id]);
    assert.equal(records[0].rasterize, true);
    assert.equal(records[0].rasterizeReason, "maskGroup");
    assert.equal(records[0].childIds.length, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].source, "nodeExport");
    assert.equal(requests[0].nodeId, node.id);
  }
});

test("root masked artwork retains the rasterize contract in the exported manifest", async () => {
  const root = maskedArt();
  const result = await api([root]).exportFigmaToPrefabJob({ target: { nodeId: root.id }, includeScreenshot: false });
  assert.equal(result.status, "completed");
  assert.equal(result.figmaNodeManifest.nodes[0].rasterize, true);
  assert.equal(result.figmaNodeManifest.nodes[0].rasterizeReason, "maskGroup");
  assert.equal(result.imageExportManifest.exports[0].nodeId, root.id);
  assert.equal(result.imageExportManifest.exports[0].width, 120);
});

test("masked groups containing nested visible text preserve editable text", async () => {
  const root = maskedArt();
  root.children.push({ id: "text:group", name: "Label", type: "GROUP", width: 80, height: 20,
    children: [{ id: "text:1", name: "Title", type: "TEXT", width: 80, height: 20, characters: "Editable" }] });
  const { records } = await collect(api(), root);
  assert.equal(records[0].rasterize, undefined);
  assert.equal(records.some(record => record.id === "text:1" && record.type === "TEXT"), true);
});

test("ordinary groups and groups with hidden masks preserve their hierarchy", async () => {
  for (const mode of ["ordinary", "hiddenMask"]) {
    const root = maskedArt();
    delete root.imageHash;
    if (mode === "ordinary") root.children[1].isMask = false;
    else root.children[1].visible = false;
    const { records, requests } = await collect(api(), root);
    assert.equal(records[0].rasterize, undefined);
    assert.equal(records.some(record => record.id === "art:2"), true);
    assert.equal(requests.some(request => request.nodeId === root.id), false);
  }
});

test("masked groups do not flatten reusable instances or nested nine-slice artwork", async () => {
  for (const semanticType of ["INSTANCE", "COMPONENT", "nineSlice"]) {
    const root = maskedArt();
    const child = { id: "reuse:1", name: "Common_Prefab_Card", type: semanticType === "nineSlice" ? "FRAME" : semanticType,
      width: 20, height: 20, imageHash: "reused-art", children: [] };
    root.children.push(child);
    const context = api();
    context.buildFigmaPrefabNineSliceInfo = node => semanticType === "nineSlice" && node.id === child.id
      ? { border: { left: 2, right: 2, top: 2, bottom: 2 }, sliceKind: "9slice", sliceCount: 9,
        minSize: { width: 6, height: 6 }, sourceVisibleSize: { width: 20, height: 20 } }
      : null;
    const { records } = await collect(context, root);
    assert.equal(records[0].rasterize, undefined);
    assert.equal(records.some(record => record.id === child.id), true);
  }
});

test("hidden text does not prevent preserving a mask composition", async () => {
  const root = maskedArt();
  root.children.push({ id: "text:1", name: "Hidden", type: "TEXT", visible: false });
  const { records } = await collect(api(), root);
  assert.equal(records[0].rasterize, true);
  assert.equal(records.length, 1);
});

test("mask nodes are recorded without image requests or operand traversal", async () => {
  for (const type of ["BOOLEAN_OPERATION", "GROUP", "VECTOR"]) {
    const mask = { id: "mask:1", name: "Mask", type, isMask: true, width: 100, height: 70,
      imageHash: "mask-fill", children: [
        { id: "mask:2", name: "Operand", type: "RECTANGLE", width: 100, height: 70, imageHash: "operand-fill" },
      ] };
    const { records, requests } = await collect(api(), mask);
    assert.deepEqual(records.map(record => record.id), [mask.id]);
    assert.equal(records[0].isMask, true);
    assert.equal(records[0].childIds.length, 0);
    assert.equal(requests.length, 0);
  }
});

test("masked groups with text retain text and painted siblings without rendering the mask itself", async () => {
  const root = maskedArt();
  delete root.imageHash;
  root.children.push({ id: "label:1", name: "Label", type: "TEXT", width: 70, height: 20, characters: "Editable" });
  const { records, requests } = await collect(api(), root);
  assert.equal(records[0].rasterize, undefined);
  assert.equal(records.find(record => record.id === "art:3").isMask, true);
  assert.equal(records.find(record => record.id === "label:1").type, "TEXT");
  assert.equal(records.find(record => record.id === "art:2").isMask, false);
  assert.deepEqual(requests.map(request => request.nodeId), ["art:2", "art:4"]);
  assert.equal(requests.every(request => request.source === "nodeExport"), true);
});

test("exporting a mask as the root is rejected with guidance to select its containing frame", async () => {
  for (const type of ["GROUP", "VECTOR", "BOOLEAN_OPERATION"]) {
    const root = { id: "mask:1", name: "Mask", type, isMask: true, width: 95, height: 66,
      exportAsync: async () => pngHeader(95, 66) };
    await assert.rejects(
      api([root]).exportFigmaToPrefabJob({ target: { nodeId: root.id }, includeScreenshot: false }),
      /mask.*select.*containing frame/i,
    );
  }
});

test("ordinary artwork preserves effects and valid absolute render bounds in the manifest", async () => {
  const effects = [{ type: "DROP_SHADOW", visible: true, radius: 8,
    offset: { x: 0, y: 4 }, color: { r: 0, g: 0, b: 0, a: 0.5 } }];
  const renderBounds = { x: -8, y: -4, width: 116, height: 116 };
  for (const type of ["ELLIPSE", "RECTANGLE", "VECTOR", "FRAME"]) {
    const node = { id: "effect:1", name: "Artwork", type, width: 100, height: 100,
      effects, absoluteRenderBounds: renderBounds };
    const { records } = await collect(api(), node);
    assert.deepEqual(records[0].effects, effects);
    assert.deepEqual(records[0].renderBounds, renderBounds);
  }
});

test("invalid absolute render bounds are omitted from the manifest", async () => {
  for (const absoluteRenderBounds of [null, { x: 0, y: 0, width: 0, height: 20 },
    { x: NaN, y: 0, width: 20, height: 20 }]) {
    const { records } = await collect(api(), { id: "shape:1", type: "ELLIPSE", width: 20, height: 20, absoluteRenderBounds });
    assert.equal(records[0].renderBounds, undefined);
  }
});

function shadowNode(id = "shadow:1", effectType = "DROP_SHADOW") {
  return {
    id, name: id, type: "RECTANGLE", width: 50, height: 40, imageHash: "shared-source",
    absoluteBoundingBox: { x: 100.25, y: 200.5, width: 50, height: 40 },
    absoluteRenderBounds: { x: 95.1, y: 195.2, width: 62.3, height: 53.7 },
    effects: [{ type: effectType, visible: true, radius: 8, offset: { x: 3, y: 4 },
      color: { r: 0, g: 0, b: 0, a: 0.5 } }],
    exportAsync: async options => options.useAbsoluteBounds ? pngHeader(50, 40) : pngHeader(63, 54),
  };
}

test("shadow and blur exports preserve the full PNG and rendered center", async () => {
  for (const effectType of ["DROP_SHADOW", "LAYER_BLUR"]) {
    for (const source of ["imageHash", "nodeExport"]) {
      const node = shadowNode("shadow:1", effectType);
      let settings;
      node.exportAsync = async options => {
        settings = options;
        return options.useAbsoluteBounds ? pngHeader(50, 40) : pngHeader(63, 54);
      };
      const result = await api([node]).exportFigmaPrefabImages([
        { id: "img_0", nodeId: node.id, source, imageHash: node.imageHash, effects: node.effects },
      ], []);
      assert.equal(settings.useAbsoluteBounds, false);
      assert.equal(result.exports[0].health.status, "healthy");
      const bounds = result.exports[0].exportBounds;
      assert.ok(Math.abs(bounds.x - 94.75) < 0.000001);
      assert.ok(Math.abs(bounds.y - 195.05) < 0.000001);
      assert.equal(bounds.width, 63);
      assert.equal(bounds.height, 54);
      assert.equal(result.exports[0].width, 63);
      assert.equal(result.exports[0].height, 54);
    }
  }
});

test("effect export size mismatches are blocked without cropping or native-image fallback", async () => {
  for (const source of ["imageHash", "nodeExport"]) {
    const node = shadowNode();
    node.exportAsync = async () => pngHeader(61, 54);
    const warnings = [];
    const result = await api([node]).exportFigmaPrefabImages([
      { id: "img_0", nodeId: node.id, source, imageHash: node.imageHash, effects: node.effects },
    ], warnings);
    assert.equal(result.exports[0].health.status, "blocked");
    assert.equal(result.exports[0].base64, "");
    assert.match(warnings[0], /render bounds.*63x54.*61x54/i);
  }
});

test("hidden and inner shadows keep the existing node-bounds export strategy", async () => {
  for (const mode of ["hidden", "inner", "noExpansion"]) {
    const node = shadowNode();
    if (mode === "hidden") node.effects[0].visible = false;
    if (mode === "inner") node.effects[0].type = "INNER_SHADOW";
    if (mode === "noExpansion") node.absoluteRenderBounds = node.absoluteBoundingBox;
    let settings;
    node.exportAsync = async options => { settings = options; return pngHeader(50, 40); };
    const result = await api([node]).exportFigmaPrefabImages([{ id: "img_0", nodeId: node.id, source: "nodeExport" }], []);
    assert.equal(settings.useAbsoluteBounds, true);
    assert.equal(result.exports[0].exportBounds, undefined);
    assert.equal(result.exports[0].health.status, "healthy");
  }
});

test("image requests with effects cannot reuse a different node's composed PNG", async () => {
  const first = shadowNode("shadow:1");
  const second = shadowNode("shadow:2");
  second.effects[0].color.a = 0.75;
  const root = { id: "root", name: "Root", type: "GROUP", width: 300, height: 300, children: [first, second] };
  const context = api([first, second]);
  const { requests } = await collect(context, root);
  const result = await context.exportFigmaPrefabImages(requests, []);
  assert.equal(result.exports.length, 2);
  assert.equal(result.exports[0].health.status, "healthy");
  assert.equal(result.exports[1].health.status, "healthy");
  assert.equal(result.exports[1].duplicateOf, undefined);
  assert.deepEqual(requests.map(request => request.effects), [first.effects, second.effects]);
});

test("duplicates of the same effect export retain its render bounds", async () => {
  const node = shadowNode();
  const request = { nodeId: node.id, source: "imageHash", imageHash: node.imageHash, effects: node.effects };
  const result = await api([node]).exportFigmaPrefabImages([{ ...request, id: "img_0" }, { ...request, id: "img_1" }], []);
  assert.equal(result.exports[1].duplicateOf, "img_0");
  assert.ok(Math.abs(result.exports[1].exportBounds.x - 94.75) < 0.000001);
  assert.ok(Math.abs(result.exports[1].exportBounds.y - 195.05) < 0.000001);
  assert.equal(result.exports[1].width, 63);
  assert.equal(result.exports[1].height, 54);
});

test("outer strokes preserve their render bounds and stroke metadata without a shadow effect", async () => {
  const node = { id: "stroke:1", name: "Ring", type: "ELLIPSE", width: 32, height: 32, strokeWeight: 4,
    absoluteBoundingBox: { x: 9107, y: -878, width: 32, height: 32 },
    absoluteRenderBounds: { x: 9103, y: -882, width: 40, height: 40 },
    strokes: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 } }],
    effects: [], exportAsync: async options => options.useAbsoluteBounds ? pngHeader(32, 32) : pngHeader(40, 40) };
  const context = api([node]);
  const { records, requests } = await collect(context, node);
  assert.equal(records[0].strokeWeight, 4);
  const result = await context.exportFigmaPrefabImages(requests, []);
  assert.equal(result.exports[0].health.status, "healthy");
  assert.deepEqual(JSON.parse(JSON.stringify(result.exports[0].exportBounds)), { x: 9103, y: -882, width: 40, height: 40 });
});

test("text stroke alignment is exported for Unity outline placement", async () => {
  const cases = [["OUTSIDE", "OUTSIDE"], ["CENTER", "CENTER"], ["INSIDE", "INSIDE"], ["outside", "OUTSIDE"], [undefined, ""], [Symbol("mixed"), ""]];
  for (const [strokeAlign, expected] of cases) {
    const node = { id: "text:1", name: "Coins", type: "TEXT", width: 258, height: 43, strokeWeight: 4, strokeAlign,
      characters: "342,553,552", strokes: [{ type: "SOLID", visible: true, color: { r: 0.43, g: 0.08, b: 0.08 } }],
      absoluteBoundingBox: { x: 352, y: 89, width: 258, height: 43 }, fills: [], effects: [] };
    const { records } = await collect(api([node]), node);
    assert.equal(records[0].strokeAlign, expected);
  }
  const shape = { id: "rect:1", name: "Bar", type: "RECTANGLE", width: 10, height: 10, strokeWeight: 2, strokeAlign: "OUTSIDE",
    absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, fills: [], strokes: [], effects: [] };
  const { records } = await collect(api([shape]), shape);
  assert.equal(records[0].strokeAlign, "");
});

test("fractional render bounds accept Figma pixel quantization while preserving the rendered center", async () => {
  const cases = [
    { nodeId: "33:541", rendered: { x: 8704.5, y: -2438.5, width: 149, height: 149 }, png: [149, 149] },
    { nodeId: "33:422", rendered: { x: 9018.799805, y: -1323.554077, width: 44.079102, height: 69.9021 }, png: [45, 70] },
    { nodeId: "33:423", rendered: { x: 9010.007813, y: -1259.242187, width: 37.007813, height: 37.008301 }, png: [37, 37] },
    { nodeId: "40:666", rendered: { x: 9015.008789, y: -1254.241089, width: 27.005859, height: 27.005981 }, png: [27, 27] },
  ];
  for (const fixture of cases) {
    const node = shadowNode(fixture.nodeId);
    node.absoluteRenderBounds = fixture.rendered;
    node.absoluteBoundingBox = { x: fixture.rendered.x + 4, y: fixture.rendered.y + 4,
      width: fixture.rendered.width - 8, height: fixture.rendered.height - 8 };
    node.exportAsync = async () => pngHeader(...fixture.png);
    const result = await api([node]).exportFigmaPrefabImages([
      { id: "img_0", nodeId: node.id, source: "nodeExport" },
    ], []);
    const exported = result.exports[0];
    assert.equal(exported.health.status, "healthy", fixture.nodeId);
    assert.equal(exported.exportBounds.width, fixture.png[0]);
    assert.equal(exported.exportBounds.height, fixture.png[1]);
    assert.ok(Math.abs(exported.exportBounds.x + fixture.png[0] / 2
      - (fixture.rendered.x + fixture.rendered.width / 2)) < 0.000001, fixture.nodeId);
    assert.ok(Math.abs(exported.exportBounds.y + fixture.png[1] / 2
      - (fixture.rendered.y + fixture.rendered.height / 2)) < 0.000001, fixture.nodeId);
  }
});
