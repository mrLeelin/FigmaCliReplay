import fs from "node:fs";
import path from "node:path";

import {
  computeCleanupSnapshotHash,
  validateCleanupPlanV3,
  type CleanupPlanV3,
  type CleanupSnapshotNodeV1,
  type CleanupSnapshotV1,
} from "./cleanupPlan.js";
import { isRecord } from "./utils.js";

export const CleanupConfirmationPlanFileName = "cleanup-plan-for-confirmation.json";
export const CleanupConfirmationDecisionFileName = "cleanup-plan-decision.json";

export interface CleanupConfirmationSubgroupV1 {
  name: string;
  sourceNodeIds: string[];
  preserveSiblingOrder: true;
  subgroups?: CleanupConfirmationSubgroupV1[];
}

export interface CleanupConfirmationGroupV1 {
  name: string;
  parentNodeId: string;
  sourceNodeIds: string[];
  preserveSiblingOrder: true;
  subgroups?: CleanupConfirmationSubgroupV1[];
}

export interface CleanupConfirmationAssignmentV1 {
  nodeId: string;
  nodeName: string;
  targetParent: string;
  targetSiblingIndex: number;
}

export interface CleanupConfirmationPlanV1 {
  schemaVersion: 1;
  rootNodeId: string;
  groups: CleanupConfirmationGroupV1[];
  assignments: CleanupConfirmationAssignmentV1[];
  componentCandidates: unknown[];
  warnings: string[];
}

export interface CleanupConfirmationDecisionGroupV1 {
  name: string;
  count: number;
  startNodeId: string;
  endNodeId: string;
  subgroups?: CleanupConfirmationDecisionGroupV1[];
}

export interface CleanupConfirmationDecisionV1 {
  schemaVersion: 1;
  rootNodeId: string;
  groups: CleanupConfirmationDecisionGroupV1[];
  componentCandidates: unknown[];
  warnings: string[];
}

export interface CleanupConfirmationPlanSummary {
  beforeCount: number;
  assignedCount: number;
  missing: string[];
  duplicate: string[];
  extra: string[];
  groupCount: number;
}

export interface ValidatedCleanupConfirmationPlan {
  plan: CleanupConfirmationPlanV1;
  summary: CleanupConfirmationPlanSummary;
}

export interface MaterializedCleanupConfirmationPlan extends ValidatedCleanupConfirmationPlan {
  decisionBytes: number;
  artifactBytes: number;
  replacedAiArtifact?: string;
}

const LargeGroupThreshold = 12;

/**
 * Expands a compact, count-based AI decision into the only confirmable plan.
 * Node IDs, names, assignments, and all sibling ordering come exclusively from
 * the authoritative snapshot so the model cannot accidentally rewrite them.
 */
