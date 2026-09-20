import fs from "node:fs";
import { spawn } from "node:child_process";
import { startFigmaPrefabImportTask, getFigmaPrefabImportTask } from "./figmaPrefabImportTask.js";
import type { UnityProjectRegistry } from "./unityProjectRegistry.js";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { GatewayConfig } from "./config.js";
import { LOCAL_DIR, PLUGIN_ROOT, publicUrl } from "./config.js";
import { getLoggingRuntime, type LoggingRuntime } from "./logging/loggingRuntime.js";
import { assertCleanupAiJobAllowed, recordCleanupAiJobResult } from "./cleanupAiWriteGuard.js";
import type { OperationScope } from "./logging/operationScope.js";
import type { RelayLogger } from "./logging/relayLogger.js";
import { logInfo, logWarn } from "./utils/logger.js";
import type { PythonAlgorithms } from "./pythonAlgorithms.js";
import { startPsdImportTask, getPsdImportTask, applyPsdImportTask, adoptPsdImportBaseline, cancelPsdImportTask } from "./psdImportTask.js";
import type { JsonObject, AlgorithmStatus, RelayJob } from "./types.js";
import { constantTimeEqual, isRecord, makeRequestId, sleep, validOperationId } from "./utils.js";
import type { WebSocketGateway } from "./websocketGateway.js";

const DONE_JOB_TTL_MS = 10 * 60 * 1000;
const PENDING_JOB_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 1000;
const JOB_LEASE_MS = 5 * 60 * 1000;
const RECONNECT_GRACE_MS = 30_000;

export interface RelayStatus {
  status: "ok";
  mode: "node-gateway";
  pending: number;
  done: number;
  total: number;
  uptimeSeconds: number;
  publicUrl: string;
  transport: string;
  assetRoots: string[];
  adminTokenRequired: boolean;
  plugin: ReturnType<WebSocketGateway["status"]>;
  algorithms: AlgorithmStatus;
}

export class RuntimeRelay {
  private readonly jobs = new Map<string, RelayJob>();
  private readonly startedAt = Date.now();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly operations = new Map<string, OperationScope>();
  private readonly operationLogger: RelayLogger;

  constructor(
    private readonly config: GatewayConfig,
    private readonly gateway: WebSocketGateway,
    private readonly algorithms: PythonAlgorithms,
    logging: LoggingRuntime = getLoggingRuntime()
  ) {
    this.operationLogger = logging.logger("runtime-relay");
    this.gateway.onReceived((requestId, operationId) => this.markWebSocketReceived(requestId, operationId));
    this.gateway.onUndelivered((requestId, reason) => this.markWebSocketUndelivered(requestId, reason));
    this.gateway.onResult((requestId, result) => {
      const job = this.jobs.get(requestId);
      if (!job || job.requiredTransport !== "websocket") return false;
      if (job.result) {
        this.operationLogger.info("Acknowledged repeated WebSocket result without rewriting the stored result", { requestId }, {
          operationId: job.operationId,
          operationName: "relay.job",
        });
        return true;
      }
      return this.setResult(requestId, result);
    });
    this.gateway.onTaskControl((action, payload, sessionId) => this.handleTaskControl(action, payload, sessionId));
    this.cleanupTimer = setInterval(() => this.cleanupJobs(), CLEANUP_INTERVAL_MS);
  }

  get publicUrl(): string {
    return publicUrl(this.config);
  }

