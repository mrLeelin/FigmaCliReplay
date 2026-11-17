import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import path from "node:path";

import type { GatewayConfig } from "./config.js";
import { DATA_ROOT, PLUGIN_ROOT, publicUrl } from "./config.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import type { OperationScope } from "./logging/operationScope.js";
import { logInfo, logWarn } from "./utils/logger.js";
import { isRecord } from "./utils.js";
import { notifyRunChanged } from "./runChangeNotifier.js";
import { assertPsdUploadSize, MAX_INLINE_PSD_UPLOAD_BYTES, MAX_PLUGIN_MESSAGE_BYTES } from "./psdUploadLimits.js";
import { hashPsdFile, preparePsdUpload, sanitizePsdFileName } from "./psdUploadStore.js";

type PsdImportMode =
  | "initial"
  | "incremental-preview"
  | "incremental-baseline-adopt"
  | "incremental-apply";
type PsdPreviewStatus =
  | "preview-ready"
  | "preview-blocked"
  | "preview-no-changes"
  | "preview-baseline-required";
type PsdImportTaskStatus =
  | "cancel_requested"
  | "cancelled"
  | "queued"
  | "running"
  | PsdPreviewStatus
  | "baseline-adopted"
  | "completed"
  | "error";

export interface PsdImportTask {
  taskId: string;
  mode: PsdImportMode;
  status: PsdImportTaskStatus;
  stage: string;
  percent: number;
  fileName: string;
  sourcePsdPath: string;
  sourceFile: {
    size: number;
    lastModified: number;
    sha256: string;
    identicalToPreviousUpload: boolean;
  };
  artifactDir: string;
  manifestSummaryPath: string;
  resultPath: string;
  timelinePath: string;
  target: {
    fileKey: string;
    sessionId: string;
    targetNodeId: string;
    targetName: string;
    targetType: string;
  };
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  logs: string[];
  error?: string;
  summary?: unknown;
  preview?: unknown;
  baselineFingerprint?: string;
  /** 图层像素来源：默认优先 Photoshop，未安装时由 psd-tools 合成。raw 仅供显式诊断。 */
  renderer?: PsdLayerRenderer;
}

type PsdLayerRenderer = "raw" | "photoshop" | "psd-tools";

const tasks = new Map<string, PsdImportTask>();
export function activePsdImportCount(): number {
  return [...tasks.values()].filter((task) => ["queued", "running", "cancel_requested", "preview-ready", "preview-baseline-required"].includes(task.status)).length;
}
const requests = new Map<string, Record<string, unknown>>();
const taskOperations = new Map<string, OperationScope>();
const logging = getLoggingRuntime();
const taskLogger = logging.logger("psd-import-task");
const PYTHON_LOG_MARKER = "FIGMA_RELAY_LOG ";
// 提交 Figma 之前的阶段都可以取消：当前脚本返回后不再提交。
const CANCELLABLE_STAGES = new Set(["exporting_psd_layers", "waiting_for_photoshop", "rendering_psd_photoshop", "rendering_psd_tools"]);
const PSD_SKILL_SCRIPTS = path.join(PLUGIN_ROOT, "ai", "skills", "psd-layer-to-figma", "scripts");
// Photoshop 的整个导入会话串行：Figma 导入结束并完成自有进程清理后才交给下个任务。
let photoshopRenderQueue: Promise<void> = Promise.resolve();
const PSD_PREVIEW_STATUSES = new Set<PsdPreviewStatus>([
  "preview-ready",
  "preview-blocked",
  "preview-no-changes",
  "preview-baseline-required"
]);

