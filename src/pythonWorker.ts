import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SERVER_DIR } from "./config.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";

export interface PythonProbe {
  available: boolean;
  command?: string;
  version?: string;
  scriptExists: boolean;
  error?: string;
}

export function probePythonWorker(): PythonProbe {
  const operation = getLoggingRuntime().logger("python-worker").startOperation("python.probe", "Probe Python CLI runtime");
  const scriptExists = fs.existsSync(path.join(SERVER_DIR, "algorithm_cli.py"));
  const candidates = [
    ...(process.env.FIGMA_RELAY_PYTHON ? [{ command: process.env.FIGMA_RELAY_PYTHON, args: ["--version"] }] : []),
    { command: "py", args: ["-3", "--version"] }, { command: "python", args: ["--version"] },
  ];
  for (const candidate of candidates) {
    operation.step("provider-probe", "Probe Python candidate", { command: path.basename(candidate.command) });
    const result = spawnSync(candidate.command, candidate.args, { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (result.status === 0) {
      operation.succeed("Python CLI available", { scriptExists });
      return { available: true, command: [candidate.command, ...candidate.args].join(" "),
        version: (result.stdout || result.stderr || "").trim(), scriptExists };
    }
  }
  const error = "Python was not found by FIGMA_RELAY_PYTHON, py -3, or python.";
  operation.fail(new Error(error), "Python CLI unavailable", { scriptExists });
  return { available: false, scriptExists, error };
}