  submitJob(payload: unknown, options?: { transport: "websocket" }): JsonObject {
    if (!isRecord(payload)) {
      throw new Error("json body must be object");
    }
    const requestId = makeRequestId(payload.requestId);
    const operationId = validOperationId(payload.operationId) ?? requestId;
    const jobPayload = payload.job;
    if (!isRecord(jobPayload)) {
      throw new Error("missing job object");
    }

    const existing = this.jobs.get(requestId);
    if (existing) {
      const target = parseTarget(payload, jobPayload);
      const candidate = rewriteAssetUrls({ ...jobPayload }, requestId, this.publicUrl);
      if (!isDeepStrictEqual(existing.job, candidate)
        || (target.sessionId && existing.targetSessionId !== target.sessionId) || (target.fileKey && existing.targetFileKey !== target.fileKey)
        || !isDeepStrictEqual(existing.assetPaths, parseAssetPaths(payload.assetPaths, this.config.assetRoots))) {
        throw new Error(`requestId conflict: job payload or target differs: ${requestId}`);
      }
      this.operationLogger.info("Existing task returned without redispatch", { requestId }, { operationId: existing.operationId });
      return {
        ok: true,
        requestId,
        operationId: existing.operationId,
        status: this.getJobStatus(requestId).status,
        replayed: true,
        transport: "websocket",
        target: { sessionId: existing.targetSessionId, fileKey: existing.targetFileKey },
      };
    }

    const operation = this.operationLogger.startOperation("relay.job", "开始提交 Relay 任务", {
      operationId,
      data: { requestId, jobType: String(jobPayload.type || "") }
    });
    this.operations.set(requestId, operation);
    try {
      const assetPaths = parseAssetPaths(payload.assetPaths, this.config.assetRoots);
      const target = parseTarget(payload, jobPayload);
      const sessions = this.gateway.status().sessions.filter((session) => session.authenticated
        && (!target.sessionId || session.sessionId === target.sessionId)
        && (!target.fileKey || session.fileKey === target.fileKey));
      if (sessions.length !== 1) throw new Error("Select exactly one matching online Figma plugin WebSocket session.");
      const selected = sessions[0];
      if (!["job.result", "job.reconcile", "job.cancel"].every((capability) => selected.capabilities.includes(capability))) {
        throw new Error("Reload the updated Figma plugin with WebSocket task support.");
      }
      target.sessionId = selected.sessionId;
      target.fileKey = selected.fileKey;
      assertCleanupAiJobAllowed(jobPayload.type, target.sessionId);
      const job: RelayJob = {
        requestId,
        operationId,
        job: rewriteAssetUrls({ ...jobPayload }, requestId, this.publicUrl),
        assetPaths,
        targetSessionId: target.sessionId,
        targetFileKey: target.fileKey,
        requiredTransport: "websocket",
        resultToken: randomUUID(),
        delivered: false,
        inFlight: false,
        dispatchAttempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      this.jobs.set(requestId, job);
      this.tryPush(job);
      operation.step("websocket-dispatched", "Relay job dispatched over WebSocket", { requestId, jobType: String(job.job.type || ""), attempts: job.dispatchAttempts });

      return {
        ok: true,
        requestId,
        operationId,
        statusUrl: `${this.publicUrl}/jobs/${encodeURIComponent(requestId)}/result`,
        transport: "websocket",
        target: {
          sessionId: job.targetSessionId,
          fileKey: job.targetFileKey
        }
      };
    } catch (error) {
      this.jobs.delete(requestId);
      this.operations.delete(requestId);
      operation.fail(error, "Relay 任务提交失败", { requestId });
      throw error;
    }
  }

  tryPush(job: RelayJob): boolean {
    const pushed = this.gateway.sendJob(job);
    if (pushed) {
      job.dispatchAttempts += 1;
      job.lastDispatchBy = "websocket";
      job.lastDispatchedAt = Date.now();
      job.inFlight = true;
      job.lastDeliveryError = undefined;
      job.updatedAt = Date.now();
      return true;
    }
    throw new Error("No matching online Figma plugin WebSocket session. Keep one plugin panel open, or pass target.sessionId/fileKey.");
  }

  // Retained only for callers awaiting the T6 HTTP route removal; never leases a job.

  getJob(requestId: string): RelayJob | undefined {
    return this.jobs.get(requestId);
  }

  getJobStatus(requestId: string): JsonObject {
    const job = this.jobs.get(requestId);
    if (!job) {
      return { ok: false, requestId, status: "unknown" };
    }
    this.refreshReconnectState(job);
    const status = job.result
      ? isFailedJobResult(job.result)
        ? ["cancelled", "result_unknown"].includes(String(job.result.status || "").toLowerCase())
          ? String(job.result.status).toLowerCase()
          : "failed"
        : "succeeded"
      : job.deliveryState ?? (job.cancelRequestedAt ? "cancel_requested" : job.inFlight ? "running" : "queued");
    return {
      ok: true,
      requestId,
      operationId: job.operationId,
      status,
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      dispatchAttempts: job.dispatchAttempts,
      result: job.result,
      cancelRequestedAt: job.cancelRequestedAt ? new Date(job.cancelRequestedAt).toISOString() : undefined,
      cancelOutcome: job.cancelOutcome,
      reconnectDeadline: job.reconnectDeadline,
      lastDeliveryError: job.lastDeliveryError,
    };
  }

  cancelJob(requestId: string): JsonObject {
    const job = this.jobs.get(requestId);
    if (!job) return { ok: false, requestId, status: "unknown", error: "unknown task" };
    if (job.result) return this.getJobStatus(requestId);
    if (job.cancelRequestedAt) return this.getJobStatus(requestId);
    job.cancelRequestedAt = Date.now();
    job.updatedAt = Date.now();
    if (job.dispatchAttempts === 0) {
      job.result = { ok: false, status: "cancelled", requestId, reason: "cancelled before dispatch" };
      job.updatedAt = Date.now();
      this.operations.get(requestId)?.cancel("任务在下发前已取消", { requestId });
      this.operations.delete(requestId);
      return this.getJobStatus(requestId);
    }
    const sent = this.gateway.sendCancel(job);
    this.operations.get(requestId)?.step("cancel-requested", "已向 Figma 插件请求取消任务", { requestId, sent });
    return { ...this.getJobStatus(requestId), cancelSent: sent };
  }

  private handleTaskControl(action: string, payload: JsonObject, sessionId: string): JsonObject {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const job = this.jobs.get(requestId);
    const operation = this.operationLogger.startOperation("relay.reconcile", "Reconcile plugin task state", {
      operationId: job?.operationId, data: { requestId, action, sessionId },
    });
    try {
      operation.step("validate", "Validate task recovery report");
      if (!job || job.requiredTransport !== "websocket" || job.targetSessionId !== sessionId
        || !job.resultToken || !constantTimeEqual(String(payload.resultToken || ""), job.resultToken)) {
        throw new Error("Unknown task or invalid recovery token for this session.");
      }
      if (action === "job.result") {
        if (!isRecord(payload.result)) throw new Error("Task result must be an object.");
        if (!job.result) this.setResult(requestId, payload.result);
      } else if (action === "job.reconcile") {
        if (!["queued", "running", "completed", "unknown"].includes(String(payload.state))) throw new Error("Invalid task reconciliation state.");
        if (!job.result) {
          job.deliveryState = payload.state === "unknown" ? "result_unknown" : undefined;
          job.reconnectDeadline = undefined;
          job.inFlight = payload.state !== "unknown";
          job.leaseExpiresAt = Date.now() + JOB_LEASE_MS;
          job.updatedAt = Date.now();
        }
      } else if (action === "job.cancel-status") {
        if (!["running", "unknown"].includes(String(payload.state))) throw new Error("Invalid cancellation report.");
        if (!job.cancelRequestedAt) throw new Error("Cancellation was not requested.");
        job.cancelOutcome = payload.state as "running" | "unknown";
        job.updatedAt = Date.now();
      } else {
        throw new Error("Unsupported task control action.");
      }
      operation.succeed("Plugin task state reconciled", { status: this.getJobStatus(requestId).status });
      return { accepted: true, cancelRequested: Boolean(job.cancelRequestedAt && !job.result), terminal: Boolean(job.result) };
    } catch (error) {
      operation.fail(error, "Plugin task reconciliation rejected");
      throw error;
    }
  }

  private refreshReconnectState(job: RelayJob): void {
    if (job.result || job.deliveryState !== "waiting_reconnect" || !job.reconnectDeadline || Date.now() < job.reconnectDeadline) return;
    job.deliveryState = "result_unknown";
    job.reconnectDeadline = undefined;
    this.operations.get(job.requestId)?.step("result-unknown", "Reconnect deadline expired; task will not be replayed", { requestId: job.requestId }, "warn");
  }

  setResult(requestId: string, result: unknown): boolean {
    const job = this.jobs.get(requestId);
    if (!job || !isRecord(result)) {
      return false;
    }
    job.result = this.persistResultArtifacts(requestId, result);
    job.deliveryState = undefined;
    job.reconnectDeadline = undefined;
    job.inFlight = false;
    job.leaseExpiresAt = undefined;
    job.updatedAt = Date.now();
    const operation = this.operations.get(requestId);
    operation?.step("result-received", "Relay 已收到插件结果", {
      requestId,
      deliveredBy: job.deliveredBy || "",
      status: String(result.status || result.ok || "")
    });
    recordCleanupAiJobResult(job.job.type, job.targetSessionId, !isFailedJobResult(result), requestId);
    if (isFailedJobResult(result)) {
      operation?.fail(new Error(String(result.error || result.status || "plugin command failed")), "Relay 任务执行失败", {
        requestId
      });
    } else {
      operation?.succeed("Relay 任务执行成功", { requestId });
    }
    this.operations.delete(requestId);
    logInfo("Relay job result received", {
      requestId,
      jobType: String(job.job.type || ""),
      deliveredBy: job.deliveredBy || "",
      status: isRecord(result) ? String(result.status || result.ok || "") : ""
    });
    return true;
  }

  async waitResult(requestId: string, timeoutSeconds: number, intervalSeconds: number): Promise<JsonObject> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const job = this.jobs.get(requestId);
      if (!job) {
        throw new Error(`unknown job: ${requestId}`);
      }
      if (job.result) {
        return { requestId, result: job.result };
      }
      await sleep(Math.max(50, intervalSeconds * 1000));
    }
    throw new Error(`timeout waiting for Figma plugin result: ${requestId}`);
  }

  async waitResultCompact(requestId: string, timeoutSeconds: number, intervalSeconds: number): Promise<JsonObject> {
    const payload = await this.waitResult(requestId, timeoutSeconds, intervalSeconds);
    return {
      requestId,
      result: compactJobResult(isRecord(payload.result) ? payload.result : {}),
      summaryOnly: true
    };
  }

  status(): RelayStatus {
    let pending = 0;
    let done = 0;
    for (const job of this.jobs.values()) {
      if (job.result) {
        done += 1;
      } else {
        pending += 1;
      }
    }
    return {
      status: "ok",
      mode: "node-gateway",
      pending,
      done,
      total: this.jobs.size,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 10) / 100,
      publicUrl: this.publicUrl,
      transport: "websocket",
      assetRoots: this.config.assetRoots,
      adminTokenRequired: Boolean(this.config.adminToken),
      plugin: this.gateway.status(),
      algorithms: this.algorithms.status()
    };
  }

  hasLivePluginSession(sessionId: unknown): boolean {
    return typeof sessionId === "string" && this.gateway.hasLiveSessionId(sessionId);
  }

  async algorithmControl(action: string, payload: Record<string, unknown>, unityProjects?: UnityProjectRegistry): Promise<unknown> {
    if (action === "figma.prefab.start") {
      if (!unityProjects || typeof payload.clientRequestId !== "string" || !payload.clientRequestId) throw new Error("Registered project and stable clientRequestId are required");
      return { ok: true, task: startFigmaPrefabImportTask(this.config, unityProjects, payload) };
    }
    if (action === "figma.prefab.get") {
      const task = getFigmaPrefabImportTask(String(payload.taskId || ""));
      if (!task) throw new Error("Unknown import task; do not replay an uncertain write");
      const sessionId = typeof payload.sessionId === "string" && payload.sessionId ? payload.sessionId : task.sessionId;
      const fileKey = typeof payload.fileKey === "string" && payload.fileKey ? payload.fileKey : task.fileKey;
      if (task.sessionId !== sessionId || task.fileKey !== fileKey) throw new Error("Import belongs to a different Figma session");
      return { ok: true, task };
    }
    if (action.startsWith("psd.import.")) {
      if (action === "psd.import.start") {
        const target = isRecord(payload.target) ? payload.target : {};
        if ((target.sessionId && target.sessionId !== payload.sessionId) || (target.fileKey && target.fileKey !== payload.fileKey)) {
          throw new Error("PSD target conflicts with the authenticated Figma session");
        }
        return { ok: true, task: startPsdImportTask(this.config, { ...payload, target: { ...target, sessionId: payload.sessionId, fileKey: payload.fileKey } }) };
      }
      const taskId = String(payload.taskId || "");
      const task = getPsdImportTask(taskId);
      if (!task) throw new Error("Unknown PSD task; do not replay an uncertain write");
      const sessionId = typeof payload.sessionId === "string" && payload.sessionId ? payload.sessionId : task.target.sessionId;
      const fileKey = typeof payload.fileKey === "string" && payload.fileKey ? payload.fileKey : task.target.fileKey;
      if (task.target.sessionId !== sessionId || task.target.fileKey !== fileKey) throw new Error("PSD task belongs to a different Figma session");
      if (action === "psd.import.get") return { ok: true, task };
      if (action === "psd.import.cancel") return cancelPsdImportTask(taskId);
      if (action === "psd.import.apply") return { ok: true, task: applyPsdImportTask(this.config, taskId, payload) };
      if (action === "psd.import.adopt-baseline") return { ok: true, task: adoptPsdImportBaseline(this.config, taskId, payload) };
      throw new Error(`Unknown PSD action: ${action}`);
    }
    switch (action) {
      case "plugin.open-folder": {
        const operation = getLoggingRuntime().logger("relay-runtime").startOperation("plugin.open-folder", "Open plugin folder");
        try {
          const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
          operation.step("spawn", "Launch folder opener");
          await new Promise<void>((resolve, reject) => {
            const child = spawn(command, [PLUGIN_ROOT], { windowsHide: true, stdio: "ignore" });
            child.once("error", reject);
            child.once("spawn", () => { child.unref(); resolve(); });
          });
          operation.succeed("Folder opener launched");
          return { ok: true, path: PLUGIN_ROOT };
        } catch (error) { operation.fail(error, "Folder opener failed"); throw error; }
      }
      case "image.crop": return this.algorithms.crop(payload);
      case "prefab.import.start": return this.algorithms.startImport(payload);
      case "prefab.import.get": return this.algorithms.getImport(String(payload.taskId || ""), String(payload.sessionId || ""));
      default: throw new Error(`Unknown algorithm control: ${action}`);
    }
  }

  assetPath(requestId: string, assetId: string): string | undefined {
    const job = this.jobs.get(requestId);
    const candidate = job?.assetPaths.get(assetId);
    if (!candidate) {
      return undefined;
    }
    return fs.existsSync(candidate) ? candidate : undefined;
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    for (const [requestId, operation] of this.operations) {
      operation.cancel("Relay 关闭，未完成任务已取消", { requestId });
    }
    this.operations.clear();
  }

  private markWebSocketReceived(requestId: string, receivedOperationId?: string): void {
    const job = this.jobs.get(requestId);
    if (!job || job.result) {
      return;
    }
    job.delivered = true;
    job.deliveredBy = "websocket";
    job.acknowledgedAt = Date.now();
    job.inFlight = true;
    job.leaseExpiresAt = Date.now() + JOB_LEASE_MS;
    job.updatedAt = Date.now();
    this.operations.get(requestId)?.step("plugin-acknowledged", "Figma 插件已确认接收任务", {
      requestId,
      receivedOperationId: receivedOperationId || ""
    });
    logInfo("Relay job acknowledged by websocket", {
      requestId,
      jobType: String(job.job.type || "")
    });
  }

  private markWebSocketUndelivered(requestId: string, reason: string): void {
    const job = this.jobs.get(requestId);
    if (!job || job.result) {
      return;
    }
    job.delivered = false;
    job.deliveredBy = undefined;
    job.inFlight = false;
    job.leaseExpiresAt = undefined;
    job.lastDeliveryError = reason;
    job.updatedAt = Date.now();
    logWarn("Relay websocket delivery failed", {
      requestId,
      jobType: String(job.job.type || ""),
      reason
    });
    job.deliveryState = "waiting_reconnect";
    job.reconnectDeadline = Date.now() + RECONNECT_GRACE_MS;
    this.operations.get(requestId)?.step("waiting-reconnect", "Waiting for plugin reconciliation; no automatic replay", { requestId, reason, graceMs: RECONNECT_GRACE_MS }, "warn");
  }

  private cleanupJobs(now = Date.now()): void {
    for (const [requestId, job] of this.jobs) {
      this.refreshReconnectState(job);
      const ttl = job.result ? DONE_JOB_TTL_MS : PENDING_JOB_TTL_MS;
      if (now - job.updatedAt > ttl) {
        logInfo("Relay job expired from memory", {
          requestId,
          jobType: String(job.job.type || ""),
          done: Boolean(job.result)
        });
        this.operations.get(requestId)?.step("expired", "Relay 任务已过期", { requestId });
        this.operations.get(requestId)?.cancel("Relay 任务已过期", { requestId });
        this.operations.delete(requestId);
        this.jobs.delete(requestId);
        continue;
      }
      if (!job.result && job.inFlight && job.leaseExpiresAt && now > job.leaseExpiresAt) {
        this.markWebSocketUndelivered(requestId, "job execution lease expired");
      }
    }
  }

  private persistResultArtifacts(requestId: string, result: JsonObject): JsonObject {
    this.persistFigmaToPrefabManifestArtifacts(requestId, result);

    const screenshot = isRecord(result.screenshot) ? result.screenshot : undefined;
    const base64 = typeof screenshot?.base64 === "string" ? screenshot.base64 : "";
    if (!screenshot || !base64) {
      return result;
    }
    try {
      const bytes = Buffer.from(base64.replace(/\s+/g, ""), "base64");
      if (!isPngBytes(bytes)) {
        throw new Error(`screenshot payload is not PNG: ${bytes.length} bytes`);
      }
      const artifactDir = path.join(LOCAL_DIR, "artifacts", sanitizePathSegment(requestId));
      fs.mkdirSync(artifactDir, { recursive: true });
      const fileName = sanitizePathSegment(stringOr(screenshot.fileName, "screenshot.png")) || "screenshot.png";
      const filePath = path.join(artifactDir, fileName.toLowerCase().endsWith(".png") ? fileName : `${fileName}.png`);
      fs.writeFileSync(filePath, bytes);
      delete screenshot.base64;
      screenshot.path = filePath;
      screenshot.byteLength = bytes.length;
      screenshot.hasBase64 = false;
      screenshot.fileValid = true;
      logInfo("Relay screenshot artifact written", {
        requestId,
        path: filePath,
        byteLength: bytes.length
      });
    } catch (error) {
      delete screenshot.base64;
      screenshot.hasBase64 = false;
      screenshot.fileValid = false;
      screenshot.fileError = error instanceof Error ? error.message : String(error);
      logWarn("Relay screenshot artifact write failed", {
        requestId,
        error: screenshot.fileError
      });
    }
    return result;
  }

  private persistFigmaToPrefabManifestArtifacts(requestId: string, result: JsonObject): void {
    const manifests: Array<[string, string, unknown]> = [
      ["figmaNodeManifest", "figma_node_manifest.json", result.figmaNodeManifest],
      ["imageExportManifest", "image_export_manifest.json", result.imageExportManifest]
    ];
    for (const [key, fileName, value] of manifests) {
      if (!isRecord(value)) {
        continue;
      }
      try {
        const artifactDir = path.join(LOCAL_DIR, "artifacts", sanitizePathSegment(requestId));
        fs.mkdirSync(artifactDir, { recursive: true });
        const filePath = path.join(artifactDir, fileName);
        fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        result[`${key}Path`] = filePath;
        logInfo("Relay manifest artifact written", {
          requestId,
          key,
          path: filePath
        });
      } catch (error) {
        result[`${key}FileError`] = error instanceof Error ? error.message : String(error);
        logWarn("Relay manifest artifact write failed", {
          requestId,
          key,
          error: result[`${key}FileError`]
        });
      }
    }
  }

}

