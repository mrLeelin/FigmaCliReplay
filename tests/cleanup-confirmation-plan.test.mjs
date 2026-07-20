import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCleanupConfirmationPlanFromDecision,
  compileCleanupConfirmationPlanToV3,
  validateCleanupConfirmationPlan,
} from "../dist/cleanupConfirmationPlan.js";
import { validateCleanupPlanV3 } from "../dist/cleanupPlan.js";

const snapshot = {
  schemaVersion: 1,
  rootNodeId: "R",
  nodes: [
    { id: "R", parentId: "", type: "FRAME", name: "Root", siblingIndex: 0, depth: 0 },
    { id: "A", parentId: "R", type: "RECTANGLE", name: "Background", siblingIndex: 0, depth: 1 },
    { id: "B", parentId: "R", type: "TEXT", name: "Title", siblingIndex: 1, depth: 1 },
    { id: "C", parentId: "R", type: "RECTANGLE", name: "Button", siblingIndex: 2, depth: 1 },
    { id: "D", parentId: "R", type: "TEXT", name: "ButtonText", siblingIndex: 3, depth: 1 },
    { id: "NESTED", parentId: "A", type: "RECTANGLE", name: "BackgroundImage", siblingIndex: 0, depth: 2 },
  ],
};

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    rootNodeId: "R",
    groups: [
      { name: "Header", parentNodeId: "R", sourceNodeIds: ["A", "B"], preserveSiblingOrder: true },
      { name: "Actions", parentNodeId: "R", sourceNodeIds: ["C", "D"], preserveSiblingOrder: true },
    ],
    assignments: [
      { nodeId: "A", nodeName: "Background", targetParent: "Header", targetSiblingIndex: 0 },
      { nodeId: "B", nodeName: "Title", targetParent: "Header", targetSiblingIndex: 1 },
      { nodeId: "C", nodeName: "Button", targetParent: "Actions", targetSiblingIndex: 0 },
      { nodeId: "D", nodeName: "ButtonText", targetParent: "Actions", targetSiblingIndex: 1 },
    ],
    componentCandidates: [],
    warnings: [],
    ...overrides,
  };
}

test("confirmation plan independently proves exact direct-child coverage and names", () => {
  const result = validateCleanupConfirmationPlan(plan(), snapshot);

  assert.deepEqual(result.summary, {
    beforeCount: 4,
    assignedCount: 4,
    missing: [],
    duplicate: [],
    extra: [],
    groupCount: 2,
  });
});

test("Relay compiles a validated confirmation plan into an exact nested V3 transaction", () => {
  const confirmationPlan = plan({
    groups: [{
      name: "Screen",
      parentNodeId: "R",
      sourceNodeIds: ["A", "B", "C", "D"],
      preserveSiblingOrder: true,
      subgroups: [
        { name: "Header", sourceNodeIds: ["A", "B"], preserveSiblingOrder: true },
        { name: "Actions", sourceNodeIds: ["C", "D"], preserveSiblingOrder: true },
      ],
    }],
    assignments: [
      { nodeId: "A", nodeName: "Background", targetParent: "Screen", targetSiblingIndex: 0 },
      { nodeId: "B", nodeName: "Title", targetParent: "Screen", targetSiblingIndex: 1 },
      { nodeId: "C", nodeName: "Button", targetParent: "Screen", targetSiblingIndex: 2 },
      { nodeId: "D", nodeName: "ButtonText", targetParent: "Screen", targetSiblingIndex: 3 },
    ],
  });

  const compiled = compileCleanupConfirmationPlanToV3(confirmationPlan, snapshot);

  assert.equal(compiled.schemaVersion, 3);
  assert.equal(compiled.rootNodeId, "R");
  assert.deepEqual(compiled.preconditions.map(({ nodeId }) => nodeId), ["A", "B", "C", "D"]);
  assert.deepEqual(compiled.operations.map(({ type, name }) => [type, name]), [
    ["CREATE_GROUP", "Screen"],
    ["CREATE_GROUP", "Header"],
    ["CREATE_GROUP", "Actions"],
  ]);
  assert.deepEqual(validateCleanupPlanV3(compiled, snapshot), compiled);
});

test("Relay refuses to compile a confirmation plan for another root", () => {
  assert.throws(
    () => compileCleanupConfirmationPlanToV3(plan({ rootNodeId: "OTHER" }), snapshot),
    /rootNodeId|根节点/i,
  );
});

