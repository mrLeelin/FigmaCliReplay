#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";

import { DEFAULT_HOST, DEFAULT_PORT, LOCAL_DIR, SERVER_VERSION } from "./config.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import type { OperationScope } from "./logging/operationScope.js";
import { RELAY_CLI_PATH, RELAY_PROTOCOL_VERSION, RelayProtocolError } from "./relayProtocol.js";
import { isRecord } from "./utils.js";

const HELP = `Figma Relay CLI

Usage: figma-relay <sessions|selection|figma-status|figma-children|figma-components|figma-pages|figma-command|control|task-status|task-cancel|task-wait|serve> [options]

  sessions                 List connected Figma sessions
  selection                Query the selected Figma session
  figma-status             Query Figma plugin status
  figma-children           Query children for a node (--payload {"nodeId":"..."})
  figma-components         Query available components
  figma-pages              Query Figma pages
  figma-command            Submit a Figma job type through WebSocket
  control                  Execute an AI or cleanup Relay control action
  task-status              Read a submitted task by ID
  task-cancel              Request cancellation of a submitted task
  task-wait                Subscribe until completion or result uncertainty
  psd-status               Read PSD import status (--task-id required)
  psd-wait                 Wait for PSD completion or an actionable preview
  psd-cancel               Request cancellation; inspect result.accepted
  serve                    Long-lived mode: one process and one Relay connection for many requests.
                           stdin lines:  {"action":"relay.control","payload":{...},"timeout":15}
                           stdout lines: {"requestId":"...","ok":true,"result":{...}}
                           Ends on stdin EOF; payload keys must match the wire schema (strict).
  --session-id <id>         Target one plugin session
  --file-key <key>          Target one Figma file
  --url <ws-url>            Default: ws://${DEFAULT_HOST}:${DEFAULT_PORT}${RELAY_CLI_PATH}
  --timeout <seconds>       Query timeout, 0.1 to 120 (default: 15)
  --detach                  Submit selection and return without waiting
  --task-id <id>            Task ID for task-status/task-cancel
  --request-id <id>         Stable submission ID for safe retries
  --job-type <type>         Figma job type for figma-command
  --payload <json>          Job fields as a JSON object
  --payload-file <path>     Read job fields from a UTF-8 JSON file
  --assets-file <path>      Read asset ID to local path mapping as JSON
  control uses --job-type   Control action name (for example ai.run.get)
  --help                   Show help

Results are JSON on stdout; diagnostic logs are on stderr.
Authentication: FIGMA_RELAY_TOKEN or the local admin-token.txt file.
This command does not start or stop the Relay.
`;

