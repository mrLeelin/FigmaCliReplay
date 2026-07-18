import { createHash } from "node:crypto";

import { isRecord } from "./utils.js";
import { logInfo, logError } from "./utils/logger.js";

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
  if (markerCount === 0) throw new Error("缺少清理计划标记");
  if (markerCount !== 1) throw new Error("期望恰好一个清理计划标记");
  const markedOutput = source.slice(source.indexOf(CleanupPlanMarker) + CleanupPlanMarker.length).trim();
  const fencedJson = markedOutput.match(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  const jsonText = fencedJson ? fencedJson[1].trim() : markedOutput;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`无效的清理计划 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateCleanupPlan(plan: unknown, snapshotValue: unknown): CleanupPlanV1 {
  rejectForbiddenPlanFields(plan);
  const snapshot = normalizeSnapshot(snapshotValue);
  if (!isRecord(plan)) throw new Error("清理计划必须是一个对象");
  if (plan.schemaVersion !== 1) throw new Error("清理计划 schemaVersion 必须为 1");
  const rootNodeId = requiredString(plan.rootNodeId, "清理计划 rootNodeId");
  if (rootNodeId !== snapshot.rootNodeId) throw new Error("清理计划 rootNodeId 必须与快照根节点匹配");

  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const rootChildren = snapshot.nodes
    .filter((node) => node.parentId === snapshot.rootNodeId)
    .sort((left, right) => left.siblingIndex - right.siblingIndex);
  const rootChildIds = rootChildren.map((node) => node.id);
  if (!Array.isArray(plan.groups) || plan.groups.length === 0) throw new Error("清理计划分组不能为空");

  const usedGroupNodeIds = new Set<string>();
  const flattenedGroupNodeIds: string[] = [];
  const groups = plan.groups.map((value, groupIndex) => {
    if (!isRecord(value)) throw new Error(`清理计划分组 ${groupIndex} 必须是一个对象`);
    const name = requiredString(value.name, `清理计划分组 ${groupIndex} name`);
    const parentNodeId = requiredString(value.parentNodeId, `清理计划分组 ${groupIndex} parentNodeId`);
    if (parentNodeId !== snapshot.rootNodeId) throw new Error("清理计划分组 parentNodeId 必须等于快照根节点");
    if (value.preserveSiblingOrder !== true) throw new Error("清理计划分组 preserveSiblingOrder 必须为 true");
    const sourceNodeIds = stringArray(value.sourceNodeIds, "清理计划分组 sourceNodeIds");
    if (sourceNodeIds.length === 0) throw new Error("清理计划分组 sourceNodeIds 不能为空");

    let previousIndex = -1;
    for (const nodeId of sourceNodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) throw new Error(`未知的快照节点 ${nodeId}`);
      if (node.parentId !== parentNodeId) throw new Error(`节点 ${nodeId} 不是 ${parentNodeId} 的直接子节点`);
      if (usedGroupNodeIds.has(nodeId)) throw new Error(`节点 ${nodeId} 出现在多个分组中`);
      if (node.siblingIndex <= previousIndex) throw new Error("清理计划分组 sourceNodeIds 必须保持兄弟节点顺序");
      previousIndex = node.siblingIndex;
      usedGroupNodeIds.add(nodeId);
      flattenedGroupNodeIds.push(nodeId);
    }
    return { name, parentNodeId, sourceNodeIds, preserveSiblingOrder: true as const };
  });

  if (!sameStrings(flattenedGroupNodeIds, rootChildIds)) {
    throw new Error("清理计划分组必须完整覆盖根节点的所有直接子节点且保持兄弟节点顺序");
  }

  const componentCandidates = normalizeComponentCandidates(plan.componentCandidates, nodeById);
  const warnings = stringArray(plan.warnings, "清理计划警告", true);
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
  if (!isRecord(planValue)) throw new Error("清理计划必须是一个对象");
  if (planValue.schemaVersion !== 2) throw new Error("清理计划 schemaVersion 必须为 2");
  const rootNodeId = requiredString(planValue.rootNodeId, "清理计划 rootNodeId");
  if (rootNodeId !== snapshot.rootNodeId) throw new Error("清理计划 rootNodeId 必须与快照根节点匹配");
  const snapshotHash = requiredString(planValue.snapshotHash, "清理计划 snapshotHash");
  if (snapshotHash !== computeCleanupSnapshotHash(snapshot)) throw new Error("清理计划快照哈希与当前快照不匹配");
  if (!Array.isArray(planValue.operations)) throw new Error("清理计划操作必须是数组");

  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const operationIds = new Set<string>();
  const groupedNodeIds = new Set<string>();
  const flattenedRootGroupNodeIds: string[] = [];
  const operations = planValue.operations.map((operation, index) => {
    if (!isRecord(operation)) throw new Error(`清理操作 ${index} 必须是一个对象`);
    const id = requiredString(operation.id, `清理操作 ${index} id`);
    if (operationIds.has(id)) throw new Error(`重复的清理操作 id ${id}`);
    operationIds.add(id);
    const type = requiredString(operation.type, `清理操作 ${index} type`);
    if (type === "CREATE_GROUP") {
      const parentNodeId = requiredExistingNodeId(operation.parentNodeId, nodeById, `清理操作 ${id} parentNodeId`);
      const name = requiredString(operation.name, `清理操作 ${id} name`);
      const childNodeIds = stringArray(operation.childNodeIds, `清理操作 ${id} childNodeIds`);
      if (childNodeIds.length < 2) throw new Error(`清理操作 ${id} 不允许单子节点分组`);
      let previousSiblingIndex = -1;
      for (const childNodeId of childNodeIds) {
        const child = nodeById.get(childNodeId);
        if (!child) throw new Error(`未知的快照节点 ${childNodeId}`);
        if (child.parentId !== parentNodeId) throw new Error(`节点 ${childNodeId} 不是 ${parentNodeId} 的直接子节点`);
        if (groupedNodeIds.has(childNodeId)) throw new Error(`节点 ${childNodeId} 出现在多个清理分组中`);
        if (child.siblingIndex <= previousSiblingIndex) throw new Error("清理分组 childNodeIds 必须保持兄弟节点顺序");
        previousSiblingIndex = child.siblingIndex;
        groupedNodeIds.add(childNodeId);
        if (parentNodeId === rootNodeId) flattenedRootGroupNodeIds.push(childNodeId);
      }
      return { id, type, parentNodeId, name, childNodeIds } as CleanupOperationV2;
    }
    if (type === "RENAME_NODE") {
      throw new Error("plugin V2 cleanup must create semantic groups instead of only renaming original nodes");
    }
    if (type === "MOVE_NODE") {
      throw new Error("plugin V2 cleanup must use CREATE_GROUP to move original nodes into semantic groups");
    }
    if (type === "REORDER_CHILDREN") {
      const parentNodeId = requiredExistingNodeId(operation.parentNodeId, nodeById, `清理操作 ${id} parentNodeId`);
      const childNodeIds = stringArray(operation.childNodeIds, `清理操作 ${id} childNodeIds`);
      const actualChildNodeIds = snapshot.nodes
        .filter((node) => node.parentId === parentNodeId)
        .sort((left, right) => left.siblingIndex - right.siblingIndex)
        .map((node) => node.id);
      childNodeIds.forEach((nodeId) => requiredExistingNodeId(nodeId, nodeById, `清理操作 ${id} childNodeId`));
      if (!sameStringSets(childNodeIds, actualChildNodeIds)) throw new Error(`清理操作 ${id} 必须恰好重排所有直接子节点一次`);
      return { id, type, parentNodeId, childNodeIds } as CleanupOperationV2;
    }
    if (type === "SET_AUTO_LAYOUT") {
      throw new Error("plugin V2 cleanup does not allow SET_AUTO_LAYOUT because it can change visual layout");
    }
    throw new Error(`不支持的清理操作 ${type}`);
  });

  const rootChildren = snapshot.nodes
    .filter((node) => node.parentId === rootNodeId)
    .sort((left, right) => left.siblingIndex - right.siblingIndex);
  const rootGroupCount = operations.filter((operation) => operation.type === "CREATE_GROUP" && operation.parentNodeId === rootNodeId).length;
  if (rootGroupCount > 0 && !sameStrings(flattenedRootGroupNodeIds, rootChildren.map((node) => node.id))) {
    throw new Error("清理操作的分组必须完整覆盖根节点的所有直接子节点");
  }
  if (operations.length === 0) {
    if (rootChildren.length === 0 || !rootChildren.every((node) => semanticContainerName(node.name))) {
      throw new Error("no-op cleanup is allowed only for an already organized root");
    }
    logInfo("节点已组织良好，无需整理", {
      rootNodeId,
      rootChildrenCount: rootChildren.length,
      rootChildrenNames: rootChildren.map((node) => node.name),
    });
    // 不抛出错误，允许空操作通过
  }

  const preconditionsValue = planValue.preconditions;
  if (!Array.isArray(preconditionsValue)) throw new Error("清理计划前置条件必须是数组");
  const preconditions = preconditionsValue.map((precondition, index) => {
    if (!isRecord(precondition)) throw new Error(`清理前置条件 ${index} 必须是一个对象`);
    return {
      nodeId: requiredExistingNodeId(precondition.nodeId, nodeById, `清理前置条件 ${index} nodeId`),
      parentNodeId: typeof precondition.parentNodeId === "string" ? precondition.parentNodeId : "",
      siblingIndex: finiteInteger(precondition.siblingIndex, `清理前置条件 ${index} siblingIndex`),
    };
  });
  if (!isRecord(planValue.verification)) throw new Error("清理计划验证配置必须是一个对象");
  const verification = {
    preserveAbsoluteBoundsTolerance: nonNegativeNumber(
      planValue.verification.preserveAbsoluteBoundsTolerance,
      "清理计划验证配置 preserveAbsoluteBoundsTolerance",
    ),
  };
  const warnings = stringArray(planValue.warnings, "清理计划警告", true);
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
    // Exact cleanup operations are journaled in-memory and never delete source nodes.
    // Avoid cloning the entire image-heavy root, which can block Figma's main thread.
    createBackup: false,
  };
}

function normalizeSnapshot(value: unknown): CleanupSnapshotV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.nodes)) {
    throw new Error("清理快照 schemaVersion 必须为 1 且包含 nodes");
  }
  const rootNodeId = requiredString(value.rootNodeId, "清理快照 rootNodeId");
  const seen = new Set<string>();
  const nodes = value.nodes.map((node, index) => {
    if (!isRecord(node)) throw new Error(`清理快照节点 ${index} 必须是一个对象`);
    const id = requiredString(node.id, `清理快照节点 ${index} id`);
    if (seen.has(id)) throw new Error(`重复的清理快照节点 ${id}`);
    seen.add(id);
    return {
      ...node,
      id,
      parentId: typeof node.parentId === "string" ? node.parentId : "",
      type: typeof node.type === "string" ? node.type : "",
      name: typeof node.name === "string" ? node.name : "",
      siblingIndex: finiteInteger(node.siblingIndex, `清理快照节点 ${id} siblingIndex`),
      depth: finiteInteger(node.depth, `清理快照节点 ${id} depth`),
    } as CleanupSnapshotNodeV1;
  });
  if (!seen.has(rootNodeId)) throw new Error("清理快照根节点缺失");
  return { ...value, schemaVersion: 1, rootNodeId, nodes };
}

function normalizeComponentCandidates(value: unknown, nodeById: Map<string, CleanupSnapshotNodeV1>): CleanupComponentCandidateV1[] {
  if (!Array.isArray(value)) throw new Error("清理计划组件候选必须是数组");
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`清理组件候选 ${index} 必须是一个对象`);
    const name = requiredString(candidate.name, `清理组件候选 ${index} name`);
    const sourceNodeIds = stringArray(candidate.sourceNodeIds, `清理组件候选 ${index} sourceNodeIds`);
    if (sourceNodeIds.length === 0) throw new Error("清理组件候选 sourceNodeIds 不能为空");
    for (const nodeId of sourceNodeIds) {
      if (!nodeById.has(nodeId)) throw new Error(`未知的快照节点 ${nodeId}`);
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
    if (ForbiddenPlanFields.has(key)) throw new Error(`禁止的清理计划字段 ${key}`);
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
      throw new Error(`禁止的清理计划字段 ${key}`);
    }
    rejectForbiddenCleanupV2Fields(child);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function stringArray(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  const result = value.map((item, index) => requiredString(item, `${label}[${index}]`));
  if (!allowEmpty && result.length === 0) throw new Error(`${label} 不能为空`);
  return result;
}

function finiteInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} 必须是非负整数`);
  return number;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} 必须是非负数`);
  return number;
}

function requiredExistingNodeId(
  value: unknown,
  nodeById: Map<string, CleanupSnapshotNodeV1>,
  label: string,
): string {
  const nodeId = requiredString(value, label);
  if (!nodeById.has(nodeId)) throw new Error(`未知的快照节点 ${nodeId}`);
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