export function compactJobResult(result: JsonObject): JsonObject {
  const summary = isRecord(result.summary) ? result.summary : {};
  const validation = isRecord(summary.validation) ? summary.validation : {};
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const blockingErrors = Array.isArray(result.blockingErrors) ? result.blockingErrors : [];
  const screenshot = isRecord(result.screenshot) ? result.screenshot : {};
  const nodeManifest = firstRecord(result.figmaNodeManifest, result.figma_node_manifest, result.nodeManifest);
  const imageManifest = firstRecord(result.imageExportManifest, result.image_export_manifest, result.imageManifest);
  const imageHealthSummary = isRecord(imageManifest.healthSummary) ? imageManifest.healthSummary : {};

  return {
    status: stringOr(result.status, "unknown"),
    allPass: result.allPass === true,
    rootNodeId: stringOr(result.rootNodeId || result.nodeId, ""),
    rootName: stringOr(result.rootName || result.name, ""),
    createdCount: numberOr(result.createdCount, 0),
    durationMs: numberOr(summary.durationMs, null),
    layerCount: numberOr(summary.layerCount, null),
    exportedNodeCount: numberOr(result.exportedNodeCount || summary.exportedNodeCount, countContainer(nodeManifest, "nodes", "items")),
    expectedNodeCount: numberOr(summary.expectedNodeCount || validation.expectedNodeCount, null),
    imageCount: numberOr(summary.imageCount, countContainer(imageManifest, "images", "exports", "items", "assets")),
    imageHealthSummary,
    missingImageCount: numberOr(validation.missingImageCount || validation.missingImageFillCount, null),
    textCount: numberOr(summary.textCount, null),
    textMetadataMissingCount: numberOr(validation.textMetadataMissingCount, null),
    slicedImageCount: numberOr(summary.slicedImageCount, null),
    invalidSliceMetadataCount: numberOr(validation.invalidSliceMetadataCount || validation.sliceProblemCount, null),
    stats: isRecord(summary.stats) ? summary.stats : {},
    summary,
    checks: compactChecks(isRecord(result.checks) ? result.checks : {}),
    artifacts: compactArtifacts(isRecord(result.artifacts) ? result.artifacts : {}),
    validation: compactValidation(validation),
    screenshot: compactScreenshot(screenshot),
    warningCount: warnings.length,
    blockingErrorCount: blockingErrors.length,
    blockingErrors,
    errorCount: errors.length,
    warningSamples: warnings.slice(0, 5),
    blockingErrorSamples: blockingErrors.slice(0, 5),
    errorSamples: errors.slice(0, 5)
  };
}