export function startPsdImportTask(config: GatewayConfig, payload: unknown): PsdImportTask {
  if (!isRecord(payload)) {
    throw new Error("json body must be object");
  }
  const requestId = stringValue(payload.clientRequestId);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new Error("A stable clientRequestId is required for PSD import");
  if (stringValue(payload.fileBase64).length > MAX_PLUGIN_MESSAGE_BYTES) {
    throw new Error("Encoded PSD file exceeds the upload limit");
  }
  const identity = { ...payload, fileBase64: createHash("sha256").update(stringValue(payload.fileBase64)).digest("hex") };
  const original = requests.get(requestId);
  if (original) {
    if (!isDeepStrictEqual(original, identity)) throw new Error("PSD request id conflicts with its original payload");
    taskLogger.info("PSD import request deduplicated", { taskId: requestId });
    return serializePsdImportTask(tasks.get(requestId)!);
  }
  if (tasks.size >= 100) throw new Error("PSD task capacity reached");
  const fileName = sanitizePsdFileName(stringValue(payload.fileName) || "source.psd");
  if (!/\.psd$/i.test(fileName)) {
    throw new Error("fileName must end with .psd");
  }
  const fileBase64 = stringValue(payload.fileBase64);
  const uploadId = stringValue(payload.uploadId);
  if (Boolean(fileBase64) === Boolean(uploadId)) {
    throw new Error("Supply exactly one of fileBase64 or uploadId");
  }
  const target = isRecord(payload.target) ? payload.target : {};
  const sourceFilePayload = isRecord(payload.sourceFile) ? payload.sourceFile : {};
  const fileKey = stringValue(target.fileKey);
  const sessionId = stringValue(target.sessionId);
  const targetNodeId = stringValue(target.targetNodeId);
  const targetName = stringValue(target.targetName);
  const targetType = stringValue(target.targetType).toUpperCase();
  const requestedMode = stringValue(payload.mode) || "initial";
  if (requestedMode !== "initial" && requestedMode !== "incremental-preview") {
    throw new Error(`unsupported PSD import mode: ${requestedMode}`);
  }
  const mode: PsdImportMode = requestedMode;
  if (mode === "incremental-preview" && (!targetNodeId || (targetType !== "FRAME" && targetType !== "COMPONENT"))) {
    throw new Error("incremental PSD import requires one FRAME or COMPONENT target");
  }
  if (!fileKey || !sessionId) {
    throw new Error("target.fileKey and target.sessionId are required");
  }

  const taskId = requestId;
  const importsRoot = path.join(DATA_ROOT, ".tmp", "psd-to-figma");
  const taskDir = path.join(importsRoot, taskId);
  if (fs.existsSync(taskDir)) throw new Error("PSD task artifacts already exist; execution status is unknown. Do not replay.");
  const sourcePsdPath = path.join(taskDir, fileName);
  const artifactDir = path.join(taskDir, "layers");
  const resultPath = path.join(taskDir, "figma_relay_result.json");
  const timelinePath = path.join(taskDir, "timeline.json");
  const manifestSummaryPath = path.join(artifactDir, "manifest_summary.json");

  const prepared = uploadId ? preparePsdUpload(uploadId, requestId, fileName, sessionId, fileKey) : null;
  const sourceBytes = prepared ? null : decodeBase64File(fileBase64);
  const sourceSize = prepared ? prepared.size : sourceBytes!.length;
  assertPsdUploadSize(sourceSize);
  if (sourceBytes && sourceSize > MAX_INLINE_PSD_UPLOAD_BYTES) {
    throw new Error("PSD files above 256 MiB require chunked upload");
  }
  const sourceSha256 = prepared ? prepared.sha256 : createHash("sha256").update(sourceBytes!).digest("hex");
  const identicalToPreviousUpload = findPreviousIdenticalPsdUpload(importsRoot, fileName, sourceSize, sourceSha256);
  fs.mkdirSync(taskDir, { recursive: true });
  if (prepared) fs.renameSync(prepared.sourcePath, sourcePsdPath);
  else fs.writeFileSync(sourcePsdPath, sourceBytes!);

  const now = Date.now();
  const task: PsdImportTask = {
    taskId,
    mode,
    status: "queued",
    stage: "queued",
    percent: 0,
    fileName,
    sourcePsdPath,
    sourceFile: {
      size: sourceSize,
      lastModified: finiteNonNegativeNumber(sourceFilePayload.lastModified),
      sha256: sourceSha256,
      identicalToPreviousUpload
    },
    artifactDir,
    manifestSummaryPath,
    resultPath,
    timelinePath,
    target: { fileKey, sessionId, targetNodeId, targetName, targetType },
    startedAt: now,
    updatedAt: now,
    logs: []
  };
  tasks.set(taskId, task);
  requests.set(taskId, structuredClone(identity));
  startTaskOperation(task, "psd.import", "开始 PSD 导入任务");
  void runPsdImportTask(config, task, { reuseExportArtifacts: false });
  return serializePsdImportTask(task);
}

