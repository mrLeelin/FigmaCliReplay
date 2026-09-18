import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_ROOT, SERVER_DIR, publicUrl, type GatewayConfig } from "./config.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import { isRecord } from "./utils.js";
import { notifyRunChanged } from "./runChangeNotifier.js";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const RETENTION_MS = 60 * 60 * 1000;
const logging = getLoggingRuntime();
const logger = logging.logger("python-algorithms");

interface ImportRecord {
  payload: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  active: boolean;
  expiresAt: number;
}

/** Fixed algorithm entrypoint, one process per operation; never starts a server. */
export class PythonAlgorithms {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly imports = new Map<string, ImportRecord>();

  constructor(private readonly config: GatewayConfig) {}

  async crop(payload: Record<string, unknown>): Promise<unknown> {
    return this.execute({ action: "crop-jiugong", payload }, 120_000);
  }

  startImport(payload: Record<string, unknown>): Record<string, unknown> {
    if (typeof payload.sessionId !== "string" || !payload.sessionId.trim()
      || typeof payload.fileKey !== "string" || !payload.fileKey.trim()) {
      throw new Error("Prefab import requires a fixed Figma sessionId and fileKey.");
    }
    const taskId = typeof payload.clientRequestId === "string" ? payload.clientRequestId.trim() : "";
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) throw new Error("A stable clientRequestId is required.");
    payload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    for (const [id, record] of this.imports) {
      if (!record.active && record.expiresAt <= Date.now()) this.imports.delete(id);
    }
    const previous = this.imports.get(taskId);
    if (previous) {
      if (canonical(previous.payload) !== canonical(payload)) throw new Error("Import request id conflicts with its original payload.");
      logger.info("Prefab import request deduplicated", { taskId, sessionId: payload.sessionId });
      return { ok: true, taskId, prefabCount: previous.snapshot.total };
    }
    if (this.imports.size >= 100) throw new Error("Import task capacity reached; retry after completed tasks expire.");
    const now = Date.now();
    const record: ImportRecord = {
      payload: structuredClone(payload), active: true, expiresAt: now + RETENTION_MS,
      snapshot: { ok: true, taskId, status: "queued", stage: "queued", percent: 0,
        total: Array.isArray(payload.prefabPaths) ? payload.prefabPaths.length : 0,
        currentIndex: 0, logs: [], errors: [], createdAt: now / 1000, updatedAt: now / 1000 },
    };
    this.imports.set(taskId, record);
    notifyRunChanged(taskId);
    void this.execute({ action: "prefab-to-figma", payload: record.payload, taskId, relayUrl: publicUrl(this.config) },
      60 * 60 * 1000, (snapshot) => { record.snapshot = snapshot; notifyRunChanged(taskId); })
      .then((result) => {
        if (!isRecord(result) || result.taskId !== taskId || !["completed", "error"].includes(String(result.status))) {
          throw new Error("Python import did not return a terminal task snapshot.");
        }
        record.snapshot = result;
      }).catch((error: unknown) => {
        record.snapshot = { ...record.snapshot, ok: false, status: "error", stage: "error",
          updatedAt: Date.now() / 1000, errors: [error instanceof Error ? error.message : String(error)] };
        notifyRunChanged(taskId);
      }).finally(() => { record.active = false; record.expiresAt = Date.now() + RETENTION_MS; });
    return { ok: true, taskId, prefabCount: record.snapshot.total };
  }

  getImport(taskId: string, sessionId: string): Record<string, unknown> {
    const record = this.imports.get(taskId);
    if (!record || (!record.active && record.expiresAt <= Date.now())) throw new Error("Unknown or expired import task; do not replay an uncertain write.");
    if (!sessionId || record.payload.sessionId !== sessionId) throw new Error("Import task belongs to a different Figma session.");
    return structuredClone(record.snapshot);
  }

  status() {
    const scriptExists = fs.existsSync(path.join(SERVER_DIR, "algorithm_cli.py"));
    return { enabled: this.config.pythonWorker, available: this.config.pythonWorker && scriptExists,
      url: "", scriptExists, processRunning: this.children.size > 0 };
  }

  close(): void {
    for (const child of this.children) terminateTree(child);
  }

  private execute(request: Record<string, unknown>, timeoutMs: number,
    progress?: (snapshot: Record<string, unknown>) => void): Promise<unknown> {
    const operation = logger.startOperation("python.algorithm", "Execute Python algorithm", {
      data: { action: request.action, taskId: request.taskId },
    });
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        if (!this.config.pythonWorker) throw new Error("Python algorithms are disabled.");
        const body = JSON.stringify({ ...request, operationId: operation.operationId });
        if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) throw new Error("Python request exceeds 16 MiB.");
        const command = resolvePythonCommand();
        operation.step("spawn", "Start fixed Python entrypoint", { action: request.action, taskId: request.taskId });
        child = spawn(command.command, [...command.args, path.join(SERVER_DIR, "algorithm_cli.py")], {
          cwd: PLUGIN_ROOT, windowsHide: true, detached: process.platform !== "win32",
          env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", FIGMA_RELAY_OPERATION_ID: operation.operationId },
        });
        this.children.add(child);
        child.stdin.on("error", (error) => fail(error));
        child.stdin.end(body);
      } catch (error) {
        operation.fail(error, "Python algorithm could not start");
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      let result: unknown;
      let hasResult = false;
      let failure: Error | undefined;
      const timer = setTimeout(() => fail(new Error("Python algorithm timed out; write outcome may be unknown. Do not replay.")), timeoutMs);
      const fail = (error: Error) => {
        if (!failure) failure = error;
        terminateTree(child);
      };
      const consume = (line: string) => {
        if (!line.trim()) return;
        const event: unknown = JSON.parse(line);
        if (!isRecord(event) || hasResult) throw new Error("Invalid Python protocol output.");
        if (event.type === "progress" && isRecord(event.task) && event.task.taskId === request.taskId) {
          progress?.(event.task);
          operation.step("progress", "Python import progressed", { taskId: request.taskId, stage: event.task.stage, percent: event.task.percent });
        } else if (event.type === "result") {
          result = event.result;
          hasResult = true;
        } else if (event.type === "error") {
          throw new Error(String(event.error || "Python algorithm failed"));
        } else throw new Error("Unexpected Python protocol event.");
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        try {
          stdout += chunk;
          if (Buffer.byteLength(stdout) > MAX_MESSAGE_BYTES) throw new Error("Python protocol message exceeds 16 MiB.");
          let end: number;
          while ((end = stdout.indexOf("\n")) >= 0) {
            const line = stdout.slice(0, end); stdout = stdout.slice(end + 1); consume(line);
          }
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        let end: number;
        while ((end = stderr.indexOf("\n")) >= 0) {
          ingestStderr(stderr.slice(0, end), operation.operationId); stderr = stderr.slice(end + 1);
        }
        if (stderr.length > 64 * 1024) { ingestStderr(stderr.slice(0, 500), operation.operationId); stderr = ""; }
      });
      child.on("error", (error) => { failure = error; });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (stderr) ingestStderr(stderr, operation.operationId);
        try {
          if (failure) throw failure;
          if (stdout.trim()) consume(stdout);
          if (code !== 0 || !hasResult) throw new Error(`Python algorithm exited without success (code=${code}, signal=${signal}).`);
          if (isRecord(result) && result.ok === false) operation.fail(new Error(String(result.error || "Algorithm reported failure")), "Python algorithm rejected", { taskId: request.taskId });
          else operation.succeed("Python algorithm completed", { taskId: request.taskId });
          resolve(result);
        } catch (error) { operation.fail(error, "Python algorithm failed", { taskId: request.taskId }); reject(error); }
      });
    });
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function resolvePythonCommand(): { command: string; args: string[] } {
  const candidates = [
    ...(process.env.FIGMA_RELAY_PYTHON ? [{ command: process.env.FIGMA_RELAY_PYTHON, args: [] }] : []),
    { command: "py", args: ["-3"] }, { command: "python", args: [] },
  ];
  for (const candidate of candidates) {
    if (spawnSync(candidate.command, [...candidate.args, "--version"], { windowsHide: true, timeout: 5000 }).status === 0) return candidate;
  }
  throw new Error("Python was not found by FIGMA_RELAY_PYTHON, py -3, or python.");
}

function terminateTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
  }
}

function ingestStderr(line: string, operationId: string): void {
  const marker = "FIGMA_RELAY_LOG ";
  if (line.startsWith(marker)) {
    try { logging.store.ingest([JSON.parse(line.slice(marker.length))]); return; } catch { /* Preserve malformed diagnostics below. */ }
  }
  logger.warn("Python algorithm stderr", { summary: line.slice(0, 500) }, { operationId });
}
