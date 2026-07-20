import assert from "node:assert/strict";
import test from "node:test";

import {
  computeCleanupSnapshotHash,
  toFigmaCleanupTransactionPlan,
  validateCleanupPlanV3,
} from "../dist/cleanupPlan.js";
import {
  CleanupSkillDecisionMarker,
  buildCleanupSkillDecisionTask,
  compileSkillConstrainedCleanupPlan,
  extractCleanupSkillDecision,
} from "../dist/cleanup/skillConstrainedPlan.js";

const snapshot = {
  schemaVersion: 1,
  rootNodeId: "R",
  nodes: [
    { id: "R", parentId: "", type: "FRAME", name: "Root", siblingIndex: 0, depth: 0 },
    { id: "A", parentId: "R", type: "RECTANGLE", name: "Background", siblingIndex: 0, depth: 1, x: 0, y: 0, w: 100, h: 100 },
    { id: "B", parentId: "R", type: "TEXT", name: "Title", siblingIndex: 1, depth: 1, x: 10, y: 10, w: 80, h: 20 },
    { id: "C", parentId: "R", type: "RECTANGLE", name: "ButtonBackground", siblingIndex: 2, depth: 1, x: 10, y: 60, w: 80, h: 24 },
    { id: "D", parentId: "R", type: "TEXT", name: "ButtonText", siblingIndex: 3, depth: 1, x: 30, y: 64, w: 40, h: 12 },
    { id: "NESTED", parentId: "A", type: "TEXT", name: "Nested detail", siblingIndex: 0, depth: 2, x: 5, y: 5, w: 20, h: 10 },
  ],
};

function decision(overrides = {}) {
  return {
    schemaVersion: 1,
    rootNodeId: "R",
    snapshotHash: computeCleanupSnapshotHash(snapshot),
    tree: [
      {
        name: "Screen",
        endExclusive: 4,
        children: [
          { name: "Header", endExclusive: 2, children: [] },
          { name: "Actions", endExclusive: 4, children: [] },
        ],
      },
    ],
    warnings: [],
    ...overrides,
  };
}

test("skill decision output cannot reference a nested snapshot node", () => {
  const task = buildCleanupSkillDecisionTask(snapshot, "claude-code");
  assert.match(task, /endExclusive/i);
  assert.match(task, /direct child sequence/i);
  assert.doesNotMatch(task, /NESTED/);
  assert.doesNotMatch(task, /\"id\":\"A\"/);
  assert.match(task, /\"width\":100/);
  assert.match(task, /\"height\":100/);
});

test("compiles a range-only skill decision into an ordered V3 transaction", () => {
  const compiled = compileSkillConstrainedCleanupPlan(decision(), snapshot);

  assert.equal(compiled.schemaVersion, 3);
  assert.deepEqual(compiled.operations, [
    { id: "op-001", type: "CREATE_GROUP", parentNodeId: "R", name: "[Screen]", childNodeIds: ["A", "B", "C", "D"] },
    { id: "op-002", type: "CREATE_GROUP", parentOperationId: "op-001", name: "[Header]", childNodeIds: ["A", "B"] },
    { id: "op-003", type: "CREATE_GROUP", parentOperationId: "op-001", name: "[Actions]", childNodeIds: ["C", "D"] },
  ]);
  assert.deepEqual(compiled.preconditions, [
    { nodeId: "A", parentNodeId: "R", siblingIndex: 0 },
    { nodeId: "B", parentNodeId: "R", siblingIndex: 1 },
    { nodeId: "C", parentNodeId: "R", siblingIndex: 2 },
    { nodeId: "D", parentNodeId: "R", siblingIndex: 3 },
  ]);
  assert.equal(compiled.operations.some((operation) => operation.childNodeIds.includes("NESTED")), false);
  assert.deepEqual(validateCleanupPlanV3(compiled, snapshot), compiled);
  assert.deepEqual(toFigmaCleanupTransactionPlan(compiled, snapshot), {
    schemaVersion: 3,
    operation: "figma-hierarchy-cleanup-transaction",
    target: { nodeId: "R", snapshotHash: compiled.snapshotHash },
    operations: compiled.operations,
    verification: compiled.verification,
    createBackup: false,
  });
});

test("rejects generic skill-decision names before any transaction is created", () => {
  assert.throws(
    () => compileSkillConstrainedCleanupPlan(decision({ tree: [{ name: "UI Layer Set 1", endExclusive: 4, children: [] }] }), snapshot),
    /generic.*group name|通用分组名/i,
  );
});

test("extracts exactly one marked skill decision", () => {
  const value = decision();
  assert.deepEqual(extractCleanupSkillDecision(`${CleanupSkillDecisionMarker}\n${JSON.stringify(value)}`), value);
  assert.throws(() => extractCleanupSkillDecision(JSON.stringify(value)), /skill decision marker|技能决策标记/i);
});

test("extracts the first marked skill decision when the provider appends harmless prose", () => {
  const value = decision();
  const response = `${CleanupSkillDecisionMarker}\n${JSON.stringify(value, null, 2)}\nDecision completed; no Figma writes were performed.`;

  assert.deepEqual(extractCleanupSkillDecision(response), value);
});
