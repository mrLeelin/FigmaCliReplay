import { createHash } from "node:crypto";

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

export type CleanupOperationV2 =
  | { id: string; type: "CREATE_GROUP"; parentNodeId: string; name: string; childNodeIds: string[] }
  | { id: string; type: "RENAME_NODE"; nodeId: string; name: string }
  | { id: string; type: "MOVE_NODE"; nodeId: string; parentNodeId: string; index: number }
  | { id: string; type: "REORDER_CHILDREN"; parentNodeId: string; childNodeIds: string[] }
  | {
      id: string;
      type: "SET_AUTO_LAYOUT";
      nodeId: string;
      layoutMode: "HORIZONTAL" | "VERTICAL";
      itemSpacing: number;
      paddingTop: number;
      paddingRight: number;
      paddingBottom: number;
      paddingLeft: number;
    };

export interface CleanupPreconditionV2 {
  nodeId: string;
  parentNodeId: string;
  siblingIndex: number;
}

export interface CleanupPlanV2 {
  schemaVersion: 2;
  rootNodeId: string;
  snapshotHash: string;
  operations: CleanupOperationV2[];
  preconditions: CleanupPreconditionV2[];
  verification: { preserveAbsoluteBoundsTolerance: number };
  warnings: string[];
}

const ForbiddenPlanFields = new Set(["applied", "commands", "toolCalls", "mutationResult"]);