export function buildCleanupConfirmationPlanFromDecision(
  value: unknown,
  snapshotValue: unknown,
): CleanupConfirmationPlanV1 {
  const snapshot = normalizeSnapshot(snapshotValue);
  if (!isRecord(value)) throw new Error("cleanup decision must be a JSON object");
  if (value.schemaVersion !== 1) throw new Error("cleanup decision schemaVersion must be 1");
  const rootNodeId = requiredString(value.rootNodeId, "cleanup decision rootNodeId");
  if (rootNodeId !== snapshot.rootNodeId) {
    throw new Error(`cleanup decision rootNodeId=${rootNodeId} does not match authoritative rootNodeId=${snapshot.rootNodeId}`);
  }
  if (!Array.isArray(value.groups) || value.groups.length === 0) {
    throw new Error("cleanup decision groups must be a non-empty array");
  }
  if (!Array.isArray(value.componentCandidates)) throw new Error("cleanup decision componentCandidates must be an array");
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error("cleanup decision warnings must be a string array");
  }

  const rootChildren = snapshot.nodes
    .filter((node) => node.parentId === snapshot.rootNodeId)
    .sort((left, right) => left.siblingIndex - right.siblingIndex);
  const normalizedDecisions = normalizeDecisionGroups(value.groups, "groups");
  const totalCount = normalizedDecisions.reduce((total, group) => total + group.count, 0);
  if (totalCount !== rootChildren.length) {
    throw new Error(
      `cleanup decision groups total count=${totalCount} does not match authoritative directChildCount=${rootChildren.length}`,
    );
  }

  let cursor = 0;
  const assignments: CleanupConfirmationAssignmentV1[] = [];
  const groups = normalizedDecisions.map((decision) => {
    const groupNodes = rootChildren.slice(cursor, cursor + decision.count);
    const groupStartIndex = cursor;
    cursor += decision.count;
    assertDecisionBoundary(decision, `group ${decision.name}`, groupNodes, groupStartIndex);
    const sourceNodeIds = groupNodes.map((node) => node.id);
    const subgroups = buildDecisionSubgroups(decision.subgroups, decision.name, groupNodes, groupStartIndex);
    groupNodes.forEach((node, targetSiblingIndex) => {
      assignments.push({
        nodeId: node.id,
        nodeName: node.name,
        targetParent: decision.name,
        targetSiblingIndex,
      });
    });
    return {
      name: decision.name,
      parentNodeId: snapshot.rootNodeId,
      sourceNodeIds,
      preserveSiblingOrder: true as const,
      ...(subgroups ? { subgroups } : {}),
    };
  });

  const plan: CleanupConfirmationPlanV1 = {
    schemaVersion: 1,
    rootNodeId: snapshot.rootNodeId,
    groups,
    assignments,
    componentCandidates: [...value.componentCandidates],
    warnings: [...value.warnings] as string[],
  };
  return validateCleanupConfirmationPlan(plan, snapshot).plan;
}

