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
import { getLoggingRuntime } from "../logging/loggingRuntime.js";
import type {
  CleanupPlannerPort,
  CleanupPlannerRequest,
  CleanupPlanningResult,
  CleanupPlanSummaryV2,
} from "./cleanupTypes.js";

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
    const operation = getLoggingRuntime().logger("cleanup-planner").startOperation(
      "cleanup.planning",
      "开始生成 Cleanup 计划",
      { operationId: request.runId, data: { providerId: request.providerId } },
    );
    try {
      const provider = await this.registry.resolve(request.providerId);
      operation.step("provider-probe", "Cleanup Provider 已确认可用", { providerId: provider.id });
      request.onProgress({ state: "planning", message: `Planning with ${provider.label}.` });
      const assistantText = await this.transport.run({
        provider,
        operationId: request.runId,
        prompt: buildCleanupPlanV2ReviewTask(request.snapshot, request.providerId),
        signal: request.signal,
        onOutput: (text) => request.onProgress({ state: "planning", message: text }),
      });
      request.onProgress({ state: "validating", message: "Validating cleanup plan." });
      operation.step("verification", "开始校验 Cleanup 计划");
      const plan = validateCleanupPlanV2(extractCleanupPlan(assistantText), request.snapshot);
      operation.succeed("Cleanup 计划生成并校验成功", { operationCount: plan.operations.length });
      return { plan, summary: buildCleanupPlanV2Summary(plan) };
    } catch (error) {
      operation.fail(error, "Cleanup 计划生成失败");
      throw error;
    }
  }
}

export function buildCleanupPlanV2ReviewTask(snapshot: CleanupSnapshotV1, providerId: PlanningProviderId): string {
  const snapshotHash = computeCleanupSnapshotHash(snapshot);
  return [
    "# Figma cleanup PlanReview V2",
    "",
    `Planning provider: ${providerId}`,
    "This turn is strictly read-only. Do not call tools, MCP, shell commands, or Figma write operations.",
    "Use only the supplied snapshot. Do not spawn subagents.",
    "Return the complete hierarchy operation list; approval will execute exactly this list and nothing else.",
    "Do not create Component, ComponentSet, Variant, image, or PSD identity operations.",
    "Do not create single-child groups or wrap an already bracketed semantic container.",
    "If the root is already organized, return an empty operations array.",
    "Return exactly one marked JSON object with schemaVersion 2 and no surrounding prose.",
    `snapshotHash must equal: ${snapshotHash}`,
    "Allowed operation types: CREATE_GROUP, RENAME_NODE, MOVE_NODE, REORDER_CHILDREN, SET_AUTO_LAYOUT.",
    CleanupPlanMarker,
    '{"schemaVersion":2,"rootNodeId":"string","snapshotHash":"sha256","operations":[],"preconditions":[],"verification":{"preserveAbsoluteBoundsTolerance":0.01},"warnings":[]}',
    "",
    "## Snapshot",
    JSON.stringify(snapshot),
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

