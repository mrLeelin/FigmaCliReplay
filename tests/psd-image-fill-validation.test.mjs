import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../code/05_utils.js", import.meta.url), "utf8");

function functionSource(name) {
  const header = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(header, `missing runtime function ${name}`);
  const afterHeader = header.index + header[0].length;
  const next = /\n(?:async )?function [A-Za-z]/.exec(source.slice(afterHeader));
  return source.slice(header.index, next ? afterHeader + next.index : undefined);
}

async function validateLayer(mode, node) {
  const layer = { idx: 1, mode, slices: mode === "nine-slice" ? [{}, {}, {}] : undefined };
  const root = { children: [node] };
  const context = { nodeByLayerIdx: new Map([["1", "1:1"]]), errors: [] };
  const sandbox = {
    figma: { getNodeByIdAsync: async () => node },
    countIndexOrderProblems: () => 0,
    validateLayerGeometry() {},
    countBadTransforms: () => 0,
    validateSliceFrame: () => 0,
  };
  vm.createContext(sandbox);
  const names = [
    "validateImportedRoot", "countEmptyImageFills", "hasEmptyImageFill",
    "hasNineSliceSourceFill", "buildFinalStatus", "numericOr",
  ];
  vm.runInContext(names.map(functionSource).join("\n"), sandbox);
  const validation = await sandbox.validateImportedRoot(root, [layer], context);
  validation.screenshotExported = true;
  return { validation, status: sandbox.buildFinalStatus(context, validation) };
}

test("initial import rejects an expected image rectangle with absent or malformed image fill", async () => {
  for (const fills of [[], [{ type: "SOLID" }], [{ type: "IMAGE", imageHash: null }],
    [{ type: "IMAGE", imageHash: " " }], [{ type: "IMAGE", imageHash: 123 }]]) {
    const { validation, status } = await validateLayer("image", { type: "RECTANGLE", fills });
    assert.equal(validation.missingNodeCount, 0);
    assert.equal(validation.emptyImageFillCount, 1, JSON.stringify(fills));
    assert.equal(status, "completed_with_errors");
  }
});

test("the image gate distinguishes a common raster fallback, an instance, and a missing slice source", async () => {
  const image = { type: "IMAGE", imageHash: "image-hash" };
  const valid = await validateLayer("image", { type: "RECTANGLE", fills: [image] });
  assert.equal(valid.status, "completed");
  const fallback = await validateLayer("common-component", { type: "RECTANGLE", fills: [] });
  assert.equal(fallback.validation.emptyImageFillCount, 1);
  const instance = await validateLayer("common-component", {
    type: "INSTANCE", fills: [], children: [{ type: "RECTANGLE", fills: [{ type: "SOLID" }] }],
  });
  assert.equal(instance.status, "completed");
  const nineSlice = await validateLayer("nine-slice", {
    type: "FRAME", fills: [],
    children: Array.from({ length: 3 }, (_, i) => ({ name: `__slice_${i}`, fills: [image] })),
  });
  assert.equal(nineSlice.validation.emptyImageFillCount, 0);
  assert.equal(nineSlice.validation.missingSliceSourceFillCount, 1);
});
