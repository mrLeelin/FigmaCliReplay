import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildPsdIncrementalDiff,
  computePsdGeometryTarget,
  hashPsdSourceState,
  measurePsdLayerIdentity,
  normalizePsdLayerId,
  psdOwnershipForMode,
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

test("new unsupported source state is blocking", () => {
  const incoming = state({
    layerId: "407",
    unsupported: [{ path: "geometry.rotation", value: { tag: "SoLd", sha256: "abc" } }],
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

test("geometry target preserves organized offset under transformed parents", () => {
  const target = computePsdGeometryTarget({
    baseline: { x: 580, y: 1514, width: 363, height: 140, rotation: 0 },
    incoming: { x: 580, y: 1196, width: 726, height: 140, rotation: 15 },
    currentAbsolute: { x: 1000, y: 2000 },
    currentSize: { width: 500, height: 200 },
    currentRotation: 5,
    rootAbsoluteTransform: [[2, 0, 100], [0, 2, 50]],
    parentAbsoluteTransform: [[1, 0, 400], [0, 1, 600]],
  });
  assert.deepEqual(target.localPosition, { x: 600, y: 764 });
  assert.deepEqual(target.size, { width: 1000, height: 200 });
  assert.equal(target.rotation, 20);
});

test("zero baseline size blocks geometry planning", () => {
  assert.throws(() => computePsdGeometryTarget({
    baseline: { x: 0, y: 0, width: 0, height: 10, rotation: 0 },
    incoming: { x: 0, y: 0, width: 20, height: 10, rotation: 0 },
    currentAbsolute: { x: 0, y: 0 },
    currentSize: { width: 10, height: 10 },
    currentRotation: 0,
    rootAbsoluteTransform: [[1, 0, 0], [0, 1, 0]],
    parentAbsoluteTransform: [[1, 0, 0], [0, 1, 0]],
  }), /invalid-baseline-size/);
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
  assert.equal(psdOwnershipForMode("nine-slice"), "protected");
  assert.equal(validatePsdOwnedTarget("image-content", "image", "RECTANGLE", ""), "");
  assert.equal(validatePsdOwnedTarget("text-content", "text", "TEXT", "NONE"), "");
  assert.equal(validatePsdOwnedTarget("image-content", "text", "TEXT", "NONE"), "ownership-mismatch");
  assert.equal(validatePsdOwnedTarget("text-content", "text", "TEXT", "WIDTH_AND_HEIGHT"), "unsafe-text-auto-resize");
  assert.equal(validatePsdOwnedTarget("protected", "nine-slice", "FRAME", ""), "protected-source-mode");
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
