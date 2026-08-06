import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as psdIncremental from "../code/06_psd_incremental.mjs";

import {
  buildPsdIncrementalDiff,
  buildPsdLayerMutationPlan,
  computePsdGeometryTarget,
  diffPsdSourceStates,
  hashPsdSourceState,
  isPsdFontFamilyAllowed,
  measurePsdLayerIdentity,
  normalizePsdLayerId,
  psdOwnershipForMode,
  resolvePsdLiveContentHash,
  validatePsdOwnedTarget,
} from "../code/06_psd_incremental.mjs";


function state(overrides = {}) {
  return {
    version: 3,
    layerId: "406",
    mode: "image",
    geometry: { x: 580, y: 1514, width: 363, height: 140, rotation: 0 },
    display: {
      visible: true,
      opacity: 1,
      blendMode: "NORMAL",
      constraints: { horizontal: "CENTER", vertical: "CENTER" },
    },
    content: { contentHash: "same-pixels" },
    text: null,
    nineSlice: null,
    unsupported: [],
    ...overrides,
  };
}


test("normalizes only positive decimal Photoshop layer ids", () => {
  assert.equal(normalizePsdLayerId(205), "205");
  assert.equal(normalizePsdLayerId(" 205 "), "205");
  assert.equal(normalizePsdLayerId(0), "");
  assert.equal(normalizePsdLayerId("-1"), "");
  assert.equal(normalizePsdLayerId("abc"), "");
});

test("classifies changed unchanged new and missing layers", () => {
  const changedBaseline = state({ layerId: "10" });
  const changedIncoming = state({
    layerId: "10",
    content: { contentHash: "new-a" },
  });
  const unchangedState = state({ layerId: "20" });
  const current = [
    { layerId: "10", nodeId: "1:10", sourceState: changedBaseline, name: "Avatar_Image" },
    { layerId: "20", nodeId: "1:20", sourceState: unchangedState, name: "Title" },
    { layerId: "30", nodeId: "1:30", sourceState: state({ layerId: "30" }), name: "OldBadge" },
  ];
  const incoming = [
    { layerId: "10", sourceState: changedIncoming, name: "Avatar", mode: "image" },
    { layerId: "20", sourceState: unchangedState, name: "Heading", mode: "text" },
    { layerId: "40", sourceState: state({ layerId: "40" }), name: "NewBadge", mode: "image" },
  ];

  const diff = buildPsdIncrementalDiff(current, incoming);

  assert.equal(diff.status, "preview-ready");
  assert.equal(diff.summary.affected, 1);
  assert.equal(diff.summary.unchanged, 1);
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.missing, 1);
  assert.equal(diff.summary.conflicts, 0);
  assert.equal(diff.canApply, true);
  assert.equal(diff.changed[0].target.nodeId, "1:10");
  assert.equal(diff.added[0].source.layerId, "40");
  assert.equal(diff.missing[0].target.layerId, "30");
});

test("position-only source changes are affected even when content hash is unchanged", () => {
  const baseline = state();
  const incoming = state({ geometry: { ...baseline.geometry, y: 1196 } });
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "7195:882", sourceState: baseline }],
    [{ layerId: "406", name: "ui_anniu_1", sourceState: incoming }],
  );
  assert.equal(diff.summary.affected, 1);
  assert.equal(diff.summary.position, 1);
  assert.equal(diff.summary.content, 0);
  assert.equal(diff.changed[0].changes[0].path, "geometry.y");
  assert.equal(diff.changed[0].changes[0].delta, -318);
});

test("Figma-only position drift is affected when PSD is the authoritative source", () => {
  const baseline = state({ geometry: { ...state().geometry, y: 1196 } });
  const liveState = state({ geometry: { ...baseline.geometry, y: 1443 } });
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "7210:992", sourceState: baseline, liveState }],
    [{ layerId: "406", name: "ui_anniu_1", sourceState: baseline }],
  );

  assert.equal(diff.status, "preview-ready");
  assert.equal(diff.summary.affected, 1);
  assert.equal(diff.summary.position, 1);
  assert.equal(diff.summary.content, 0);
  assert.equal(diff.changed[0].changes[0].path, "geometry.y");
  assert.equal(diff.changed[0].changes[0].before, 1443);
  assert.equal(diff.changed[0].changes[0].after, 1196);
  assert.equal(diff.changed[0].changes[0].delta, -247);
});