async function main(): Promise<void> {
  const logging = getLoggingRuntime();
  const logger = logging.logger("relay-cli");
  const operation = logger.startOperation("cli.command", "Run project CLI command");
  try {
    operation.step("validate", "Validate CLI arguments");
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean" }, url: { type: "string" }, timeout: { type: "string" },
        "session-id": { type: "string" }, "file-key": { type: "string" },
        detach: { type: "boolean" }, "task-id": { type: "string" },
        "request-id": { type: "string" },
        "job-type": { type: "string" }, payload: { type: "string" },
        "payload-file": { type: "string" },
        "assets-file": { type: "string" },
      },
    });
    if (values.help) {
      logger.writeProtocolOutput(HELP);
      operation.succeed("CLI help displayed");
      return;
    }
    const commandNames = ["sessions", "selection", "figma-status", "figma-children", "figma-components", "figma-pages", "figma-command", "control", "task-status", "task-cancel", "task-wait", "psd-status", "psd-wait", "psd-cancel", "serve"];
    if (positionals.length !== 1 || !commandNames.includes(positionals[0])) {
      throw new RelayProtocolError("USAGE", "Expected a supported Relay CLI command. Use --help for options.");
    }
    if ((positionals[0].startsWith("task-") || positionals[0].startsWith("psd-")) && !values["task-id"]) throw new RelayProtocolError("USAGE", "--task-id is required.");
    if (positionals[0].startsWith("psd-")) {
      if (values.payload || values["payload-file"] || values["job-type"]) throw new RelayProtocolError("USAGE", "PSD status commands use --task-id, not a job payload.");
      values["job-type"] = "psd.import." + (positionals[0] === "psd-status" ? "get" : positionals[0] === "psd-wait" ? "wait" : "cancel");
      values.payload = JSON.stringify({ taskId: values["task-id"] });
      positionals[0] = "control";
    }
    for (const id of [values["task-id"], values["request-id"]]) {
      if (id !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new RelayProtocolError("USAGE", "Invalid task or request ID.");
    }
    const aliases: Record<string, string> = { "figma-status": "QUERY_PLUGIN_STATUS", "figma-children": "QUERY_NODE_CHILDREN", "figma-components": "COLLECT_COMPONENTS", "figma-pages": "QUERY_FIGMA_PAGES" };
    const aliasJobType = aliases[positionals[0]];
    if (values.payload && values["payload-file"]) throw new RelayProtocolError("USAGE", "Choose --payload or --payload-file.");
    if (values["payload-file"]) values.payload = fs.readFileSync(values["payload-file"], "utf8").replace(/^\uFEFF/, "");
    if (positionals[0] === "control" && (!values["job-type"] || !values.payload)) throw new RelayProtocolError("USAGE", "control requires --job-type as control action and --payload JSON.");
    if ((positionals[0] === "figma-command" && (!values["job-type"] || !values.payload)) || (aliasJobType && positionals[0] === "figma-children" && !values.payload)) {
      throw new RelayProtocolError("USAGE", "This command requires --payload JSON.");
    }
    let job: Record<string, unknown> | undefined;
    if (values.payload) {
      try { const parsed = JSON.parse(values.payload); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); job = parsed; }
      catch { throw new RelayProtocolError("USAGE", "--payload must be a JSON object."); }
    }
    const timeout = Number(values.timeout ?? 15);
    let assetPaths: Record<string, string> | undefined;
    if (values["assets-file"]) {
      try {
        const parsed = JSON.parse(fs.readFileSync(values["assets-file"], "utf8").replace(/^\uFEFF/, ""));
        if (!isRecord(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) throw new Error();
        assetPaths = parsed as Record<string, string>;
      } catch { throw new RelayProtocolError("USAGE", "--assets-file must contain an asset ID to path JSON object."); }
    }
    if (!Number.isFinite(timeout) || timeout < 0.1 || timeout > 120) throw new RelayProtocolError("USAGE", "--timeout must be between 0.1 and 120 seconds.");
    const url = new URL(values.url ?? `ws://${DEFAULT_HOST}:${DEFAULT_PORT}${RELAY_CLI_PATH}`);
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.pathname !== RELAY_CLI_PATH || url.username || url.password || url.search || url.hash) {
      throw new RelayProtocolError("USAGE", "--url must be a local ws:// host with path /relay and no credentials or query.");
    }
    const tokenPath = process.env.FIGMA_RELAY_TOKEN_FILE ?? path.join(LOCAL_DIR, "admin-token.txt");
    const token = process.env.FIGMA_RELAY_TOKEN || (fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf8").trim() : "");
    if (positionals[0] === "serve") {
      // 长驻模式：一个进程 + 一条连接处理多轮请求，消除每命令一次进程启动与握手。
      operation.step("serve", "Serve requests from stdin over one Relay connection", { url: url.toString() });
      const served = await runCliServe(url.toString(), token, timeout, (value) => logger.writeProtocolOutput(value));
      operation.succeed("CLI serve loop completed", { requests: served });
      return;
    }
    const action = positionals[0] === "sessions" ? "relay.sessions"
      : positionals[0] === "selection" ? "figma.selection"
        : ["figma-status", "figma-children", "figma-components", "figma-pages", "figma-command"].includes(positionals[0]) ? "figma.command"
          : positionals[0] === "control" ? "relay.control"
          : positionals[0] === "task-status" ? "task.status" : positionals[0] === "task-wait" ? "task.wait" : "task.cancel";
    const request = {
      type: "relay.request", requestId: values["request-id"] ?? randomUUID(), operationId: operation.operationId,
      action,
      payload: {
        timeout,
        detach: values.detach === true,
        taskId: values["task-id"],
        target: { sessionId: values["session-id"], fileKey: values["file-key"] },
        jobType: aliasJobType || values["job-type"], job: job || {},
        assetPaths,
        controlAction: positionals[0] === "control" ? values["job-type"] : undefined,
        controlPayload: positionals[0] === "control" ? job : undefined,
      },
    };
    operation.step("connect", "Connect to local Relay", { action: request.action, requestId: request.requestId });
    const response = await callRelay(url.toString(), token, request, timeout, operation);
    if (response.ok !== true) {
      const error = isRecord(response.error) ? response.error : {};
      throw new RelayProtocolError(String(error.code || "QUERY_FAILED"), String(error.message || "Relay request failed"));
    }
    operation.succeed("CLI command completed", { requestId: request.requestId });
    logger.writeProtocolOutput(response);
  } catch (error) {
    const nativeCode = error instanceof Error && "code" in error ? String(error.code) : "";
    const code = error instanceof RelayProtocolError ? error.code
      : nativeCode.startsWith("ERR_PARSE_ARGS") || nativeCode === "ERR_INVALID_URL" ? "USAGE" : "CLI_ERROR";
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    operation.fail(error, "CLI command failed", {
      code, attempt: 1, maxAttempts: 1,
      ...(cause ? { originalError: { name: cause.name, message: cause.message, code: "code" in cause ? cause.code : undefined, stack: cause.stack } } : {}),
    });
    logger.writeProtocolOutput({ ok: false, operationId: operation.operationId, error: { code, message: error instanceof Error ? error.message : String(error) } });
    process.exitCode = code === "USAGE" ? 2 : 1;
  } finally {
    await logging.close();
  }
}

