import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type { GatewayConfig } from "./config.js";
import { PLUGIN_ROOT, SERVER_VERSION, publicUrl } from "./config.js";
import { callUnityBridge } from "./unityBridgeClient.js";
import type { UnityProjectRegistry, UnityProjectStatus } from "./unityProjectRegistry.js";
import { isRecord } from "./utils.js";
import { logInfo, logWarn } from "./utils/logger.js";

export type FigmaPrefabImportTaskStatus = "queued" | "running" | "completed" | "error";

export interface FigmaPrefabImportSummary {
  status: string;
  prefab: string;
  targetImageDir: string;
  atlasDir: string;
  atlasPath?: string;
  verifyAllPass: boolean;
  auditReport?: string;
  imageReport?: string;
  verifyReport?: string;
  wallClockReport?: string;
  [key: string]: unknown;
}

export interface FigmaPrefabImportTask {
  taskId: string;
  sessionId: string;
  fileKey: string;
  requestFingerprint: string;
  status: FigmaPrefabImportTaskStatus;
  stage: string;
  percent: number;
  projectId: string;
  projectPath: string;
  targetFolder: string;
  manifestDir: string;
  wallClockReport: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  logs: string[];
  error?: string;
  summary?: FigmaPrefabImportSummary;
}

export interface FigmaPrefabImportProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FigmaPrefabImportDependencies {
  probeUnityGateway?: (project: UnityProjectStatus, expectedTargetFolder?: string) => Promise<void>;
  executePython?: (
    task: FigmaPrefabImportTask,
    scriptPath: string,
    args: string[]
  ) => Promise<FigmaPrefabImportProcessResult>;
}

interface PreparedImport {
  project: UnityProjectStatus;
  projectKey: string;
  targetFolder: string;
  sessionId: string;
  fileKey: string;
  nodeId: string;
  nodeName: string;
  nodeWidth: number;
  nodeHeight: number;
}

const tasks = new Map<string, FigmaPrefabImportTask>();
const projectImportLocks = new Map<string, string>();
const MAX_TASK_LOGS = 60;
const MAX_PROCESS_OUTPUT_CHARS = 2 * 1024 * 1024;
const MAX_RETAINED_TASKS = 100;
const TERMINAL_TASK_TTL_MS = 30 * 60 * 1000;