test("live-state comparison ignores serialization noise but keeps meaningful numeric drift", () => {
  const baseline = state();
  const noisy = state({
    display: { ...baseline.display, opacity: baseline.display.opacity - 2e-8 },
    text: {
      characters: "99",
      effectiveFontSize: 55.83997344970703,
      leading: 0,
      lineHeightMode: "AUTO",
    },
  });
  const incoming = state({
    text: {
      characters: "99",
      effectiveFontSize: 55.839974447056775,
      leading: 0.01,
      lineHeightMode: "AUTO",
    },
  });
  assert.deepEqual(diffPsdSourceStates(noisy, incoming).changes, []);

  const meaningful = state({ display: { ...baseline.display, opacity: 0.98 } });
  assert.equal(diffPsdSourceStates(meaningful, baseline).changes[0].path, "display.opacity");
});

test("live image bytes resolve to the PSD hash only when the pixels still match", () => {
  const incomingBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  assert.equal(resolvePsdLiveContentHash({
    currentBytes: new Uint8Array(incomingBytes),
    incomingBytes,
    currentImageHash: "figma-hash",
    incomingContentHash: "psd-sha256",
  }), "psd-sha256");
  assert.equal(resolvePsdLiveContentHash({
    currentBytes: new Uint8Array([137, 80, 78, 71, 9, 9, 9]),
    incomingBytes,
    currentImageHash: "figma-hash",
    incomingContentHash: "psd-sha256",
  }), "figma-image:figma-hash");
  assert.equal(resolvePsdLiveContentHash({
    currentBytes: null,
    incomingBytes,
    currentImageHash: "",
    incomingContentHash: "psd-sha256",
  }), "figma-image:missing");
});

test("an installed PSD fallback font is equivalent to the requested source font", () => {
  const text = {
    fontFamily: "GROBOLD",
    fontFallback: [
      { family: "GROBOLD", style: "Regular" },
      { family: "Lilita One", style: "Regular" },
    ],
  };
  assert.equal(isPsdFontFamilyAllowed(text, "Lilita One"), true);
  assert.equal(isPsdFontFamilyAllowed(text, "Arial"), false);
});

test("live text paint comparison tolerates Figma float serialization", () => {
  const baseline = state({
    mode: "text",
    text: {
      characters: "99",
      fillColor: { r: 1, g: 0.5, b: 0.25, a: 1, hex: "#FF8040" },
      stroke: { enabled: true, size: 6, color: { r: 0, g: 0.1443350911, b: 0.360784322 } },
      dropShadow: null,
    },
  });
  const noisy = state({
    mode: "text",
    text: {
      ...baseline.text,
      fillColor: { ...baseline.text.fillColor, g: 0.50000002 },
      stroke: { ...baseline.text.stroke, size: 6.000001 },
    },
  });
  assert.deepEqual(diffPsdSourceStates(noisy, baseline).changes, []);
  const changed = state({
    mode: "text",
    text: { ...baseline.text, fillColor: { ...baseline.text.fillColor, g: 0.7 } },
  });
  assert.equal(diffPsdSourceStates(changed, baseline).changes[0].path, "text.fillColor");
});

test("one layer contributes to multiple categories but one affected total", () => {
  const baseline = state();
  const incoming = state({
    geometry: { ...baseline.geometry, width: 726 },
    display: { ...baseline.display, opacity: 0.5, visible: false },
    content: { contentHash: "new-pixels" },
  });
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "n", sourceState: baseline }],
    [{ layerId: "406", sourceState: incoming }],
  );
  assert.equal(diff.summary.affected, 1);
  assert.equal(diff.summary.size, 1);
  assert.equal(diff.summary.display, 1);
  assert.equal(diff.summary.content, 1);
});

test("legacy matched nodes require baseline adoption", () => {
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "n", sourceState: null }],
    [{ layerId: "406", sourceState: state() }],
  );
  assert.equal(diff.status, "preview-baseline-required");
  assert.equal(diff.canApply, false);
});

test("identical canonical source state produces preview-no-changes", () => {
  const baseline = state();
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "n", sourceState: baseline }],
    [{ layerId: "406", sourceState: JSON.parse(JSON.stringify(baseline)) }],
  );
  assert.equal(diff.status, "preview-no-changes");
  assert.equal(diff.summary.affected, 0);
  assert.equal(diff.canApply, false);
});