/** 进度变化：更新 updatedAt 并通知订阅者。 */
function touchTask(task: PsdImportTask): void {
  task.updatedAt = Date.now();
  notifyRunChanged(task.taskId);
}

export function getPsdImportTask(taskId: string): PsdImportTask | undefined {
  const task = tasks.get(taskId);
  return task ? serializePsdImportTask(task) : undefined;
}

export function applyPsdImportTask(config: GatewayConfig, taskId: string, payload: unknown): PsdImportTask {
  const task = tasks.get(taskId);
  if (!task || task.status !== "preview-ready") {
    throw new Error("PSD incremental preview is not ready");
  }
  const providedFingerprint = isRecord(payload) ? stringValue(payload.baselineFingerprint) : "";
  if (!providedFingerprint || providedFingerprint !== task.baselineFingerprint) {
    throw new Error("PSD incremental preview fingerprint does not match");
  }
  if (isRecord(task.preview) && task.preview.canApply === false) {
    throw new Error("PSD incremental preview contains blocking conflicts");
  }
  task.mode = "incremental-apply";
  task.status = "queued";
  task.stage = "queued_apply";
  task.percent = 0;
  task.error = undefined;
  touchTask(task);
  startTaskOperation(task, "psd.incremental-apply", "开始 PSD 增量应用任务");
  void runPsdImportTask(config, task, { reuseExportArtifacts: true });
  return serializePsdImportTask(task);
}

export function adoptPsdImportBaseline(config: GatewayConfig, taskId: string, payload: unknown): PsdImportTask {
  const task = tasks.get(taskId);
  if (!task || task.status !== "preview-baseline-required") {
    throw new Error("PSD source baseline adoption is not available");
  }
  const providedFingerprint = isRecord(payload) ? stringValue(payload.baselineFingerprint) : "";
  if (!providedFingerprint || providedFingerprint !== task.baselineFingerprint) {
    throw new Error("PSD baseline preview fingerprint does not match");
  }
  task.mode = "incremental-baseline-adopt";
  task.status = "queued";
  task.stage = "queued_baseline_adopt";
  task.percent = 0;
  task.error = undefined;
  touchTask(task);
  startTaskOperation(task, "psd.incremental-baseline-adopt", "开始认领 PSD 源状态基线");
  void runPsdImportTask(config, task, { reuseExportArtifacts: true });
  return serializePsdImportTask(task);
}

function serializePsdImportTask(task: PsdImportTask): PsdImportTask {
  return structuredClone({
    ...task,
    logs: task.logs.slice(-40)
  });
}

export function cancelPsdImportTask(taskId: string): { ok: true; accepted: boolean; task: PsdImportTask } {
  const task = tasks.get(taskId);
  if (!task) throw new Error("Unknown PSD task; do not replay an uncertain write");
  if (task.status === "cancel_requested" || task.status === "cancelled") {
    taskLogger.info("Repeated PSD cancellation request", { taskId, status: task.status });
    return { ok: true, accepted: true, task: serializePsdImportTask(task) };
  }
  if (PSD_PREVIEW_STATUSES.has(task.status as PsdPreviewStatus)) {
    task.status = "cancelled";
    task.stage = "cancelled";
    task.updatedAt = task.completedAt = Date.now();
    notifyRunChanged(task.taskId);
    const operation = taskLogger.startOperation("psd.cancel", "Cancel PSD preview", { operationId: taskId });
    operation.step("validate", "Preview is idle; no write is executing");
    operation.cancel("PSD preview cancelled");
    return { ok: true, accepted: true, task: serializePsdImportTask(task) };
  }
  if (task.status === "queued" || (task.status === "running" && CANCELLABLE_STAGES.has(task.stage))) {
    task.status = "cancel_requested";
    touchTask(task);
    taskOperations.get(taskId)?.step("cancel.requested", "Cancel after the current export returns; do not submit to Figma");
    return { ok: true, accepted: true, task: serializePsdImportTask(task) };
  }
  taskLogger.warn("PSD cancellation rejected; retain actual execution outcome", { taskId, status: task.status, stage: task.stage });
  return { ok: true, accepted: false, task: serializePsdImportTask(task) };
}

