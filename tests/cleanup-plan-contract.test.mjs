import assert from "node:assert/strict";
import test from "node:test";

import {
  CleanupPlanMarker,
  computeCleanupSnapshotHash,
  extractCleanupPlan,
  toFigmaCleanupTransactionPlan,
  toPipelineRootPlan,
  validateCleanupPlan,
  validateCleanupPlanV2,
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

const v2Snapshot = {
  ...snapshot,
  nodes: [
    ...snapshot.nodes,
    { id: "E", parentId: "R", type: "FRAME", name: "E", siblingIndex: 3, depth: 1 },
  ],
};

function validV2Plan(overrides = {}) {
  return {
    schemaVersion: 2,
    rootNodeId: "R",
    snapshotHash: computeCleanupSnapshotHash(v2Snapshot),
    operations: [
      { id: "group-hud", type: "CREATE_GROUP", parentNodeId: "R", name: "HUD", childNodeIds: ["A", "B"] },
      { id: "group-actions", type: "CREATE_GROUP", parentNodeId: "R", name: "Actions", childNodeIds: ["C", "E"] },
    ],
    preconditions: [],
    verification: { preserveAbsoluteBoundsTolerance: 0.01 },
    warnings: [],
    ...overrides,
  };
}

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
  assert.throws(() => extractCleanupPlan(JSON.stringify(plan)), /缺少清理计划标记/);
  assert.throws(
    () => extractCleanupPlan(`${CleanupPlanMarker}\n{}\n${CleanupPlanMarker}\n{}`),
    /期望恰好一个清理计划标记/,
  );
  assert.throws(() => extractCleanupPlan(`${CleanupPlanMarker}\n{broken`), /无效的清理计划 JSON/);
});

