import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { GatewayConfig } from "./config.js";
import { publicUrl, SERVER_DIR } from "./config.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import type { LegacyRelayStatus } from "./types.js";
import { requestJson, sleep } from "./utils.js";

const logging = getLoggingRuntime();
const logger = logging.logger("python-worker");
const PYTHON_LOG_MARKER = "FIGMA_RELAY_LOG ";

export interface PythonProbe {
  available: boolean;
  command?: string;
  version?: string;
  scriptExists: boolean;
  error?: string;
}

export function probePythonWorker(): PythonProbe {
  const operation = logger.startOperation("python.probe", "开始探测 Python 运行时");
  const scriptPath = path.join(SERVER_DIR, "figma_mcp_relay_server.py");
  const scriptExists = fs.existsSync(scriptPath);
  const candidates = pythonCandidates();
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.status === 0) {
      operation.step("provider-probe", "Python 候选命令可用", {
        command: path.basename(candidate.command)
      });
      operation.succeed("Python 运行时探测成功", { scriptExists });
      return {
        available: true,
        command: [candidate.command, ...candidate.args].join(" "),
        version: (result.stdout || result.stderr || "").trim(),
        scriptExists
      };
    }
  }
  operation.fail(new Error("Python runtime unavailable"), "Python 运行时探测失败", { scriptExists });
  return {
    available: false,
    scriptExists,
    error: "Python was not found by FIGMA_RELAY_PYTHON, py -3, or python."
  };
}

export class LegacyRelay {
  private process?: ChildProcessWithoutNullStreams;
  private lastError = "";

  constructor(private readonly config: GatewayConfig) {}

  get url(): string {
    return `http://127.0.0.1:${this.config.legacyPort}`;
  }

  async ensureRunning(): Promise<boolean> {
    const operation = logger.startOperation("python.legacy-connect", "开始连接 Python Legacy Relay");
    if (!this.config.pythonWorker) {
      this.lastError = "disabled";
      operation.cancel("Python Legacy Relay 已禁用");
      return false;
    }
    if (await this.isHealthy()) {
      operation.succeed("Python Legacy Relay 已处于健康状态");
      return true;
    }
    if (this.process && this.process.exitCode === null) {
      operation.fail(new Error("legacy relay process is running but unhealthy"), "Python Legacy Relay 尚未就绪");
      return false;
    }

    const scriptPath = this.scriptPath();
    if (!fs.existsSync(scriptPath)) {
      this.lastError = `legacy relay script not found: ${scriptPath}`;
      operation.fail(new Error(this.lastError), "Python Legacy Relay 脚本不存在");
      return false;
    }
    const command = resolvePythonCommand();
    if (!command) {
      this.lastError = "Python was not found by FIGMA_RELAY_PYTHON, py -3, or python.";
      operation.fail(new Error(this.lastError), "Python Legacy Relay 启动失败");
      return false;
    }

    const args = [
      ...command.args,
      scriptPath,
      "--bind-host",
      "127.0.0.1",
      "--no-ipv6",
      "--public-host",
      this.config.publicHost,
      "--public-url",
      publicUrl(this.config),
      "--port",
      String(this.config.legacyPort)
    ];
    this.process = spawn(command.command, args, {
      cwd: path.resolve(SERVER_DIR, "..", "..", ".."),
      windowsHide: true,
      env: {
        ...process.env,
        FIGMA_RELAY_OPERATION_ID: operation.operationId,
        FIGMA_RELAY_OPERATION_NAME: "python.legacy-connect",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      }
    });
    operation.step("cli-spawn", "Python Legacy Relay 进程已启动", {
      command: path.basename(command.command),
      argumentCount: args.length,
      pid: this.process.pid
    });
    this.process.stdout.on("data", (data) => {
      logger.debug("Python Legacy Relay stdout", {
        chars: Buffer.byteLength(data),
        verbose: this.config.verbose
      }, { operationId: operation.operationId, operationName: "python.legacy-connect" });
    });
    this.process.stderr.on("data", (data) => {
      this.lastError = String(data).trim();
      ingestPythonStderr(String(data), operation.operationId);
    });
    this.process.on("exit", (code, signal) => {
      this.lastError = `legacy relay exited code=${code ?? ""} signal=${signal ?? ""}`.trim();
      logger.warn("Python Legacy Relay 进程已退出", {
        step: "cli-exit",
        exitCode: code,
        signal
      }, { operationId: operation.operationId, operationName: "python.legacy-connect" });
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await this.isHealthy()) {
        this.lastError = "";
        operation.step("connect", "Python Legacy Relay 健康检查通过");
        operation.succeed("Python Legacy Relay 连接成功");
        return true;
      }
      await sleep(150);
    }
    operation.fail(new Error(this.lastError || "legacy relay health check failed"), "Python Legacy Relay 连接失败");
    return false;
  }

