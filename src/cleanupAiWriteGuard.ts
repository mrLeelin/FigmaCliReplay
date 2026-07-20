import { getLoggingRuntime } from "./logging/loggingRuntime.js";

export type CleanupAiWritePhase =
  | "analysis"
  | "awaiting_plan_confirmation"
  | "hierarchy"
  | "awaiting_satisfaction"
  | "variants"
  | "finished"
  | "failed"
  | "cancelled";

interface CleanupAiWriteGuardRecord {
  runId: string;
  phase: CleanupAiWritePhase;
  successfulWrites: number;
  failedWrites: number;
  lastWriteJobType?: string;
  lastWriteRequestId?: string;
}

export interface CleanupAiWriteEvidence {
  runId: string;
  phase: CleanupAiWritePhase;
  successfulWrites: number;
  failedWrites: number;
  lastWriteJobType?: string;
  lastWriteRequestId?: string;
}

const guards = new Map<string, CleanupAiWriteGuardRecord>();
const guardLogger = getLoggingRuntime().logger("cleanup-ai-write-guard");

const ReadOnlyJobTypes = new Set([
  "QUERY_SELECTION",
  "QUERY_PLUGIN_STATUS",
  "QUERY_NODE_CHILDREN",
  "QUERY_FIGMA_PAGES",
  "QUERY_CLEANUP_SNAPSHOT",
  "COLLECT_COMPONENTS",
  "FIGMA_HIERARCHY_CLEANUP_ANALYZE",
  "FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE",
  "FIGMA_EXPORT_NODE_SCREENSHOT",
]);

const HierarchyJobTypes = new Set([
  "FIGMA_HIERARCHY_CLEANUP_APPLY",
  "FIGMA_HIERARCHY_CLEANUP_TRANSACTION",
  "FIGMA_HIERARCHY_BATCH_APPLY",
  "FIGMA_HIERARCHY_REORDER_CHILDREN",
  "FIGMA_HIERARCHY_MOVE_NODES",
  "FIGMA_HIERARCHY_SET_NODE_POSITIONS",
  "FIGMA_HIERARCHY_WRAP_CHAIN",
]);

const VariantJobTypes = new Set([
  "FIGMA_CREATE_COMPONENT_SET_VARIANTS",
  "FIGMA_ADD_COMPONENT_SET_VARIANTS",
  "FIGMA_CREATE_COMPONENT_FROM_SELECTION",
  "FIGMA_REBUILD_COMPONENT_SET_FROM_SIBLINGS",
  "FIGMA_CREATE_COMPONENT_SET_FROM_NODE_GROUPS",
]);

export function beginCleanupAiWriteGuard(sessionId: string, runId: string): void {
  const key = required(sessionId, "cleanup AI sessionId");
  const ownerRunId = required(runId, "cleanup AI runId");
  guards.set(key, { runId: ownerRunId, phase: "analysis", successfulWrites: 0, failedWrites: 0 });
  guardLogger.info("AI 整理写入闸门已启用，首轮限定为只读分析", {
    sessionId: key,
    runId: ownerRunId,
    phase: "analysis",
  }, { operationId: ownerRunId, operationName: "cleanup.ai-write-guard" });
}

export function setCleanupAiWritePhase(
  sessionId: string,
  runId: string,
  phase: CleanupAiWritePhase,
): void {
  const key = required(sessionId, "cleanup AI sessionId");
  const guard = guards.get(key);
  if (!guard || guard.runId !== required(runId, "cleanup AI runId")) {
    throw new Error("cleanup AI write guard ownership mismatch");
  }
  const previousPhase = guard.phase;
  guard.phase = phase;
  if (previousPhase !== phase) {
    guard.successfulWrites = 0;
    guard.failedWrites = 0;
    guard.lastWriteJobType = undefined;
    guard.lastWriteRequestId = undefined;
  }
  guardLogger.info("AI 整理写入闸门阶段已更新", {
    sessionId: key,
    runId: guard.runId,
    previousPhase,
    phase,
  }, { operationId: guard.runId, operationName: "cleanup.ai-write-guard" });
}

export function endCleanupAiWriteGuard(sessionId: string, runId: string): void {
  const key = required(sessionId, "cleanup AI sessionId");
  const guard = guards.get(key);
  if (guard?.runId === required(runId, "cleanup AI runId")) {
    guards.delete(key);
    guardLogger.info("AI 整理写入闸门已关闭", {
      sessionId: key,
      runId: guard.runId,
      finalPhase: guard.phase,
    }, { operationId: guard.runId, operationName: "cleanup.ai-write-guard" });
  }
}

export function cleanupAiWritePhase(sessionId: string): CleanupAiWritePhase | undefined {
  return guards.get(String(sessionId || "").trim())?.phase;
}

export function cleanupAiWriteEvidence(sessionId: string, runId: string): CleanupAiWriteEvidence | undefined {
  const key = String(sessionId || "").trim();
  const guard = guards.get(key);
  if (!guard || guard.runId !== String(runId || "").trim()) return undefined;
  return { ...guard };
}