export function validateCleanupConfirmationPlan(
  value: unknown,
  snapshotValue: unknown,
): ValidatedCleanupConfirmationPlan {
  const snapshot = normalizeSnapshot(snapshotValue);
  if (!isRecord(value)) throw new Error("确认方案必须是 JSON 对象");
  if (value.schemaVersion !== 1) throw new Error("确认方案 schemaVersion 必须为 1");
  const rootNodeId = requiredString(value.rootNodeId, "确认方案 rootNodeId");
  if (rootNodeId !== snapshot.rootNodeId) {
    throw new Error(`确认方案 rootNodeId ${rootNodeId} 与权威快照根节点 ${snapshot.rootNodeId} 不一致`);
  }

  const rootChildren = snapshot.nodes
    .filter((node) => node.parentId === snapshot.rootNodeId)
    .sort((left, right) => left.siblingIndex - right.siblingIndex);
  const rootChildIds = rootChildren.map((node) => node.id);
  const rootChildById = new Map(rootChildren.map((node) => [node.id, node]));
  const allNodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  if (!Array.isArray(value.groups) || value.groups.length === 0) {
    throw new Error("确认方案 groups 不能为空");
  }

  const groupNames = new Set<string>();
  const groupByNodeId = new Map<string, { groupName: string; targetSiblingIndex: number }>();
  const flattenedGroupIds: string[] = [];
  const groups = value.groups.map((groupValue, groupIndex) => {
    if (!isRecord(groupValue)) throw new Error(`确认方案 groups[${groupIndex}] 必须是对象`);
    const name = requiredString(groupValue.name, `确认方案 groups[${groupIndex}].name`);
    if (groupNames.has(name)) throw new Error(`确认方案存在重复分组名称：${name}`);
    groupNames.add(name);
    const parentNodeId = requiredString(groupValue.parentNodeId, `分组 ${name} parentNodeId`);
    if (parentNodeId !== snapshot.rootNodeId) throw new Error(`分组 ${name} parentNodeId 必须等于根节点 ${snapshot.rootNodeId}`);
    if (groupValue.preserveSiblingOrder !== true) throw new Error(`分组 ${name} preserveSiblingOrder 必须为 true`);
    const sourceNodeIds = requiredStringArray(groupValue.sourceNodeIds, `分组 ${name} sourceNodeIds`);
    if (sourceNodeIds.length < 2) throw new Error(`分组 ${name} 不允许单子节点分组`);

    let previousSiblingIndex = -1;
    let previousNodeId = "<start>";
    sourceNodeIds.forEach((nodeId, targetSiblingIndex) => {
      const node = allNodeById.get(nodeId);
      if (!node) throw new Error(`分组 ${name} 引用了快照中不存在的节点 ${nodeId}`);
      if (!rootChildById.has(nodeId)) {
        throw new Error(`节点 ${nodeId} (${node.name}) 不是 ${snapshot.rootNodeId} 的直接子节点；不能用后代节点替代根直属节点`);
      }
      if (groupByNodeId.has(nodeId)) throw new Error(`根直属节点 ${nodeId} 同时出现在多个分组中`);
      if (node.siblingIndex <= previousSiblingIndex) {
        throw new Error(
          `分组 ${name} 的 sourceNodeIds 未保持原兄弟顺序：index=${targetSiblingIndex}, previousNodeId=${previousNodeId}, previousSiblingIndex=${previousSiblingIndex}, actualNodeId=${nodeId}, actualSiblingIndex=${node.siblingIndex}`,
        );
      }
      previousSiblingIndex = node.siblingIndex;
      previousNodeId = nodeId;
      groupByNodeId.set(nodeId, { groupName: name, targetSiblingIndex });
      flattenedGroupIds.push(nodeId);
    });

    const subgroups = normalizeSubgroups(groupValue.subgroups, name, sourceNodeIds);
    if (sourceNodeIds.length >= LargeGroupThreshold && !subgroups) {
      throw new Error(`大分组 ${name} 包含 ${sourceNodeIds.length} 个直属节点，必须使用 subgroups 结构化展开`);
    }
    return {
      name,
      parentNodeId,
      sourceNodeIds,
      preserveSiblingOrder: true as const,
      ...(subgroups ? { subgroups } : {}),
    };
  });

  const groupCoverage = compareCoverage(rootChildIds, flattenedGroupIds);
  if (!sameOrderedStrings(rootChildIds, flattenedGroupIds)) {
    throw new Error(
      `确认方案 groups 未按原顺序完整覆盖所有根直接子节点：missing=${jsonList(groupCoverage.missing)}, duplicate=${jsonList(groupCoverage.duplicate)}, extra=${jsonList(groupCoverage.extra)}, ${describeOrderedMismatch(rootChildIds, flattenedGroupIds)}`,
    );
  }

  if (!Array.isArray(value.assignments)) throw new Error("确认方案 assignments 必须是数组");
  const assignmentIds: string[] = [];
  const assignments = value.assignments.map((assignmentValue, assignmentIndex) => {
    if (!isRecord(assignmentValue)) throw new Error(`确认方案 assignments[${assignmentIndex}] 必须是对象`);
    const nodeId = requiredString(assignmentValue.nodeId, `assignments[${assignmentIndex}].nodeId`);
    const node = allNodeById.get(nodeId);
    if (!node) throw new Error(`assignments[${assignmentIndex}] 引用了快照中不存在的节点 ${nodeId}`);
    if (!rootChildById.has(nodeId)) {
      throw new Error(`assignments[${assignmentIndex}] 的节点 ${nodeId} (${node.name}) 不是根直接子节点`);
    }
    const nodeName = exactString(assignmentValue.nodeName, `assignments[${assignmentIndex}].nodeName`);
    if (nodeName !== node.name) {
      throw new Error(`节点 ${nodeId} 名称不匹配：方案=${JSON.stringify(nodeName)}，快照=${JSON.stringify(node.name)}`);
    }
    const targetParent = requiredString(assignmentValue.targetParent, `assignments[${assignmentIndex}].targetParent`);
    const expectedTarget = groupByNodeId.get(nodeId);
    if (!expectedTarget) throw new Error(`节点 ${nodeId} 没有对应的根分组`);
    if (targetParent !== expectedTarget.groupName) {
      throw new Error(`节点 ${nodeId} targetParent=${targetParent}，但 groups 映射为 ${expectedTarget.groupName}`);
    }
    const targetSiblingIndex = requiredNonNegativeInteger(
      assignmentValue.targetSiblingIndex,
      `assignments[${assignmentIndex}].targetSiblingIndex`,
    );
    if (targetSiblingIndex !== expectedTarget.targetSiblingIndex) {
      throw new Error(`节点 ${nodeId} targetSiblingIndex=${targetSiblingIndex}，预期为 ${expectedTarget.targetSiblingIndex}`);
    }
    assignmentIds.push(nodeId);
    return { nodeId, nodeName, targetParent, targetSiblingIndex };
  });

  const assignmentCoverage = compareCoverage(rootChildIds, assignmentIds);
  if (!sameOrderedStrings(rootChildIds, assignmentIds)) {
    throw new Error(
      `确认方案 assignments 未按原顺序完整覆盖所有根直接子节点：missing=${jsonList(assignmentCoverage.missing)}, duplicate=${jsonList(assignmentCoverage.duplicate)}, extra=${jsonList(assignmentCoverage.extra)}, ${describeOrderedMismatch(rootChildIds, assignmentIds)}`,
    );
  }

  if (!Array.isArray(value.componentCandidates)) throw new Error("确认方案 componentCandidates 必须是数组");
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error("确认方案 warnings 必须是字符串数组");
  }

  const summary: CleanupConfirmationPlanSummary = {
    beforeCount: rootChildIds.length,
    assignedCount: assignments.length,
    missing: assignmentCoverage.missing,
    duplicate: assignmentCoverage.duplicate,
    extra: assignmentCoverage.extra,
    groupCount: groups.length,
  };
  return {
    plan: {
      schemaVersion: 1,
      rootNodeId,
      groups,
      assignments,
      componentCandidates: [...value.componentCandidates],
      warnings: [...value.warnings] as string[],
    },
    summary,
  };
}

