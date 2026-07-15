import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { GatewayConfig } from "./config.js";
import { PLUGIN_ROOT, REPO_ROOT, publicUrl } from "./config.js";
import { logInfo, logWarn } from "./logger.js";
import { isRecord } from "./utils.js";

type PsdImportTaskStatus = "queued" | "running" | "completed" | "error";

export interface PsdImportTask {
  taskId: string;
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
  };
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  logs: string[];
  error?: string;
  summary?: unknown;
}

const tasks = new Map<string, PsdImportTask>();

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
    status: "queued",
    stage: "queued",
    percent: 0,
    fileName,
    sourcePsdPath,
    artifactDir,
    manifestSummaryPath,
    resultPath,
    timelinePath,
    target: { fileKey, sessionId, targetNodeId },
    startedAt: now,
    updatedAt: now,
    logs: []
  };
  tasks.set(taskId, task);
  void runPsdImportTask(config, task);
  return serializePsdImportTask(task);
}

export function getPsdImportTask(taskId: string): PsdImportTask | undefined {
  const task = tasks.get(taskId);
  return task ? serializePsdImportTask(task) : undefined;
}

function serializePsdImportTask(task: PsdImportTask): PsdImportTask {
  return {
    ...task,
    logs: task.logs.slice(-40)
  };
}

async function runPsdImportTask(config: GatewayConfig, task: PsdImportTask): Promise<void> {
  try {
    setTaskStage(task, "exporting_psd_layers", 10, "开始导出 PSD 图层");
    const exportScript = path.join(PLUGIN_ROOT, "ai", "skills", "psd-layer-to-figma", "scripts", "export_psd_layers.py");
    await runPythonScript(task, exportScript, [
      task.sourcePsdPath,
      "--out",
      task.artifactDir,
      "--summary"
    ]);
    if (!fs.existsSync(task.manifestSummaryPath)) {
      throw new Error(`manifest_summary.json was not created: ${task.manifestSummaryPath}`);
    }

    setTaskStage(task, "submitting_figma_import", 55, "开始提交 Figma 导入任务");
    const submitScript = path.join(PLUGIN_ROOT, "ai", "skills", "psd-layer-to-figma", "scripts", "submit_psd_import_job.py");
    const submitArgs = [
      task.manifestSummaryPath,
      "--root-name",
      rootNameFromFile(task.fileName),
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
    await runPythonScript(task, submitScript, submitArgs);

    setTaskStage(task, "completed", 100, "PSD 导入完成");
    task.status = "completed";
    task.completedAt = Date.now();
    task.updatedAt = task.completedAt;
    logInfo("PSD import task completed", { taskId: task.taskId, fileName: task.fileName });
  } catch (error) {
    task.status = "error";
    task.stage = "error";
    task.percent = 100;
    task.error = error instanceof Error ? error.message : String(error);
    task.completedAt = Date.now();
    task.updatedAt = task.completedAt;
    task.logs.push(formatTaskLog(task, `错误：${task.error}`));
    logWarn("PSD import task failed", { taskId: task.taskId, error: task.error });
  }
}

function setTaskStage(task: PsdImportTask, stage: string, percent: number, log: string): void {
  task.status = "running";
  task.stage = stage;
  task.percent = percent;
  task.updatedAt = Date.now();
  task.logs.push(formatTaskLog(task, log));
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
      cwd: REPO_ROOT,
      windowsHide: true
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
      appendCommandOutput(task, err);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(scriptPath)} exited with code ${code}${err ? `: ${trimText(err, 1000)}` : ""}`));
      }
    });
  });
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
