import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as incremental from "../code/06_psd_incremental.mjs";

const source = fs.readFileSync(new URL("../code/05_utils.js", import.meta.url), "utf8");

function functionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `missing runtime function ${name}`);
  const remainder = source.slice(match.index + match[0].length);
  const next = /\n(?:async )?function [A-Za-z]/.exec(remainder);
  return source.slice(match.index, next ? match.index + match[0].length + next.index : undefined);
}

function textNode() {
  let characters = "";
  let fontSize = 12;
  const node = {
    type: "TEXT", width: 0, height: 0, x: 0, y: 0, rotation: 0,
    textAutoResize: "WIDTH_AND_HEIGHT", constraints: {}, effects: [],
    fontName: { family: "Inter", style: "Regular" },
  };
  const reflow = () => {
    if (node.textAutoResize !== "WIDTH_AND_HEIGHT") return;
    node.width = Array.from(characters).length * fontSize * 0.6;
    node.height = fontSize * 1.4;
  };
  Object.defineProperties(node, {
    characters: { get: () => characters, set: value => { characters = value; reflow(); } },
    fontSize: { get: () => fontSize, set: value => { fontSize = value; reflow(); } },
  });
  return node;
}

function fixture({ fontFailure = false } = {}) {
  const calls = [];
  const root = { children: [], appendChild(node) { this.children.push(node); node.parent = this; } };
  const context = {
    manifest: { canvas: { width: 800, height: 1200 } },
    assetBytes: new Map(), stats: { text: 0, image: 0 },
    textReports: [], warnings: [],
  };
  const sandbox = {
    ...incremental,
    figma: {
      createText() { calls.push("createText"); return textNode(); },
      createRectangle() {
        calls.push("createRectangle");
        return { type: "RECTANGLE", resize(w, h) { this.width = w; this.height = h; } };
      },
    },
    async loadBestFont(layer) {
      calls.push("loadFont");
      if (fontFailure) throw new Error("font unavailable");
      return layer.fontFallback[0];
    },
    async createImagePaint() { return { type: "IMAGE", imageHash: "retained-artwork" }; },
    buildTextLayerName: layer => layer.name + "__text",
    buildImageLayerName: layer => layer.name,
    writePluginData(node, metadata) { node.metadata = metadata; },
    readSharedPluginData(node, key) { return node && node.metadata && node.metadata[key] || ""; },
    applyLayerGeometry(node, layer) { node.x = layer.x; node.y = layer.y; node.resize(layer.w, layer.h); },
    refreshPsdIncrementalDiffStatus(diff) { diff.status = diff.conflicts.length ? "preview-blocked" : "preview-ready"; },
    normalizedPsdSourceFileName: () => "fixture.psd",
    Date,
  };
  const names = [
    "numericOr", "firstDefined", "positiveOr", "clamp01", "cloneObject", "clonePsdValue",
    "isOrdinaryTextLayer", "assertOrdinaryTextLayer", "normalizeManifest", "normalizeLayer",
    "applyNestedManifestCompatibility", "extractTextFontFallback", "normalizeTextStroke",
    "normalizeConstraint", "normalizeTextAlign", "solidPaintFromManifest", "applyLayerCommonState",
    "centerNodeOnLayer", "applyPsdTextShadow", "writeLayerMetadata", "capturePsdLayerMetadata",
    "createTextLayer", "createImageLayer", "createLayerNode", "importPsdJob",
    "appendPsdIncrementalRuntimeConflicts", "applyPsdTextPlan",
  ];
  vm.createContext(sandbox);
  vm.runInContext(names.map(functionSource).join("\n"), sandbox);
  return { api: sandbox, root, context, calls };
}

function layer(overrides = {}) {
  return {
    idx: 1, layerId: "101", name: "Reward quantity", mode: "text", semanticMode: "text",
    textRole: "ordinary", chars: "×50", x: 100.25, y: 200.5, w: 55.02, h: 24.91,
    fontSize: 28, fontFallback: [{ family: "Arial", style: "Bold" }],
    fillColor: { r: 0.02, g: 0.03, b: 0.04 },
    stroke: { enabled: true, size: 1, r: 0.94, g: 0.95, b: 0.96 },
    opacity: 1, visible: true,
    constraints: { horizontal: "MIN", vertical: "MIN" },
    sourceState: { text: { lineHeightMode: "PIXELS", leading: 90 }, geometry: {}, display: {} },
    ...overrides,
  };
}