  async proxyJson(pathname: string, method: "GET" | "POST", payload?: unknown, timeoutMs = 10_000) {
    if (!(await this.ensureRunning())) {
      throw new Error(this.lastError || "legacy relay is unavailable");
    }
    const url = new URL(pathname, this.url);
    const result = await requestJson(url, method, payload, timeoutMs);
    return result;
  }

  status(): LegacyRelayStatus {
    const scriptExists = fs.existsSync(this.scriptPath());
    return {
      enabled: this.config.pythonWorker,
      available: this.config.pythonWorker && scriptExists && Boolean(resolvePythonCommand()),
      url: this.url,
      scriptExists,
      processRunning: Boolean(this.process && this.process.exitCode === null),
      error: this.lastError || undefined
    };
  }

  close(): void {
    if (this.process && this.process.exitCode === null) {
      this.process.kill();
    }
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const result = await requestJson(new URL("/health", this.url), "GET", undefined, 800);
      return result.status === 200;
    } catch {
      return false;
    }
  }

  private scriptPath(): string {
    return path.join(SERVER_DIR, "figma_mcp_relay_server.py");
  }
}

function ingestPythonStderr(text: string, operationId: string): void {
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith(PYTHON_LOG_MARKER)) {
      try {
        logging.store.ingest([JSON.parse(line.slice(PYTHON_LOG_MARKER.length))]);
        continue;
      } catch (error) {
        logger.warn("Python 结构化日志解析失败", {
          step: "python.stderr",
          error: error instanceof Error ? error.message : String(error)
        }, { operationId, operationName: "python.legacy-connect" });
      }
    } else {
      logger.warn("Python Legacy Relay stderr", {
        step: "python.stderr",
        chars: line.length,
        summary: line.slice(0, 500)
      }, { operationId, operationName: "python.legacy-connect" });
    }
  }
}

function pythonCandidates(): Array<{ command: string; args: string[] }> {
  const explicit = process.env.FIGMA_RELAY_PYTHON;
  const result: Array<{ command: string; args: string[] }> = [];
  if (explicit) {
    result.push({ command: explicit, args: ["--version"] });
  }
  result.push({ command: "py", args: ["-3", "--version"] });
  result.push({ command: "python", args: ["--version"] });
  return result;
}

function resolvePythonCommand(): { command: string; args: string[] } | undefined {
  const explicit = process.env.FIGMA_RELAY_PYTHON;
  const candidates: Array<{ command: string; args: string[]; versionArgs: string[] }> = [];
  if (explicit) {
    candidates.push({ command: explicit, args: [], versionArgs: ["--version"] });
  }
  candidates.push({ command: "py", args: ["-3"], versionArgs: ["-3", "--version"] });
  candidates.push({ command: "python", args: [], versionArgs: ["--version"] });

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.versionArgs, {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.status === 0) {
      return { command: candidate.command, args: candidate.args };
    }
  }
  return undefined;
}
