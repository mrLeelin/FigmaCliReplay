import { computeCleanupSnapshotHash, validateCleanupPlanV2 } from "../cleanupPlan.js";
import type { PlanningProviderId } from "../ai/planningProvider.js";
import { getLoggingRuntime } from "../logging/loggingRuntime.js";
import type { OperationScope } from "../logging/operationScope.js";
import { CleanupRunStore, type CleanupRunRecord } from "./cleanupRunStore.js";
import {
  CleanupError,
  isCleanupTerminalState,
  type ApproveCleanupRequest,
  type CleanupExecutorPort,
  type CleanupPlannerPort,
  type CleanupProgress,
  type CleanupRunView,
  type StartCleanupRequest,
  type StartCleanupResponse,
} from "./cleanupTypes.js";

export interface CleanupControllerDependencies {
  planner: CleanupPlannerPort;
  executor: CleanupExecutorPort;
  store?: CleanupRunStore;
}

export interface CleanupController {
  start(request: StartCleanupRequest): Promise<StartCleanupResponse>;
  get(runId: string, capabilityToken: string, afterSequence?: number): CleanupRunView;
  approve(runId: string, capabilityToken: string, request: ApproveCleanupRequest): CleanupRunView;
  cancel(runId: string, capabilityToken: string): CleanupRunView;
  stopForSession(sessionId: string, reason: string): number;
  waitForPlanning(runId: string): Promise<void>;
  waitForExecution(runId: string): Promise<void>;
  has(runId: string): boolean;
}

export function createCleanupController(dependencies: CleanupControllerDependencies): CleanupController {
  const store = dependencies.store || new CleanupRunStore();
  const planningTasks = new Map<string, Promise<void>>();
  const executionTasks = new Map<string, Promise<void>>();
  const operations = new Map<string, OperationScope>();
  const logger = getLoggingRuntime().logger("cleanup-controller");

  function progress(run: CleanupRunRecord, value: CleanupProgress): void {
    if (value.state === "validating" && (run.state === "planning" || run.state === "validating")) {
      transition(run, ["planning", "validating"], "validating");
    }
    if (value.state === "verifying" && (run.state === "applying" || run.state === "verifying")) {
      transition(run, ["applying", "verifying"], "verifying");
      operations.get(run.runId)?.step("verification", "开始验证 Cleanup 执行结果", {
        completed: value.completed,
        total: value.total
      });
    }
    if (value.state === "rolled_back" || value.state === "recovery_required") {
      operations.get(run.runId)?.step("rollback", "Cleanup 执行进入回滚或恢复状态", {
        state: value.state
      }, "warn");
    }
    store.addOutput(run, "system", value.message);
  }

  async function start(request: StartCleanupRequest): Promise<StartCleanupResponse> {
    const sessionId = requiredString(request?.sessionId, "cleanup sessionId");
    const providerId = requiredProviderId(request?.providerId);
    assertCleanupSnapshotHasNoRecoveryNodes(request?.snapshot);
    const snapshotHash = computeCleanupSnapshotHash(request?.snapshot);
    const run = store.create({ sessionId, providerId, snapshot: request.snapshot, snapshotHash });
    const operation = logger.startOperation("cleanup.run", "开始 Cleanup 操作", {
      operationId: run.runId,
      data: { providerId, rootNodeId: run.rootNodeId }
    });
    operations.set(run.runId, operation);
    operation.step("planning", "开始生成 Cleanup 计划", { providerId });
    store.addOutput(run, "system", `Cleanup planning started with ${providerId}.`);
    const task = Promise.resolve()
      .then(() => dependencies.planner.plan({
        runId: run.runId,
        sessionId: run.sessionId,
        providerId: run.providerId,
        snapshot: run.snapshot,
        signal: run.abortController.signal,
        onProgress: (value) => progress(run, value),
      }))
      .then((result) => {
        if (run.state === "cancelled") return;
        transition(run, ["planning", "validating"], "validating");
        run.plan = validateCleanupPlanV2(result.plan, run.snapshot);
        run.planSummary = result.summary;
        run.planReady = true;
        transition(run, ["validating"], "review");
        operation.step("planning", "Cleanup 计划生成并校验完成", {
          operationCount: result.summary.operationCount
        });
        store.addOutput(run, "system", `Cleanup plan validated: ${result.summary.operationCount} operations.`);
      })
      .catch((error) => {
        if (run.state === "cancelled") return;
        run.planReady = false;
        store.addOutput(run, "stderr", error instanceof Error ? error.message : String(error));
        store.finish(run, "failed");
        operation.fail(error, "Cleanup 计划生成失败");
        operations.delete(run.runId);
      });
    planningTasks.set(run.runId, task);
    return { ok: true, runId: run.runId, capabilityToken: run.capabilityToken, providerId, state: run.state };
  }

  function get(runId: string, capabilityToken: string, afterSequence = 0): CleanupRunView {
    return view(store.authorised(runId, capabilityToken), afterSequence);
  }

  function approve(runId: string, capabilityToken: string, request: ApproveCleanupRequest): CleanupRunView {
    const run = store.authorised(runId, capabilityToken);
    if (request?.approval !== true) throw new CleanupError("CLEANUP_APPROVAL_REQUIRED", "explicit cleanup approval is required");
    if (run.state !== "review" || !run.planReady || !run.plan) {
      throw new CleanupError("CLEANUP_NOT_REVIEWABLE", "cleanup approval requires a validated review plan");
    }
    if (request.snapshotHash !== run.snapshotHash) {
      throw new CleanupError("SNAPSHOT_CHANGED", "the approved snapshot hash does not match the planned snapshot");
    }
    run.abortController = new AbortController();
    operations.get(run.runId)?.step("approval", "Cleanup 计划已获得明确批准", {
      snapshotHash: run.snapshotHash
    });
    transition(run, ["review"], "applying");
    operations.get(run.runId)?.step("execution", "开始执行 Cleanup 计划");
    store.addOutput(run, "system", "Cleanup apply started from the approved exact plan.");
    const task = Promise.resolve().then(() => dependencies.executor.execute({
      runId: run.runId,
      sessionId: run.sessionId,
      plan: run.plan!,
      snapshot: run.snapshot,
      signal: run.abortController.signal,
      onProgress: (value) => progress(run, value),
    })).then((result) => {
      store.addOutput(run, "system", `Cleanup execution ended as ${result.state}.`);
      store.finish(run, result.state);
      const operation = operations.get(run.runId);
      if (result.state === "succeeded") {
        operation?.succeed("Cleanup 操作执行成功", { state: result.state });
      } else {
        operation?.step("rollback", "Cleanup 操作未成功完成", { state: result.state }, "warn");
        operation?.fail(new Error(`cleanup ended as ${result.state}`), "Cleanup 操作执行失败", {
          state: result.state
        });
      }
      operations.delete(run.runId);
    }).catch((error) => {
      store.addOutput(run, "stderr", error instanceof Error ? error.message : String(error));
      store.finish(run, "failed");
      operations.get(run.runId)?.fail(error, "Cleanup 执行异常");
      operations.delete(run.runId);
    });
    executionTasks.set(run.runId, task);
    return view(run, 0);
  }

  function cancel(runId: string, capabilityToken: string): CleanupRunView {
    const run = store.authorised(runId, capabilityToken);
    if (isCleanupTerminalState(run.state)) return view(run, 0);
    run.cancelRequested = true;
    run.abortController.abort();
    operations.get(run.runId)?.step("cancel", "收到 Cleanup 取消请求", undefined, "warn");
    store.addOutput(run, "system", "Cleanup cancellation requested.");
    if (run.state === "planning" || run.state === "validating" || run.state === "review") {
      run.planReady = false;
      run.plan = undefined;
      run.planSummary = undefined;
      store.finish(run, "cancelled");
      operations.get(run.runId)?.cancel("Cleanup 操作已取消");
      operations.delete(run.runId);
    }
    return view(run, 0);
  }

  function stopForSession(sessionId: string, reason: string): number {
    let stopped = 0;
    for (const run of store.runsForSession(sessionId)) {
      if (isCleanupTerminalState(run.state)) continue;
      store.addOutput(run, "system", reason);
      cancel(run.runId, run.capabilityToken);
      stopped += 1;
    }
    return stopped;
  }

  return {
    start,
    get,
    approve,
    cancel,
    stopForSession,
    async waitForPlanning(runId: string): Promise<void> {
      await planningTasks.get(runId);
    },
    async waitForExecution(runId: string): Promise<void> {
      await executionTasks.get(runId);
    },
    has(runId: string): boolean {
      return store.has(runId);
    },
  };
}