test("ordinary Unicode text imports without PNG bytes, stays automatic and keeps the source center", async () => {
  const { api, root, context, calls } = fixture();
  const input = layer({ chars: "剩余21天 ×50 / 100%" });
  const node = await api.createLayerNode(root, input, context);

  assert.equal(node.type, "TEXT");
  assert.equal(node.characters, input.chars);
  assert.equal(node.textAutoResize, "WIDTH_AND_HEIGHT");
  assert.equal(node.lineHeight.unit, "AUTO");
  assert.equal(node.fills[0].type, "SOLID");
  assert.equal(node.fills[0].color.g, input.fillColor.g);
  assert.equal(node.strokes[0].color.r, input.stroke.r);
  assert.equal(node.strokeWeight, 1);
  assert.equal(node.x + node.width / 2, input.x + input.w / 2);
  assert.equal(node.y + node.height / 2, input.y + input.h / 2);
  assert.equal(node.metadata.textRole, "ordinary");
  assert.equal(context.stats.text, 1);
  assert.deepEqual(calls, ["loadFont", "createText"]);
  assert.equal(root.children.length, 1);
});

test("mixed native text and decorative raster retain their respective node types", async () => {
  const { api, root, context } = fixture();
  const text = await api.createLayerNode(root, layer(), context);
  const art = await api.createLayerNode(root, layer({
    idx: 2, layerId: "102", name: "Illustrated title", textRole: "decorative", mode: "image",
  }), context);

  assert.equal(text.type, "TEXT");
  assert.equal(art.type, "RECTANGLE");
  assert.equal(art.fills[0].imageHash, "retained-artwork");
  assert.equal(art.metadata.textRole, "decorative");
  assert.deepEqual(root.children.map(node => node.type), ["TEXT", "RECTANGLE"]);
  assert.equal(context.stats.image, 1);
});

test("ordinary text font failure creates neither an orphan node nor a raster fallback", async () => {
  const { api, root, context, calls } = fixture({ fontFailure: true });
  await assert.rejects(() => api.createLayerNode(root, layer(), context), /font unavailable/);
  assert.deepEqual(calls, ["loadFont"]);
  assert.equal(root.children.length, 0);
  assert.equal(context.stats.image, 0);
  assert.equal(context.stats.text, 0);
});

test("ordinary text only tries declared font candidates and never silently uses Inter or fuzzy matches", async () => {
  const { api, root, context, calls } = fixture();
  const attempted = [];
  api.figma.loadFontAsync = async font => { attempted.push(`${font.family}/${font.style}`); throw new Error("not installed"); };
  api.getAvailableFonts = async () => { throw new Error("ordinary text must not discover a substitute"); };
  vm.runInContext(functionSource("normalizeFontCandidates") + "\n" + functionSource("loadBestFont"), api);
  const input = layer({
    chars: "领取 ×50",
    fontFallback: [{ family: "Observed CJK Font", style: "Bold" }, { family: "Explicit Backup", style: "Medium" }],
  });
  await assert.rejects(() => api.createLayerNode(root, input, context), /ordinary-text-font-unavailable/);
  assert.deepEqual(attempted, ["Observed CJK Font/Bold", "Explicit Backup/Medium"]);
  assert.deepEqual(calls, []);
  assert.equal(root.children.length, 0);
  assert.equal(context.stats.image, 0);
});

