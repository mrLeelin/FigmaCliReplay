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