function view(run: CleanupRunRecord, afterSequence: number): CleanupRunView {
  return {
    ok: true,
    runId: run.runId,
    sessionId: run.sessionId,
    providerId: run.providerId,
    rootNodeId: run.rootNodeId,
    snapshotHash: run.snapshotHash,
    state: run.state,
    planReady: run.planReady,
    ...(run.planSummary ? { planSummary: run.planSummary } : {}),
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    cancelRequested: run.cancelRequested,
    nextSequence: run.nextSequence,
    output: run.output.filter((entry) => entry.sequence > afterSequence).slice(0, 200),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CleanupError("CLEANUP_REQUEST_INVALID", `${label} is required`);
  return value.trim();
}

function assertCleanupSnapshotHasNoRecoveryNodes(snapshot: StartCleanupRequest["snapshot"] | undefined): void {
  const nodes = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const recoveryNode = nodes.find((node) => typeof node?.name === "string" && node.name.startsWith("__cleanup_backup__"));
  if (recoveryNode) {
    throw new CleanupError("CLEANUP_RECOVERY_REQUIRED", "resolve or delete the hidden cleanup recovery backup before starting a new cleanup");
  }
}

function transition(run: CleanupRunRecord, expected: CleanupRunRecord["state"][], next: CleanupRunRecord["state"]): void {
  if (!expected.includes(run.state)) {
    throw new CleanupError("CLEANUP_STATE_INVALID", `cannot transition cleanup from ${run.state} to ${next}`);
  }
  run.state = next;
}

function requiredProviderId(value: unknown): PlanningProviderId {
  if (value === "codex" || value === "claude-code") return value;
  throw new CleanupError("PROVIDER_UNAVAILABLE", `unknown planning provider: ${String(value || "missing")}`);
}