/**
 * Converts the Relay-validated grouping artifact into the only hierarchy
 * transaction shape the Figma executor accepts. The model never supplies
 * transaction operations, node names, or node ordering.
 */
export function compileCleanupConfirmationPlanToV3(
  value: unknown,
  snapshotValue: CleanupSnapshotV1,
): CleanupPlanV3 {
  const snapshot = normalizeSnapshot(snapshotValue);
  const { plan } = validateCleanupConfirmationPlan(value, snapshot);
  const rootChildren = snapshot.nodes
    .filter((node) => node.parentId === snapshot.rootNodeId)
    .sort((left, right) => left.siblingIndex - right.siblingIndex);
  const operations: CleanupPlanV3["operations"] = [];
  let nextOperation = 1;

  const compileGroups = (
    groups: Array<CleanupConfirmationGroupV1 | CleanupConfirmationSubgroupV1>,
    parent: { parentNodeId: string } | { parentOperationId: string },
  ): void => {
    for (const group of groups) {
      const operationId = `op-${String(nextOperation++).padStart(3, "0")}`;
      operations.push({
        id: operationId,
        type: "CREATE_GROUP",
        name: group.name,
        childNodeIds: [...group.sourceNodeIds],
        ...parent,
      });
      if (group.subgroups?.length) compileGroups(group.subgroups, { parentOperationId: operationId });
    }
  };

  compileGroups(plan.groups, { parentNodeId: snapshot.rootNodeId });
  return validateCleanupPlanV3({
    schemaVersion: 3,
    rootNodeId: snapshot.rootNodeId,
    snapshotHash: computeCleanupSnapshotHash(snapshot),
    operations,
    preconditions: rootChildren.map((node) => ({
      nodeId: node.id,
      parentNodeId: snapshot.rootNodeId,
      siblingIndex: node.siblingIndex,
    })),
    verification: { preserveAbsoluteBoundsTolerance: 0.01 },
    warnings: [...plan.warnings],
  }, snapshot);
}