export function startFigmaPrefabImportTask(
  config: GatewayConfig,
  registry: UnityProjectRegistry,
  payload: unknown,
  dependencies: FigmaPrefabImportDependencies = {}
): FigmaPrefabImportTask {
  evictRetainedTasks();
  if (!isRecord(payload)) throw new Error("json body must be object");
  const taskId = stringValue(payload.clientRequestId) || `figma-prefab-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new Error("Invalid clientRequestId");
  const requestFingerprint = createHash("sha256").update(JSON.stringify([
    payload.projectId, payload.gatewayProjectPath, payload.targetFolder, payload.sessionId, payload.fileKey,
    payload.nodeId, payload.nodeName, payload.nodeWidth, payload.nodeHeight,
  ])).digest("hex");
  const previous = tasks.get(taskId);
  if (previous) {
    if (previous.requestFingerprint !== requestFingerprint) throw new Error("Import request identity conflict");
    logInfo("Deterministic import deduplicated", { taskId, sessionId: previous.sessionId });
    return serializeTask(previous);
  }
  if (tasks.size >= MAX_RETAINED_TASKS) throw new Error("Import task capacity reached");
  const prepared = prepareFigmaPrefabImport(registry, payload);
  const activeTaskId = projectImportLocks.get(prepared.projectKey);
  if (activeTaskId) {
    throw new Error(`Unity project already has a deterministic import task in flight: ${activeTaskId}`);
  }

  const taskDirectory = path.join(PLUGIN_ROOT, ".tmp", "figma-to-prefab", taskId);
  if (fs.existsSync(taskDirectory)) throw new Error("Import request has existing artifacts; do not replay an unknown write");
  const now = Date.now();
  const task: FigmaPrefabImportTask = {
    taskId,
    sessionId: prepared.sessionId,
    fileKey: prepared.fileKey,
    requestFingerprint,
    status: "queued",
    stage: "queued",
    percent: 0,
    projectId: prepared.project.id,
    projectPath: prepared.project.path,
    targetFolder: prepared.targetFolder,
    manifestDir: path.join(taskDirectory, "manifest"),
    wallClockReport: path.join(taskDirectory, "wall-clock.json"),
    startedAt: now,
    updatedAt: now,
    logs: ["[0%] Deterministic Figma import queued."]
  };

  fs.mkdirSync(task.manifestDir, { recursive: true });
  tasks.set(taskId, task);
  projectImportLocks.set(prepared.projectKey, taskId);
  queueMicrotask(() => {
    void runFigmaPrefabImportTask(config, task, prepared, dependencies);
  });
  return serializeTask(task);
}

export function getFigmaPrefabImportTask(taskId: string): FigmaPrefabImportTask | undefined {
  evictRetainedTasks();
  const task = tasks.get(taskId);
  return task ? serializeTask(task) : undefined;
}

export function normalizeFigmaPrefabTargetFolder(value: unknown): string {
  const raw = stringValue(value).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!raw) throw new Error("targetFolder is required");
  if (path.isAbsolute(raw) || /^\/?[A-Za-z]:/.test(raw) || raw.startsWith("/")) {
    throw new Error("targetFolder must be a Unity asset path under Assets/");
  }
  const segments = raw.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("targetFolder must not contain empty, current, or parent path segments");
  }
  if (segments[0] !== "Assets" || segments.length < 2) {
    throw new Error("targetFolder must be a child folder under Assets/");
  }
  return segments.join("/");
}

export function buildFigmaPrefabImportArgs(
  config: GatewayConfig,
  prepared: PreparedImport,
  task: Pick<FigmaPrefabImportTask, "manifestDir" | "wallClockReport">
): string[] {
  const placeholderPrefab = `${prepared.targetFolder}/Prefab/Pending.prefab`;
  const placeholderTextureDirectory = `${prepared.targetFolder}/Texture`;
  const urlNodeId = prepared.nodeId.replace(/:/g, "-");
  const figmaUrl = `https://www.figma.com/design/${encodeURIComponent(prepared.fileKey)}/Relay?node-id=${encodeURIComponent(urlNodeId)}`;
  const args = [
    "--unity-project", prepared.project.path,
    "--unity-project-id", prepared.project.id,
    "--figma-url", figmaUrl,
    "--target-prefab", placeholderPrefab,
    "--target-image-dir", placeholderTextureDirectory,
    "--file-key", prepared.fileKey,
    "--session-id", prepared.sessionId,
    "--relay-url", publicUrl(config),
    "--infer-formal-names",
    "--formal-layout", "split",
    "--formal-output-dir", prepared.targetFolder,
    "--overwrite", "create-new-only",
    "--manifest-dir", task.manifestDir,
    "--wall-clock-report", task.wallClockReport,
    "--expect-root-name", prepared.nodeName,
    "--yes"
  ];
  if (prepared.nodeWidth > 0) args.push("--expect-root-width", String(prepared.nodeWidth));
  if (prepared.nodeHeight > 0) args.push("--expect-root-height", String(prepared.nodeHeight));
  return args;
}