async function runPsdImportTask(
  config: GatewayConfig,
  task: PsdImportTask,
  options: { reuseExportArtifacts: boolean }
): Promise<void> {
  let releasePhotoshopSlot: (() => void) | undefined;
  let photoshopReceiptPath: string | undefined;
  let photoshopCleanupFinished = false;
  const cleanupPhotoshop = async (showProgress: boolean): Promise<void> => {
    if (photoshopCleanupFinished || !photoshopReceiptPath) return;
    photoshopCleanupFinished = true;
    await releasePhotoshopImportSession(task, photoshopReceiptPath, showProgress);
  };
  try {
    if (!options.reuseExportArtifacts) {
      setTaskStage(task, "exporting_psd_layers", 10, "开始导出 PSD 图层");
      const exportScript = path.join(PSD_SKILL_SCRIPTS, "export_psd_layers.py");
      const exportArgs = [
        task.sourcePsdPath,
        "--out",
        task.artifactDir,
        "--summary"
      ];
      // 增量预览必须保留源图层身份，隐藏变化才能作为 visible=false 应用，而非误判为删除。
      if (task.mode === "incremental-preview") exportArgs.push("--include-hidden");
      await runPythonScript(task, exportScript, exportArgs);
    }
    if (task.status === "cancel_requested") throw new Error("PSD export cancellation requested");
    if (!fs.existsSync(task.manifestSummaryPath)) {
      throw new Error(`manifest_summary.json was not created: ${task.manifestSummaryPath}`);
    }
    if (!options.reuseExportArtifacts && task.mode === "initial") {
      task.renderer = resolvePsdLayerRenderer();
      if (task.renderer === "photoshop") {
        setTaskStage(task, "waiting_for_photoshop", 20, "等待 Photoshop 导入会话");
        releasePhotoshopSlot = await acquirePhotoshopImportSlot();
        if (isCancelRequested(task)) throw new Error("PSD render cancellation requested");
        photoshopReceiptPath = path.join(path.dirname(task.artifactDir), "photoshop_session.json");
      }
      await renderPsdLayers(task, photoshopReceiptPath);
      if (isCancelRequested(task)) throw new Error("PSD render cancellation requested");
    }

    setTaskStage(task, "submitting_figma_import", 55, "开始提交 Figma 导入任务");
    const submitScript = path.join(PLUGIN_ROOT, "ai", "skills", "psd-layer-to-figma", "scripts", "submit_psd_import_job.py");
    const submitArgs = [
      task.manifestSummaryPath,
      "--import-mode",
      task.mode,
      "--root-name",
      rootNameFromFile(task.fileName),
      "--source-file-name",
      task.fileName,
      "--relay-url",
      publicUrl(config),
      "--wait",
      "--timeout",
      "240",
      "--result-output",
      task.resultPath,
      "--timeline-output",
      task.timelinePath
    ];
    if (task.target.sessionId) {
      submitArgs.push("--session-id", task.target.sessionId);
    }
    if (task.target.fileKey) {
      submitArgs.push("--file-key", task.target.fileKey);
    }
    if (task.target.targetNodeId) {
      submitArgs.push("--target-node-id", task.target.targetNodeId);
    }
    if ((task.mode === "incremental-apply" || task.mode === "incremental-baseline-adopt")
      && task.baselineFingerprint) {
      submitArgs.push("--baseline-fingerprint", task.baselineFingerprint);
    }
    await runPythonScript(task, submitScript, submitArgs);

    const result = readResultSummary(task.resultPath);
    taskOperations.get(task.taskId)?.step("result", "已读取 PSD 导入结果", {
      mode: task.mode
    });
    task.summary = result;
    if (task.mode === "incremental-preview") {
      if (!isRecord(result)) {
        throw new Error("PSD incremental preview did not return a result");
      }
      const previewStatus = stringValue(result.status);
      if (!PSD_PREVIEW_STATUSES.has(previewStatus as PsdPreviewStatus)) {
        throw new Error(`PSD incremental preview returned invalid status: ${previewStatus || "missing"}`);
      }
      if (!stringValue(result.baselineFingerprint)) {
        throw new Error("PSD incremental preview did not return a baseline fingerprint");
      }
      task.preview = result;
      task.baselineFingerprint = stringValue(result.baselineFingerprint);
      task.status = previewStatus as PsdPreviewStatus;
      task.stage = previewStatus.replace(/-/g, "_");
      task.percent = 100;
      touchTask(task);
      task.logs.push(formatTaskLog(task, `PSD 增量预览已完成：${previewStatus}`));
      taskOperations.get(task.taskId)?.succeed("PSD 增量预览已生成", { status: previewStatus });
      taskOperations.delete(task.taskId);
      return;
    }
    if (task.mode === "incremental-baseline-adopt") {
      if (!isRecord(result) || result.status !== "baseline-adopted") {
        throw new Error("PSD source baseline adoption was not completed");
      }
      task.status = "baseline-adopted";
      task.stage = "baseline_adopted";
      task.percent = 100;
      task.completedAt = Date.now();
      task.updatedAt = task.completedAt;
    notifyRunChanged(task.taskId);
      task.logs.push(formatTaskLog(task, "PSD 源状态基线认领完成，画布未修改"));
      taskOperations.get(task.taskId)?.succeed("PSD 源状态基线认领完成", { status: task.status });
      taskOperations.delete(task.taskId);
      return;
    }
    if (task.mode === "incremental-apply" && (!isRecord(result) || result.status !== "applied")) {
      throw new Error("PSD incremental apply was not completed");
    }
    if (task.mode === "initial" && task.renderer === "photoshop" && isRecord(result)) {
      await alignTextToPhotoshopReference(task, stringValue(result.rootNodeId));
    }
    await cleanupPhotoshop(true);
    setTaskStage(task, "completed", 100, task.mode === "incremental-apply" ? "PSD 增量更新完成" : "PSD 导入完成");
    task.status = "completed";
    task.completedAt = Date.now();
    task.updatedAt = task.completedAt;
    notifyRunChanged(task.taskId);
    logInfo("PSD import task completed", { taskId: task.taskId, fileName: task.fileName });
    taskOperations.get(task.taskId)?.succeed("PSD 导入任务完成", { mode: task.mode });
    taskOperations.delete(task.taskId);
  } catch (error) {
    const cancelled = isCancelRequested(task);
    await cleanupPhotoshop(false);
    if (cancelled) {
      task.status = "cancelled";
      task.stage = "cancelled";
      task.updatedAt = task.completedAt = Date.now();
    notifyRunChanged(task.taskId);
      task.logs.push(formatTaskLog(task, "Cancelled before Figma submission"));
      taskOperations.get(task.taskId)?.cancel("Export finished; Figma submission skipped");
      taskOperations.delete(task.taskId);
      return;
    }
    task.status = "error";
    task.stage = "error";
    task.percent = 100;
    task.error = error instanceof Error ? error.message : String(error);
    task.completedAt = Date.now();
    task.updatedAt = task.completedAt;
    notifyRunChanged(task.taskId);
    task.logs.push(formatTaskLog(task, `错误：${task.error}`));
    logWarn("PSD import task failed", { taskId: task.taskId, error: task.error });
    taskOperations.get(task.taskId)?.fail(error, "PSD 导入任务失败");
    taskOperations.delete(task.taskId);
  } finally {
    try {
      await cleanupPhotoshop(false);
    } finally {
      releasePhotoshopSlot?.();
    }
  }
}

