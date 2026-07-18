import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";

import { PLUGIN_ROOT } from "../config.js";
import type { CleanupPlanningTransport } from "../cleanup/cleanupPlanner.js";
import { getLoggingRuntime } from "../logging/loggingRuntime.js";
import type { OperationScope } from "../logging/operationScope.js";

export interface CliPlanningTransportOptions {
  workspace?: string;
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export class CliPlanningTransport implements CleanupPlanningTransport {
  private readonly workspace: string;
  private readonly totalTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(options: CliPlanningTransportOptions = {}) {
    this.workspace = options.workspace || PLUGIN_ROOT;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 180_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 90_000;
  }

  async run(options: Parameters<CleanupPlanningTransport["run"]>[0]): Promise<string> {
    if (options.signal.aborted) throw new Error("cleanup planning was cancelled");
    const command = resolvePlanningCommand(options.provider.command);
    const args = options.provider.buildArgs(this.workspace, options.prompt);
    const operation = getLoggingRuntime().logger("cli-planning-transport").startOperation(
      "ai.cli-planning",
      "开始 CLI 规划任务",
      {
        operationId: options.operationId,
        data: { providerId: options.provider.id, command: path.basename(command), argumentCount: args.length },
      },
    );
    try {
      const child = spawnPlanningCli(command, args, this.workspace);
      operation.step("cli-spawn", "CLI 规划进程已启动", { pid: child.pid });
      const result = await collectPlanningResult(child, options, this.totalTimeoutMs, this.idleTimeoutMs, operation);
      operation.succeed("CLI 规划任务完成", { outputChars: result.length });
      return result;
    } catch (error) {
      if (!operation.completed) operation.fail(error, "CLI 规划任务失败");
      throw error;
    }
  }
}

async function collectPlanningResult(
  child: ChildProcessByStdio<null, Readable, Readable>,
  options: Parameters<CleanupPlanningTransport["run"]>[0],
  totalTimeoutMs: number,
  idleTimeoutMs: number,
  operation: OperationScope,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let assistantText = "";
    let terminalState: "completed" | "failed" | null = null;
    let totalTimer: NodeJS.Timeout;
    let idleTimer: NodeJS.Timeout;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (!assistantText.trim()) reject(new Error("planning provider returned no assistant plan"));
      else resolve(assistantText.trim());
    };
    const failTimeout = (message: string): void => {
      operation.step("timeout", "CLI 规划任务超时", { message }, "warn");
      terminatePlanningProcess(child);
      finish(new Error(message));
    };
    const resetIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => failTimeout(`cleanup planning produced no output for ${Math.round(idleTimeoutMs / 1000)} seconds`), idleTimeoutMs);
    };
    const abort = (): void => {
      operation.step("cancel", "CLI 规划任务已取消", undefined, "warn");
      terminatePlanningProcess(child);
      finish(new Error("cleanup planning was cancelled"));
    };
    const consume = (line: string, source: "stdout" | "stderr"): void => {
      if (!line.trim()) return;
      resetIdleTimer();
      if (source === "stderr") {
        options.onOutput(`stderr: ${line}`);
        return;
      }
      try {
        const event: unknown = JSON.parse(line);
        const text = options.provider.extractAssistantText(event);
        if (text) {
          assistantText = text;
          options.onOutput(text);
        }
        const eventState = options.provider.isTerminalEvent(event);
        if (eventState) terminalState = eventState;
      } catch {
        options.onOutput(line);
      }
    };

    totalTimer = setTimeout(() => failTimeout(`cleanup planning exceeded ${Math.round(totalTimeoutMs / 1000)} seconds`), totalTimeoutMs);
    idleTimer = setTimeout(() => failTimeout(`cleanup planning produced no output for ${Math.round(idleTimeoutMs / 1000)} seconds`), idleTimeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    wirePlanningLines(child.stdout, (line) => consume(line, "stdout"));
    wirePlanningLines(child.stderr, (line) => consume(line, "stderr"));
    child.once("error", (error) => finish(new Error(`planning provider failed to start: ${error.message}`)));
    child.once("close", (code) => {
      operation.step("cli-exit", "CLI 规划进程已退出", { exitCode: code, outputChars: assistantText.length });
      if (terminalState === "failed" || code !== 0) {
        finish(new Error(`planning provider failed (exit ${code === null ? "unknown" : code})`));
        return;
      }
      finish();
    });
  });
}

function wirePlanningLines(stream: NodeJS.ReadableStream, consume: (line: string) => void): void {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    lines.forEach(consume);
  });
  stream.on("end", () => {
    if (pending) consume(pending);
  });
}

function spawnPlanningCli(command: string, args: string[], cwd: string): ChildProcessByStdio<null, Readable, Readable> {
  const env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  if (process.platform === "win32" && /\.cmd$/i.test(command)) {
    const commandLine = `call ${cmdQuote(command)} ${args.map(cmdQuote).join(" ")}`;
    return spawn("cmd.exe", ["/d", "/s", "/c", commandLine], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
}

function resolvePlanningCommand(command: string): string {
  if (process.platform !== "win32" || path.extname(command)) return command;
  const result = spawnSync("where.exe", [command], { windowsHide: true });
  const candidates = result.stdout?.toString().split(/\r?\n/).map((item) => item.trim()).filter(Boolean) || [];
  return candidates.find((item) => /\.(cmd|exe)$/i.test(item)) || command;
}

function terminatePlanningProcess(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill();
  }
}

function cmdQuote(value: string): string {
  return `"${String(value).replaceAll("\"", "\"\"")}"`;
}