export function parseFigmaPrefabImportSummary(
  stdout: string,
  targetFolder: string,
  options: { requireVerified?: boolean } = {}
): FigmaPrefabImportSummary {
  const requireVerified = options.requireVerified !== false;
  const marker = "[SUMMARY_JSON]";
  const markerCount = stdout.split(marker).length - 1;
  if (markerCount !== 1) {
    throw new Error(`run_full_import.py must emit exactly one ${marker} block; received ${markerCount}`);
  }
  const jsonText = stdout.slice(stdout.indexOf(marker) + marker.length).trim();
  const summaryLines = jsonText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (summaryLines.length !== 1) {
    throw new Error(`${marker} must be the final process output`);
  }
  const firstLine = summaryLines[0] || "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch (error) {
    throw new Error(`run_full_import.py emitted malformed summary JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("run_full_import.py summary must be an object");

  const summary: FigmaPrefabImportSummary = {
    ...parsed,
    status: stringValue(parsed.status),
    prefab: stringValue(parsed.prefab),
    targetImageDir: stringValue(parsed.targetImageDir),
    atlasDir: stringValue(parsed.atlasDir),
    atlasPath: stringValue(parsed.atlasPath),
    verifyAllPass: parsed.verifyAllPass === true
  };
  if (requireVerified && (summary.status !== "completed" || summary.verifyAllPass !== true)) {
    throw new Error("deterministic import summary did not pass Unity verification");
  }
  for (const [name, output] of [
    ["prefab", summary.prefab],
    ["targetImageDir", summary.targetImageDir],
    ["atlasDir", summary.atlasDir],
    ["atlasPath", summary.atlasPath || ""]
  ] as const) {
    if (output && !isUnityAssetPathWithin(output, targetFolder)) {
      throw new Error(`${name} output is not beneath the selected target folder`);
    }
  }
  if (!requireVerified && summary.status !== "completed") return summary;
  if (!summary.prefab || !summary.targetImageDir || !summary.atlasDir) {
    throw new Error("deterministic import summary is missing one or more output paths");
  }
  if (!summary.atlasPath) {
    throw new Error("deterministic import summary is missing the generated SpriteAtlas path");
  }
  const normalizedPrefab = normalizeFigmaPrefabTargetAssetPath(summary.prefab);
  const normalizedTextureDir = normalizeFigmaPrefabTargetAssetPath(summary.targetImageDir);
  const normalizedAtlasDir = normalizeFigmaPrefabTargetAssetPath(summary.atlasDir);
  if (!normalizedPrefab.startsWith(`${targetFolder}/Prefab/`) || !normalizedPrefab.toLowerCase().endsWith(".prefab")) {
    throw new Error("prefab output does not match the fixed Prefab/ layout");
  }
  if (normalizedTextureDir !== `${targetFolder}/Texture`) {
    throw new Error("targetImageDir output does not match the fixed Texture/ layout");
  }
  if (normalizedAtlasDir !== `${targetFolder}/UiAtlas`) {
    throw new Error("atlasDir output does not match the fixed UiAtlas/ layout");
  }
  const normalizedAtlasPath = normalizeFigmaPrefabTargetAssetPath(summary.atlasPath);
  if (!normalizedAtlasPath.startsWith(`${targetFolder}/UiAtlas/`) || !normalizedAtlasPath.toLowerCase().endsWith(".spriteatlasv2")) {
    throw new Error("atlasPath output does not match the fixed UiAtlas/*.spriteatlasv2 layout");
  }
  return summary;
}

async function runFigmaPrefabImportTask(
  config: GatewayConfig,
  task: FigmaPrefabImportTask,
  prepared: PreparedImport,
  dependencies: FigmaPrefabImportDependencies
): Promise<void> {
  try {
    setTaskStage(task, "checking_unity", 5, "Checking the registered Unity project and gateway.");
    assertEmptyImportTarget(prepared.project.path, prepared.targetFolder);
    await (dependencies.probeUnityGateway || probeUnityGateway)(prepared.project, prepared.targetFolder);

    setTaskStage(task, "running_pipeline", 10, "Running fixed Figma-to-Prefab rules.");
    assertEmptyImportTarget(prepared.project.path, prepared.targetFolder);
    await (dependencies.probeUnityGateway || probeUnityGateway)(prepared.project, prepared.targetFolder);
    const scriptPath = path.join(
      PLUGIN_ROOT,
      "ai",
      "skills",
      "figma-to-prefab",
      "scripts",
      "run_full_import.py"
    );
    if (!fs.statSync(scriptPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`run_full_import.py was not found: ${scriptPath}`);
    }
    const args = buildFigmaPrefabImportArgs(config, prepared, task);
    const result = await (dependencies.executePython || executePython)(task, scriptPath, args);
    appendProcessOutput(task, result.stdout);
    appendProcessOutput(task, result.stderr);

    let summary: FigmaPrefabImportSummary | undefined;
    let summaryError: Error | undefined;
    try {
      summary = parseFigmaPrefabImportSummary(result.stdout, prepared.targetFolder, { requireVerified: false });
      task.summary = summary;
    } catch (error) {
      summaryError = error instanceof Error ? error : new Error(String(error));
      if (result.exitCode === 0) throw summaryError;
    }
    if (result.exitCode !== 0) {
      const summaryDetail = summary ? describeUnverifiedSummary(summary) : "";
      const processDetail = summarizeProcessFailure(result.stdout, result.stderr);
      throw new Error([
        `run_full_import.py exited with nonzero exit code ${result.exitCode}`,
        summaryDetail,
        processDetail
      ].filter(Boolean).join("; "));
    }
    if (summaryError) throw summaryError;
    if (!summary) throw new Error("run_full_import.py completed without a valid summary");
    assertImportOutputsExist(prepared.project.path, prepared.targetFolder, summary);

    task.status = "completed";
    task.stage = "completed";
    task.percent = 100;
    task.completedAt = Date.now();
    task.updatedAt = task.completedAt;
    appendTaskLog(task, "[100%] Prefab, Texture, and UiAtlas outputs passed deterministic verification.");
    logInfo("Deterministic Figma Prefab import completed", {
      taskId: task.taskId,
      projectId: task.projectId,
      prefab: summary.prefab
    });
  } catch (error) {
    task.status = "error";
    task.stage = "error";
    task.percent = 100;
    task.error = error instanceof Error ? error.message : String(error);
    task.completedAt = Date.now();
    task.updatedAt = task.completedAt;
    appendTaskLog(task, `[error] ${task.error}`);
    logWarn("Deterministic Figma Prefab import failed", {
      taskId: task.taskId,
      projectId: task.projectId,
      error: task.error
    });
  } finally {
    if (projectImportLocks.get(prepared.projectKey) === task.taskId) {
      projectImportLocks.delete(prepared.projectKey);
    }
  }
}

function prepareFigmaPrefabImport(registry: UnityProjectRegistry, payload: unknown): PreparedImport {
  if (!isRecord(payload)) throw new Error("json body must be object");
  const projectId = stringValue(payload.projectId);
  if (!projectId) throw new Error("projectId is required");
  const project = registry.snapshot(projectId);
  if (!project.valid) throw new Error("registered Unity project is invalid");
  if (!project.bridgeInstalled) throw new Error("compatible Figma Bridge is not installed in the selected Unity project");
  if (!project.settingsConfigured) throw new Error("Figma Bridge import settings are not configured");

  const gatewayProjectPath = stringValue(payload.gatewayProjectPath);
  if (!gatewayProjectPath || pathKey(gatewayProjectPath) !== pathKey(project.path)) {
    throw new Error("connected Unity gateway does not match the selected registered project");
  }
  assertCommonFontAssets(project.path);

  const targetFolder = normalizeFigmaPrefabTargetFolder(payload.targetFolder);
  assertEmptyImportTarget(project.path, targetFolder);
  const sessionId = requiredString(payload.sessionId, "sessionId");
  const fileKey = requiredString(payload.fileKey, "fileKey");
  const nodeId = requiredString(payload.nodeId, "nodeId");
  const nodeName = requiredString(payload.nodeName, "nodeName");
  if (!/^[A-Za-z0-9_-]+$/.test(fileKey)) throw new Error("fileKey contains invalid characters");
  if (!/^[0-9]+(?::|-)[0-9]+$/.test(nodeId)) throw new Error("nodeId must identify exactly one Figma node");

  return {
    project,
    projectKey: pathKey(project.path),
    targetFolder,
    sessionId,
    fileKey,
    nodeId,
    nodeName,
    nodeWidth: positiveInteger(payload.nodeWidth),
    nodeHeight: positiveInteger(payload.nodeHeight)
  };
}

function assertEmptyImportTarget(projectPath: string, targetFolder: string): string {
  const projectRealPath = fs.realpathSync.native(projectPath);
  const assetsRealPath = fs.realpathSync.native(path.join(projectRealPath, "Assets"));
  if (!isFileSystemPathWithin(assetsRealPath, projectRealPath)) {
    throw new Error("the registered project's Assets directory escapes the project through a symlink or junction");
  }
  const targetPath = path.resolve(projectRealPath, ...targetFolder.split("/"));
  if (!fs.statSync(targetPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`selected Unity target folder does not exist: ${targetFolder}`);
  }
  const targetRealPath = fs.realpathSync.native(targetPath);
  if (!isFileSystemPathWithin(targetRealPath, assetsRealPath)) {
    throw new Error("selected Unity target folder escapes the registered project's Assets directory through a symlink or junction");
  }
  if (fs.readdirSync(targetRealPath).length !== 0) {
    throw new Error("selected Unity target folder must be empty");
  }
  return targetRealPath;
}

function assertCommonFontAssets(projectPath: string): void {
  const settingsPath = path.join(projectPath, "ProjectSettings", "FigmaBridgeImportSettings.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`Figma Bridge import settings are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fontAsset = isRecord(parsed) ? normalizeFigmaPrefabTargetAssetPath(parsed.commonFontAsset) : "";
  if (!fontAsset || !fontAsset.toLowerCase().endsWith(".asset")) {
    throw new Error("Figma Bridge CommonFont asset is not configured");
  }
  const materialAsset = fontAsset.slice(0, -".asset".length) + ".mat";
  for (const [label, assetPath] of [["CommonFont", fontAsset], ["CommonFont material", materialAsset]] as const) {
    const resolved = path.resolve(projectPath, ...assetPath.split("/"));
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${label} asset does not exist: ${assetPath}`);
    }
    const real = fs.realpathSync.native(resolved);
    const assetsReal = fs.realpathSync.native(path.join(projectPath, "Assets"));
    if (!isFileSystemPathWithin(real, assetsReal)) {
      throw new Error(`${label} asset escapes the registered project's Assets directory`);
    }
  }
}

