import {
  computeCleanupSnapshotHash,
  validateCleanupPlanV3,
  type CleanupPlanV3,
  type CleanupSnapshotNodeV1,
  type CleanupSnapshotV1,
} from "../cleanupPlan.js";
import { isRecord } from "../utils.js";

/**
 * This is intentionally separate from CleanupPlanMarker. Providers never
 * receive write-capable IDs or operations: they can only name contiguous
 * ranges of the root's direct-child sequence.
 */
export const CleanupSkillDecisionMarker = "[CLEANUP_SKILL_DECISION_JSON]";

interface CleanupSkillDecisionGroup {
  name: string;
  endExclusive: number;
  children: CleanupSkillDecisionGroup[];
}

interface CleanupSkillDecisionV1 {
  schemaVersion: 1;
  rootNodeId: string;
  snapshotHash: string;
  tree: CleanupSkillDecisionGroup[];
  warnings: string[];
}

interface ParentReference {
  parentNodeId?: string;
  parentOperationId?: string;
}

export function extractCleanupSkillDecision(text: string): unknown {
  const source = String(text || "");
  const markerCount = source.split(CleanupSkillDecisionMarker).length - 1;
  if (markerCount === 0) throw new Error("缺少技能决策标记");
  if (markerCount !== 1) throw new Error("期望恰好一个技能决策标记");
  const payload = source.slice(source.indexOf(CleanupSkillDecisionMarker) + CleanupSkillDecisionMarker.length).trim();
  try {
    return JSON.parse(extractFirstSkillDecisionJson(payload));
  } catch (error) {
    throw new Error(`无效的技能决策 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Providers occasionally append a natural-language completion sentence after
 * the marked JSON. The semantic decision has no write authority, so parse the
 * first complete object only while retaining the one-marker requirement above.
 */
function extractFirstSkillDecisionJson(payload: string): string {
  const source = payload.trim();
  const fenced = source.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/i);
  if (fenced) return fenced[1].trim();
  if (!source.startsWith("{")) throw new Error("技能决策必须以 JSON 对象或 JSON 代码块开始");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(0, index + 1);
      if (depth < 0) break;
    }
  }
  throw new Error("技能决策 JSON 对象未闭合");
}

export function compileSkillConstrainedCleanupPlan(
  decisionValue: unknown,
  snapshotValue: CleanupSnapshotV1,
): CleanupPlanV3 {
  const snapshot = normalizeSnapshot(snapshotValue);
  const decision = validateDecision(decisionValue, snapshot);
  const rootChildren = directChildren(snapshot, snapshot.rootNodeId);
  const operations: CleanupPlanV3["operations"] = [];
  let nextOperation = 1;

  const compileScope = (
    groups: CleanupSkillDecisionGroup[],
    sourceNodes: CleanupSnapshotNodeV1[],
    parent: ParentReference,
    depth: number,
  ): void => {
    if (depth > 8) throw new Error("技能决策树超过最大安全深度 8");
    let start = 0;
    for (const group of groups) {
      if (!Number.isInteger(group.endExclusive) || group.endExclusive <= start || group.endExclusive > sourceNodes.length) {
        throw new Error(`技能决策分组 ${group.name} 的 endExclusive 不在当前直接子节点范围内`);
      }
      const childNodes = sourceNodes.slice(start, group.endExclusive);
      if (childNodes.length < 2) throw new Error(`技能决策分组 ${group.name} 不允许单子节点分组`);
      const normalizedName = normalizeSkillGroupName(group.name);
      const id = `op-${String(nextOperation++).padStart(3, "0")}`;
      const operation = {
        id,
        type: "CREATE_GROUP" as const,
        name: normalizedName,
        childNodeIds: childNodes.map((node) => node.id),
        ...parent,
      };
      operations.push(operation);
      if (group.children.length > 0) {
        compileScope(group.children, childNodes, { parentOperationId: id }, depth + 1);
      } else if (childNodes.length >= 12) {
        throw new Error(`技能约束要求继续展开大分组 ${normalizedName}（directChildCount=${childNodes.length}）`);
      }
      start = group.endExclusive;
    }
    if (start !== sourceNodes.length) throw new Error("技能决策树必须完整覆盖当前直接子节点序列");
  };

  if (decision.tree.length > 0) compileScope(decision.tree, rootChildren, { parentNodeId: snapshot.rootNodeId }, 0);
  const plan: CleanupPlanV3 = {
    schemaVersion: 3,
    rootNodeId: snapshot.rootNodeId,
    snapshotHash: decision.snapshotHash,
    operations,
    preconditions: rootChildren.map((node) => ({
      nodeId: node.id,
      parentNodeId: snapshot.rootNodeId,
      siblingIndex: node.siblingIndex,
    })),
    verification: { preserveAbsoluteBoundsTolerance: 0.01 },
    warnings: decision.warnings,
  };
  return validateCleanupPlanV3(plan, snapshot);
}

export function buildCleanupSkillDecisionTask(snapshotValue: CleanupSnapshotV1, providerId: string): string {
  const snapshot = normalizeSnapshot(snapshotValue);
  const rootChildren = directChildren(snapshot, snapshot.rootNodeId);
  const directChildSequence = rootChildren.map((node, index) => ({
    index,
    type: node.type,
    x: numberOrNull(node.x),
    y: numberOrNull(node.y),
    width: numberOrNull(node.w),
    height: numberOrNull(node.h),
    visible: booleanOrNull(node.visible),
    opacity: numberOrNull(node.opacity),
    childCount: numberOrNull(node.childCount),
    // Reporting-only hint. It must not be used as repeat-cluster evidence.
    nameHint: typeof node.name === "string" ? node.name : "",
  }));

  return [
    "# Figma hierarchy cleanup Skill-constrained decision",
    "",
    `Planning provider: ${providerId}`,
    "This turn is strictly read-only. Do not call tools, MCP, shell commands, subagents, or Figma write operations.",
    "Follow the figma-hierarchy-cleanup-mcp plugin V2 safety boundary: this decision is compiled locally into one exact transaction; it cannot create Component, ComponentSet, Variant, PSD, or visual-property changes.",
    "You are not writing a Figma plan. You are naming a complete semantic range tree over the supplied root direct child sequence.",
    "Do not return node IDs, parent IDs, childNodeIds, operation IDs, sibling orders, Figma commands, or any write payload. Those are compiler-owned and cannot be overridden.",
    "Use geometry/type/visibility/opacity/child-count for spatial ownership and repeat reasoning. nameHint is reporting-only; do not use names, paths, or text as repeat-clustering evidence.",
    "Every level must partition its current direct child sequence completely, in original order. Each range must contain at least two children.",
    "Nested endExclusive values are relative to their own parent group and reset to zero at every level. For a parent range containing 18 children, three child ranges may end at 6, 12, and 18.",
    "Use semantic, production-readable group names. UI Layer Set, Group, Section, Batch, and numbered generic sets are forbidden.",
    "A range with 12 or more direct children must contain child ranges; do not leave a coarse semantic group.",
    "Treat the root as already organized only when its direct children already form a coherent semantic container hierarchy; otherwise return a complete tree.",
    "Preserve visual appearance, size, absolute position, and sibling stacking order exactly; preserve absolute bounds, PSD identity, hidden nodes, masks, and Instances.",
    "Return exactly one marked JSON object and no prose.",
    `snapshotHash must equal: ${computeCleanupSnapshotHash(snapshot)}`,
    CleanupSkillDecisionMarker,
    '{"schemaVersion":1,"rootNodeId":"string","snapshotHash":"sha256","tree":[{"name":"Header","endExclusive":2,"children":[]}],"warnings":[]}',
    "",
    "## Root direct child sequence",
    JSON.stringify({ rootNodeId: snapshot.rootNodeId, directChildCount: rootChildren.length, directChildSequence }),
  ].join("\n");
}

/**
 * A single repair request may correct an otherwise well-formed semantic tree.
 * It receives only the validated, ID-free decision and the local compiler
 * reason; the compiler still owns all Figma references and write operations.
 */
export function buildCleanupSkillDecisionRepairTask(
  snapshotValue: CleanupSnapshotV1,
  providerId: string,
  decisionValue: unknown,
  compilerError: unknown,
): string {
  const snapshot = normalizeSnapshot(snapshotValue);
  const decision = validateDecision(decisionValue, snapshot);
  const safeDecision = {
    schemaVersion: decision.schemaVersion,
    rootNodeId: decision.rootNodeId,
    snapshotHash: decision.snapshotHash,
    tree: decision.tree,
    warnings: decision.warnings,
  };
  const reason = compilerError instanceof Error ? compilerError.message : String(compilerError);
  return [
    buildCleanupSkillDecisionTask(snapshot, providerId),
    "",
    "## Compiler-directed semantic repair",
    "Repair the previous semantic-only decision below. Return a complete replacement decision, not a patch and not an explanation.",
    `Compiler rejection: ${reason}`,
    "Preserve any valid semantic ownership, but add the required nested child ranges so every large group is structurally complete.",
    "The previous decision contains no node IDs and must remain ID-free:",
    JSON.stringify(safeDecision),
  ].join("\n");
}

function validateDecision(value: unknown, snapshot: CleanupSnapshotV1): CleanupSkillDecisionV1 {
  if (!isRecord(value)) throw new Error("技能决策必须是一个对象");
  if (value.schemaVersion !== 1) throw new Error("技能决策 schemaVersion 必须为 1");
  const rootNodeId = requiredString(value.rootNodeId, "技能决策 rootNodeId");
  if (rootNodeId !== snapshot.rootNodeId) throw new Error("技能决策 rootNodeId 必须与快照根节点匹配");
  const snapshotHash = requiredString(value.snapshotHash, "技能决策 snapshotHash");
  if (snapshotHash !== computeCleanupSnapshotHash(snapshot)) throw new Error("技能决策快照哈希与当前快照不匹配");
  if (!Array.isArray(value.tree)) throw new Error("技能决策 tree 必须是数组");
  const tree = value.tree.map((group, index) => normalizeDecisionGroup(group, `技能决策 tree[${index}]`));
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.map((warning, index) => requiredString(warning, `技能决策 warnings[${index}]`))
    : (() => { throw new Error("技能决策 warnings 必须是数组"); })();
  return { schemaVersion: 1, rootNodeId, snapshotHash, tree, warnings };
}

function normalizeDecisionGroup(value: unknown, label: string): CleanupSkillDecisionGroup {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`);
  const name = requiredString(value.name, `${label}.name`);
  const endExclusive = Number(value.endExclusive);
  if (!Number.isInteger(endExclusive) || endExclusive < 0) throw new Error(`${label}.endExclusive 必须是非负整数`);
  if (!Array.isArray(value.children)) throw new Error(`${label}.children 必须是数组`);
  return {
    name,
    endExclusive,
    children: value.children.map((child, index) => normalizeDecisionGroup(child, `${label}.children[${index}]`)),
  };
}

function normalizeSkillGroupName(value: string): string {
  const bare = value.trim().replace(/^\[|\]$/g, "").trim();
  if (!bare) throw new Error("技能决策分组名称不能为空");
  if (/^(ui\s*)?(layer\s*set|group|section|batch)(\s*\d+)?$/i.test(bare)) {
    throw new Error(`技能决策包含通用分组名：${value}`);
  }
  return `[${bare}]`;
}

function directChildren(snapshot: CleanupSnapshotV1, parentNodeId: string): CleanupSnapshotNodeV1[] {
  return snapshot.nodes
    .filter((node) => node.parentId === parentNodeId)
    .sort((left, right) => left.siblingIndex - right.siblingIndex);
}

function normalizeSnapshot(value: CleanupSnapshotV1): CleanupSnapshotV1 {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.nodes)) throw new Error("无效的清理快照");
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
