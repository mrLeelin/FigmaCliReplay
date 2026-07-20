import type { CleanupPlanV3, CleanupSnapshotV1 } from "../cleanupPlan.js";
import { getLoggingRuntime } from "../logging/loggingRuntime.js";
import type { CleanupExecutionResult, CleanupExecutorPort } from "./cleanupTypes.js";

export interface ValidatedHierarchyCleanupDispatch {
  runId: string;
  sessionId: string;
  plan: CleanupPlanV3;
  snapshot: CleanupSnapshotV1;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

export interface ConversationCleanupDispatcher {
  dispatchValidatedHierarchyCleanup(request: ValidatedHierarchyCleanupDispatch): Promise<CleanupExecutionResult>;
  dispatchConfirmedComponentSets(request: ValidatedHierarchyCleanupDispatch): Promise<CleanupExecutionResult>;
}

export function createConversationCleanupDispatcher(executor: CleanupExecutorPort): ConversationCleanupDispatcher {
  const logger = getLoggingRuntime().logger("conversation-cleanup-dispatcher");
  return {
    async dispatchValidatedHierarchyCleanup(request): Promise<CleanupExecutionResult> {
      const operation = logger.startOperation("cleanup.conversation-dispatch", "Relay 开始执行已验证的层级整理事务", {
        operationId: request.runId,
        data: {
          sessionId: request.sessionId,
          rootNodeId: request.snapshot.rootNodeId,
          operationCount: request.plan.operations.length,
        },
      });
      try {
        const result = await executor.execute({
          runId: request.runId,
          sessionId: request.sessionId,
          plan: request.plan,
          snapshot: request.snapshot,
          signal: request.signal,
          onProgress: (progress) => request.onProgress(progress.message),
        });
        if (result.state === "succeeded") {
          operation.succeed("Relay 已完成已验证层级整理事务", { state: result.state });
        } else {
          operation.fail(new Error(`cleanup transaction ended as ${result.state}`), "Relay 层级整理事务未成功完成", {
            state: result.state,
          });
        }
        return result;
      } catch (error) {
        operation.fail(error, "Relay 层级整理事务执行异常");
        throw error;
      }
    },
    async dispatchConfirmedComponentSets(request): Promise<CleanupExecutionResult> {
      const operation = logger.startOperation("cleanup.conversation-component-sets", "Relay 开始执行满意确认后的 ComponentSet 变体阶段", {
        operationId: request.runId,
        data: {
          sessionId: request.sessionId,
          rootNodeId: request.snapshot.rootNodeId,
        },
      });
      try {
        const result = await executor.executeComponentSets({
          runId: request.runId,
          sessionId: request.sessionId,
          plan: request.plan,
          snapshot: request.snapshot,
          signal: request.signal,
          onProgress: (progress) => request.onProgress(progress.message),
        });
        if (result.state === "succeeded") {
          operation.succeed("Relay 已完成满意确认后的 ComponentSet 变体阶段", { state: result.state });
        } else {
          operation.fail(new Error(`component-set stage ended as ${result.state}`), "Relay ComponentSet 变体阶段未成功完成", {
            state: result.state,
          });
        }
        return result;
      } catch (error) {
        operation.fail(error, "Relay ComponentSet 变体阶段执行异常");
        throw error;
      }
    },
  };
}
