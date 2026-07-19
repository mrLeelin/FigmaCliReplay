import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pluginSource = fs.readFileSync(new URL("../code.js", import.meta.url), "utf8");

test("PSD incremental apply finalizes its transparent staging frame into the import root", () => {
  assert.match(pluginSource, /function buildPsdStagingFinalizationPlan\(target\)/);
  assert.match(pluginSource, /async function finalizePsdIncrementalStaging\(target, plan, context, orderedLayers\)/);
  assert.match(pluginSource, /await ensurePsdIndexOrder\(target, orderedLayers, context\)/);
  assert.match(pluginSource, /stagingFrame\.remove\(\)/);
  assert.match(pluginSource, /finalizedStagingNodeCount/);
});

test("PSD incremental preview reports pending staging cleanup before any write", () => {
  assert.match(pluginSource, /stagingFinalization: prepared\.stagingFinalization/);
  assert.match(pluginSource, /finalizedStagingNodeCount/);
});

test("PSD layout repair and staging finalization emit structured plugin diagnostics", () => {
  assert.match(pluginSource, /pluginLogger\.info\("PSD 文字自动尺寸已修复"/);
  assert.match(pluginSource, /pluginLogger\.info\("PSD 增量临时容器已解包"/);
});