// 取消请求可能在 await 期间到达；用函数读取，避免 TypeScript 沿用 await 前的类型收窄。
function isCancelRequested(task: PsdImportTask): boolean {
  return task.status === "cancel_requested";
}

/**
 * 默认使用本机 Photoshop；不可用时由 psd-tools 合成。
 * FIGMA_RELAY_PSD_RENDERER 可显式选择 raw|photoshop|psd-tools|auto，供兼容与诊断。
 */
function resolvePsdLayerRenderer(): PsdLayerRenderer {
  const requested = (process.env.FIGMA_RELAY_PSD_RENDERER || "auto").trim().toLowerCase();
  if (requested === "raw") return "raw";
  if (requested === "psd-tools") return "psd-tools";
  if (requested !== "auto" && requested !== "photoshop") {
    throw new Error(`Unsupported FIGMA_RELAY_PSD_RENDERER: ${requested}`);
  }
  const available = isPhotoshopComRegistered();
  if (requested === "photoshop" && !available) {
    throw new Error("FIGMA_RELAY_PSD_RENDERER=photoshop but Photoshop.Application COM is not registered");
  }
  return available ? "photoshop" : "psd-tools";
}

function isPhotoshopComRegistered(): boolean {
  if (process.platform !== "win32") return false;
  const result = spawnSync("reg", ["query", "HKCR\\Photoshop.Application\\CLSID"], { windowsHide: true });
  return result.status === 0;
}