export function validateCleanupConfirmationPlanArtifact(
  runDir: string,
  snapshot: CleanupSnapshotV1,
): ValidatedCleanupConfirmationPlan {
  const artifactPath = path.join(runDir, CleanupConfirmationPlanFileName);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`缺少 Relay 强制确认方案文件：${CleanupConfirmationPlanFileName}`);
  }
  let value: unknown;
  try {
    const source = fs.readFileSync(artifactPath, "utf8").replace(/^\uFEFF/, "");
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`无法解析 ${CleanupConfirmationPlanFileName}：${error instanceof Error ? error.message : String(error)}`);
  }
  return validateCleanupConfirmationPlan(value, snapshot);
}

export function materializeCleanupConfirmationPlanArtifact(
  runDir: string,
  snapshot: CleanupSnapshotV1,
): MaterializedCleanupConfirmationPlan {
  const decisionPath = path.join(runDir, CleanupConfirmationDecisionFileName);
  if (!fs.existsSync(decisionPath)) {
    throw new Error(`缺少 Relay 强制精简决策文件：${CleanupConfirmationDecisionFileName}`);
  }
  let decision: unknown;
  let decisionBytes = 0;
  try {
    const source = fs.readFileSync(decisionPath, "utf8").replace(/^\uFEFF/, "");
    decisionBytes = Buffer.byteLength(source, "utf8");
    decision = JSON.parse(source);
  } catch (error) {
    throw new Error(`无法解析 ${CleanupConfirmationDecisionFileName}：${error instanceof Error ? error.message : String(error)}`);
  }

  const plan = buildCleanupConfirmationPlanFromDecision(decision, snapshot);
  const artifactPath = path.join(runDir, CleanupConfirmationPlanFileName);
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  let replacedAiArtifact: string | undefined;
  if (fs.existsSync(artifactPath)) {
    replacedAiArtifact = `cleanup-plan-for-confirmation.ai-provided.${Date.now()}.json`;
    fs.renameSync(artifactPath, path.join(runDir, replacedAiArtifact));
  }
  fs.writeFileSync(artifactPath, serialized, "utf8");
  const validation = validateCleanupConfirmationPlanArtifact(runDir, snapshot);
  return {
    ...validation,
    decisionBytes,
    artifactBytes: Buffer.byteLength(serialized, "utf8"),
    ...(replacedAiArtifact ? { replacedAiArtifact } : {}),
  };
}

function normalizeSnapshot(value: unknown): CleanupSnapshotV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.rootNodeId !== "string" || !Array.isArray(value.nodes)) {
    throw new Error("权威 cleanup snapshot 无效");
  }
  const nodes = value.nodes.map((nodeValue, index) => {
    if (!isRecord(nodeValue)) throw new Error(`cleanup snapshot nodes[${index}] 必须是对象`);
    return {
      ...nodeValue,
      id: requiredString(nodeValue.id, `snapshot nodes[${index}].id`),
      parentId: typeof nodeValue.parentId === "string" ? nodeValue.parentId : "",
      type: requiredString(nodeValue.type, `snapshot nodes[${index}].type`),
      name: typeof nodeValue.name === "string" ? nodeValue.name : "",
      siblingIndex: requiredNonNegativeInteger(nodeValue.siblingIndex, `snapshot nodes[${index}].siblingIndex`),
      depth: requiredNonNegativeInteger(nodeValue.depth, `snapshot nodes[${index}].depth`),
    } as CleanupSnapshotNodeV1;
  });
  return { ...value, schemaVersion: 1, rootNodeId: value.rootNodeId, nodes } as CleanupSnapshotV1;
}

