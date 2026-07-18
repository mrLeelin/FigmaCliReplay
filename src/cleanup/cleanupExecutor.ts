import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PLUGIN_ROOT } from "../config.js";
import { getLoggingRuntime } from "../logging/loggingRuntime.js";
import type { OperationScope } from "../logging/operationScope.js";
import { isRecord } from "../utils.js";
import type {
  CleanupExecutionResult,
  CleanupExecutorPort,
  CleanupExecutorRequest,
  CleanupProgress,
} from "./cleanupTypes.js";

export interface CleanupApplyProcessOptions {
  pluginRoot: string;
  sessionId: string;
  planPath: string;
  outputPath: string;
  timeoutSeconds?: number;
}

export interface CleanupExecutorOptions {
  pluginRoot?: string;
  runsRoot?: string;
  workspace?: string;
  pythonCommand?: string;
  timeoutMs?: number;
}

export interface CleanupPipelineProcessOptions {
  pluginRoot: string;
  sessionId: string;
  rootNodeId: string;
  fileKey?: string;
  workDir: string;
  outputPath: string;
  stage?: "hierarchy" | "component-sets";
  timeoutSeconds?: number;
}

export function buildCleanupApplyProcess(options: CleanupApplyProcessOptions): { command: string; args: string[] } {
  const scriptPath = path.join(
    options.pluginRoot,
    "ai",
    "skills",
    "figma-hierarchy-cleanup-mcp",
    "scripts",
    "apply_cleanup_plan.py",
  );
  return {
    command: "python",
    args: [
      scriptPath,
      "--session-id",
      options.sessionId,
      "--plan",
      path.normalize(options.planPath),
      "--output",
      path.normalize(options.outputPath),
      "--timeout",
      String(options.timeoutSeconds ?? 120),
    ],
  };
}

/**
 * The repository skill is the authoritative cleanup path.  It re-analyzes the
 * live Figma tree, plans semantic/nested groups, verifies every write, then
 * creates only unambiguous ComponentSets with source backups.
 */
export function buildCleanupPipelineProcess(options: CleanupPipelineProcessOptions): { command: string; args: string[] } {
  const scriptPath = path.join(
    options.pluginRoot,
    "ai",
    "skills",
    "figma-hierarchy-cleanup-mcp",
    "scripts",
    "run_cleanup_pipeline.py",
  );
  const stageArgs = options.stage === "component-sets"
    ? ["--auto-component-sets-only"]
    : ["--auto-nested-generic", "--no-auto-component-sets"];
  const args = [
    scriptPath,
    "--node-id",
    options.rootNodeId,
    "--session-id",
    options.sessionId,
    "--work-dir",
    path.normalize(options.workDir),
    "--output",
    path.normalize(options.outputPath),
    "--apply-confirmed",
    ...stageArgs,
    "--detect-psd-prefix-hints",
    "--timeout",
    String(options.timeoutSeconds ?? 600),
  ];
  if (options.fileKey) args.splice(3, 0, "--file-key", options.fileKey);
  return { command: "python", args };
}

export function validateCleanupExecutionReport(value: unknown): CleanupExecutionResult {
  if (!isRecord(value)) throw new Error("cleanup transaction report must be a JSON object");
  const state = value.state;
  if (state !== "succeeded" && state !== "rolled_back" && state !== "recovery_required") {
    throw new Error(`invalid cleanup transaction state: ${String(state || "missing")}`);
  }
  const expectedStatus = state === "succeeded" ? "completed" : state;
  if (value.status !== expectedStatus) {
    throw new Error(`cleanup transaction status is ${String(value.status || "missing")}`);
  }
  return { state, report: value };
}

export function validateCleanupPipelineReport(value: unknown): CleanupExecutionResult {
  if (!isRecord(value)) throw new Error("cleanup skill pipeline report must be a JSON object");
  if (value.status !== "completed") {
    throw new Error(`cleanup skill pipeline status is ${String(value.status || "missing")}`);
  }
  const steps = Array.isArray(value.steps) ? value.steps : [];
  if (hasFailedPipelineVerification(steps)) {
    return { state: "recovery_required", report: value };
  }
  return { state: "succeeded", report: value };
}