interface ServePending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 长驻模式：stdin 每行一个请求，stdout 每行一个响应，全程复用同一条 Relay 连接。
 * 调用方（AI 包装脚本/批处理）因此不必为每条命令付一次进程启动 + 一次 WS 握手。
 */
async function runCliServe(
  url: string, token: string, defaultTimeout: number, emit: (value: unknown) => void,
): Promise<number> {
  const socket = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, handshakeTimeout: 5_000 });
  const pending = new Map<string, ServePending>();
  const failAll = (error: Error): void => {
    for (const [requestId, entry] of pending) {
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  };
  socket.on("message", (raw) => {
    let message: unknown;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!isRecord(message) || message.type !== "relay.response") return;
    const requestId = String(message.requestId || "");
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(message);
  });
  socket.on("close", () => failAll(new RelayProtocolError("CONNECTION_CLOSED", "Relay connection closed.")));
  socket.on("error", (error) => failAll(new RelayProtocolError("CONNECTION_FAILED", error.message, error)));

  await awaitCliHandshake(socket);
  emit({ type: "serve.ready", url });

  const reader = createInterface({ input: process.stdin });
  let served = 0;
  try {
    for await (const rawLine of reader) {
      const line = rawLine.trim();
      if (!line) continue;
      // 顺序处理：stdout 的顺序与 stdin 一致，调用方无需自行配对。
      emit(await serveOneLine(socket, pending, line, defaultTimeout));
      served += 1;
    }
  } finally {
    reader.close();
    socket.terminate();
  }
  emit({ type: "serve.closed", requests: served });
  return served;
}

function awaitCliHandshake(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RelayProtocolError("TIMEOUT", "Relay handshake timed out.")), 10_000);
    const onMessage = (raw: unknown): void => {
      let message: unknown;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (!isRecord(message)) return;
      if (message.type === "relay.error") {
        clearTimeout(timer);
        socket.off("message", onMessage);
        const error = isRecord(message.error) ? message.error : {};
        reject(new RelayProtocolError(String(error.code || "PROTOCOL_ERROR"), String(error.message || "Relay rejected connection")));
        return;
      }
      if (message.type !== "relay.ready") return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      if (message.protocolVersion !== RELAY_PROTOCOL_VERSION || message.serverVersion !== SERVER_VERSION) {
        reject(new RelayProtocolError("UPGRADE_REQUIRED", "Upgrade the CLI and Relay together to matching versions."));
        return;
      }
      resolve();
    };
    socket.on("message", onMessage);
    socket.once("open", () => socket.send(JSON.stringify({
      type: "relay.hello", role: "cli", protocolVersion: RELAY_PROTOCOL_VERSION, clientVersion: SERVER_VERSION,
    })));
    socket.once("error", (error) => { clearTimeout(timer); reject(new RelayProtocolError("CONNECTION_FAILED", error.message, error)); });
    socket.once("close", () => { clearTimeout(timer); reject(new RelayProtocolError("CONNECTION_CLOSED", "Relay closed the CLI connection during handshake.")); });
  });
}

