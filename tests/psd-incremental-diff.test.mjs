import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildPsdIncrementalDiff,
  measurePsdLayerIdentity,
  normalizePsdLayerId,
  psdOwnershipForMode,
  validatePsdOwnedTarget,
} from "../code/06_psd_incremental.mjs";


test("normalizes only positive decimal Photoshop layer ids", () => {
  assert.equal(normalizePsdLayerId(205), "205");
  assert.equal(normalizePsdLayerId(" 205 "), "205");
  assert.equal(normalizePsdLayerId(0), "");
  assert.equal(normalizePsdLayerId("-1"), "");
  assert.equal(normalizePsdLayerId("abc"), "");
});

test("classifies changed unchanged new and missing layers", () => {
  const current = [
    { layerId: "10", nodeId: "1:10", contentHash: "old-a", name: "Avatar_Image" },
    { layerId: "20", nodeId: "1:20", contentHash: "same", name: "Title" },
    { layerId: "30", nodeId: "1:30", contentHash: "gone", name: "OldBadge" },
  ];
  const incoming = [
    { layerId: "10", contentHash: "new-a", name: "头像", mode: "image" },
    { layerId: "20", contentHash: "same", name: "标题", mode: "text" },
    { layerId: "40", contentHash: "new", name: "NewBadge", mode: "image" },
  ];

  const diff = buildPsdIncrementalDiff(current, incoming);

  assert.deepEqual(diff.summary, {
    changed: 1,
    unchanged: 1,
    added: 1,
    missing: 1,
    conflicts: 0,
  });
  assert.equal(diff.canApply, true);
  assert.equal(diff.changed[0].target.nodeId, "1:10");
  assert.equal(diff.added[0].source.layerId, "40");
  assert.equal(diff.missing[0].target.layerId, "30");
});

test("duplicate stored layer ids are blocking conflicts", () => {
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "10", nodeId: "a" }, { layerId: "10", nodeId: "b" }],
    [{ layerId: "10", contentHash: "new" }],
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
