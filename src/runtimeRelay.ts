import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GatewayConfig } from "./config.js";
import { LOCAL_DIR, PLUGIN_ROOT, publicUrl } from "./config.js";
import { getLoggingRuntime, type LoggingRuntime } from "./logging/loggingRuntime.js";
import { assertCleanupAiJobAllowed, recordCleanupAiJobResult } from "./cleanupAiWriteGuard.js";
import type { OperationScope } from "./logging/operationScope.js";
import type { RelayLogger } from "./logging/relayLogger.js";
import { logInfo, logWarn } from "./utils/logger.js";
import {
  deleteMcpConfigForClient,
  desiredMcpUrl,
  mcpConfigStatusForClient,
  normalizeMcpClient,
  openMcpConfigForClient,
  writeMcpConfigForClient
} from "./mcpConfig.js";
import type { LegacyRelay } from "./pythonWorker.js";
import type { JsonObject, LegacyRelayStatus, RelayJob } from "./types.js";
import { isRecord, makeRequestId, sleep, validOperationId } from "./utils.js";
import type { WebSocketGateway } from "./websocketGateway.js";

const DONE_JOB_TTL_MS = 10 * 60 * 1000;
const PENDING_JOB_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 1000;
const JOB_LEASE_MS = 5 * 60 * 1000;

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
  legacyRelay: LegacyRelayStatus;
}

export class RuntimeRelay {
  private readonly jobs = new Map<string, RelayJob>();
  private readonly queue: string[] = [];
  private readonly startedAt = Date.now();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly operations = new Map<string, OperationScope>();
  private readonly operationLogger: RelayLogger;

  constructor(
    private readonly config: GatewayConfig,
    private readonly gateway: WebSocketGateway,
    private readonly legacyRelay: LegacyRelay,
    logging: LoggingRuntime = getLoggingRuntime()
  ) {
    this.operationLogger = logging.logger("runtime-relay");
    this.gateway.onReceived((requestId, operationId) => this.markWebSocketReceived(requestId, operationId));
    this.gateway.onUndelivered((requestId, reason) => this.markWebSocketUndelivered(requestId, reason));
    this.cleanupTimer = setInterval(() => this.cleanupJobs(), CLEANUP_INTERVAL_MS);
  }

  get publicUrl(): string {
    return publicUrl(this.config);
  }