async function acquirePhotoshopImportSlot(): Promise<() => void> {
  const previous = photoshopRenderQueue;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  photoshopRenderQueue = previous.then(() => held);
  await previous;
  return release;
}

/** 两种合成器共享提交契约；缺少 Photoshop 时使用独立合成，不再默默读取原始通道像素。 */
async function renderPsdLayers(task: PsdImportTask, photoshopReceiptPath?: string): Promise<void> {
  if (task.renderer === "raw") {
    task.logs.push(formatTaskLog(task, "已显式选择原始像素诊断模式，跳过合成渲染"));
    taskOperations.get(task.taskId)?.step("render.raw", "使用显式原始像素诊断模式", {}, "warn");
    touchTask(task);
    return;
  }
  const photoshop = task.renderer === "photoshop";
  setTaskStage(task, photoshop ? "rendering_psd_photoshop" : "rendering_psd_tools", 25,
    photoshop ? "使用 Photoshop 渲染图层样式、蒙版与画板" : "使用 psd-tools 独立渲染 PSD 图层");
  const renderDir = path.join(path.dirname(task.artifactDir), photoshop ? "ps_layers" : "psd_tools_layers");
  const args = [
    task.sourcePsdPath,
    "--out",
    renderDir,
    "--base-manifest",
    task.manifestSummaryPath
  ];
  if (photoshopReceiptPath) args.push("--session-receipt", photoshopReceiptPath);
  await runPythonScript(task, path.join(PSD_SKILL_SCRIPTS,
    photoshop ? "photoshop_render_units.py" : "psd_tools_render_units.py"), args);
  const renderedManifest = path.join(renderDir, "manifest_summary.json");
  if (!fs.existsSync(renderedManifest)) {
    throw new Error(`PSD rendered manifest was not created: ${renderedManifest}`);
  }
  task.manifestSummaryPath = renderedManifest;
}