function compactChecks(checks: JsonObject): JsonObject {
  const compact: JsonObject = {};
  for (const [key, value] of Object.entries(checks)) {
    if (isRecord(value)) {
      compact[key] = {
        pass: value.pass === true,
        driftCount: numberOr(value.driftCount, undefined as unknown as null),
        movedCount: numberOr(value.movedCount, undefined as unknown as null),
        expected: value.expected
      };
    }
  }
  return compact;
}

function compactArtifacts(artifacts: JsonObject): JsonObject {
  const createdGroups = Array.isArray(artifacts.createdGroups) ? artifacts.createdGroups : [];
  const refs = isRecord(artifacts.refs) ? artifacts.refs : {};
  const steps = Array.isArray(artifacts.steps) ? artifacts.steps : [];
  return {
    createdGroups,
    deepestGroupId: stringOr(artifacts.deepestGroupId, ""),
    deepestGroupName: stringOr(artifacts.deepestGroupName, ""),
    wrapperChain: Array.isArray(artifacts.wrapperChain) ? artifacts.wrapperChain : [],
    beforeDirectChildCount: countDirectChildIds(artifacts.before),
    afterDirectChildCount: countDirectChildIds(artifacts.after),
    mutatedNodeCount: Array.isArray(artifacts.mutatedNodeIds) ? artifacts.mutatedNodeIds.length : null,
    refs,
    stepCount: steps.length,
    steps
  };
}

