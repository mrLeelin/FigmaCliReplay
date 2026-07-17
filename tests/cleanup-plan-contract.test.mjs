import assert from "node:assert/strict";
import test from "node:test";

import {
  CleanupPlanMarker,
  extractCleanupPlan,
  toPipelineRootPlan,
  validateCleanupPlan,
} from "../dist/cleanupPlan.js";

const snapshot = {
  schemaVersion: 1,
  rootNodeId: "R",
  capturedAt: "2026-07-17T06:30:00.000Z",
  limits: { maxNodes: 500, maxDepth: 12, maxTextCharacters: 256, maxBytes: 262144 },
  nodes: [
    { id: "R", parentId: "", type: "FRAME", name: "Root", siblingIndex: 0, depth: 0 },
    { id: "A", parentId: "R", type: "FRAME", name: "A", siblingIndex: 0, depth: 1 },
    { id: "B", parentId: "R", type: "FRAME", name: "B", siblingIndex: 1, depth: 1 },
    { id: "C", parentId: "R", type: "FRAME", name: "C", siblingIndex: 2, depth: 1 },
    { id: "D", parentId: "A", type: "TEXT", name: "D", siblingIndex: 0, depth: 2 },
  ],
};

function validPlan(overrides = {}) {
  return {
    schemaVersion: 1,
    rootNodeId: "R",
    groups: [
      { name: "TopHUD", parentNodeId: "R", sourceNodeIds: ["A", "B"], preserveSiblingOrder: true },
      { name: "BottomActions", parentNodeId: "R", sourceNodeIds: ["C"], preserveSiblingOrder: true },
    ],
    componentCandidates: [{ name: "Title", sourceNodeIds: ["D"], reason: "Repeated title style" }],
    warnings: ["One ambiguous decorative layer"],
    ...overrides,
  };
}

test("extracts exactly one marked cleanup plan", () => {
  const plan = validPlan();
  assert.deepEqual(extractCleanupPlan(`${CleanupPlanMarker}\n${JSON.stringify(plan)}`), plan);
  assert.throws(() => extractCleanupPlan(JSON.stringify(plan)), /missing cleanup plan marker/i);
  assert.throws(
    () => extractCleanupPlan(`${CleanupPlanMarker}\n{}\n${CleanupPlanMarker}\n{}`),
    /exactly one cleanup plan marker/i,
  );
  assert.throws(() => extractCleanupPlan(`${CleanupPlanMarker}\n{broken`), /invalid cleanup plan JSON/i);
});

test("normalizes a valid plan and drops unknown display fields", () => {
  const plan = validPlan({ commentary: "ignored" });
  const validated = validateCleanupPlan(plan, snapshot);
  assert.deepEqual(validated, validPlan());
  assert.equal(Object.prototype.hasOwnProperty.call(validated, "commentary"), false);
});

test("rejects root mismatch and foreign references", () => {
  assert.throws(() => validateCleanupPlan(validPlan({ rootNodeId: "OTHER" }), snapshot), /rootNodeId must match snapshot root/i);
  const foreignGroup = validPlan();
  foreignGroup.groups[1].sourceNodeIds = ["FOREIGN"];
  assert.throws(() => validateCleanupPlan(foreignGroup, snapshot), /unknown snapshot node FOREIGN/i);
  const foreignCandidate = validPlan();
  foreignCandidate.componentCandidates[0].sourceNodeIds = ["FOREIGN"];
  assert.throws(() => validateCleanupPlan(foreignCandidate, snapshot), /unknown snapshot node FOREIGN/i);
});

test("rejects duplicate, incomplete, and reordered root child coverage", () => {
  const duplicate = validPlan();
  duplicate.groups[1].sourceNodeIds = ["B", "C"];
  assert.throws(() => validateCleanupPlan(duplicate, snapshot), /node B appears in more than one group/i);

  const incomplete = validPlan();
  incomplete.groups[1].sourceNodeIds = [];
  assert.throws(() => validateCleanupPlan(incomplete, snapshot), /group sourceNodeIds must not be empty|root direct children exactly once/i);

  const reordered = validPlan();
  reordered.groups[0].sourceNodeIds = ["B", "A"];
  assert.throws(() => validateCleanupPlan(reordered, snapshot), /sourceNodeIds must preserve sibling order/i);
});

test("rejects a source under the wrong or unsupported parent", () => {
  const wrongParent = validPlan();
  wrongParent.groups[0].sourceNodeIds = ["D"];
  assert.throws(() => validateCleanupPlan(wrongParent, snapshot), /node D is not a direct child of R/i);

  const nestedParent = validPlan();
  nestedParent.groups[0] = { name: "Nested", parentNodeId: "A", sourceNodeIds: ["D"], preserveSiblingOrder: true };
  assert.throws(() => validateCleanupPlan(nestedParent, snapshot), /group parentNodeId must equal snapshot root/i);
});

test("rejects mutation authority embedded in AI output", () => {
  for (const field of ["applied", "commands", "toolCalls", "mutationResult"]) {
    assert.throws(
      () => validateCleanupPlan(validPlan({ [field]: field === "applied" ? true : [] }), snapshot),
      new RegExp(`forbidden cleanup plan field ${field}`, "i"),
    );
  }
});

test("adapts the validated contract to the existing root pipeline plan", () => {
  const plan = validateCleanupPlan(validPlan(), snapshot);
  assert.deepEqual(toPipelineRootPlan(plan, snapshot), {
    schemaVersion: 1,
    operation: "figma-hierarchy-cleanup",
    target: { nodeId: "R" },
    options: {
      preserveAbsoluteBoundsTolerance: 0.01,
      createGroupType: "FRAME",
      renameOriginalNodes: false,
      allowVisualChanges: false,
    },
    groups: [
      { name: "[TopHUD]", childNodeIds: ["A", "B"], sourceIndices: [0, 1] },
      { name: "[BottomActions]", childNodeIds: ["C"], sourceIndices: [2] },
    ],
    warnings: ["One ambiguous decorative layer"],
    blockingErrors: [],
  });
});