function hasFailedPipelineVerification(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasFailedPipelineVerification);
  if (!isRecord(value)) return false;
  if (value.allPass === false) return true;

  // The ComponentSet stage is nested beneath its own stage record. Inspect
  // every nested `steps` / `summary` node so a failed sub-verification never
  // gets reported to the UI as a completed cleanup.
  return hasFailedPipelineVerification(value.steps)
    || hasFailedPipelineVerification(value.summary);
}

export class CleanupExecutor implements CleanupExecutorPort {
  private readonly pluginRoot: string;
  private readonly runsRoot: string;
  private readonly workspace: string;
  private readonly pythonCommand: string;
  private readonly timeoutMs: number;

  constructor(options: CleanupExecutorOptions = {}) {
    this.pluginRoot = options.pluginRoot || PLUGIN_ROOT;
    this.runsRoot = options.runsRoot || path.join(this.pluginRoot, ".tmp", "ai-runs");
    this.workspace = options.workspace || this.pluginRoot;
    this.pythonCommand = options.pythonCommand || "python";
    this.timeoutMs = options.timeoutMs ?? 600_000;
  }

  async execute(request: CleanupExecutorRequest): Promise<CleanupExecutionResult> {
    return await this.executePipeline(request, "hierarchy");
  }

  async executeComponentSets(request: CleanupExecutorRequest): Promise<CleanupExecutionResult> {
    return await this.executePipeline(request, "component-sets");
  }

  private async executePipeline(
    request: CleanupExecutorRequest,
    stage: "hierarchy" | "component-sets",
  ): Promise<CleanupExecutionResult> {
    const operation = getLoggingRuntime().logger("cleanup-executor").startOperation(
      "cleanup.execution",
      "开始执行 Cleanup 事务",
      { operationId: `${request.runId}:${stage}`, data: { sessionId: request.sessionId, stage } },
    );
    const runDir = path.join(this.runsRoot, request.runId);
    const planPath = path.join(runDir, "ai-review-plan.json");
    const pipelineDir = path.join(runDir, "skill-pipeline", stage);
    const outputPath = path.join(runDir, stage === "hierarchy" ? "cleanup-pipeline-report.json" : "cleanup-component-sets-report.json");
    try {
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(planPath, `${JSON.stringify(request.plan, null, 2)}\n`, "utf8");
      operation.step("ai-plan-audit", "AI 整理计划已归档，实际写入将由技能流水线重新分析", {
        operationCount: request.plan.operations.length
      });
      const fileKey = typeof request.snapshot.fileKey === "string" ? request.snapshot.fileKey.trim() : "";
      operation.step("stage", stage === "hierarchy"
        ? "Executing hierarchy cleanup; ComponentSet creation is disabled until final satisfaction."
        : "Executing ComponentSet creation after final satisfaction.", { stage });
      const processSpec = buildCleanupPipelineProcess({
        pluginRoot: this.pluginRoot,
        sessionId: request.sessionId,
        rootNodeId: request.snapshot.rootNodeId,
        ...(fileKey ? { fileKey } : {}),
        workDir: pipelineDir,
        outputPath,
        stage,
        timeoutSeconds: Math.ceil(this.timeoutMs / 1000),
      });
      processSpec.command = this.pythonCommand;
      const result = await runCleanupProcess(
        processSpec,
        this.workspace,
        outputPath,
        request.signal,
        request.onProgress,
        this.timeoutMs,
        `${request.runId}:${stage}`,
        operation,
        validateCleanupPipelineReport,
      );
      emitPipelineReportProgress(result.report, request.onProgress, operation);
      if (result.state === "succeeded") {
        operation.step("verification", stage === "hierarchy"
          ? "层级整理报告验证通过，等待最终满意确认。"
          : "确认后的 ComponentSet 变体报告验证通过。");
        operation.succeed(stage === "hierarchy"
          ? "层级整理技能流水线执行成功"
          : "确认后的 ComponentSet 变体技能流水线执行成功");
      } else {
        operation.step("rollback", "技能流水线验证未通过，需要恢复处理", { state: result.state }, "warn");
        operation.fail(new Error(`cleanup skill pipeline ended as ${result.state}`), "完整层级整理技能流水线未通过验证");
      }
      return result;
    } catch (error) {
      if (!operation.completed) operation.fail(error, "Cleanup 事务执行异常");
      throw error;
    }
  }
}