test("confirmation plan preserves empty and whitespace-sensitive Figma node names", () => {
  const nameSnapshot = {
    schemaVersion: 1,
    rootNodeId: "R",
    nodes: [
      snapshot.nodes[0],
      { id: "A", parentId: "R", type: "RECTANGLE", name: "", siblingIndex: 0, depth: 1 },
      { id: "B", parentId: "R", type: "TEXT", name: " Title ", siblingIndex: 1, depth: 1 },
    ],
  };
  const namePlan = {
    schemaVersion: 1,
    rootNodeId: "R",
    groups: [{ name: "Content", parentNodeId: "R", sourceNodeIds: ["A", "B"], preserveSiblingOrder: true }],
    assignments: [
      { nodeId: "A", nodeName: "", targetParent: "Content", targetSiblingIndex: 0 },
      { nodeId: "B", nodeName: " Title ", targetParent: "Content", targetSiblingIndex: 1 },
    ],
    componentCandidates: [],
    warnings: [],
  };

  assert.equal(validateCleanupConfirmationPlan(namePlan, nameSnapshot).summary.assignedCount, 2);
});

test("confirmation plan rejects a descendant substituted for a root direct child", () => {
  const invalid = plan({
    groups: [
      { name: "Header", parentNodeId: "R", sourceNodeIds: ["A", "B"], preserveSiblingOrder: true },
      { name: "Actions", parentNodeId: "R", sourceNodeIds: ["C", "NESTED"], preserveSiblingOrder: true },
    ],
    assignments: [
      { nodeId: "A", nodeName: "Background", targetParent: "Header", targetSiblingIndex: 0 },
      { nodeId: "B", nodeName: "Title", targetParent: "Header", targetSiblingIndex: 1 },
      { nodeId: "C", nodeName: "Button", targetParent: "Actions", targetSiblingIndex: 0 },
      { nodeId: "NESTED", nodeName: "BackgroundImage", targetParent: "Actions", targetSiblingIndex: 1 },
    ],
  });

  assert.throws(() => validateCleanupConfirmationPlan(invalid, snapshot), /直接子节点|完整覆盖/);
});

test("confirmation plan rejects single-child groups", () => {
  const invalid = plan({
    groups: [
      { name: "Header", parentNodeId: "R", sourceNodeIds: ["A", "B", "C"], preserveSiblingOrder: true },
      { name: "HiddenElements", parentNodeId: "R", sourceNodeIds: ["D"], preserveSiblingOrder: true },
    ],
    assignments: [
      { nodeId: "A", nodeName: "Background", targetParent: "Header", targetSiblingIndex: 0 },
      { nodeId: "B", nodeName: "Title", targetParent: "Header", targetSiblingIndex: 1 },
      { nodeId: "C", nodeName: "Button", targetParent: "Header", targetSiblingIndex: 2 },
      { nodeId: "D", nodeName: "ButtonText", targetParent: "HiddenElements", targetSiblingIndex: 0 },
    ],
  });

  assert.throws(() => validateCleanupConfirmationPlan(invalid, snapshot), /单子节点分组/);
});

test("confirmation plan rejects large leaf groups until they are structurally expanded", () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({
    id: `N${index}`,
    parentId: "R",
    type: "RECTANGLE",
    name: `Node${index}`,
    siblingIndex: index,
    depth: 1,
  }));
  const largeSnapshot = { schemaVersion: 1, rootNodeId: "R", nodes: [snapshot.nodes[0], ...nodes] };
  const ids = nodes.map((node) => node.id);
  const assignments = nodes.map((node, index) => ({
    nodeId: node.id,
    nodeName: node.name,
    targetParent: "MapSelection",
    targetSiblingIndex: index,
  }));
  const largePlan = {
    schemaVersion: 1,
    rootNodeId: "R",
    groups: [{ name: "MapSelection", parentNodeId: "R", sourceNodeIds: ids, preserveSiblingOrder: true }],
    assignments,
    componentCandidates: [],
    warnings: [],
  };

  assert.throws(() => validateCleanupConfirmationPlan(largePlan, largeSnapshot), /大分组.*subgroups/);

  largePlan.groups[0].subgroups = [
    { name: "MapButtons", sourceNodeIds: ids.slice(0, 6), preserveSiblingOrder: true },
    { name: "Progress", sourceNodeIds: ids.slice(6), preserveSiblingOrder: true },
  ];
  assert.equal(validateCleanupConfirmationPlan(largePlan, largeSnapshot).summary.assignedCount, 12);
});