function normalizeSubgroups(
  value: unknown,
  parentName: string,
  parentSourceNodeIds: string[],
): CleanupConfirmationSubgroupV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 2) throw new Error(`分组 ${parentName} 的 subgroups 至少需要两个子分组`);
  const names = new Set<string>();
  const flattenedIds: string[] = [];
  const subgroups = value.map((subgroupValue, index) => {
    if (!isRecord(subgroupValue)) throw new Error(`分组 ${parentName} subgroups[${index}] 必须是对象`);
    const name = requiredString(subgroupValue.name, `分组 ${parentName} subgroups[${index}].name`);
    if (names.has(name)) throw new Error(`分组 ${parentName} 存在重复子分组名称：${name}`);
    names.add(name);
    if (subgroupValue.preserveSiblingOrder !== true) throw new Error(`子分组 ${name} preserveSiblingOrder 必须为 true`);
    const sourceNodeIds = requiredStringArray(subgroupValue.sourceNodeIds, `子分组 ${name} sourceNodeIds`);
    if (sourceNodeIds.length < 2) throw new Error(`子分组 ${name} 不允许单子节点分组`);
    flattenedIds.push(...sourceNodeIds);
    const nested = normalizeSubgroups(subgroupValue.subgroups, name, sourceNodeIds);
    if (sourceNodeIds.length >= LargeGroupThreshold && !nested) {
      throw new Error(`大分组 ${name} 包含 ${sourceNodeIds.length} 个节点，必须继续使用 subgroups 展开`);
    }
    return {
      name,
      sourceNodeIds,
      preserveSiblingOrder: true as const,
      ...(nested ? { subgroups: nested } : {}),
    };
  });
  if (!sameOrderedStrings(parentSourceNodeIds, flattenedIds)) {
    const coverage = compareCoverage(parentSourceNodeIds, flattenedIds);
    throw new Error(
      `分组 ${parentName} 的 subgroups 未按原顺序完整覆盖父分组：missing=${jsonList(coverage.missing)}, duplicate=${jsonList(coverage.duplicate)}, extra=${jsonList(coverage.extra)}, ${describeOrderedMismatch(parentSourceNodeIds, flattenedIds)}`,
    );
  }
  return subgroups;
}

function compareCoverage(expected: string[], actual: string[]) {
  const expectedSet = new Set(expected);
  const actualCounts = new Map<string, number>();
  for (const id of actual) actualCounts.set(id, (actualCounts.get(id) || 0) + 1);
  return {
    missing: expected.filter((id) => !actualCounts.has(id)),
    duplicate: [...actualCounts].filter(([, count]) => count > 1).map(([id]) => id),
    extra: [...actualCounts.keys()].filter((id) => !expectedSet.has(id)),
  };
}

function normalizeDecisionGroups(value: unknown[], label: string): CleanupConfirmationDecisionGroupV1[] {
  const names = new Set<string>();
  return value.map((groupValue, index) => {
    if (!isRecord(groupValue)) throw new Error(`${label}[${index}] must be an object`);
    const name = requiredString(groupValue.name, `${label}[${index}].name`);
    if (names.has(name)) throw new Error(`${label} contains duplicate name: ${name}`);
    names.add(name);
    const count = requiredPositiveInteger(groupValue.count, `${label}[${index}].count`);
    if (count < 2) throw new Error(`${label}[${index}] ${name} cannot be a single-node group`);
    const startNodeId = requiredString(groupValue.startNodeId, `${label}[${index}].startNodeId`);
    const endNodeId = requiredString(groupValue.endNodeId, `${label}[${index}].endNodeId`);
    let subgroups: CleanupConfirmationDecisionGroupV1[] | undefined;
    if (groupValue.subgroups !== undefined) {
      if (!Array.isArray(groupValue.subgroups) || groupValue.subgroups.length < 2) {
        throw new Error(`${label}[${index}] ${name} subgroups must contain at least two groups`);
      }
      subgroups = normalizeDecisionGroups(groupValue.subgroups, `${label}[${index}].subgroups`);
      const subgroupCount = subgroups.reduce((total, subgroup) => total + subgroup.count, 0);
      if (subgroupCount !== count) {
        throw new Error(`${label}[${index}] ${name} subgroup total count=${subgroupCount} does not match parent count=${count}`);
      }
    }
    if (count >= LargeGroupThreshold && !subgroups) {
      throw new Error(`${label}[${index}] ${name} count=${count} requires contiguous subgroups`);
    }
    return { name, count, startNodeId, endNodeId, ...(subgroups ? { subgroups } : {}) };
  });
}

