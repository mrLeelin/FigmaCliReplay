import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  createImageHealth,
  applyImageValidationErrors,
  isValidImagePayload,
  summarizeImageHealth,
  validateImageExports
} from "../code/03_image_health.mjs";

test("valid PNG payload is healthy", () => {
  const item = { id: "img_0", width: 8, height: 8, byteLength: 32, base64: "iVBORw0KGgo=" };
  assert.equal(isValidImagePayload(item), true);
});

test("duplicate export is repaired only when its source is valid", () => {
  const source = { id: "img_0", width: 8, height: 8, byteLength: 32, base64: "iVBORw0KGgo=", health: createImageHealth("healthy", "exported") };
  const duplicate = { id: "img_1", duplicateOf: "img_0", byteLength: 0, base64: "", health: createImageHealth("repaired", "duplicateReused", { sourceExportId: "img_0" }) };
  assert.deepEqual(validateImageExports([source, duplicate]), []);
});

test("dangling duplicate and zero-sized image are blocked", () => {
  const errors = validateImageExports([
    { id: "img_1", duplicateOf: "missing", health: createImageHealth("repaired", "duplicateReused", { sourceExportId: "missing" }) },
    { id: "img_2", width: 0, height: 0, byteLength: 149, base64: "iVBORw0KGgo=" }
  ]);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map((item) => item.code), ["danglingDuplicate", "invalidImagePayload"]);
});

test("summary counts healthy repaired and blocked", () => {
  const summary = summarizeImageHealth([
    { health: createImageHealth("healthy", "exported") },
    { health: createImageHealth("repaired", "tinyFrameFallback") },
    { health: createImageHealth("blocked", "missingPayload") }
  ]);
  assert.deepEqual(summary, { total: 3, healthy: 1, repaired: 1, blocked: 1 });
});

test("validation errors convert repaired placeholders to blocked health", () => {
  const exports = [{ id: "img_1", duplicateOf: "missing", health: createImageHealth("repaired", "duplicateReused") }];
  const errors = validateImageExports(exports);
  applyImageValidationErrors(exports, errors);
  assert.equal(exports[0].health.status, "blocked");
  assert.equal(summarizeImageHealth(exports).blocked, 1);
});

test("generated plugin exposes health helpers before split prefab function", () => {
  const code = fs.readFileSync(new URL("../code.js", import.meta.url), "utf8");
  assert.ok(code.indexOf("function createImageHealth") < code.indexOf("async function getPrefabImageHash"));
});

test("generated plugin exposes health helpers before plugin bootstrap", () => {
  const code = fs.readFileSync(new URL("../code.js", import.meta.url), "utf8");
  assert.ok(code.indexOf("function createImageHealth") < code.indexOf("figma.showUI"));
});
