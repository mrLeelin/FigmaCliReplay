import {
  CleanupPlanMarker,
  computeCleanupSnapshotHash,
  extractCleanupPlan,
  validateCleanupPlanV2,
  type CleanupPlanV2,
  type CleanupSnapshotV1,
} from "../cleanupPlan.js";
import type { PlanningProvider, PlanningProviderId } from "../ai/planningProvider.js";
import type { PlanningProviderRegistry } from "../ai/providerRegistry.js";
import type {
  CleanupPlannerPort,
  CleanupPlannerRequest,
  CleanupPlanningResult,
  CleanupPlanSummaryV2,
} from "./cleanupTypes.js";
import { logInfo, logError } from "../utils/logger.js";

export interface CleanupPlanningTransport {
  run(options: {
    provider: PlanningProvider;
    operationId?: string;
    prompt: string;
    signal: AbortSignal;
    onOutput: (text: string) => void;
  }): Promise<string>;
}

export class CleanupPlanner implements CleanupPlannerPort {
  constructor(
    private readonly registry: PlanningProviderRegistry,
    private readonly transport: CleanupPlanningTransport,
  ) {}

  async plan(request: CleanupPlannerRequest): Promise<CleanupPlanningResult> {
    const provider = await this.registry.resolve(request.providerId);
    logInfo("Starting cleanup planning", {
      providerId: request.providerId,
      providerLabel: provider.label,
      snapshotNodeCount: request.snapshot.nodes.length,
    });
    request.onProgress({ state: "planning", message: `Planning with ${provider.label}.` });
    const prompt = buildCleanupPlanV2ReviewTask(request.snapshot, request.providerId);
    const runProvider = (task: string) => this.transport.run({
      provider,
      operationId: request.runId,
      prompt: task,
      signal: request.signal,
      onOutput: (text) => request.onProgress({ state: "planning", message: text }),
    });
    let assistantText = await runProvider(prompt);
    request.onProgress({ state: "validating", message: "Validating cleanup plan." });
    let plan: CleanupPlanV2;
    try {
      plan = validateAssistantCleanupPlan(assistantText, request.snapshot);
      logInfo("Cleanup plan validated successfully", {
        operationCount: plan.operations.length,
        warningCount: plan.warnings.length,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      const validationReason = error instanceof Error ? error.message : String(error);
      const repairReason = normalizeCleanupPlanValidationReason(validationReason);
      logError("Cleanup plan validation failed, attempting repair", { reason: validationReason, repairReason });
      request.onProgress({ state: "planning", message: `Repairing cleanup plan after validation error: ${repairReason}` });
      assistantText = await runProvider(buildCleanupPlanV2RepairTask(prompt, repairReason));
      request.onProgress({ state: "validating", message: "Validating repaired cleanup plan." });
      plan = validateAssistantCleanupPlan(assistantText, request.snapshot);
      logInfo("Repaired cleanup plan validated successfully", {
        operationCount: plan.operations.length,
        warningCount: plan.warnings.length,
      });
    }
    return { plan, summary: buildCleanupPlanV2Summary(plan) };
  }
}

function validateAssistantCleanupPlan(assistantText: string, snapshot: CleanupSnapshotV1): CleanupPlanV2 {
  try {
    return validateCleanupPlanV2(extractCleanupPlan(assistantText), snapshot);
  } catch (error) {
    if (!(error instanceof Error) || !isMissingCleanupPlanMarker(error.message)) throw error;
    const fences = [...assistantText.matchAll(/```([^\r\n]*)\r?\n([\s\S]*?)```/g)];
    if (fences.length !== 1 || fences[0]?.[1]?.trim().toLowerCase() !== "json") throw error;
    const outsideFence = assistantText.replace(fences[0][0], "");
    if (outsideFence.includes("```")) throw error;
    const fencedJson = fences[0]?.[2]?.trim() || "";
    return validateCleanupPlanV2(extractCleanupPlan(`${CleanupPlanMarker}\n${fencedJson}`), snapshot);
  }
}

function normalizeCleanupPlanValidationReason(reason: string): string {
  return isMissingCleanupPlanMarker(reason) ? "missing cleanup plan marker" : reason;
}

function isMissingCleanupPlanMarker(reason: string): boolean {
  return reason === "missing cleanup plan marker" || reason === "缺少清理计划标记";
}

function buildCleanupPlanV2RepairTask(originalTask: string, reason: string): string {
  return [
    originalTask,
    "",
    "## Repair required",
    `The previous response failed validation: ${reason}`,
    "Generate the complete plan again from the supplied snapshot.",
    `Return ${CleanupPlanMarker} followed by exactly one JSON object and no prose or markdown fence.`,
  ].join("\n");
}

export function buildCleanupPlanV2ReviewTask(snapshot: CleanupSnapshotV1, providerId: PlanningProviderId): string {
  const snapshotHash = computeCleanupSnapshotHash(snapshot);

  // 压缩快照：只保留 AI 规划需要的核心字段，减少提示词大小以加速处理
  const compactSnapshot = {
    schemaVersion: snapshot.schemaVersion,
    rootNodeId: snapshot.rootNodeId,
    nodes: snapshot.nodes.map(node => ({
      id: node.id,
      parentId: node.parentId,
      type: node.type,
      name: node.name,
      siblingIndex: node.siblingIndex,
      depth: node.depth,
      visible: node.visible,
      childCount: node.childCount
    }))
  };

  return [
    "# Figma cleanup PlanReview V2",
    "",
    `Planning provider: ${providerId}`,
    "This turn is strictly read-only. Do not call tools, MCP, shell commands, or Figma write operations.",
    "Use only the supplied snapshot. Do not spawn subagents.",
    "Return a bounded preflight audit plan only. In direct cleanup mode, the repository hierarchy-cleanup skill will re-read the live Figma tree and perform its own verified writes; never claim that this audit plan has written Figma.",
    "Do not create Component, ComponentSet, Variant, image, or PSD identity operations.",
    "Do not create single-child groups or wrap an already bracketed semantic container.",
    "Follow the repository figma-hierarchy-cleanup-mcp plugin V2 contract.",
    "Cleanup goal: remove meaningless nesting by creating semantic outer groups and moving the original nodes into them so the hierarchy is readable before Unity import.",
    "Do not rename original nodes. Use the CREATE_GROUP name for semantic naming instead.",
    "Preserve visual appearance, size, absolute position, and sibling stacking order exactly.",
    "Preserve hidden nodes, masks, Instances, PSD metadata, image content, and nine-slice identity.",
    "Treat the root as already organized only when every direct child is already a bracketed semantic container and its hierarchy satisfies the cleanup goal; only then return an empty operations array.",
    "Return exactly one marked JSON object with schemaVersion 2 and no surrounding prose.",
    `snapshotHash must equal: ${snapshotHash}`,
    "Allowed operation types: CREATE_GROUP, REORDER_CHILDREN.",
    "For a grouping plan, use CREATE_GROUP to partition every root direct child exactly once, and keep their flattened order equal to the original sibling order. Never partially group the root. If a complete safe partition is not justified, return an empty plan only when the root already meets the organized-root rule above.",
    "Every operation must include a unique non-empty id. Use sequential ids op-001, op-002, and so on in operation order.",
    "Operation item schemas; every shown field is required:",
    '{"id":"op-001","type":"CREATE_GROUP","parentNodeId":"string","name":"string","childNodeIds":["string","string"]}',
    '{"id":"op-001","type":"REORDER_CHILDREN","parentNodeId":"string","childNodeIds":["string"]}',
    'preconditions may be empty. Each item must be: {"nodeId":"string","parentNodeId":"string","siblingIndex":0}.',
    CleanupPlanMarker,
    '{"schemaVersion":2,"rootNodeId":"string","snapshotHash":"sha256","operations":[],"preconditions":[],"verification":{"preserveAbsoluteBoundsTolerance":0.01},"warnings":[]}',
    "",
    "## Snapshot",
    JSON.stringify(compactSnapshot),
  ].join("\n");
}

export function buildCleanupPlanV2Summary(plan: CleanupPlanV2): CleanupPlanSummaryV2 {
  return {
    operationCount: plan.operations.length,
    operations: plan.operations.map((operation) => ({
      id: operation.id,
      type: operation.type,
      label: "name" in operation ? operation.name : "nodeId" in operation ? operation.nodeId : operation.type,
    })),
    warningCount: plan.warnings.length,
    warnings: [...plan.warnings],
  };
}
