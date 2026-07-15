import assert from "node:assert/strict";
import test from "node:test";

import { compactJobResult } from "../dist/runtimeRelay.js";

test("compact result preserves image health summary", () => {
  const result = compactJobResult({
    status: "blocked",
    imageExportManifest: { healthSummary: { total: 5, healthy: 2, repaired: 2, blocked: 1 } },
    blockingErrors: [{ code: "invalidImagePayload", nodePath: "Root/Bg" }]
  });
  assert.deepEqual(result.imageHealthSummary, { total: 5, healthy: 2, repaired: 2, blocked: 1 });
  assert.equal(result.blockingErrors.length, 1);
});