test("ordinary text can use an explicitly supplied fallback with its actual style", async () => {
  const { api, root, context } = fixture();
  const attempted = [];
  api.figma.loadFontAsync = async font => {
    attempted.push(`${font.family}/${font.style}`);
    if (font.family !== "Explicit Backup") throw new Error("not installed");
  };
  vm.runInContext(functionSource("normalizeFontCandidates") + "\n" + functionSource("loadBestFont"), api);
  const input = layer({ fontFallback: [{ family: "Unavailable", style: "Bold" }, { family: "Explicit Backup", style: "Medium" }] });
  const node = await api.createLayerNode(root, input, context);
  assert.deepEqual(attempted, ["Unavailable/Bold", "Explicit Backup/Medium"]);
  assert.equal(node.fontName.family, "Explicit Backup");
  assert.equal(node.fontName.style, "Medium");
  assert.equal(node.textAutoResize, "WIDTH_AND_HEIGHT");
});

test("ordinary image and missing characters are rejected before any Figma creation", async () => {
  const { api, root, context, calls } = fixture();
  await assert.rejects(() => api.createLayerNode(root, layer({ mode: "common-component" }), context), /ordinary-text-requires-native-text/);
  await assert.rejects(() => api.createLayerNode(root, layer({ chars: " " }), context), /ordinary-text-missing-characters/);
  await assert.rejects(() => api.importPsdJob({ manifest: { layers: [layer({ mode: "image" })] } }, []), /ordinary-text-requires-native-text/);
  assert.equal(root.children.length, 0);
  assert.deepEqual(calls, []);
});

test("normalization preserves the text role and makes its stored line-height baseline automatic", () => {
  const { api } = fixture();
  const input = layer({
    chars: undefined,
    text: { characters: "×50", fontSize: 28, fillColor: { r: 0.1, g: 0.2, b: 0.3 } },
  });
  const normalized = api.normalizeLayer(input);
  assert.equal(normalized.textRole, "ordinary");
  assert.equal(normalized.chars, "×50");
  assert.equal(normalized.sourceState.text.lineHeightMode, "AUTO");
  assert.equal(normalized.sourceState.text.leading, 0);
  assert.equal(input.sourceState.text.leading, 90);
});

test("legacy unmarked PSD text retains its existing fixed-size incremental contract", async () => {
  const { api, root, context } = fixture();
  const node = await api.createLayerNode(root, layer({ textRole: undefined }), context);
  assert.equal(node.textAutoResize, "NONE");
  assert.equal(node.lineHeight.unit, "PIXELS");
  assert.equal(node.lineHeight.value, 90);
});

test("ordinary incremental edits are blocked using incoming or persisted role before mutation", async () => {
  for (const persistedRole of [false, true]) {
    const { api } = fixture();
    const node = {
      type: "TEXT", characters: "×50", textAutoResize: "WIDTH_AND_HEIGHT",
      metadata: persistedRole ? { textRole: "ordinary" } : {},
    };
    const input = layer({ textRole: persistedRole ? undefined : "ordinary" });
    const pair = { source: input, target: { node, nodeId: "1:5" } };
    const diff = { changed: [pair], conflicts: [] };
    const target = { metadata: { psdImportSchemaVersion: "3", psdCanvasWidth: "800", psdCanvasHeight: "1200" } };
    api.appendPsdIncrementalRuntimeConflicts(diff, target, [{ layerId: "101" }], {}, { canvas: { width: 800, height: 1200 }, layers: [input] });
    assert.equal(diff.conflicts.length, 1);
    assert.equal(diff.conflicts[0].kind, "ordinary-text-requires-native-replacement");
    assert.equal(diff.status, "preview-blocked");
    await assert.rejects(() => api.applyPsdTextPlan({ source: input, incoming: { text: { characters: "×75" } }, changedPaths: ["text.characters"] }, pair, {}), /ordinary-text-requires-native-replacement/);
    assert.equal(node.characters, "×50");
    assert.equal(node.textAutoResize, "WIDTH_AND_HEIGHT");
  }
});

test("rollback metadata snapshots preserve ordinary text ownership annotation", () => {
  const { api } = fixture();
  const snapshot = api.capturePsdLayerMetadata({ metadata: { textRole: "ordinary", psdOwnership: "text-content" } });
  assert.equal(snapshot.textRole, "ordinary");
  assert.equal(snapshot.psdOwnership, "text-content");
});
