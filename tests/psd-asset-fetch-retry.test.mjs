import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const uiSource = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

test("PSD asset download limits concurrency and retries transient local fetch failures", () => {
  assert.match(uiSource, /const PSD_ASSET_FETCH_CONCURRENCY = 2;/);
  assert.match(uiSource, /const PSD_ASSET_FETCH_MAX_ATTEMPTS = 3;/);
  assert.match(uiSource, /async function fetchAssetWithRetry\(asset\)/);
  assert.match(uiSource, /PSD 资源下载失败 assetId=/);
  assert.match(uiSource, /Math\.min\(PSD_ASSET_FETCH_CONCURRENCY, list\.length\)/);
  assert.doesNotMatch(uiSource, /Math\.min\(8, list\.length\)/);
});