test("extracts a marked cleanup plan wrapped in one JSON code fence", () => {
  const plan = validPlan();
  const fencedPlan = `${CleanupPlanMarker}\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
  assert.deepEqual(extractCleanupPlan(fencedPlan), plan);
  assert.throws(
    () => extractCleanupPlan(`${fencedPlan}\nAdditional explanation`),
    /无效的清理计划 JSON/,
  );
});

test("normalizes a valid plan and drops unknown display fields", () => {
  const plan = validPlan({ commentary: "ignored" });
  const validated = validateCleanupPlan(plan, snapshot);
  assert.deepEqual(validated, validPlan());
  assert.equal(Object.prototype.hasOwnProperty.call(validated, "commentary"), false);
});

test("rejects root mismatch and foreign references", () => {
  assert.throws(() => validateCleanupPlan(validPlan({ rootNodeId: "OTHER" }), snapshot), /rootNodeId 必须与快照根节点匹配/);
  const foreignGroup = validPlan();
  foreignGroup.groups[1].sourceNodeIds = ["FOREIGN"];
  assert.throws(() => validateCleanupPlan(foreignGroup, snapshot), /未知的快照节点 FOREIGN/);
  const foreignCandidate = validPlan();
  foreignCandidate.componentCandidates[0].sourceNodeIds = ["FOREIGN"];
  assert.throws(() => validateCleanupPlan(foreignCandidate, snapshot), /未知的快照节点 FOREIGN/);
});

test("rejects duplicate, incomplete, and reordered root child coverage", () => {
  const duplicate = validPlan();
  duplicate.groups[1].sourceNodeIds = ["B", "C"];
  assert.throws(() => validateCleanupPlan(duplicate, snapshot), /节点 B 出现在多个分组中/);

  const incomplete = validPlan();
  incomplete.groups[1].sourceNodeIds = [];
  assert.throws(() => validateCleanupPlan(incomplete, snapshot), /sourceNodeIds 不能为空|完整覆盖根节点/);

  const reordered = validPlan();
  reordered.groups[0].sourceNodeIds = ["B", "A"];
  assert.throws(() => validateCleanupPlan(reordered, snapshot), /sourceNodeIds 必须保持兄弟节点顺序/);
});

test("rejects a source under the wrong or unsupported parent", () => {
  const wrongParent = validPlan();
  wrongParent.groups[0].sourceNodeIds = ["D"];
  assert.throws(() => validateCleanupPlan(wrongParent, snapshot), /节点 D 不是 R 的直接子节点/);

  const nestedParent = validPlan();
  nestedParent.groups[0] = { name: "Nested", parentNodeId: "A", sourceNodeIds: ["D"], preserveSiblingOrder: true };
  assert.throws(() => validateCleanupPlan(nestedParent, snapshot), /parentNodeId 必须等于快照根节点/);
});

test("rejects mutation authority embedded in AI output", () => {
  for (const field of ["applied", "commands", "toolCalls", "mutationResult"]) {
    assert.throws(
      () => validateCleanupPlan(validPlan({ [field]: field === "applied" ? true : [] }), snapshot),
      new RegExp(`禁止的清理计划字段 ${field}`),
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

test("validates an exact V2 hierarchy plan and canonical snapshot hash", () => {
  const plan = validV2Plan();
  assert.match(plan.snapshotHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateCleanupPlanV2(plan, v2Snapshot), plan);
  assert.throws(
    () => validateCleanupPlanV2({ ...plan, snapshotHash: "0".repeat(64) }, v2Snapshot),
    /快照哈希/,
  );
});

test("rejects a V2 plan that only renames original nodes", () => {
  const renameOnly = {
    ...validV2Plan(),
    operations: [
      { id: "rename-a", type: "RENAME_NODE", nodeId: "A", name: "Background_Image" },
      { id: "rename-b", type: "RENAME_NODE", nodeId: "B", name: "Title_Text" },
    ],
  };

  assert.throws(
    () => validateCleanupPlanV2(renameOnly, v2Snapshot),
    /must create semantic groups instead of only renaming original nodes/i,
  );
});

test("rejects component writes, duplicate operation ids, and redundant wrappers", () => {
  const plan = validV2Plan();
  assert.throws(
    () => validateCleanupPlanV2({ ...plan, operations: [{ id: "component", type: "CREATE_COMPONENT", nodeId: "A" }] }, v2Snapshot),
    /不支持的清理操作/,
  );
  assert.throws(
    () => validateCleanupPlanV2({ ...plan, operations: [plan.operations[0], { ...plan.operations[1], id: plan.operations[0].id }] }, v2Snapshot),
    /重复的清理操作 id/,
  );
  const alreadyWrapped = {
    ...v2Snapshot,
    nodes: v2Snapshot.nodes.map((node) => node.id === "A" ? { ...node, name: "[Background]" } : node),
  };
  assert.throws(
    () => validateCleanupPlanV2({
      ...plan,
      snapshotHash: computeCleanupSnapshotHash(alreadyWrapped),
      operations: [{ id: "wrapper", type: "CREATE_GROUP", parentNodeId: "R", name: "Background", childNodeIds: ["A"] }],
    }, alreadyWrapped),
    /不允许单子节点分组|冗余/,
  );
});

test("accepts an explicit no-op only for an already organized root", () => {
  const organized = {
    ...v2Snapshot,
    nodes: v2Snapshot.nodes.map((node) => node.parentId === "R" ? { ...node, name: `[${node.name}]` } : node),
  };
  const noOp = {
    ...validV2Plan(),
    snapshotHash: computeCleanupSnapshotHash(organized),
    operations: [],
  };
  assert.deepEqual(validateCleanupPlanV2(noOp, organized), noOp);
  assert.throws(
    () => validateCleanupPlanV2({ ...validV2Plan(), operations: [] }, v2Snapshot),
    /no-op.*already organized/i,
  );
});

test("adapts V2 without adding post-approval operations", () => {
  const plan = validateCleanupPlanV2(validV2Plan(), v2Snapshot);
  assert.deepEqual(toFigmaCleanupTransactionPlan(plan, v2Snapshot), {
    schemaVersion: 2,
    operation: "figma-hierarchy-cleanup-transaction",
    target: { nodeId: "R", snapshotHash: plan.snapshotHash },
    operations: plan.operations,
    verification: plan.verification,
    createBackup: false,
  });
});