/** 只释放 Python 所记录的本次启动实例；已有实例或用户后开了文档时保持打开。 */
async function releasePhotoshopImportSession(task: PsdImportTask, receiptPath: string, showProgress: boolean): Promise<void> {
  if (!fs.existsSync(receiptPath)) return;
  if (showProgress) setTaskStage(task, "closing_psd_photoshop", 98, "检查并关闭本次导入启动的 Photoshop");
  try {
    const output = await runPythonScript(task, path.join(PSD_SKILL_SCRIPTS, "photoshop_lifecycle.py"), [
      "release", "--session-receipt", receiptPath
    ], 30_000);
    const result: unknown = JSON.parse(output);
    if (!isRecord(result)) throw new Error("Photoshop cleanup returned an invalid result");
    const action = stringValue(result.action);
    const reason = stringValue(result.reason);
    const message = action === "closed" ? "本次导入启动的 Photoshop 已退出"
      : action === "kept" && reason === "open-documents" ? "Photoshop 中仍有打开的文档，保持打开"
        : action === "kept" ? "Photoshop 在导入前已运行，保持打开"
        : action === "already-closed" ? "本次导入的 Photoshop 已关闭"
          : `Photoshop 自动退出未执行：${reason || action}`;
    task.logs.push(formatTaskLog(task, message));
    taskOperations.get(task.taskId)?.step("photoshop.release", message, { action, reason },
      action === "error" || action === "skipped" || reason === "open-documents" ? "warn" : "info");
    touchTask(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    task.logs.push(formatTaskLog(task, `Photoshop 自动退出失败：${trimText(message, 300)}`));
    taskLogger.warn("Photoshop session cleanup failed", { taskId: task.taskId, error: trimText(message, 500) });
    touchTask(task);
  }
}

/** 按 Photoshop 合成图校正 Figma 原生文字位置；失败只记警告，不影响已完成的导入。 */
async function alignTextToPhotoshopReference(task: PsdImportTask, rootNodeId: string): Promise<void> {
  const reference = path.join(path.dirname(task.manifestSummaryPath), "ps_render", "reference.png");
  if (!rootNodeId || !fs.existsSync(reference)) {
    task.logs.push(formatTaskLog(task, "缺少根节点或 Photoshop 参照图，跳过文字对齐"));
    return;
  }
  setTaskStage(task, "aligning_psd_text", 90, "按 Photoshop 合成图校正文字位置");
  const script = path.join(PSD_SKILL_SCRIPTS, "align_psd_text_to_reference.py");
  const args = [rootNodeId, task.manifestSummaryPath, reference, "--session-id", task.target.sessionId, "--apply"];
  try {
    // 第二轮校正第一轮移动后残留的 1px 级偏移。
    await runPythonScript(task, script, args);
    await runPythonScript(task, script, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    task.logs.push(formatTaskLog(task, `文字对齐失败（导入结果已保留）：${trimText(message, 300)}`));
    taskOperations.get(task.taskId)?.step("align.failed", "文字对齐失败", { error: trimText(message, 500) }, "warn");
  }
}

function readResultSummary(resultPath: string): unknown {
  if (!fs.existsSync(resultPath)) {
    throw new Error(`Figma result was not created: ${resultPath}`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  return isRecord(parsed) && "result" in parsed ? parsed.result : parsed;
}

function setTaskStage(task: PsdImportTask, stage: string, percent: number, log: string): void {
  task.status = "running";
  task.stage = stage;
  task.percent = percent;
  touchTask(task);
  task.logs.push(formatTaskLog(task, log));
  const step = stage.includes("export")
    ? "export"
    : stage.includes("render") ? "render"
      : stage.includes("align") ? "align"
        : stage.includes("submit") ? "submit" : stage.includes("queue") ? "queued" : stage;
  taskOperations.get(task.taskId)?.step(step, log, { stage, percent });
  logInfo("PSD import task stage", { taskId: task.taskId, stage, percent });
}

function runPythonScript(task: PsdImportTask, scriptPath: string, args: string[], timeoutMs = 0): Promise<string> {
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`script not found: ${scriptPath}`);
  }
  const command = resolvePythonCommand();
  if (!command) {
    throw new Error("Python was not found by FIGMA_RELAY_PYTHON, the project .venv, py -3, or python.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.args, scriptPath, ...args], {
      cwd: PLUGIN_ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        FIGMA_RELAY_OPERATION_ID: task.taskId,
        FIGMA_RELAY_OPERATION_NAME: "psd.import",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      }
    });
    let finished = false;
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      if (finished) return;
      finished = true;
      // Only stop this task's Python helper. Never terminate Photoshop itself.
      try { child.kill(); } catch { /* Preserve the timeout result even if the helper already exited. */ }
      reject(new Error(`${path.basename(scriptPath)} timed out after ${timeoutMs} ms; Photoshop was not terminated`));
    }, timeoutMs) : undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      appendCommandOutput(task, out);
      appendPythonStderr(task, err);
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`${path.basename(scriptPath)} exited with code ${code}${err ? `: ${trimText(err, 1000)}` : ""}`));
      }
    });
  });
}

