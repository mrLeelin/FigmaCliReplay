import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PLUGIN_ROOT } from "../config.js";
import { toFigmaCleanupTransactionPlan } from "../cleanupPlan.js";
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
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async execute(request: CleanupExecutorRequest): Promise<CleanupExecutionResult> {
    const operation = getLoggingRuntime().logger("cleanup-executor").startOperation(
      "cleanup.execution",
      "开始执行 Cleanup 事务",
      { operationId: request.runId, data: { sessionId: request.sessionId } },
    );
    const runDir = path.join(this.runsRoot, request.runId);
    const planPath = path.join(runDir, "cleanup-transaction-plan.json");
    const outputPath = path.join(runDir, "cleanup-apply-report.json");
    try {
      fs.mkdirSync(runDir, { recursive: true });
      const transactionPlan = toFigmaCleanupTransactionPlan(request.plan, request.snapshot);
      fs.writeFileSync(planPath, `${JSON.stringify(transactionPlan, null, 2)}\n`, "utf8");
      operation.step("execution", "Cleanup 事务计划已写入", {
        operationCount: request.plan.operations.length
      });
      const processSpec = buildCleanupApplyProcess({
        pluginRoot: this.pluginRoot,
        sessionId: request.sessionId,
        planPath,
        outputPath,
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
        request.runId,
        operation,
      );
      if (result.state === "succeeded") {
        operation.step("verification", "Cleanup 事务报告验证通过");
        operation.succeed("Cleanup 事务执行成功");
      } else {
        operation.step("rollback", "Cleanup 事务已回滚或需要恢复", { state: result.state }, "warn");
        operation.fail(new Error(`cleanup transaction ended as ${result.state}`), "Cleanup 事务执行失败");
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
        resolve(validateCleanupExecutionReport(JSON.parse(fs.readFileSync(outputPath, "utf8"))));
      } catch (error) {
        reject(error);
      }
    });
  });
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