function buildDecisionSubgroups(
  decisions: CleanupConfirmationDecisionGroupV1[] | undefined,
  parentName: string,
  parentNodes: CleanupSnapshotNodeV1[],
  parentStartIndex: number,
): CleanupConfirmationSubgroupV1[] | undefined {
  if (!decisions) return undefined;
  let cursor = 0;
  return decisions.map((decision) => {
    const nodes = parentNodes.slice(cursor, cursor + decision.count);
    const startIndex = parentStartIndex + cursor;
    cursor += decision.count;
    const sourceNodeIds = nodes.map((node) => node.id);
    if (nodes.length !== decision.count) {
      throw new Error(
        `cleanup decision subgroup ${decision.name} exceeds parent ${parentName}: startIndex=${startIndex}, requestedCount=${decision.count}, availableCount=${nodes.length}`,
      );
    }
    assertDecisionBoundary(decision, `subgroup ${decision.name} under ${parentName}`, nodes, startIndex);
    const nested = buildDecisionSubgroups(decision.subgroups, decision.name, nodes, startIndex);
    return {
      name: decision.name,
      sourceNodeIds,
      preserveSiblingOrder: true as const,
      ...(nested ? { subgroups: nested } : {}),
    };
  });
}

function assertDecisionBoundary(
  decision: CleanupConfirmationDecisionGroupV1,
  label: string,
  nodes: CleanupSnapshotNodeV1[],
  startIndex: number,
): void {
  const actualStartNodeId = nodes[0]?.id || "<none>";
  const actualEndNodeId = nodes.at(-1)?.id || "<none>";
  if (decision.startNodeId !== actualStartNodeId || decision.endNodeId !== actualEndNodeId) {
    throw new Error(
      `cleanup decision ${label} boundary mismatch: expectedStartNodeId=${decision.startNodeId}, actualStartNodeId=${actualStartNodeId}, expectedEndNodeId=${decision.endNodeId}, actualEndNodeId=${actualEndNodeId}, startIndex=${startIndex}, count=${decision.count}`,
    );
  }
}

function describeOrderedMismatch(expected: string[], actual: string[]): string {
  const sharedLength = Math.min(expected.length, actual.length);
  let firstMismatchIndex = 0;
  while (firstMismatchIndex < sharedLength && expected[firstMismatchIndex] === actual[firstMismatchIndex]) {
    firstMismatchIndex += 1;
  }
  const expectedId = firstMismatchIndex < expected.length ? expected[firstMismatchIndex] : "<end>";
  const actualId = firstMismatchIndex < actual.length ? actual[firstMismatchIndex] : "<end>";
  return `firstMismatchIndex=${firstMismatchIndex}, expected=${expectedId}, actual=${actualId}, expectedLength=${expected.length}, actualLength=${actual.length}`;
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  return value;
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} 必须是非空字符串数组`);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`);
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const result = requiredNonNegativeInteger(value, label);
  if (result === 0) throw new Error(`${label} must be a positive integer`);
  return result;
}

function jsonList(values: string[]): string {
  return JSON.stringify(values);
}