function startTaskOperation(task: PsdImportTask, name: string, message: string): void {
  const operation = taskLogger.startOperation(name, message, {
    operationId: task.taskId,
    data: { mode: task.mode, fileName: task.fileName }
  });
  operation.step("queued", "PSD 任务已进入执行队列", { mode: task.mode });
  taskOperations.set(task.taskId, operation);
}

function appendPythonStderr(task: PsdImportTask, text: string): void {
  if (!text) return;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith(PYTHON_LOG_MARKER)) {
      try {
        logging.store.ingest([JSON.parse(line.slice(PYTHON_LOG_MARKER.length))]);
        continue;
      } catch (error) {
        taskOperations.get(task.taskId)?.step("python.stderr", "Python 结构化日志解析失败", {
          error: error instanceof Error ? error.message : String(error)
        }, "warn");
      }
    } else {
      taskOperations.get(task.taskId)?.step("python.stderr", "Python 进程输出了非结构化 stderr", {
        chars: line.length,
        summary: trimText(line, 500)
      }, "warn");
    }
  }
  appendCommandOutput(task, text);
}

function appendCommandOutput(task: PsdImportTask, text: string): void {
  if (!text) return;
  for (const line of text.split(/\r?\n/).slice(-12)) {
    if (line.trim()) {
      task.logs.push(formatTaskLog(task, trimText(line.trim(), 500)));
    }
  }
  touchTask(task);
}

function formatTaskLog(task: PsdImportTask, message: string): string {
  const percent = Math.max(0, Math.min(100, Math.round(task.percent || 0)));
  return `[${percent}%] ${message}`;
}

function resolvePythonCommand(): { command: string; args: string[] } | null {
  const env = process.env.FIGMA_RELAY_PYTHON;
  const projectPython = path.join(PLUGIN_ROOT, ".venv", process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python");
  const candidates = env
    ? [{ command: env, args: ["--version"] }]
    : [
        ...(fs.existsSync(projectPython) ? [{ command: projectPython, args: ["--version"] }] : []),
        { command: "py", args: ["-3", "--version"] },
        { command: "python", args: ["--version"] }
      ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, { encoding: "utf8", windowsHide: true });
    if (result.status === 0) {
      return env || candidate.command === projectPython
        ? { command: candidate.command, args: [] }
        : candidate.command === "py"
          ? { command: "py", args: ["-3"] }
          : { command: "python", args: [] };
    }
  }
  return null;
}

function decodeBase64File(value: string): Buffer {
  const cleaned = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const bytes = Buffer.from(cleaned.replace(/\s+/g, ""), "base64");
  if (bytes.length < 16) {
    throw new Error("decoded PSD file is empty");
  }
  return bytes;
}

function findPreviousIdenticalPsdUpload(
  importsRoot: string,
  fileName: string,
  size: number,
  sha256: string
): boolean {
  if (!fs.existsSync(importsRoot)) return false;
  try {
    const taskDirs = fs.readdirSync(importsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("psd-"))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 50);
    for (const taskDirName of taskDirs) {
      const taskDirPath = path.join(importsRoot, taskDirName);
      const candidateNames = fs.readdirSync(taskDirPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.psd$/i.test(entry.name))
        .map((entry) => entry.name);
      for (const candidateName of candidateNames) {
        const candidatePath = path.join(taskDirPath, candidateName);
        const stat = fs.statSync(candidatePath);
        if (stat.size !== size) continue;
        const candidateSha256 = hashPsdFile(candidatePath);
        if (candidateSha256 === sha256) return true;
      }
    }
  } catch (error) {
    logWarn("Unable to inspect previous PSD upload fingerprint", {
      fileName,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  return false;
}

function rootNameFromFile(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName));
  const cleaned = stem
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^_+|_+$/g, "")
    .trim();
  return cleaned || "psd_import";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function trimText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