function normalizeFigmaPrefabTargetAssetPath(value: unknown): string {
  const raw = stringValue(value).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!raw || path.isAbsolute(raw) || raw.startsWith("/") || /^\/?[A-Za-z]:/.test(raw)) return "";
  const segments = raw.split("/");
  if (segments[0] !== "Assets" || segments.some((segment) => !segment || segment === "." || segment === "..")) return "";
  return segments.join("/");
}

export async function probeUnityGateway(project: UnityProjectStatus, expectedTargetFolder = "", command = callUnityBridge): Promise<void> {
  const payload = await command(project.path, "unity.health", {}, { timeoutMs: 3000 });
  if (pathKey(stringValue(payload.projectPath)) !== pathKey(project.path)) {
    throw new Error("running Unity gateway reports a different project path");
  }
  if (stringValue(payload.version) !== SERVER_VERSION) {
    throw new Error(`Unity Bridge version mismatch: expected ${SERVER_VERSION}, received ${stringValue(payload.version) || "missing"}`);
  }
  if (!expectedTargetFolder) return;
  const selection = await command(project.path, "unity.selected-folder", {}, { timeoutMs: 3000 });
  if (selection.ok === false) throw new Error(String(selection.error || "Unity selected-folder query failed"));
  const selectedFolder = normalizeFigmaPrefabTargetFolder(selection.selectedFolder);
  if (pathKey(selectedFolder) !== pathKey(expectedTargetFolder)) {
    throw new Error(`Unity current selected folder does not match the import target: ${selectedFolder}`);
  }
  if (selection.selectedObjectIsFolder !== true || selection.selectedFolderIsEmpty !== true) {
    throw new Error("Unity current selected target must be an empty folder");
  }
}

