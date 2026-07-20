import type { CleanupPlanV3, CleanupSnapshotV1 } from "../cleanupPlan.js";
import type { PlanningProvider, PlanningProviderId } from "../ai/planningProvider.js";
import type { PlanningProviderRegistry } from "../ai/providerRegistry.js";
import { getLoggingRuntime } from "../logging/loggingRuntime.js";
import type {
  CleanupPlannerPort,
  CleanupPlannerRequest,
  CleanupPlanningResult,
  CleanupPlanSummaryV2,
} from "./cleanupTypes.js";
import {
  CleanupSkillDecisionMarker,
  buildCleanupSkillDecisionRepairTask,
  buildCleanupSkillDecisionTask,
  compileSkillConstrainedCleanupPlan,
  extractCleanupSkillDecision,
} from "./skillConstrainedPlan.js";

export interface CleanupPlanningTransport {
  run(options: {
    provider: PlanningProvider;
    operationId?: string;
    prompt: string;
    signal: AbortSignal;
    onOutput: (text: string) => void;
  }): Promise<string>;
}

/**
 * The provider may choose semantic names and range boundaries only. Node IDs,
 * parent references, ordering, preconditions, and write operations are built
 * locally from the live snapshot and cannot be supplied by the model.
 */
export class CleanupPlanner implements CleanupPlannerPort {
  constructor(
    private readonly registry: PlanningProviderRegistry,
    private readonly transport: CleanupPlanningTransport,
  ) {}

  async plan(request: CleanupPlannerRequest): Promise<CleanupPlanningResult> {
    const provider = await this.registry.resolve(request.providerId);
    const operation = getLoggingRuntime().logger("cleanup-skill-planner").startOperation(
      "cleanup.skill-constrained-planning",
      "开始生成受 Skill 强约束的 Cleanup 语义决策",
      {
        operationId: request.runId,
        data: {
          providerId: request.providerId,
          providerLabel: provider.label,
          rootNodeId: request.snapshot.rootNodeId,
          snapshotNodeCount: request.snapshot.nodes.length,
        },
      },
    );
    request.onProgress({ state: "planning", message: `Planning with ${provider.label}.` });
    const task = buildCleanupSkillDecisionTask(request.snapshot, request.providerId);
    try {
      operation.step("provider-request", "已发送仅含根直接子序列的 Skill 决策任务", {
        promptChars: task.length,
      });
      const assistantText = await this.transport.run({
        provider,
        operationId: request.runId,
        prompt: task,
        signal: request.signal,
        onOutput: (text) => request.onProgress({ state: "planning", message: text }),
      });
      operation.step("provider-response", "已接收 AI 规划响应，准备解析受约束的语义决策", {
        outputChars: assistantText.length,
        decisionMarkerCount: assistantText.split(CleanupSkillDecisionMarker).length - 1,
        startsWithJsonFence: /^\s*```(?:json)?/i.test(assistantText.slice(assistantText.indexOf(CleanupSkillDecisionMarker) + CleanupSkillDecisionMarker.length)),
      });
      request.onProgress({ state: "validating", message: "Compiling skill-constrained cleanup transaction." });
      const decision = extractCleanupSkillDecision(assistantText);
      operation.step("decision-received", "AI 已返回无节点 ID 的语义范围决策", {
        outputChars: assistantText.length,
      });
      let plan: CleanupPlanV3;
      try {
        plan = compileSkillConstrainedCleanupPlan(decision, request.snapshot);
      } catch (compilerError) {
        const compilerMessage = compilerError instanceof Error ? compilerError.message : String(compilerError);
        operation.step("structural-repair", "语义决策未满足 Skill 结构规则，开始一次受约束的自动纠偏", {
          compilerMessage,
        });
        request.onProgress({ state: "planning", message: "Refining the skill decision after a structural check." });
        const repairTask = buildCleanupSkillDecisionRepairTask(request.snapshot, request.providerId, decision, compilerError);
        operation.step("repair-provider-request", "已发送仅含语义范围树和编译错误的一次纠偏任务", {
          promptChars: repairTask.length,
        });
        const repairText = await this.transport.run({
          provider,
          operationId: request.runId,
          prompt: repairTask,
          signal: request.signal,
          onOutput: (text) => request.onProgress({ state: "planning", message: text }),
        });
        operation.step("repair-provider-response", "已接收自动纠偏响应，准备再次执行本地编译", {
          outputChars: repairText.length,
          decisionMarkerCount: repairText.split(CleanupSkillDecisionMarker).length - 1,
        });
        const repairedDecision = extractCleanupSkillDecision(repairText);
        operation.step("repair-decision-received", "已收到替换后的无节点 ID 语义范围树", {
          outputChars: repairText.length,
        });
        plan = compileSkillConstrainedCleanupPlan(repairedDecision, request.snapshot);
      }
      operation.step("transaction-compiled", "Skill 编译器已生成精确层级事务", {
        schemaVersion: plan.schemaVersion,
        operationCount: plan.operations.length,
        warningCount: plan.warnings.length,
      });
      operation.succeed("受 Skill 强约束的 Cleanup 计划已生成并校验完成");
      return { plan, summary: buildCleanupPlanV2Summary(plan) };
    } catch (error) {
      if (!operation.completed) operation.fail(error, "Skill 决策未通过编译，已阻止任何未验证写入");
      throw error;
    }
  }
}

/** Kept as an export for callers; it now returns the V3 skill-decision task. */
export function buildCleanupPlanV2ReviewTask(snapshot: CleanupSnapshotV1, providerId: PlanningProviderId): string {
  return buildCleanupSkillDecisionTask(snapshot, providerId);
}

export function buildCleanupPlanV2Summary(plan: CleanupPlanV3): CleanupPlanSummaryV2 {
  return {
    operationCount: plan.operations.length,
    operations: plan.operations.map((operation) => ({
      id: operation.id,
      type: operation.type,
      label: "name" in operation ? operation.name : operation.type,
    })),
    warningCount: plan.warnings.length,
    warnings: [...plan.warnings],
  };
}
