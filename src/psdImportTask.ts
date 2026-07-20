import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { GatewayConfig } from "./config.js";
import { PLUGIN_ROOT, publicUrl } from "./config.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import type { OperationScope } from "./logging/operationScope.js";
import { logInfo, logWarn } from "./utils/logger.js";
import { isRecord } from "./utils.js";

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
}

const tasks = new Map<string, PsdImportTask>();
const taskOperations = new Map<string, OperationScope>();
const logging = getLoggingRuntime();
const taskLogger = logging.logger("psd-import-task");
const PYTHON_LOG_MARKER = "FIGMA_RELAY_LOG ";
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
  const fileName = sanitizeFileName(stringValue(payload.fileName) || "source.psd");
  if (!/\.psd$/i.test(fileName)) {
    throw new Error("fileName must end with .psd");
  }
  const fileBase64 = stringValue(payload.fileBase64);
  if (!fileBase64) {
    throw new Error("fileBase64 is required");
  }
  const target = isRecord(payload.target) ? payload.target : {};
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
  if (!fileKey && !sessionId) {
    throw new Error("target.fileKey or target.sessionId is required");
  }

  const taskId = `psd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const taskDir = path.join(PLUGIN_ROOT, ".tmp", "psd-to-figma", taskId);
  const sourcePsdPath = path.join(taskDir, fileName);
  const artifactDir = path.join(taskDir, "layers");
  const resultPath = path.join(taskDir, "figma_mcp_result.json");
  const timelinePath = path.join(taskDir, "timeline.json");
  const manifestSummaryPath = path.join(artifactDir, "manifest_summary.json");

  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(sourcePsdPath, decodeBase64File(fileBase64));

  const now = Date.now();
  const task: PsdImportTask = {
    taskId,
    mode,
    status: "queued",
    stage: "queued",
    percent: 0,
    fileName,
    sourcePsdPath,
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
  startTaskOperation(task, "psd.import", "开始 PSD 导入任务");
  void runPsdImportTask(config, task, { reuseExportArtifacts: false });
  return serializePsdImportTask(task);
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
  task.updatedAt = Date.now();
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
  task.updatedAt = Date.now();
  startTaskOperation(task, "psd.incremental-baseline-adopt", "开始认领 PSD 源状态基线");
  void runPsdImportTask(config, task, { reuseExportArtifacts: true });
  return serializePsdImportTask(task);
}

function serializePsdImportTask(task: PsdImportTask): PsdImportTask {
  return {
    ...task,
    logs: task.logs.slice(-40)
  };
}

async function runPsdImportTask(
  config: GatewayConfig,
  task: PsdImportTask,
  options: { reuseExportArtifacts: boolean }
): Promise<void> {
  try {
    if (!options.reuseExportArtifacts) {
      setTaskStage(task, "exporting_psd_layers", 10, "开始导出 PSD 图层");
      const exportScript = path.join(PLUGIN_ROOT, "ai", "skills", "psd-layer-to-figma", "scripts", "export_psd_layers.py");
      await runPythonScript(task, exportScript, [
        task.sourcePsdPath,
        "--out",
        task.artifactDir,
        "--summary"
      ]);
    }
    if (!fs.existsSync(task.manifestSummaryPath)) {
      throw new Error(`manifest_summary.json was not created: ${task.manifestSummaryPath}`);
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
      task.updatedAt = Date.now();
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
      task.logs.push(formatTaskLog(task, "PSD 源状态基线认领完成，画布未修改"));
      taskOperations.get(task.taskId)?.succeed("PSD 源状态基线认领完成", { status: task.status });
      taskOperations.delete(task.taskId);
      return;
    }
    if (task.mode === "incremental-apply" && (!isRecord(result) || result.status !== "applied")) {
      throw new Error("PSD incremental apply was not completed");
    }
    setTaskStage(task, "completed", 100, task.mode === "incremental-apply" ? "PSD 增量更新完成" : "PSD 导入完成");
    task.status = "completed";
    task.completedAt = Date.now();
    task.updatedAt = task.completedAt;
    logInfo("PSD import task completed", { taskId: task.taskId, fileName: task.fileName });
    taskOperations.get(task.taskId)?.succeed("PSD 导入任务完成", { mode: task.mode });
    taskOperations.delete(task.taskId);
  } catch (error) {
    task.status = "error";
    task.stage = "error";
    task.percent = 100;
    task.error = error instanceof Error ? error.message : String(error);
    task.completedAt = Date.now();
    task.updatedAt = task.completedAt;
    task.logs.push(formatTaskLog(task, `错误：${task.error}`));
    logWarn("PSD import task failed", { taskId: task.taskId, error: task.error });
    taskOperations.get(task.taskId)?.fail(error, "PSD 导入任务失败");
    taskOperations.delete(task.taskId);
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
  task.updatedAt = Date.now();
  task.logs.push(formatTaskLog(task, log));
  const step = stage.includes("export")
    ? "export"
    : stage.includes("submit") ? "submit" : stage.includes("queue") ? "queued" : stage;
  taskOperations.get(task.taskId)?.step(step, log, { stage, percent });
  logInfo("PSD import task stage", { taskId: task.taskId, stage, percent });
}

function runPythonScript(task: PsdImportTask, scriptPath: string, args: string[]): Promise<void> {
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`script not found: ${scriptPath}`);
  }
  const command = resolvePythonCommand();
  if (!command) {
    throw new Error("Python was not found by FIGMA_RELAY_PYTHON, py -3, or python.");
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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      appendCommandOutput(task, out);
      appendPythonStderr(task, err);
      if (code === 0) {
        resolve();
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
  task.updatedAt = Date.now();
}

function formatTaskLog(task: PsdImportTask, message: string): string {
  const percent = Math.max(0, Math.min(100, Math.round(task.percent || 0)));
  return `[${percent}%] ${message}`;
}

function resolvePythonCommand(): { command: string; args: string[] } | null {
  const env = process.env.FIGMA_RELAY_PYTHON;
  const candidates = env
    ? [{ command: env, args: ["--version"] }]
    : [
        { command: "py", args: ["-3", "--version"] },
        { command: "python", args: ["--version"] }
      ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, { encoding: "utf8", windowsHide: true });
    if (result.status === 0) {
      return env
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

function rootNameFromFile(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName));
  const cleaned = stem
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^_+|_+$/g, "")
    .trim();
  return cleaned || "psd_import";
}

function sanitizeFileName(value: string): string {
  return path.basename(String(value || "source.psd")).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 120);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function trimText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