  submitJob(payload: unknown): JsonObject {
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
    if (existing && !existing.result) {
      throw new Error(`duplicate in-flight requestId: ${requestId}`);
    }

    const operation = this.operationLogger.startOperation("relay.job", "开始提交 Relay 任务", {
      operationId,
      data: { requestId, jobType: String(jobPayload.type || "") }
    });
    this.operations.set(requestId, operation);
    try {
      const assetPaths = parseAssetPaths(payload.assetPaths, this.config.assetRoots);
      const target = parseTarget(payload, jobPayload);
      assertCleanupAiJobAllowed(jobPayload.type, target.sessionId);
      const job: RelayJob = {
        requestId,
        operationId,
        job: rewriteAssetUrls({ ...jobPayload }, requestId, this.publicUrl),
        assetPaths,
        targetSessionId: target.sessionId,
        targetFileKey: target.fileKey,
        delivered: false,
        inFlight: false,
        dispatchAttempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      this.jobs.set(requestId, job);
      const pushed = this.tryPush(job);
      if (!pushed && this.gateway.requiresExplicitTarget({
        sessionId: job.targetSessionId,
        fileKey: job.targetFileKey
      })) {
        throw new Error("Multiple online Figma plugin sessions require target.sessionId or target.fileKey.");
      }
      if (!pushed) {
        this.queue.push(requestId);
        operation.step("queued", "Relay 任务已进入轮询队列", {
          requestId,
          jobType: String(job.job.type || ""),
          queueLength: this.queue.length
        });
      } else {
        operation.step("websocket-dispatched", "Relay 任务已通过 WebSocket 下发", {
          requestId,
          jobType: String(job.job.type || ""),
          attempts: job.dispatchAttempts
        });
      }

      return {
        ok: true,
        requestId,
        operationId,
        statusUrl: `${this.publicUrl}/jobs/${encodeURIComponent(requestId)}/result`,
        transport: pushed ? "websocket" : "polling",
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
    if (this.config.transport === "polling") {
      return false;
    }
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
    if (this.config.transport === "websocket") {
      throw new Error("No matching online Figma plugin WebSocket session. Keep one plugin panel open, or pass target.sessionId/fileKey.");
    }
    return false;
  }

  getNextPollingJob(): RelayJob | undefined {
    const target = {
      sessionId: "",
      fileKey: ""
    };
    return this.getNextPollingJobForTarget(target);
  }

  getNextPollingJobForTarget(target: { sessionId?: string; fileKey?: string }): RelayJob | undefined {
    const scanCount = this.queue.length;
    for (let index = 0; index < scanCount; index += 1) {
      const requestId = this.queue.shift();
      if (!requestId) {
        continue;
      }
      const job = this.jobs.get(requestId);
      if (job && !job.result && !job.inFlight && jobMatchesTarget(job, target)) {
        job.delivered = true;
        job.deliveredBy = "polling";
        job.lastDispatchBy = "polling";
        job.dispatchAttempts += 1;
        job.lastDispatchedAt = Date.now();
        job.inFlight = true;
        job.leaseExpiresAt = Date.now() + JOB_LEASE_MS;
        job.updatedAt = Date.now();
        logInfo("Relay job leased by polling", {
          requestId: job.requestId,
          jobType: String(job.job.type || ""),
          attempts: job.dispatchAttempts
        });
        this.operations.get(requestId)?.step("polling-leased", "Relay 任务已由轮询客户端领取", {
          requestId,
          attempts: job.dispatchAttempts
        });
        return job;
      }
      if (job && !job.result && !job.inFlight) {
        this.queue.push(requestId);
      }
    }
    return undefined;
  }

  getJob(requestId: string): RelayJob | undefined {
    return this.jobs.get(requestId);
  }

  setResult(requestId: string, result: unknown): boolean {
    const job = this.jobs.get(requestId);
    if (!job || !isRecord(result)) {
      return false;
    }
    job.result = this.persistResultArtifacts(requestId, result);
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
      transport: this.config.transport,
      assetRoots: this.config.assetRoots,
      adminTokenRequired: Boolean(this.config.adminToken),
      plugin: this.gateway.status(),
      legacyRelay: this.legacyRelay.status()
    };
  }

  mcpClientsStatus(): JsonObject {
    return {
      ok: true,
      clients: [],
      mcpEndpoint: `${this.publicUrl}${this.config.mcpPath}`,
      mcpMounted: true
    };
  }

  hasLivePluginSession(sessionId: unknown): boolean {
    return typeof sessionId === "string" && this.gateway.hasLiveSessionId(sessionId);
  }

  mcpConfigStatus(client: string): JsonObject {
    return mcpConfigStatusForClient(
      normalizeMcpClient(client),
      desiredMcpUrl(this.publicUrl, this.config.mcpPath),
      true
    );
  }

  writeMcpConfig(client: unknown, url?: unknown): JsonObject {
    const mcpUrl = typeof url === "string" && url.trim()
      ? url.trim()
      : desiredMcpUrl(this.publicUrl, this.config.mcpPath);
    return writeMcpConfigForClient(normalizeMcpClient(client), mcpUrl, true);
  }

  deleteMcpConfig(client: unknown): JsonObject {
    return deleteMcpConfigForClient(
      normalizeMcpClient(client),
      desiredMcpUrl(this.publicUrl, this.config.mcpPath),
      true
    );
  }

  openMcpConfig(client: unknown): JsonObject {
    return openMcpConfigForClient(normalizeMcpClient(client));
  }

  async legacyJson(pathname: string, method: "GET" | "POST", payload?: unknown, timeoutMs = 10_000) {
    return this.legacyRelay.proxyJson(pathname, method, payload, timeoutMs);
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
    if (!job || job.result || job.deliveredBy === "polling") {
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
    if (this.config.transport === "websocket") {
      job.result = {
        ok: false,
        error: reason,
        requestId
      };
      this.operations.get(requestId)?.fail(new Error(reason), "Relay WebSocket 任务投递失败", { requestId });
      this.operations.delete(requestId);
      return;
    }
    this.enqueueIfNeeded(requestId);
  }

  private enqueueIfNeeded(requestId: string): void {
    const job = this.jobs.get(requestId);
    if (!job || job.result || job.inFlight || this.queue.includes(requestId)) {
      return;
    }
    this.queue.push(requestId);
  }

  private cleanupJobs(now = Date.now()): void {
    for (const [requestId, job] of this.jobs) {
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
        job.inFlight = false;
        job.delivered = false;
        job.deliveredBy = undefined;
        job.leaseExpiresAt = undefined;
        job.lastDeliveryError = "job execution lease expired";
        job.updatedAt = now;
        logWarn("Relay job lease expired", {
          requestId,
          jobType: String(job.job.type || "")
        });
        this.operations.get(requestId)?.step("lease-expired", "Relay 任务租约超时，准备重试", {
          requestId
        }, "warn");
        this.enqueueIfNeeded(requestId);
      }
    }
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const requestId = this.queue[index];
      const job = this.jobs.get(requestId);
      if (!job || job.result || job.inFlight) {
        this.queue.splice(index, 1);
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

function isFailedJobResult(result: JsonObject): boolean {
  if (result.ok === false) {
    return true;
  }
  const status = String(result.status || "").toLowerCase();
  return ["failed", "error", "cancelled", "blocked"].includes(status);
}

function jobMatchesTarget(job: RelayJob, target: { sessionId?: string; fileKey?: string }): boolean {
  if (job.targetSessionId && target.sessionId && job.targetSessionId !== target.sessionId) {
    return false;
  }
  if (job.targetSessionId && !target.sessionId) {
    return false;
  }
  if (job.targetFileKey && target.fileKey && job.targetFileKey !== target.fileKey) {
    return false;
  }
  if (job.targetFileKey && !target.fileKey) {
    return false;
  }
  return true;
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
  const candidates = roots.length > 0 ? roots : [PLUGIN_ROOT, path.join(os.tmpdir(), "figma-mcp-relay")];
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
