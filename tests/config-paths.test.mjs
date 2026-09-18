import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as configModule from "../dist/config.js";

test("default asset roots stay inside the standalone plugin and system temp", () => {
  const config = configModule.parseArgs([]);
  const expected = [
    path.resolve(configModule.PLUGIN_ROOT, ".tmp"),
    path.resolve(os.tmpdir(), "figma-relay")
  ];
  assert.deepEqual(config.assetRoots, expected);
  assert.equal("REPO_ROOT" in configModule, false);
});