test("Relay deterministically expands compact contiguous decisions into the authoritative artifact", () => {
  const nodes = Array.from({ length: 14 }, (_, index) => ({
    id: `N${index}`,
    parentId: "R",
    type: index % 2 === 0 ? "RECTANGLE" : "TEXT",
    name: index === 0 ? "" : index === 1 ? " Title " : `Node${index}`,
    siblingIndex: index,
    depth: 1,
  }));
  const largeSnapshot = { schemaVersion: 1, rootNodeId: "R", nodes: [snapshot.nodes[0], ...nodes] };
  const decision = {
    schemaVersion: 1,
    rootNodeId: "R",
    groups: [{
      name: "MissionCards",
      count: 14,
      startNodeId: "N0",
      endNodeId: "N13",
      subgroups: [
        { name: "CardBackgrounds", count: 6, startNodeId: "N0", endNodeId: "N5" },
        { name: "CardContents", count: 8, startNodeId: "N6", endNodeId: "N13" },
      ],
    }],
    componentCandidates: [],
    warnings: ["Review component candidates after hierarchy verification."],
  };

  const built = buildCleanupConfirmationPlanFromDecision(decision, largeSnapshot);

  assert.deepEqual(built.groups[0].sourceNodeIds, nodes.map((node) => node.id));
  assert.deepEqual(built.groups[0].subgroups.map((group) => group.sourceNodeIds), [
    nodes.slice(0, 6).map((node) => node.id),
    nodes.slice(6).map((node) => node.id),
  ]);
  assert.deepEqual(built.assignments.slice(0, 2), [
    { nodeId: "N0", nodeName: "", targetParent: "MissionCards", targetSiblingIndex: 0 },
    { nodeId: "N1", nodeName: " Title ", targetParent: "MissionCards", targetSiblingIndex: 1 },
  ]);
  assert.equal(validateCleanupConfirmationPlan(built, largeSnapshot).summary.assignedCount, 14);
});

test("compact decision rejects incomplete direct-child counts before an artifact is written", () => {
  const decision = {
    schemaVersion: 1,
    rootNodeId: "R",
    groups: [
      { name: "Header", count: 2, startNodeId: "A", endNodeId: "B" },
      { name: "Actions", count: 3, startNodeId: "C", endNodeId: "D" },
    ],
    componentCandidates: [],
    warnings: [],
  };

  assert.throws(
    () => buildCleanupConfirmationPlanFromDecision(decision, snapshot),
    /groups total count=5.*authoritative directChildCount=4/,
  );
});

test("compact decision rejects a shifted semantic boundary even when total counts still match", () => {
  const decision = {
    schemaVersion: 1,
    rootNodeId: "R",
    groups: [
      { name: "Header", count: 2, startNodeId: "A", endNodeId: "C" },
      { name: "Actions", count: 2, startNodeId: "C", endNodeId: "D" },
    ],
    componentCandidates: [],
    warnings: [],
  };

  assert.throws(
    () => buildCleanupConfirmationPlanFromDecision(decision, snapshot),
    /group Header boundary mismatch.*expectedEndNodeId=C.*actualEndNodeId=B/,
  );
});

test("compact decision requires explicit start and end anchors for every semantic group", () => {
  const decision = {
    schemaVersion: 1,
    rootNodeId: "R",
    groups: [
      { name: "Header", count: 2 },
      { name: "Actions", count: 2, startNodeId: "C", endNodeId: "D" },
    ],
    componentCandidates: [],
    warnings: [],
  };

  assert.throws(
    () => buildCleanupConfirmationPlanFromDecision(decision, snapshot),
    /groups\[0\]\.startNodeId/,
  );
});

test("ordered coverage errors identify the first mismatched node instead of only empty set differences", () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({
    id: `N${index}`,
    parentId: "R",
    type: "RECTANGLE",
    name: `Node${index}`,
    siblingIndex: index,
    depth: 1,
  }));
  const largeSnapshot = { schemaVersion: 1, rootNodeId: "R", nodes: [snapshot.nodes[0], ...nodes] };
  const ids = nodes.map((node) => node.id);
  const interleaved = {
    schemaVersion: 1,
    rootNodeId: "R",
    groups: [{
      name: "Cards",
      parentNodeId: "R",
      sourceNodeIds: ids,
      preserveSiblingOrder: true,
      subgroups: [
        { name: "Even", sourceNodeIds: ids.filter((_, index) => index % 2 === 0), preserveSiblingOrder: true },
        { name: "Odd", sourceNodeIds: ids.filter((_, index) => index % 2 === 1), preserveSiblingOrder: true },
      ],
    }],
    assignments: nodes.map((node, index) => ({
      nodeId: node.id,
      nodeName: node.name,
      targetParent: "Cards",
      targetSiblingIndex: index,
    })),
    componentCandidates: [],
    warnings: [],
  };

  assert.throws(
    () => validateCleanupConfirmationPlan(interleaved, largeSnapshot),
    /firstMismatchIndex=1.*expected=N1.*actual=N2/,
  );
});