test("changed unsupported state is blocking", () => {
  const baseline = state();
  const incoming = state({ unsupported: [{ path: "display.blendMode", value: "zzzz" }] });
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "n", sourceState: baseline }],
    [{ layerId: "406", sourceState: incoming }],
  );
  assert.equal(diff.status, "preview-blocked");
  assert.equal(diff.conflicts[0].kind, "unsupported-source-change");
});

test("legacy raster placed-payload hashes do not create unsupported conflicts", () => {
  const baseline = state({
    unsupported: [{
      path: "geometry.rotation",
      value: { tag: "SoLd", sha256: "old-save-internal-payload" },
    }],
  });
  const incoming = state({ unsupported: [] });

  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "n", sourceState: baseline }],
    [{ layerId: "406", sourceState: incoming }],
  );

  assert.equal(diff.status, "preview-no-changes");
  assert.equal(diff.summary.conflicts, 0);
  assert.equal(diff.summary.changed, 0);
});

test("new unsupported source state is blocking", () => {
  const incoming = state({
    layerId: "407",
    unsupported: [{ path: "display.blendMode", value: "zzzz" }],
  });
  const diff = buildPsdIncrementalDiff([], [{ layerId: "407", sourceState: incoming }]);
  assert.equal(diff.status, "preview-blocked");
  assert.equal(diff.added.length, 0);
  assert.equal(diff.conflicts[0].kind, "unsupported-source-change");
});

