import { isRecord } from "./utils.js";

export const CleanupPlanMarker = "[CLEANUP_PLAN_JSON]";

export interface CleanupSnapshotNodeV1 {
  id: string;
  parentId: string;
  type: string;
  name: string;
  siblingIndex: number;
  depth: number;
  [key: string]: unknown;
}

export interface CleanupSnapshotV1 {
  schemaVersion: 1;
  rootNodeId: string;
  nodes: CleanupSnapshotNodeV1[];
  [key: string]: unknown;
}

export interface CleanupPlanGroupV1 {
  name: string;
  parentNodeId: string;
  sourceNodeIds: string[];
  preserveSiblingOrder: true;
}

export interface CleanupComponentCandidateV1 {
  name: string;
  sourceNodeIds: string[];
  reason?: string;
}

export interface CleanupPlanV1 {
  schemaVersion: 1;
  rootNodeId: string;
  groups: CleanupPlanGroupV1[];
  componentCandidates: CleanupComponentCandidateV1[];
  warnings: string[];
}

const ForbiddenPlanFields = new Set(["applied", "commands", "toolCalls", "mutationResult"]);

export function extractCleanupPlan(text: string): unknown {
  const source = String(text || "");
  const markerCount = source.split(CleanupPlanMarker).length - 1;
  if (markerCount === 0) throw new Error("missing cleanup plan marker");
  if (markerCount !== 1) throw new Error("expected exactly one cleanup plan marker");
  const jsonText = source.slice(source.indexOf(CleanupPlanMarker) + CleanupPlanMarker.length).trim();
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`invalid cleanup plan JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateCleanupPlan(plan: unknown, snapshotValue: unknown): CleanupPlanV1 {
  rejectForbiddenPlanFields(plan);
  const snapshot = normalizeSnapshot(snapshotValue);
  if (!isRecord(plan)) throw new Error("cleanup plan must be an object");
  if (plan.schemaVersion !== 1) throw new Error("cleanup plan schemaVersion must be 1");
  const rootNodeId = requiredString(plan.rootNodeId, "cleanup plan rootNodeId");
  if (rootNodeId !== snapshot.rootNodeId) throw new Error("cleanup plan rootNodeId must match snapshot root");

  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const rootChildren = snapshot.nodes
    .filter((node) => node.parentId === snapshot.rootNodeId)
    .sort((left, right) => left.siblingIndex - right.siblingIndex);
  const rootChildIds = rootChildren.map((node) => node.id);
  if (!Array.isArray(plan.groups) || plan.groups.length === 0) throw new Error("cleanup plan groups must not be empty");

  const usedGroupNodeIds = new Set<string>();
  const flattenedGroupNodeIds: string[] = [];
  const groups = plan.groups.map((value, groupIndex) => {
    if (!isRecord(value)) throw new Error(`cleanup plan group ${groupIndex} must be an object`);
    const name = requiredString(value.name, `cleanup plan group ${groupIndex} name`);
    const parentNodeId = requiredString(value.parentNodeId, `cleanup plan group ${groupIndex} parentNodeId`);
    if (parentNodeId !== snapshot.rootNodeId) throw new Error("cleanup plan group parentNodeId must equal snapshot root");
    if (value.preserveSiblingOrder !== true) throw new Error("cleanup plan group preserveSiblingOrder must be true");
    const sourceNodeIds = stringArray(value.sourceNodeIds, "cleanup plan group sourceNodeIds");
    if (sourceNodeIds.length === 0) throw new Error("cleanup plan group sourceNodeIds must not be empty");

    let previousIndex = -1;
    for (const nodeId of sourceNodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) throw new Error(`unknown snapshot node ${nodeId}`);
      if (node.parentId !== parentNodeId) throw new Error(`node ${nodeId} is not a direct child of ${parentNodeId}`);
      if (usedGroupNodeIds.has(nodeId)) throw new Error(`node ${nodeId} appears in more than one group`);
      if (node.siblingIndex <= previousIndex) throw new Error("cleanup plan group sourceNodeIds must preserve sibling order");
      previousIndex = node.siblingIndex;
      usedGroupNodeIds.add(nodeId);
      flattenedGroupNodeIds.push(nodeId);
    }
    return { name, parentNodeId, sourceNodeIds, preserveSiblingOrder: true as const };
  });

  if (!sameStrings(flattenedGroupNodeIds, rootChildIds)) {
    throw new Error("cleanup plan groups must cover root direct children exactly once in sibling order");
  }

  const componentCandidates = normalizeComponentCandidates(plan.componentCandidates, nodeById);
  const warnings = stringArray(plan.warnings, "cleanup plan warnings", true);
  return { schemaVersion: 1, rootNodeId, groups, componentCandidates, warnings };
}

export function toPipelineRootPlan(plan: CleanupPlanV1, snapshotValue: CleanupSnapshotV1): object {
  const snapshot = normalizeSnapshot(snapshotValue);
  const snapshotIndex = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return {
    schemaVersion: 1,
    operation: "figma-hierarchy-cleanup",
    target: { nodeId: plan.rootNodeId },
    options: {
      preserveAbsoluteBoundsTolerance: 0.01,
      createGroupType: "FRAME",
      renameOriginalNodes: false,
      allowVisualChanges: false,
    },
    groups: plan.groups.map((group) => ({
      name: `[${group.name.replace(/^\[|\]$/g, "")}]`,
      childNodeIds: [...group.sourceNodeIds],
      sourceIndices: group.sourceNodeIds.map((id) => snapshotIndex.get(id)!.siblingIndex),
    })),
    warnings: [...plan.warnings],
    blockingErrors: [],
  };
}

function normalizeSnapshot(value: unknown): CleanupSnapshotV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.nodes)) {
    throw new Error("cleanup snapshot schemaVersion must be 1 with nodes");
  }
  const rootNodeId = requiredString(value.rootNodeId, "cleanup snapshot rootNodeId");
  const seen = new Set<string>();
  const nodes = value.nodes.map((node, index) => {
    if (!isRecord(node)) throw new Error(`cleanup snapshot node ${index} must be an object`);
    const id = requiredString(node.id, `cleanup snapshot node ${index} id`);
    if (seen.has(id)) throw new Error(`duplicate cleanup snapshot node ${id}`);
    seen.add(id);
    return {
      ...node,
      id,
      parentId: typeof node.parentId === "string" ? node.parentId : "",
      type: typeof node.type === "string" ? node.type : "",
      name: typeof node.name === "string" ? node.name : "",
      siblingIndex: finiteInteger(node.siblingIndex, `cleanup snapshot node ${id} siblingIndex`),
      depth: finiteInteger(node.depth, `cleanup snapshot node ${id} depth`),
    } as CleanupSnapshotNodeV1;
  });
  if (!seen.has(rootNodeId)) throw new Error("cleanup snapshot root node is missing");
  return { ...value, schemaVersion: 1, rootNodeId, nodes };
}

function normalizeComponentCandidates(value: unknown, nodeById: Map<string, CleanupSnapshotNodeV1>): CleanupComponentCandidateV1[] {
  if (!Array.isArray(value)) throw new Error("cleanup plan componentCandidates must be an array");
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`cleanup component candidate ${index} must be an object`);
    const name = requiredString(candidate.name, `cleanup component candidate ${index} name`);
    const sourceNodeIds = stringArray(candidate.sourceNodeIds, `cleanup component candidate ${index} sourceNodeIds`);
    if (sourceNodeIds.length === 0) throw new Error("cleanup component candidate sourceNodeIds must not be empty");
    for (const nodeId of sourceNodeIds) {
      if (!nodeById.has(nodeId)) throw new Error(`unknown snapshot node ${nodeId}`);
    }
    const reason = typeof candidate.reason === "string" && candidate.reason.trim() ? candidate.reason.trim() : undefined;
    return reason ? { name, sourceNodeIds, reason } : { name, sourceNodeIds };
  });
}

function rejectForbiddenPlanFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectForbiddenPlanFields);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (ForbiddenPlanFields.has(key)) throw new Error(`forbidden cleanup plan field ${key}`);
    rejectForbiddenPlanFields(child);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stringArray(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((item, index) => requiredString(item, `${label}[${index}]`));
  if (!allowEmpty && result.length === 0) throw new Error(`${label} must not be empty`);
  return result;
}

function finiteInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`);
  return number;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