async function runCleanupProcess(
  processSpec: { command: string; args: string[] },
  workspace: string,
  outputPath: string,
  signal: AbortSignal,
  onProgress: (progress: CleanupProgress) => void,
  timeoutMs: number,
  operationId: string,
  operation: OperationScope,
  reportValidator: (value: unknown) => CleanupExecutionResult,
): Promise<CleanupExecutionResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(processSpec.command, processSpec.args, {
      cwd: workspace,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        FIGMA_RELAY_OPERATION_ID: operationId,
        FIGMA_RELAY_OPERATION_NAME: "cleanup.execution",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    operation.step("cli-spawn", "Cleanup Python 执行进程已启动", {
      command: path.basename(processSpec.command),
      argumentCount: processSpec.args.length
    });
    const timeout = setTimeout(() => {
      operation.step("timeout", "Cleanup Python 执行超时", { timeoutMs }, "warn");
      terminateProcessTree(child);
      reject(new Error(`cleanup apply exceeded ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    const abort = () => {
      operation.step("cancel", "Cleanup Python 执行收到取消信号", undefined, "warn");
      terminateProcessTree(child);
    };
    signal.addEventListener("abort", abort, { once: true });
    wireProgress(child.stdout, onProgress, "stdout");
    wireProgress(child.stderr, onProgress, "stderr");
    child.once("error", (error) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      operation.step("cli-exit", "Cleanup Python 执行进程已退出", { exitCode: code });
      try {
        if (!fs.existsSync(outputPath)) throw new Error("cleanup transaction report is missing");
        resolve(reportValidator(JSON.parse(fs.readFileSync(outputPath, "utf8"))));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function emitPipelineReportProgress(
  report: Record<string, unknown>,
  onProgress: (progress: CleanupProgress) => void,
  operation: OperationScope,
): void {
  const timings = Array.isArray(report.timings) ? report.timings : [];
  for (const timing of timings) {
    if (!isRecord(timing) || typeof timing.name !== "string") continue;
    const elapsedMs = typeof timing.elapsedMs === "number"
      ? timing.elapsedMs
      : typeof timing.elapsedSeconds === "number"
        ? timing.elapsedSeconds * 1000
        : undefined;
    const message = `Skill pipeline completed ${timing.name}${elapsedMs === undefined ? "" : ` (${Math.round(elapsedMs)}ms)`}.`;
    onProgress({ message, state: "applying" });
    operation.step(`skill.${timing.name}`, "技能流水线步骤完成", { ...(elapsedMs === undefined ? {} : { elapsedMs }) });
  }
  const autoSets = isRecord(report.autoComponentSets) ? report.autoComponentSets : undefined;
  if (autoSets) {
    const planCount = typeof autoSets.planCount === "number" ? autoSets.planCount : 0;
    const appliedCount = typeof autoSets.appliedCount === "number" ? autoSets.appliedCount : 0;
    onProgress({ message: `AutoComponentSet finished: ${appliedCount}/${planCount} clear candidates applied.`, state: "verifying" });
    operation.step("auto-component-set", "自动 ComponentSet 阶段完成", { planCount, appliedCount });
  }
}

function wireProgress(
  stream: NodeJS.ReadableStream,
  onProgress: (progress: CleanupProgress) => void,
  source: "stdout" | "stderr",
): void {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    lines.filter(Boolean).forEach((line) => onProgress(parseProgress(line, source)));
  });
  stream.on("end", () => {
    if (pending) onProgress(parseProgress(pending, source));
  });
}

function parseProgress(line: string, source: "stdout" | "stderr"): CleanupProgress {
  try {
    const value = JSON.parse(line);
    if (isRecord(value) && typeof value.message === "string") {
      const state = typeof value.state === "string" ? value.state : undefined;
      return {
        message: value.message,
        ...(state === "applying" || state === "verifying" || state === "rolled_back" || state === "recovery_required" || state === "failed"
          ? { state }
          : {}),
        ...(typeof value.completed === "number" ? { completed: value.completed } : {}),
        ...(typeof value.total === "number" ? { total: value.total } : {}),
      };
    }
  } catch { /* plain process output */ }
  return { message: `${source}: ${line}` };
}

function terminateProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill();
  }
}
