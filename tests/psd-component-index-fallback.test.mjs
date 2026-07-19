import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pluginSource = fs.readFileSync(new URL("../code.js", import.meta.url), "utf8");

test("PSD import treats unavailable component-library scans as a logged image fallback", () => {
  assert.match(pluginSource, /async function collectComponentIndexSafely\(libraryName, rootId\)/);
  assert.match(pluginSource, /pluginLogger\.warn\("PSD 组件索引不可用，已回退为图片导入"/);
  assert.match(pluginSource, /common: await collectComponentIndexSafely\("common", config\.commonRootId\)/);
  assert.match(pluginSource, /image: await collectComponentIndexSafely\("image", config\.imageRootId\)/);
});