function executePython(
  task: FigmaPrefabImportTask,
  scriptPath: string,
  args: string[]
): Promise<FigmaPrefabImportProcessResult> {
  const command = resolvePythonCommand();
  if (!command) throw new Error("Python was not found by FIGMA_RELAY_PYTHON, py -3, or python");
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.args, scriptPath, ...args], {
      cwd: PLUGIN_ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        FIGMA_RELAY_OPERATION_ID: task.taskId,
        FIGMA_RELAY_OPERATION_NAME: "figma.prefab-import",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
  });
}

function resolvePythonCommand(): { command: string; args: string[] } | null {
  const configured = stringValue(process.env.FIGMA_RELAY_PYTHON);
  const candidates = configured
    ? [{ command: configured, versionArgs: ["--version"], args: [] }]
    : [
        { command: "py", versionArgs: ["-3", "--version"], args: ["-3"] },
        { command: "python", versionArgs: ["--version"], args: [] }
      ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.versionArgs, { encoding: "utf8", windowsHide: true });
    if (result.status === 0) return { command: candidate.command, args: candidate.args };
  }
  return null;
}

function serializeTask(task: FigmaPrefabImportTask): FigmaPrefabImportTask {
  return structuredClone({ ...task, logs: task.logs.slice(-MAX_TASK_LOGS) });
}

function setTaskStage(task: FigmaPrefabImportTask, stage: string, percent: number, message: string): void {
  task.status = "running";
  task.stage = stage;
  task.percent = percent;
  task.updatedAt = Date.now();
  appendTaskLog(task, `[${percent}%] ${message}`);
}

function appendProcessOutput(task: FigmaPrefabImportTask, output: string): void {
  if (!output) return;
  for (const line of output.split(/\r?\n/).filter(Boolean).slice(-12)) {
    appendTaskLog(task, line.trim().slice(0, 500));
  }
}

function appendTaskLog(task: FigmaPrefabImportTask, line: string): void {
  task.logs.push(line);
  if (task.logs.length > MAX_TASK_LOGS) task.logs.splice(0, task.logs.length - MAX_TASK_LOGS);
  task.updatedAt = Date.now();
}