function countDirectChildIds(value: unknown): number | null {
  if (!isRecord(value) || !Array.isArray(value.directChildIds)) {
    return null;
  }
  return value.directChildIds.length;
}

export function redactLargeRelayPayload(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (isLargePayloadKey(key) || looksLikeLargeBase64(value)) {
      return {
        redacted: true,
        reason: "large inline payload",
        originalLength: value.length
      };
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLargeRelayPayload(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: JsonObject = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redactLargeRelayPayload(childValue, childKey);
  }
  return result;
}

function isLargePayloadKey(key: string): boolean {
  return ["base64", "pngBase64", "imageBase64", "bytes"].includes(key);
}

function looksLikeLargeBase64(value: string): boolean {
  if (value.length < 4096) {
    return false;
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    return false;
  }
  const normalized = value.replace(/\s+/g, "");
  return normalized.length % 4 === 0;
}

function firstRecord(...values: unknown[]): JsonObject {
  for (const value of values) {
    if (isRecord(value)) {
      return value;
    }
  }
  return {};
}

function countContainer(value: JsonObject, ...keys: string[]): number | null {
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.length;
    }
    if (isRecord(candidate)) {
      return Object.keys(candidate).length;
    }
  }
  return null;
}

function compactValidation(validation: JsonObject): JsonObject {
  const fields = [
    "missingNodeCount",
    "emptyImageFillCount",
    "badTransformCount",
    "textClipRiskCount",
    "emptyTextCount",
    "textColorMismatchCount",
    "textStrokeMismatchCount",
    "sliceProblemCount",
    "emptySliceLayerCount",
    "missingSliceSourceFillCount",
    "indexOrderBad"
  ];
  const compact: JsonObject = {};
  for (const field of fields) {
    if (field in validation) {
      compact[field] = validation[field];
    }
  }
  return compact;
}

