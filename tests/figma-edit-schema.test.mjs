import assert from "node:assert/strict";
import test from "node:test";

import { MAX_EDITS_PER_BATCH, validateFigmaEditJob } from "../dist/figmaEditSchema.js";

const apply = (job) => validateFigmaEditJob("FIGMA_APPLY_EDITS", job);
const inspect = (job) => validateFigmaEditJob("FIGMA_INSPECT_NODES", job);

test("other job types are not handled by the design edit schema", () => {
  assert.equal(validateFigmaEditJob("RESIZE_NODE", { nodeId: "1:2" }), undefined);
});

test("a valid mixed batch passes and reports op counts", () => {
  const result = apply({
    edits: [
      { op: "setFill", nodeId: "1:2", color: "#FF6600", opacity: 1 },
      { op: "setText", nodeId: "1:3", characters: "购买" },
      { op: "createFrame", parentId: "1:1", tempId: "card", name: "Card", width: 200, height: 100 },
      { op: "setAutoLayout", nodeId: "temp:card", mode: "VERTICAL", itemSpacing: 8, padding: { top: 12, left: 16 } },
      { op: "createText", parentId: "temp:card", tempId: "title", characters: "标题", fontSize: 18 },
      { op: "bindVariable", nodeId: "temp:card", field: "itemSpacing", variableId: "VariableID:12:34" },
      { op: "setInstanceProperties", nodeId: "I5:6;7:8", properties: { "State": "Active", "Show icon#1:2": true } },
    ],
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.editCount, 7);
  assert.equal(result.job.dryRun, false);
  assert.equal(result.opCounts.setFill, 1);
  assert.equal(result.opCounts.createText, 1);
});

test("dryRun is preserved", () => {
  const result = apply({ dryRun: true, edits: [{ op: "setVisible", nodeId: "1:2", visible: false }] });
  assert.equal(result.ok, true);
  assert.equal(result.job.dryRun, true);
});

function rejected(job, pattern) {
  const result = apply(job);
  assert.equal(result.ok, false, "expected rejection");
  assert.match(result.message, pattern);
  return result;
}

test("unknown ops and extra fields are rejected", () => {
  rejected({ edits: [{ op: "runScript", nodeId: "1:2", code: "x" }] }, /edits\.0\.op/);
  rejected({ edits: [{ op: "setOpacity", nodeId: "1:2", opacity: 0.5, script: "x" }] }, /Unrecognized key/);
  rejected({ edits: [{ op: "setOpacity", nodeId: "1:2", opacity: 0.5 }], code: "x" }, /Unrecognized key/);
});

test("value formats and ranges are enforced", () => {
  rejected({ edits: [{ op: "setFill", nodeId: "1:2", color: "red" }] }, /edits\.0\.color: color must be #RRGGBB/);
  rejected({ edits: [{ op: "setOpacity", nodeId: "1:2", opacity: 2 }] }, /edits\.0\.opacity/);
  rejected({ edits: [{ op: "setOpacity", nodeId: "not-a-node", opacity: 1 }] }, /edits\.0\.nodeId/);
  rejected({ edits: [{ op: "bindVariable", nodeId: "1:2", field: "characters", variableId: "VariableID:1:2" }] }, /edits\.0\.field/);
  rejected({ edits: [{ op: "setText", nodeId: "1:2", characters: "x".repeat(5001) }] }, /edits\.0\.characters/);
});

test("batch size limits are enforced", () => {
  rejected({ edits: [] }, /edits/);
  const tooMany = Array.from({ length: MAX_EDITS_PER_BATCH + 1 }, (_, index) => ({ op: "setOpacity", nodeId: `1:${index + 1}`, opacity: 1 }));
  rejected({ edits: tooMany }, /edits/);
});

test("the same property of the same node cannot change twice in one batch", () => {
  rejected({
    edits: [
      { op: "setFill", nodeId: "1:2", color: "#000000" },
      { op: "setFill", nodeId: "1:2", color: "#FFFFFF" },
    ],
  }, /edits\.1: fills of 1:2 is already changed by edit 0/);
  const different = apply({
    edits: [
      { op: "setFill", nodeId: "1:2", color: "#000000" },
      { op: "setOpacity", nodeId: "1:2", opacity: 0.5 },
    ],
  });
  assert.equal(different.ok, true, different.message);
});

test("temp references must point at an earlier create op", () => {
  rejected({ edits: [{ op: "setOpacity", nodeId: "temp:later", opacity: 1 }] }, /references temp:later before it is created/);
  rejected({
    edits: [
      { op: "createFrame", parentId: "1:1", tempId: "a", name: "A", width: 10, height: 10 },
      { op: "createFrame", parentId: "1:1", tempId: "a", name: "B", width: 10, height: 10 },
    ],
  }, /duplicate tempId a/);
});

test("ops that need at least one field reject empty bodies", () => {
  rejected({ edits: [{ op: "setTextStyle", nodeId: "1:2" }] }, /setTextStyle requires at least one field/);
  rejected({ edits: [{ op: "setLayoutSizing", nodeId: "1:2" }] }, /setLayoutSizing requires horizontal or vertical/);
});

test("inspect validates node ids, depth and applies defaults", () => {
  const ok = inspect({ nodeIds: ["1:2", "I3:4;5:6"] });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.job.depth, 1);
  assert.equal(ok.job.includeText, true);
  assert.equal(inspect({ nodeIds: [] }).ok, false);
  assert.equal(inspect({ nodeIds: ["1:2"], depth: 4 }).ok, false);
  assert.equal(inspect({ nodeIds: ["1:2"], extra: true }).ok, false);
});
