import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { GatewayConfig } from "./config.js";
import { publicUrl, SERVER_DIR } from "./config.js";
import type { LegacyRelayStatus } from "./types.js";
import { requestJson, sleep } from "./utils.js";

export interface PythonProbe {
  available: boolean;
  command?: string;
  version?: string;
  scriptExists: boolean;
  error?: string;
}

export function probePythonWorker(): PythonProbe {
  const scriptPath = path.join(SERVER_DIR, "figma_mcp_relay_server.py");
  const scriptExists = fs.existsSync(scriptPath);
  const candidates = pythonCandidates();
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.status === 0) {
      return {
        available: true,
        command: [candidate.command, ...candidate.args].join(" "),
        version: (result.stdout || result.stderr || "").trim(),
        scriptExists
      };
    }
  }
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
    if (!this.config.pythonWorker) {
      this.lastError = "disabled";
      return false;
    }
    if (await this.isHealthy()) {
      return true;
    }
    if (this.process && this.process.exitCode === null) {
      return false;
    }

    const scriptPath = this.scriptPath();
    if (!fs.existsSync(scriptPath)) {
      this.lastError = `legacy relay script not found: ${scriptPath}`;
      return false;
    }
    const command = resolvePythonCommand();
    if (!command) {
      this.lastError = "Python was not found by FIGMA_RELAY_PYTHON, py -3, or python.";
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
      windowsHide: true
    });
    this.process.stdout.on("data", (data) => {
      if (this.config.verbose) {
        process.stdout.write(`[legacy-relay] ${data}`);
      }
    });
    this.process.stderr.on("data", (data) => {
      this.lastError = String(data).trim();
      if (this.config.verbose) {
        process.stderr.write(`[legacy-relay] ${data}`);
      }
    });
    this.process.on("exit", (code, signal) => {
      this.lastError = `legacy relay exited code=${code ?? ""} signal=${signal ?? ""}`.trim();
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await this.isHealthy()) {
        this.lastError = "";
        return true;
      }
      await sleep(150);
    }
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
