import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pluginSource = fs.readFileSync(new URL("../code.js", import.meta.url), "utf8");

test("PSD text keeps automatic sizing and incremental repair revisits legacy fixed-size text", () => {
  assert.match(pluginSource, /function needsPsdTextLayoutRepair\(target\)/);
  assert.match(pluginSource, /targetHash && targetHash === sourceHash && !needsPsdTextLayoutRepair\(target\)/);
  assert.match(pluginSource, /function normalizePsdTextLayout\(node, source\)/);
  assert.match(pluginSource, /node\.textAutoResize = "WIDTH_AND_HEIGHT";/);
  assert.match(pluginSource, /node\.lineHeight = \{ unit: "AUTO" \};/);
  assert.doesNotMatch(pluginSource, /centerNodeOnLayer\(text, layer\);\s*\/\/[^\n]*\s*text\.textAutoResize = "NONE";/);
});

test("PSD text rollback retains layout settings if incremental repair fails", () => {
  assert.match(pluginSource, /textAutoResize: node\.type === "TEXT" \? node\.textAutoResize : null/);
  assert.match(pluginSource, /lineHeight: node\.type === "TEXT" && node\.lineHeight/);
  assert.match(pluginSource, /record\.node\.textAutoResize = record\.textAutoResize/);
});