function compactScreenshot(screenshot: JsonObject): JsonObject {
  if (!Object.keys(screenshot).length) {
    return {};
  }
  return {
    fileName: stringOr(screenshot.fileName, ""),
    mimeType: stringOr(screenshot.mimeType, ""),
    path: stringOr(screenshot.path, ""),
    width: numberOr(screenshot.width, null),
    height: numberOr(screenshot.height, null),
    byteLength: numberOr(screenshot.byteLength, String(screenshot.base64 || "").length),
    hasBase64: Boolean(screenshot.base64),
    fileValid: screenshot.fileValid === true
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseTarget(payload: JsonObject, jobPayload: JsonObject): { sessionId?: string; fileKey?: string } {
  const rawTarget = isRecord(payload.target) ? payload.target : {};
  const sessionId = stringValue(payload.sessionId) || stringValue(rawTarget.sessionId) || stringValue(jobPayload.sessionId);
  const fileKey = stringValue(payload.fileKey) || stringValue(rawTarget.fileKey) || stringValue(jobPayload.fileKey);
  return {
    sessionId: sessionId || undefined,
    fileKey: fileKey || undefined
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isFailedJobResult(result: JsonObject): boolean {
  if (result.ok === false) {
    return true;
  }
  const status = String(result.status || "").toLowerCase();
  return ["failed", "error", "cancelled", "blocked", "result_unknown"].includes(status);
}


function parseAssetPaths(raw: unknown, roots: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (!isRecord(raw)) {
    return result;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim()) {
      const resolved = path.resolve(value);
      if (!isPathAllowed(resolved, roots)) {
        throw new Error(`asset path is outside allowed roots: ${key}`);
      }
      result.set(key, resolved);
    }
  }
  return result;
}

function isPathAllowed(filePath: string, roots: string[]): boolean {
  const normalized = path.resolve(filePath);
  if (isInsidePath(normalized, LOCAL_DIR)) {
    return false;
  }
  const candidates = roots.length > 0 ? roots : [PLUGIN_ROOT, path.join(os.tmpdir(), "figma-relay")];
  for (const root of candidates) {
    if (isInsidePath(normalized, root)) {
      return true;
    }
  }
  return false;
}

function isInsidePath(filePath: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(filePath));
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPngBytes(bytes: Buffer): boolean {
  return bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
}

function sanitizePathSegment(value: string): string {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function rewriteAssetUrls(job: JsonObject, requestId: string, baseUrl: string): JsonObject {
  const assets = job.assets;
  if (!Array.isArray(assets)) {
    return job;
  }
  for (const asset of assets) {
    if (isRecord(asset)) {
      const assetId = typeof asset.id === "string" ? asset.id : "";
      if (assetId) {
        asset.url = `${baseUrl}/assets/${encodeURIComponent(requestId)}/${encodeURIComponent(assetId)}`;
      }
    }
  }
  return job;
}
