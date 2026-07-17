import type { PlanningProviderId } from "../ai/planningProvider.js";
import type { CleanupPlanV2, CleanupSnapshotV1 } from "../cleanupPlan.js";

export type CleanupState =
  | "capturing"
  | "planning"
  | "validating"
  | "review"
  | "applying"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rolled_back"
  | "recovery_required";

export interface CleanupProgress {
  message: string;
  state?: CleanupState;
  completed?: number;
  total?: number;
}

export interface CleanupOutputEntry {
  sequence: number;
  at: string;
  stream: "system" | "stdout" | "stderr";
  text: string;
}

export interface CleanupPlanSummaryV2 {
  operationCount: number;
  operations: Array<{ id: string; type: string; label: string }>;
  warningCount: number;
  warnings: string[];
}

export interface StartCleanupRequest {
  sessionId: string;
  providerId: PlanningProviderId;
  snapshot: CleanupSnapshotV1;
}

export interface StartCleanupResponse {
  ok: true;
  runId: string;
  capabilityToken: string;
  providerId: PlanningProviderId;
  state: CleanupState;
}

export interface ApproveCleanupRequest {
  approval: boolean;
  snapshotHash: string;
}

export interface CleanupRunView {
  ok: true;
  runId: string;
  sessionId: string;
  providerId: PlanningProviderId;
  rootNodeId: string;
  snapshotHash: string;
  state: CleanupState;
  planReady: boolean;
  planSummary?: CleanupPlanSummaryV2;
  startedAt: string;
  endedAt?: string;
  cancelRequested: boolean;
  nextSequence: number;
  output: CleanupOutputEntry[];
}

export interface CleanupPlannerRequest {
  runId: string;
  sessionId: string;
  providerId: PlanningProviderId;
  snapshot: CleanupSnapshotV1;
  signal: AbortSignal;
  onProgress: (progress: CleanupProgress) => void;
}

export interface CleanupPlanningResult {
  plan: CleanupPlanV2;
  summary: CleanupPlanSummaryV2;
}

export interface CleanupPlannerPort {
  plan(request: CleanupPlannerRequest): Promise<CleanupPlanningResult>;
}

export interface CleanupExecutorRequest {
  runId: string;
  sessionId: string;
  plan: CleanupPlanV2;
  snapshot: CleanupSnapshotV1;
  signal: AbortSignal;
  onProgress: (progress: CleanupProgress) => void;
}

export interface CleanupExecutionResult {
  state: "succeeded" | "rolled_back" | "recovery_required" | "failed";
  report: Record<string, unknown>;
}

export interface CleanupExecutorPort {
  execute(request: CleanupExecutorRequest): Promise<CleanupExecutionResult>;
}

export class CleanupError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CleanupError";
  }
}

export function isCleanupTerminalState(state: CleanupState): boolean {
  return state === "succeeded"
    || state === "failed"
    || state === "cancelled"
    || state === "rolled_back"
    || state === "recovery_required";
}