function appendBoundedOutput(current: string, chunk: unknown): string {
  const next = current + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  return next.length > MAX_PROCESS_OUTPUT_CHARS ? next.slice(-MAX_PROCESS_OUTPUT_CHARS) : next;
}

function describeUnverifiedSummary(summary: FigmaPrefabImportSummary): string {
  const details: string[] = [];
  if (summary.status !== "completed") details.push(`summary status=${summary.status || "missing"}`);
  if (!summary.verifyAllPass) details.push("verifyAllPass=false");
  for (const key of ["blockingErrors", "errors"] as const) {
    const values = summary[key];
    if (Array.isArray(values) && values.length > 0) {
      details.push(`${key}=${JSON.stringify(values.slice(0, 3))}`);
    }
  }
  return details.length > 0 ? `deterministic import verification failed (${details.join(", ")})` : "";
}

function summarizeProcessFailure(stdout: string, stderr: string): string {
  const lines = [...stderr.split(/\r?\n/), ...stdout.split(/\r?\n/)]
    .map((line) => line.trim())
    .filter(Boolean);
  const important = lines.filter((line) => /\[FAIL\]|Traceback|Error|Exception|blocking|failed/i.test(line));
  const selected = [...new Set([...important.slice(-6), ...lines.slice(-6)])].slice(-8);
  return selected.length > 0 ? `process output: ${selected.join(" | ").slice(0, 3000)}` : "";
}

function assertImportOutputsExist(
  projectPath: string,
  targetFolder: string,
  summary: FigmaPrefabImportSummary
): void {
  const assetsPath = fs.realpathSync.native(path.join(projectPath, "Assets"));
  const targetPath = fs.realpathSync.native(path.join(projectPath, ...targetFolder.split("/")));
  if (!isFileSystemPathWithin(targetPath, assetsPath)) {
    throw new Error("import target folder escapes the project's Assets directory");
  }
  const outputs: Array<[string, string, "file" | "directory"]> = [
    ["Prefab", summary.prefab, "file"],
    ["Texture", summary.targetImageDir, "directory"],
    ["UiAtlas", summary.atlasDir, "directory"],
    ["SpriteAtlas", summary.atlasPath || "", "file"]
  ];
  for (const [label, assetPath, kind] of outputs) {
    const normalized = normalizeFigmaPrefabTargetAssetPath(assetPath);
    const resolved = path.resolve(projectPath, ...normalized.split("/"));
    if (!isFileSystemPathWithin(resolved, targetPath)) {
      throw new Error(`${label} output is outside the selected target folder`);
    }
    if (!fs.statSync(resolved, { throwIfNoEntry: false })) {
      throw new Error(`${label} output does not exist at ${assetPath}`);
    }
    const real = fs.realpathSync.native(resolved);
    if (!isFileSystemPathWithin(real, assetsPath)) {
      throw new Error(`${label} output escapes the project's Assets directory`);
    }
    const stat = fs.statSync(real);
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`${label} output does not exist at ${assetPath}`);
    }
  }
}

function evictRetainedTasks(): void {
  const now = Date.now();
  for (const [taskId, task] of tasks) {
    if ((task.status === "completed" || task.status === "error") && now - task.updatedAt > TERMINAL_TASK_TTL_MS) {
      tasks.delete(taskId);
    }
  }
  if (tasks.size <= MAX_RETAINED_TASKS) return;
  const terminal = [...tasks.values()]
    .filter((task) => task.status === "completed" || task.status === "error")
    .sort((left, right) => left.updatedAt - right.updatedAt);
  while (tasks.size > MAX_RETAINED_TASKS && terminal.length > 0) {
    tasks.delete(terminal.shift()!.taskId);
  }
}

function isUnityAssetPathWithin(value: string, targetFolder: string): boolean {
  const normalizedValue = normalizeFigmaPrefabTargetAssetPath(value);
  if (!normalizedValue) return false;
  const valueKey = process.platform === "win32" ? normalizedValue.toLowerCase() : normalizedValue;
  const targetKey = process.platform === "win32" ? targetFolder.toLowerCase() : targetFolder;
  return valueKey === targetKey || valueKey.startsWith(`${targetKey}/`);
}

function isFileSystemPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function pathKey(value: string): string {
  const resolved = path.resolve(value || ".");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}
