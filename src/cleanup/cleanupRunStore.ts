import { randomBytes } from "node:crypto";

import type { PlanningProviderId } from "../ai/planningProvider.js";
import type { CleanupPlanV2, CleanupSnapshotV1 } from "../cleanupPlan.js";
import { getLoggingRuntime } from "../logging/loggingRuntime.js";
import type { RelayLogger } from "../logging/relayLogger.js";
import {
  CleanupError,
  isCleanupTerminalState,
  type CleanupOutputEntry,
  type CleanupPlanSummaryV2,
  type CleanupState,
} from "./cleanupTypes.js";

export interface CleanupRunRecord {
  runId: string;
  capabilityToken: string;
  sessionId: string;
  providerId: PlanningProviderId;
  rootNodeId: string;
  snapshotHash: string;
  snapshot: CleanupSnapshotV1;
  state: CleanupState;
  planReady: boolean;
  autoApproved: boolean;
  plan?: CleanupPlanV2;
  planSummary?: CleanupPlanSummaryV2;
  startedAt: string;
  endedAt?: string;
  output: CleanupOutputEntry[];
  nextSequence: number;
  abortController: AbortController;
  cancelRequested: boolean;
}

export interface CleanupRunStoreOptions {
  now?: () => Date;
  randomToken?: (bytes: number) => string;
  maxOutputEntries?: number;
}

export class CleanupRunStore {
  private readonly runs = new Map<string, CleanupRunRecord>();
  private readonly activeBySession = new Map<string, string>();
  private readonly activeByRoot = new Map<string, string>();
  private readonly now: () => Date;
  private readonly randomToken: (bytes: number) => string;
  private readonly maxOutputEntries: number;
  private readonly logger: RelayLogger;

  constructor(options: CleanupRunStoreOptions = {}) {
    this.now = options.now || (() => new Date());
    this.randomToken = options.randomToken || ((bytes) => randomBytes(bytes).toString("base64url"));
    this.maxOutputEntries = options.maxOutputEntries ?? 800;
    this.logger = getLoggingRuntime().logger("cleanup-run-store");
  }

  create(options: {
    sessionId: string;
    providerId: PlanningProviderId;
    snapshot: CleanupSnapshotV1;
    snapshotHash: string;
    autoApprove?: boolean;
  }): CleanupRunRecord {
    if (this.activeBySession.has(options.sessionId)) {
      throw new CleanupError("CLEANUP_ALREADY_RUNNING", "the Figma plugin session already owns an active cleanup run");
    }
    const rootLock = `${options.sessionId}:${options.snapshot.rootNodeId}`;
    if (this.activeByRoot.has(rootLock)) {
      throw new CleanupError("CLEANUP_ALREADY_RUNNING", "the selected root already has an active cleanup run");
    }
    const startedAt = this.now().toISOString();
    const runId = `cleanup-${this.now().getTime()}-${this.randomToken(4)}`;
    const run: CleanupRunRecord = {
      runId,
      capabilityToken: this.randomToken(32),
      sessionId: options.sessionId,
      providerId: options.providerId,
      rootNodeId: options.snapshot.rootNodeId,
      snapshotHash: options.snapshotHash,
      snapshot: options.snapshot,
      state: "planning",
      planReady: false,
      autoApproved: options.autoApprove === true,
      startedAt,
      output: [],
      nextSequence: 1,
      abortController: new AbortController(),
      cancelRequested: false,
    };
    this.runs.set(runId, run);
    this.activeBySession.set(options.sessionId, runId);
    this.activeByRoot.set(rootLock, runId);
    this.logger.info("Cleanup 运行记录已创建", {
      state: "planning",
      providerId: run.providerId,
      rootNodeId: run.rootNodeId
    }, { operationId: run.runId, operationName: "cleanup.run" });
    return run;
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  get(runId: string): CleanupRunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new CleanupError("CLEANUP_RUN_NOT_FOUND", "unknown cleanup run");
    return run;
  }

  authorised(runId: string, capabilityToken: string): CleanupRunRecord {
    const run = this.get(runId);
    if (!capabilityToken || capabilityToken !== run.capabilityToken) {
      throw new CleanupError("CLEANUP_CAPABILITY_INVALID", "invalid cleanup run capability");
    }
    return run;
  }

  addOutput(run: CleanupRunRecord, stream: CleanupOutputEntry["stream"], text: string): void {
    run.output.push({ sequence: run.nextSequence++, at: this.now().toISOString(), stream, text });
    if (run.output.length > this.maxOutputEntries) run.output.splice(0, run.output.length - this.maxOutputEntries);
  }

  finish(run: CleanupRunRecord, state: CleanupState): void {
    const previousState = run.state;
    run.state = state;
    this.logger.info("Cleanup 状态已更新", {
      previousState,
      state,
      terminal: isCleanupTerminalState(state)
    }, { operationId: run.runId, operationName: "cleanup.run" });
    if (isCleanupTerminalState(state)) {
      run.endedAt = this.now().toISOString();
      this.release(run);
    }
  }

  release(run: CleanupRunRecord): void {
    if (this.activeBySession.get(run.sessionId) === run.runId) this.activeBySession.delete(run.sessionId);
    const rootLock = `${run.sessionId}:${run.rootNodeId}`;
    if (this.activeByRoot.get(rootLock) === run.runId) this.activeByRoot.delete(rootLock);
  }

  runsForSession(sessionId: string): CleanupRunRecord[] {
    return [...this.runs.values()].filter((run) => run.sessionId === sessionId);
  }
}
