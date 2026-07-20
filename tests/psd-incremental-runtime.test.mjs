import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const utils = fs.readFileSync(new URL("../code/05_utils.js", import.meta.url), "utf8");
const handlers = fs.readFileSync(new URL("../code/01_handlers.js", import.meta.url), "utf8");

test("initial import stores schema-v3 source state inside Figma", () => {
  assert.match(utils, /psdImportSchemaVersion:\s*"3"/);
  assert.match(utils, /psdSourceState:\s*stablePsdSourceStateJson/);
  assert.match(utils, /psdSourceStateHash:\s*hashPsdSourceState/);
  assert.match(utils, /readSharedPluginData\(node, "psdSourceState"\)/);
});

test("legacy adoption is metadata-only and separately routed", () => {
  assert.match(utils, /async function adoptPsdIncrementalBaseline\(/);
  assert.match(utils, /status:\s*"baseline-adopted"/);
  assert.match(handlers, /incremental-baseline-adopt/);
  assert.match(handlers, /adoptPsdIncrementalBaseline/);

  const start = utils.indexOf("async function adoptPsdIncrementalBaseline(");
  const end = utils.indexOf("async function applyPsdIncrementalUpdate(", start);
  const adoption = utils.slice(start, end);
  assert.doesNotMatch(
    adoption,
    /\.resize\(|\.remove\(|\.appendChild\(|\.(?:x|y|rotation|visible|opacity|fills|strokes|effects|characters)\s*=/,
  );
});

test("stored baseline parse failure is explicit", () => {
  assert.match(utils, /invalid-stored-source-state/);
  assert.doesNotMatch(utils, /sourceState\s*=\s*buildPsdLiveNodeState/);
});

test("transaction captures and restores every mutable PSD-owned field", () => {
  for (const field of [
    "x", "y", "width", "height", "rotation", "visible", "opacity", "blendMode",
    "constraints", "characters", "fontName", "fontSize", "lineHeight",
    "textAlignHorizontal", "fills", "strokes", "strokeWeight", "strokeAlign", "effects",
  ]) {
    assert.match(utils, new RegExp("\\b" + field + "\\b"));
  }
  assert.match(utils, /capturePsdMutationRollback/);
  assert.match(utils, /rollbackPsdIncrementalMutation/);
  assert.match(utils, /verifyPsdAppliedFields/);
  assert.match(utils, /capturePsdStructuralSnapshot/);
  assert.match(utils, /verifyPsdStructuralSnapshot/);
});

test("organized identity and hierarchy are structural invariants", () => {
  assert.match(utils, /parentId/);
  assert.match(utils, /siblingIndex/);
  assert.match(utils, /componentIdentity/);
  assert.doesNotMatch(utils, /pair\.target\.node\.name\s*=/);
  assert.doesNotMatch(utils, /appendChild\(pair\.target\.node\)/);
});

test("added PSD layers verify complete source state before commit", () => {
  const start = utils.indexOf("function verifyPsdAddedNodes(");
  const end = utils.indexOf("function clonePsdValue(", start);
  const verification = utils.slice(start, end);

  assert.match(verification, /normalizePsdSourceState\(item\.source\)/);
  assert.match(verification, /psdSourceStateHash/);
  assert.match(verification, /readStoredPsdSourceState\(node\)/);
  assert.match(verification, /stablePsdSourceStateJson/);
});