export function extractCleanupPlan(text: string): unknown {
  const source = String(text || "");
  const markerCount = source.split(CleanupPlanMarker).length - 1;
  if (markerCount === 0) throw new Error("missing cleanup plan marker");
  if (markerCount !== 1) throw new Error("expected exactly one cleanup plan marker");
  const markedOutput = source.slice(source.indexOf(CleanupPlanMarker) + CleanupPlanMarker.length).trim();
  const fencedJson = markedOutput.match(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  const jsonText = fencedJson ? fencedJson[1].trim() : markedOutput;
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

export function computeCleanupSnapshotHash(snapshotValue: unknown): string {
  const snapshot = normalizeSnapshot(snapshotValue);
  const canonicalNodes = snapshot.nodes
    .map((node) => ({
      id: node.id,
      parentId: node.parentId,
      type: node.type,
      name: node.name,
      siblingIndex: node.siblingIndex,
      depth: node.depth,
      x: primitiveOrNull(node.x),
      y: primitiveOrNull(node.y),
      w: primitiveOrNull(node.w),
      h: primitiveOrNull(node.h),
      visible: primitiveOrNull(node.visible),
      opacity: primitiveOrNull(node.opacity),
      childCount: primitiveOrNull(node.childCount),
      characters: primitiveOrNull(node.characters),
      roles: stableJsonValue(node.roles),
      psd: stableJsonValue(node.psd),
    }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(canonicalNodes)).digest("hex");
}

export function validateCleanupPlanV2(planValue: unknown, snapshotValue: unknown): CleanupPlanV2 {
  rejectForbiddenCleanupV2Fields(planValue);
  const snapshot = normalizeSnapshot(snapshotValue);
  if (!isRecord(planValue)) throw new Error("cleanup plan must be an object");
  if (planValue.schemaVersion !== 2) throw new Error("cleanup plan schemaVersion must be 2");
  const rootNodeId = requiredString(planValue.rootNodeId, "cleanup plan rootNodeId");
  if (rootNodeId !== snapshot.rootNodeId) throw new Error("cleanup plan rootNodeId must match snapshot root");
  const snapshotHash = requiredString(planValue.snapshotHash, "cleanup plan snapshotHash");
  if (snapshotHash !== computeCleanupSnapshotHash(snapshot)) throw new Error("cleanup plan snapshot hash does not match current snapshot");
  if (!Array.isArray(planValue.operations)) throw new Error("cleanup plan operations must be an array");

  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const operationIds = new Set<string>();
  const groupedNodeIds = new Set<string>();
  const flattenedRootGroupNodeIds: string[] = [];
  const operations = planValue.operations.map((operation, index) => {
    if (!isRecord(operation)) throw new Error(`cleanup operation ${index} must be an object`);
    const id = requiredString(operation.id, `cleanup operation ${index} id`);
    if (operationIds.has(id)) throw new Error(`duplicate cleanup operation id ${id}`);
    operationIds.add(id);
    const type = requiredString(operation.type, `cleanup operation ${index} type`);
    if (type === "CREATE_GROUP") {
      const parentNodeId = requiredExistingNodeId(operation.parentNodeId, nodeById, `cleanup operation ${id} parentNodeId`);
      const name = requiredString(operation.name, `cleanup operation ${id} name`);
      const childNodeIds = stringArray(operation.childNodeIds, `cleanup operation ${id} childNodeIds`);
      if (childNodeIds.length < 2) throw new Error(`cleanup operation ${id} single-child group is not allowed`);
      let previousSiblingIndex = -1;
      for (const childNodeId of childNodeIds) {
        const child = nodeById.get(childNodeId);
        if (!child) throw new Error(`unknown snapshot node ${childNodeId}`);
        if (child.parentId !== parentNodeId) throw new Error(`node ${childNodeId} is not a direct child of ${parentNodeId}`);
        if (groupedNodeIds.has(childNodeId)) throw new Error(`node ${childNodeId} appears in more than one cleanup group`);
        if (child.siblingIndex <= previousSiblingIndex) throw new Error("cleanup group childNodeIds must preserve sibling order");
        previousSiblingIndex = child.siblingIndex;
        groupedNodeIds.add(childNodeId);
        if (parentNodeId === rootNodeId) flattenedRootGroupNodeIds.push(childNodeId);
      }
      return { id, type, parentNodeId, name, childNodeIds } as CleanupOperationV2;
    }
    if (type === "RENAME_NODE") {
      return {
        id,
        type,
        nodeId: requiredExistingNodeId(operation.nodeId, nodeById, `cleanup operation ${id} nodeId`),
        name: requiredString(operation.name, `cleanup operation ${id} name`),
      } as CleanupOperationV2;
    }
    if (type === "MOVE_NODE") {
      return {
        id,
        type,
        nodeId: requiredExistingNodeId(operation.nodeId, nodeById, `cleanup operation ${id} nodeId`),
        parentNodeId: requiredExistingNodeId(operation.parentNodeId, nodeById, `cleanup operation ${id} parentNodeId`),
        index: finiteInteger(operation.index, `cleanup operation ${id} index`),
      } as CleanupOperationV2;
    }
    if (type === "REORDER_CHILDREN") {
      const parentNodeId = requiredExistingNodeId(operation.parentNodeId, nodeById, `cleanup operation ${id} parentNodeId`);
      const childNodeIds = stringArray(operation.childNodeIds, `cleanup operation ${id} childNodeIds`);
      const actualChildNodeIds = snapshot.nodes
        .filter((node) => node.parentId === parentNodeId)
        .sort((left, right) => left.siblingIndex - right.siblingIndex)
        .map((node) => node.id);
      childNodeIds.forEach((nodeId) => requiredExistingNodeId(nodeId, nodeById, `cleanup operation ${id} childNodeId`));
      if (!sameStringSets(childNodeIds, actualChildNodeIds)) throw new Error(`cleanup operation ${id} must reorder all direct children exactly once`);
      return { id, type, parentNodeId, childNodeIds } as CleanupOperationV2;
    }
    if (type === "SET_AUTO_LAYOUT") {
      const layoutMode = operation.layoutMode;
      if (layoutMode !== "HORIZONTAL" && layoutMode !== "VERTICAL") throw new Error(`cleanup operation ${id} layoutMode is invalid`);
      return {
        id,
        type,
        nodeId: requiredExistingNodeId(operation.nodeId, nodeById, `cleanup operation ${id} nodeId`),
        layoutMode,
        itemSpacing: nonNegativeNumber(operation.itemSpacing, `cleanup operation ${id} itemSpacing`),
        paddingTop: nonNegativeNumber(operation.paddingTop, `cleanup operation ${id} paddingTop`),
        paddingRight: nonNegativeNumber(operation.paddingRight, `cleanup operation ${id} paddingRight`),
        paddingBottom: nonNegativeNumber(operation.paddingBottom, `cleanup operation ${id} paddingBottom`),
        paddingLeft: nonNegativeNumber(operation.paddingLeft, `cleanup operation ${id} paddingLeft`),
      } as CleanupOperationV2;
    }
    throw new Error(`unsupported cleanup operation ${type}`);
  });

  const rootChildren = snapshot.nodes
    .filter((node) => node.parentId === rootNodeId)
    .sort((left, right) => left.siblingIndex - right.siblingIndex);
  const rootGroupCount = operations.filter((operation) => operation.type === "CREATE_GROUP" && operation.parentNodeId === rootNodeId).length;
  if (rootGroupCount > 0 && !sameStrings(flattenedRootGroupNodeIds, rootChildren.map((node) => node.id))) {
    throw new Error("cleanup CREATE_GROUP operations must cover root direct children exactly once in sibling order");
  }
  if (operations.length === 0 && (rootChildren.length === 0 || !rootChildren.every((node) => semanticContainerName(node.name)))) {
    throw new Error("cleanup no-op is valid only when the root is already organized");
  }

  const preconditionsValue = planValue.preconditions;
  if (!Array.isArray(preconditionsValue)) throw new Error("cleanup plan preconditions must be an array");
  const preconditions = preconditionsValue.map((precondition, index) => {
    if (!isRecord(precondition)) throw new Error(`cleanup precondition ${index} must be an object`);
    return {
      nodeId: requiredExistingNodeId(precondition.nodeId, nodeById, `cleanup precondition ${index} nodeId`),
      parentNodeId: typeof precondition.parentNodeId === "string" ? precondition.parentNodeId : "",
      siblingIndex: finiteInteger(precondition.siblingIndex, `cleanup precondition ${index} siblingIndex`),
    };
  });
  if (!isRecord(planValue.verification)) throw new Error("cleanup plan verification must be an object");
  const verification = {
    preserveAbsoluteBoundsTolerance: nonNegativeNumber(
      planValue.verification.preserveAbsoluteBoundsTolerance,
      "cleanup plan verification preserveAbsoluteBoundsTolerance",
    ),
  };
  const warnings = stringArray(planValue.warnings, "cleanup plan warnings", true);
  return { schemaVersion: 2, rootNodeId, snapshotHash, operations, preconditions, verification, warnings };
}

export function toFigmaCleanupTransactionPlan(planValue: unknown, snapshotValue: unknown): object {
  const plan = validateCleanupPlanV2(planValue, snapshotValue);
  return {
    schemaVersion: 2,
    operation: "figma-hierarchy-cleanup-transaction",
    target: { nodeId: plan.rootNodeId, snapshotHash: plan.snapshotHash },
    operations: plan.operations,
    verification: plan.verification,
    createBackup: true,
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

function rejectForbiddenCleanupV2Fields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectForbiddenCleanupV2Fields);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (["componentCandidates", "componentSets", "variants", "applied", "commands", "toolCalls", "mutationResult"].includes(key)) {
      throw new Error(`forbidden cleanup plan field ${key}`);
    }
    rejectForbiddenCleanupV2Fields(child);
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

function nonNegativeNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function requiredExistingNodeId(
  value: unknown,
  nodeById: Map<string, CleanupSnapshotNodeV1>,
  label: string,
): string {
  const nodeId = requiredString(value, label);
  if (!nodeById.has(nodeId)) throw new Error(`unknown snapshot node ${nodeId}`);
  return nodeId;
}

function primitiveOrNull(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return primitiveOrNull(value);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
}

function semanticContainerName(value: string): boolean {
  return /^\[[^\]]+\]$/.test(String(value || "").trim());
}

function sameStringSets(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