test("canonical hashes ignore object key insertion order", () => {
  assert.equal(
    hashPsdSourceState({ b: 2, a: { d: 4, c: 3 } }),
    hashPsdSourceState({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("geometry target restores authoritative PSD geometry under transformed parents", () => {
  const target = computePsdGeometryTarget({
    baseline: { x: 580, y: 1514, width: 363, height: 140, rotation: 0 },
    incoming: { x: 580, y: 1196, width: 726, height: 140, rotation: 15 },
    currentAbsolute: { x: 1000, y: 2000 },
    currentSize: { width: 500, height: 200 },
    currentRotation: 5,
    rootAbsoluteTransform: [[2, 0, 100], [0, 2, 50]],
    parentAbsoluteTransform: [[1, 0, 400], [0, 1, 600]],
  });
  assert.deepEqual(target.localPosition, { x: 860, y: 1842 });
  assert.deepEqual(target.size, { width: 1452, height: 280 });
  assert.equal(target.rotation, 15);
});

test("authoritative geometry planning does not depend on the stored PSD baseline size", () => {
  const target = computePsdGeometryTarget({
    baseline: { x: 0, y: 0, width: 0, height: 10, rotation: 0 },
    incoming: { x: 20, y: 30, width: 40, height: 10, rotation: 0 },
    currentAbsolute: { x: 0, y: 0 },
    currentSize: { width: 10, height: 10 },
    currentRotation: 0,
    rootAbsoluteTransform: [[1, 0, 0], [0, 1, 0]],
    parentAbsoluteTransform: [[1, 0, 0], [0, 1, 0]],
  });
  assert.deepEqual(target.localPosition, { x: 20, y: 30 });
  assert.deepEqual(target.size, { width: 40, height: 10 });
});

test("live Figma geometry is normalized back into PSD source coordinates", () => {
  assert.equal(typeof psdIncremental.mapPsdLiveGeometryToSource, "function");
  const geometry = psdIncremental.mapPsdLiveGeometryToSource({
    nodeAbsoluteTransform: [[2, 0, 1260], [0, 2, 2442]],
    nodeSize: { width: 363, height: 140 },
    nodeRotation: 0,
    rootAbsoluteTransform: [[2, 0, 100], [0, 2, 50]],
  });
  assert.deepEqual(geometry, { x: 580, y: 1196, width: 363, height: 140, rotation: 0 });
});

test("mutation plan names every writable category for one layer", () => {
  const baseline = state();
  const incoming = state({
    geometry: { x: 600, y: 1200, width: 726, height: 280, rotation: 10 },
    display: { ...baseline.display, visible: false, opacity: 0.5 },
    content: { contentHash: "new" },
  });
  const plan = buildPsdLayerMutationPlan({
    source: { layerId: "406", sourceState: incoming },
    target: { sourceState: baseline, nodeId: "n" },
    changes: diffPsdSourceStates(baseline, incoming).changes,
  });
  assert.deepEqual(plan.categories, ["content", "display", "position", "rotation", "size"]);
});

test("duplicate stored layer ids are blocking conflicts", () => {
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "10", nodeId: "a" }, { layerId: "10", nodeId: "b" }],
    [{ layerId: "10", sourceState: state({ layerId: "10" }) }],
  );

  assert.equal(diff.summary.conflicts, 1);
  assert.equal(diff.conflicts[0].kind, "duplicate-target-layer-id");
  assert.equal(diff.canApply, false);
});

test("missing and duplicate incoming ids are blocking conflicts", () => {
  const diff = buildPsdIncrementalDiff([], [
    { layerId: "", name: "NoId" },
    { layerId: "20", name: "First" },
    { layerId: "20", name: "Duplicate" },
  ]);

  assert.equal(diff.summary.conflicts, 2);
  assert.equal(diff.canApply, false);
  assert.deepEqual(
    diff.conflicts.map((item) => item.kind),
    ["missing-source-layer-id", "duplicate-source-layer-id"],
  );
});

test("Figma runtime exposes preview/apply without overwriting organized node identity", () => {
  const source = fs.readFileSync(new URL("../code/05_utils.js", import.meta.url), "utf8");

  assert.match(source, /async function previewPsdIncrementalUpdate\(/);
  assert.match(source, /async function applyPsdIncrementalUpdate\(/);
  assert.match(source, /psdLayerId/);
  assert.match(source, /psdContentHash/);
  assert.match(source, /layoutPositioning = "ABSOLUTE"/);
  assert.match(source, /rollbackPsdIncrementalMutation/);
  assert.match(source, /verifyPsdProtectedSnapshot/);
  assert.match(source, /replacePsdOwnedImageHash/);
  assert.match(source, /liveContentSignature/);
  assert.match(source, /text\.textAutoResize = "NONE"/);
  assert.match(source, /verifyPsdAddedNodes/);
  assert.match(source, /hasExpectedNineSliceImageHash/);
  assert.match(source, /imagePaints\[0\]\.imageHash === expectedImageHash/);
  assert.doesNotMatch(source, /targetNode\.name\s*=/);
  assert.doesNotMatch(source, /targetNode\.x\s*=/);
});

test("ownership is an executable write boundary", () => {
  assert.equal(psdOwnershipForMode("image"), "image-content");
  assert.equal(psdOwnershipForMode("text"), "text-content");
  assert.equal(psdOwnershipForMode("nine-slice"), "nine-slice-content");
  assert.equal(validatePsdOwnedTarget("image-content", "image", "RECTANGLE", ""), "");
  assert.equal(validatePsdOwnedTarget("text-content", "text", "TEXT", "NONE"), "");
  assert.equal(validatePsdOwnedTarget("image-content", "text", "TEXT", "NONE"), "ownership-mismatch");
  assert.equal(validatePsdOwnedTarget("text-content", "text", "TEXT", "WIDTH_AND_HEIGHT"), "unsafe-text-auto-resize");
  assert.equal(validatePsdOwnedTarget("nine-slice-content", "nine-slice", "FRAME", ""), "");
});

test("document identity uses Photoshop layer overlap instead of filename alone", () => {
  assert.deepEqual(measurePsdLayerIdentity(
    [{ layerId: "10" }, { layerId: "20" }, { layerId: "30" }],
    [{ layerId: "10" }, { layerId: "20" }, { layerId: "40" }],
  ), {
    currentCount: 3,
    incomingCount: 3,
    matchedCount: 2,
    currentCoverage: 2 / 3,
    incomingCoverage: 2 / 3,
    overlap: 2 / 3,
  });
  assert.equal(measurePsdLayerIdentity([{ layerId: "10" }], [{ layerId: "99" }]).overlap, 0);
  const additiveUpdate = measurePsdLayerIdentity([{ layerId: "10" }], [
    { layerId: "10" }, { layerId: "20" }, { layerId: "30" }, { layerId: "40" },
  ]);
  assert.equal(additiveUpdate.overlap, 0.25);
  assert.equal(additiveUpdate.currentCoverage, 1);
  assert.equal(additiveUpdate.incomingCoverage, 0.25);
});