async function serveOneLine(
  socket: WebSocket, pending: Map<string, ServePending>, line: string, defaultTimeout: number,
): Promise<Record<string, unknown>> {
  let spec: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) throw new Error("line must be a JSON object");
    spec = parsed;
  } catch (error) {
    return { ok: false, error: { code: "USAGE", message: "Invalid request line: " + (error instanceof Error ? error.message : String(error)) } };
  }
  const action = typeof spec.action === "string" ? spec.action : "";
  if (!action) return { ok: false, error: { code: "USAGE", message: "Request line requires an action." } };
  const requestId = typeof spec.requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(spec.requestId) ? spec.requestId : randomUUID();
  const timeout = typeof spec.timeout === "number" && spec.timeout >= 0.1 && spec.timeout <= 120 ? spec.timeout : defaultTimeout;
  const payload: Record<string, unknown> = isRecord(spec.payload) ? { ...spec.payload } : {};
  if (payload.timeout === undefined) payload.timeout = timeout;
  try {
    const response = await sendServeRequest(socket, pending, {
      type: "relay.request", requestId, operationId: randomUUID(), action, payload,
    }, timeout);
    if (response.ok !== true) {
      const error = isRecord(response.error) ? response.error : {};
      return { requestId, ok: false, error: { code: String(error.code || "QUERY_FAILED"), message: String(error.message || "Relay request failed") } };
    }
    return { requestId, ok: true, result: response.result };
  } catch (error) {
    return {
      requestId, ok: false,
      error: {
        code: error instanceof RelayProtocolError ? error.code : "CLI_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function sendServeRequest(
  socket: WebSocket, pending: Map<string, ServePending>, request: Record<string, unknown>, timeout: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const requestId = String(request.requestId);
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new RelayProtocolError("TIMEOUT", "Relay response timed out."));
    }, timeout * 1000 + 5_000);
    pending.set(requestId, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify(request));
    } catch (error) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function callRelay(
  url: string, token: string, request: { requestId: string; operationId: string }, timeout: number, operation: OperationScope,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, handshakeTimeout: 5_000 });
    let settled = false;
    let ready = false;
    const timer = setTimeout(() => finish(new RelayProtocolError("TIMEOUT", "Relay response timed out.")), timeout * 1000 + 5_000);
    function finish(error?: Error, result?: Record<string, unknown>): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolve(result!);
    }
    socket.on("open", () => {
      operation.step("handshake", "Negotiate CLI protocol");
      socket.send(JSON.stringify({ type: "relay.hello", role: "cli", protocolVersion: RELAY_PROTOCOL_VERSION, clientVersion: SERVER_VERSION }));
    });
    socket.on("message", (raw) => {
      let message: unknown;
      try { message = JSON.parse(String(raw)); } catch { finish(new RelayProtocolError("INVALID_RESPONSE", "Relay returned invalid JSON.")); return; }
      if (!isRecord(message)) { finish(new RelayProtocolError("INVALID_RESPONSE", "Relay returned an invalid message.")); return; }
      if (message.type === "relay.error") {
        const error = isRecord(message.error) ? message.error : {};
        finish(new RelayProtocolError(String(error.code || "PROTOCOL_ERROR"), String(error.message || "Relay rejected connection")));
      } else if (message.type === "relay.ready" && !ready) {
        if (message.protocolVersion !== RELAY_PROTOCOL_VERSION || message.serverVersion !== SERVER_VERSION) {
          finish(new RelayProtocolError("UPGRADE_REQUIRED", "Upgrade the CLI and Relay together to matching versions."));
          return;
        }
        ready = true;
        operation.step("request", "Send CLI request", { requestId: request.requestId });
        socket.send(JSON.stringify(request));
      } else if (ready && message.type === "relay.event" && message.requestId === request.requestId && message.operationId === request.operationId) {
        const status = isRecord(message.result) ? message.result : {};
        operation.step("task-status", "Task state updated", { taskId: status.requestId, status: status.status, sequence: message.sequence });
      } else if (ready && message.type === "relay.response" && message.requestId === request.requestId && message.operationId === request.operationId) {
        finish(undefined, message);
      } else {
        finish(new RelayProtocolError("INVALID_RESPONSE", "Relay response does not match the active request."));
      }
    });
    socket.on("error", (error) => {
      const code = "code" in error ? String(error.code) : "";
      const pressure = ["ENOBUFS", "EADDRINUSE", "10055", "10048"].includes(code);
      finish(new RelayProtocolError("CONNECTION_FAILED", pressure
        ? `Local TCP resource pressure prevented the client connection: ${error.message}` : error.message, error));
    });
    socket.on("close", () => finish(new RelayProtocolError("CONNECTION_CLOSED", "Relay connection closed before the result arrived.")));
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      finish(new RelayProtocolError(response.statusCode === 403 ? "FORBIDDEN" : "UPGRADE_REQUIRED", `Relay rejected the CLI endpoint (HTTP ${response.statusCode}). Check credentials and matching versions.`));
    });
  });
}

void main();