export function recordCleanupAiJobResult(
  jobTypeValue: unknown,
  sessionIdValue: unknown,
  succeeded: boolean,
  requestIdValue?: unknown,
): void {
  const jobType = String(jobTypeValue || "").trim();
  const sessionId = typeof sessionIdValue === "string" ? sessionIdValue.trim() : "";
  const guard = guards.get(sessionId);
  if (!guard) return;
  const isPhaseWrite = (guard.phase === "hierarchy" && HierarchyJobTypes.has(jobType))
    || (guard.phase === "variants" && VariantJobTypes.has(jobType));
  if (!isPhaseWrite) return;

  if (succeeded) guard.successfulWrites += 1;
  else guard.failedWrites += 1;
  guard.lastWriteJobType = jobType;
  guard.lastWriteRequestId = String(requestIdValue || "").trim() || undefined;
  guardLogger.info(succeeded ? "AI 整理写入结果已计入阶段成功证据" : "AI 整理写入失败已记录但不会计入成功证据", {
    sessionId,
    runId: guard.runId,
    phase: guard.phase,
    jobType,
    requestId: guard.lastWriteRequestId || "",
    succeeded,
    successfulWrites: guard.successfulWrites,
    failedWrites: guard.failedWrites,
  }, { operationId: guard.runId, operationName: "cleanup.ai-write-guard" });
}

export function assertCleanupAiPhaseWriteEvidence(
  sessionId: string,
  runId: string,
  phase: "hierarchy" | "variants",
): void {
  const key = required(sessionId, "cleanup AI sessionId");
  const ownerRunId = required(runId, "cleanup AI runId");
  const guard = guards.get(key);
  if (!guard || guard.runId !== ownerRunId) throw new Error("cleanup AI write evidence ownership mismatch");
  if (guard.phase !== phase) throw new Error(`cleanup AI write evidence phase mismatch: expected ${phase}, actual ${guard.phase}`);
  if (guard.successfulWrites > 0) return;
  const error = new Error(`cleanup AI ${phase} phase has no successful Figma write evidence`);
  guardLogger.error("AI 整理回合没有成功写入证据，拒绝推进阶段", error, {
    sessionId: key,
    runId: ownerRunId,
    phase,
    successfulWrites: guard.successfulWrites,
    failedWrites: guard.failedWrites,
    lastWriteJobType: guard.lastWriteJobType || "",
    lastWriteRequestId: guard.lastWriteRequestId || "",
  }, { operationId: ownerRunId, operationName: "cleanup.ai-write-guard" });
  throw error;
}

export function assertCleanupAiJobAllowed(jobTypeValue: unknown, sessionIdValue: unknown): void {
  const jobType = String(jobTypeValue || "").trim();
  if (ReadOnlyJobTypes.has(jobType)) return;

  const sessionId = typeof sessionIdValue === "string" ? sessionIdValue.trim() : "";
  if (!sessionId) {
    if (guards.size > 0) {
      throw new Error(blockedTargetMessage(jobType, "cleanup AI write guard requires an explicit target session for every mutation"));
    }
    return;
  }
  const guard = guards.get(sessionId);
  if (!guard) {
    if (guards.size > 0) {
      throw new Error(blockedTargetMessage(jobType, `mutation target is outside the active cleanup AI session: ${sessionId}`));
    }
    return;
  }

  if (guard.phase === "hierarchy" && HierarchyJobTypes.has(jobType)) return;
  if (guard.phase === "variants" && VariantJobTypes.has(jobType)) return;

  if (guard.phase === "analysis" || guard.phase === "awaiting_plan_confirmation") {
    throw new Error(blockedMessage(guard, sessionId, jobType, "cleanup AI is read-only before plan confirmation"));
  }
  if (guard.phase === "hierarchy") {
    throw new Error(blockedMessage(guard, sessionId, jobType, "cleanup AI hierarchy phase cannot run component or unrelated jobs"));
  }
  if (guard.phase === "awaiting_satisfaction") {
    throw new Error(blockedMessage(guard, sessionId, jobType, "cleanup AI is waiting for explicit satisfaction"));
  }
  if (guard.phase === "variants") {
    throw new Error(blockedMessage(guard, sessionId, jobType, "cleanup AI variant phase cannot run unrelated jobs"));
  }
  throw new Error(blockedMessage(guard, sessionId, jobType, `cleanup AI ${guard.phase} phase does not permit Figma writes`));
}

function blockedMessage(
  guard: CleanupAiWriteGuardRecord,
  sessionId: string,
  jobType: string,
  reason: string,
): string {
  const message = `${reason}; runId=${guard.runId}; sessionId=${sessionId}; phase=${guard.phase}; jobType=${jobType || "unknown"}`;
  guardLogger.warn("AI 整理写入被阶段闸门拒绝", {
    runId: guard.runId,
    sessionId,
    phase: guard.phase,
    jobType: jobType || "unknown",
    reason,
  }, { operationId: guard.runId, operationName: "cleanup.ai-write-guard" });
  return message;
}

function blockedTargetMessage(jobType: string, reason: string): string {
  const active = guards.entries().next().value as [string, CleanupAiWriteGuardRecord] | undefined;
  const activeSessionId = active?.[0] || "unknown";
  const activeGuard = active?.[1];
  guardLogger.warn("AI 整理写入因目标会话不匹配被拒绝", {
    runId: activeGuard?.runId || "unknown",
    activeSessionId,
    phase: activeGuard?.phase || "unknown",
    jobType: jobType || "unknown",
    reason,
  }, activeGuard ? { operationId: activeGuard.runId, operationName: "cleanup.ai-write-guard" } : undefined);
  return `${reason}; runId=${activeGuard?.runId || "unknown"}; activeSessionId=${activeSessionId}; phase=${activeGuard?.phase || "unknown"}; jobType=${jobType || "unknown"}`;
}

function required(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}
