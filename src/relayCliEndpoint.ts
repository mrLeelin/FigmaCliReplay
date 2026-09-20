import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";

import { SERVER_VERSION, type GatewayConfig } from "./config.js";
import { getLoggingRuntime, type LoggingRuntime } from "./logging/loggingRuntime.js";
import { cliHelloSchema, cliRequestSchema, RELAY_PROTOCOL_VERSION, RelayProtocolError } from "./relayProtocol.js";
import { isFailedJobResult, type RuntimeRelay } from "./runtimeRelay.js";
import { bearerToken, constantTimeEqual, isAllowedLocalRequest, isRecord, validOperationId } from "./utils.js";

export type RelayCliControlHandler = (action: string, payload: Record<string, unknown>, operationId?: string) => Promise<unknown> | unknown;

export class RelayCliEndpoint {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  constructor(
    private readonly config: GatewayConfig,
    private readonly relay: RuntimeRelay,
    private readonly logging: LoggingRuntime = getLoggingRuntime(),
    private readonly controlHandler?: RelayCliControlHandler,
  ) {
    this.server.on("connection", (socket) => this.attach(socket));
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const operation = this.logging.logger("cli-endpoint").startOperation("cli.connect", "Accept CLI connection");
    operation.step("validate", "Validate local CLI access");
    if (!isAllowedLocalRequest(request) || request.headers.origin !== undefined
      || (this.config.adminToken && !constantTimeEqual(bearerToken(request), this.config.adminToken))) {
      operation.fail(new RelayProtocolError("FORBIDDEN", "CLI access rejected"));
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    this.server.handleUpgrade(request, socket, head, (ws) => {
      operation.succeed("CLI WebSocket connected");
      this.server.emit("connection", ws, request);
    });
  }

  close(): void {
    for (const socket of this.server.clients) socket.terminate();
    this.server.close();
  }

  private attach(socket: WebSocket): void {
    let ready = false;
    let busy = false;
    const handshake = this.logging.logger("cli-endpoint").startOperation("cli.handshake", "Negotiate CLI protocol");
    const timer = setTimeout(() => {
      handshake.fail(new RelayProtocolError("HANDSHAKE_TIMEOUT", "CLI handshake timed out"));
      socket.terminate();
    }, 5_000);
    socket.on("error", (error) => this.logging.logger("cli-endpoint").error("CLI socket error", error));
    socket.once("close", () => {
      clearTimeout(timer);
      if (!handshake.completed) handshake.cancel("CLI disconnected before handshake completed");
    });
    socket.on("message", (raw) => {
      if (socket.readyState !== socket.OPEN) return;
      let message: unknown;
      try { message = JSON.parse(String(raw)); } catch { message = undefined; }
      if (!ready) {
        clearTimeout(timer);
        handshake.step("validate", "Check CLI role and protocol version");
        const hello = cliHelloSchema.safeParse(message);
        if (!hello.success || hello.data.clientVersion !== SERVER_VERSION) {
          const error = new RelayProtocolError("UPGRADE_REQUIRED", "Upgrade the CLI and Relay together to matching versions.");
          this.send(socket, { type: "relay.error", operationId: handshake.operationId, error: { code: error.code, message: error.message }, protocolVersion: RELAY_PROTOCOL_VERSION, serverVersion: SERVER_VERSION });
          handshake.fail(error);
          socket.close(1008, "Upgrade required");
          return;
        }
        ready = true;
        this.send(socket, { type: "relay.ready", protocolVersion: RELAY_PROTOCOL_VERSION, serverVersion: SERVER_VERSION });
        handshake.succeed("CLI protocol negotiated");
        return;
      }
      if (busy) {
        void this.dispatch(socket, message, true);
        return;
      }
      busy = true;
      void this.dispatch(socket, message).finally(() => { busy = false; });
    });
  }

  private async dispatch(socket: WebSocket, message: unknown, busy = false): Promise<void> {
    const raw = isRecord(message) ? message : {};
    const operation = this.logging.logger("cli-endpoint").startOperation("cli.request", "Execute CLI request", {
      operationId: validOperationId(raw.operationId),
      data: { requestId: validOperationId(raw.requestId) },
    });
    const envelope = { type: "relay.response", requestId: validOperationId(raw.requestId), operationId: operation.operationId };
    try {
      operation.step("validate", "Validate CLI action and arguments");
      if (busy) throw new RelayProtocolError("BUSY", "Wait for the current response before sending another request.");
      const parsed = cliRequestSchema.safeParse(message);
      if (!parsed.success) throw new RelayProtocolError("INVALID_REQUEST", "Unsupported action or invalid request arguments.");
      const request = parsed.data;
      const sessions = this.relay.status().plugin.sessions;
      if (request.action === "relay.sessions") {
        this.send(socket, { ...envelope, ok: true, result: { sessions } });
        operation.succeed("Listed Figma sessions", { sessionCount: sessions.length });
        return;
      }

      if (request.action === "relay.control") {
        if (!this.controlHandler || !request.payload.controlAction || !request.payload.controlPayload) {
          throw new RelayProtocolError("UNSUPPORTED", "Relay control action is unavailable or incomplete.");
        }
        const controlPayload = { ...request.payload.controlPayload };
        for (const key of ["sessionId", "fileKey"] as const) {
          const value = request.payload.target?.[key];
          if (!value) continue;
          if (controlPayload[key] && controlPayload[key] !== value) throw new RelayProtocolError("TARGET_CONFLICT", "Control payload conflicts with the selected target.");
          controlPayload[key] = value;
        }
        if (request.payload.controlAction === "psd.import.wait") {
          const deadline = Date.now() + request.payload.timeout * 1000;
          let previous = "";
          let sequence = 0;
          while (socket.readyState === socket.OPEN) {
            const result = await this.controlHandler("psd.import.get", controlPayload, operation.operationId);
            if (!isRecord(result) || !isRecord(result.task)) throw new RelayProtocolError("INVALID_RESULT", "PSD task status is unavailable");
            const snapshot = JSON.stringify(result);
            if (snapshot !== previous) {
              this.send(socket, { ...envelope, type: "relay.event", sequence: ++sequence, result });
              previous = snapshot;
            }
            const status = String(result.task.status);
            if (["preview-ready", "preview-blocked", "preview-no-changes", "preview-baseline-required", "baseline-adopted", "completed", "error", "cancelled"].includes(status)) {
              this.send(socket, { ...envelope, ok: true, result });
              operation.succeed("PSD task subscription resolved", { taskId: controlPayload.taskId, status });
              return;
            }
            if (Date.now() >= deadline) throw new RelayProtocolError("TIMEOUT", "PSD wait timed out; query the same task again. The task was not cancelled.");
            await sleep(100);
          }
          operation.cancel("CLI disconnected from PSD subscription", { taskId: controlPayload.taskId });
          return;
        }
        const result = await this.controlHandler(request.payload.controlAction, controlPayload, operation.operationId);
        this.send(socket, { ...envelope, ok: true, result });
        operation.succeed("Relay control action completed", { action: request.payload.controlAction });
        return;
      }
      if (["task.status", "task.cancel", "task.wait"].includes(request.action)) {
        const taskId = request.payload.taskId;
        if (!taskId) throw new RelayProtocolError("INVALID_REQUEST", "taskId is required.");
        const result = request.action === "task.cancel"
          ? this.relay.cancelJob(taskId)
          : this.relay.getJobStatus(taskId);
        if (result.status === "unknown") throw new RelayProtocolError("TASK_UNKNOWN", `Unknown task: ${taskId}`);
        if (request.action === "task.wait") {
          const deadline = Date.now() + request.payload.timeout * 1000;
          let previous = "";
          let sequence = 0;
          while (socket.readyState === socket.OPEN) {
            const status = this.relay.getJobStatus(taskId);
            if (status.status === "unknown") throw new RelayProtocolError("TASK_UNKNOWN", `Unknown task: ${taskId}`);
            const snapshot = JSON.stringify(status);
            if (snapshot !== previous) {
              this.send(socket, { ...envelope, type: "relay.event", sequence: ++sequence, result: status });
              previous = snapshot;
            }
            if (["succeeded", "failed", "cancelled", "result_unknown"].includes(String(status.status))) {
              this.send(socket, { ...envelope, ok: true, result: status });
              operation.succeed("Task subscription resolved", { taskId, status: status.status });
              return;
            }
            if (Date.now() >= deadline) throw new RelayProtocolError("TIMEOUT", `Task wait timed out; query task ${taskId} again.`);
            await sleep(50);
          }
          operation.cancel("CLI disconnected from task subscription", { taskId });
          return;
        }
        this.send(socket, { ...envelope, ok: true, result });
        operation.succeed(request.action === "task.cancel" ? "Task cancellation requested" : "Task status returned", { requestId: taskId });
        return;
      }
      const target = request.payload.target;
      const commandType = request.action === "figma.command" ? request.payload.jobType : "QUERY_SELECTION";
      if (request.action === "figma.command" && (!commandType || !request.payload.job || !isRecord(request.payload.job))) {
        throw new RelayProtocolError("INVALID_REQUEST", "figma-command requires jobType and a JSON job payload.");
      }
      const existing = this.relay.getJob(request.requestId);
      const matches = sessions.filter((session) => session.authenticated
        && (!target?.sessionId || session.sessionId === target.sessionId)
        && (!target?.fileKey || session.fileKey === target.fileKey));
      if (existing && (existing.requiredTransport !== "websocket" || existing.job.type !== commandType
        || (target?.sessionId && target.sessionId !== existing.targetSessionId)
        || (target?.fileKey && target.fileKey !== existing.targetFileKey))) {
        throw new RelayProtocolError("REQUEST_CONFLICT", "Request ID already belongs to a different task or target.");
      }
      if (!existing && matches.length === 0) throw new RelayProtocolError("TARGET_OFFLINE", "No matching Figma session is online.");
      if (!existing && matches.length !== 1) throw new RelayProtocolError("TARGET_AMBIGUOUS", "Select one Figma session with --session-id or --file-key.");
      const session = existing ? { sessionId: existing.targetSessionId, fileKey: existing.targetFileKey, capabilities: [] as string[] } : matches[0];
      if (!existing && (!session.sessionId || !session.capabilities.includes("job.result")
        || !session.capabilities.includes("job.reconcile") || !session.capabilities.includes("job.cancel"))) {
        throw new RelayProtocolError("UPGRADE_REQUIRED", "Reload the updated Figma plugin with WebSocket result support.");
      }
      operation.step("dispatch", "Dispatch Figma WebSocket job", { sessionId: session.sessionId, requestId: request.requestId, jobType: commandType });
      this.relay.submitJob({
        requestId: request.requestId,
        operationId: operation.operationId,
        target: { sessionId: session.sessionId, fileKey: session.fileKey },
        job: { ...(request.action === "figma.command" ? request.payload.job : {}), type: commandType },
        assetPaths: request.payload.assetPaths,
      }, { transport: "websocket" });
      if (request.payload.detach) {
        this.send(socket, { ...envelope, ok: true, result: this.relay.getJobStatus(request.requestId) });
        operation.succeed("Figma WebSocket job submitted", { requestId: request.requestId, jobType: commandType });
        return;
      }
      const response = await this.relay.waitResult(request.requestId, request.payload.timeout, 0.05);
      const result = isRecord(response.result) ? response.result : {};
      if (isFailedJobResult(result)) {
        throw new RelayProtocolError("PLUGIN_FAILED", String(result.error || result.status || "Figma query failed"));
      }
      this.send(socket, { ...envelope, ok: true, result });
      operation.succeed("Figma WebSocket job returned", { requestId: request.requestId, jobType: commandType });
    } catch (error) {
      const code = error instanceof RelayProtocolError ? error.code : "QUERY_FAILED";
      const text = error instanceof Error ? error.message : String(error);
      operation.fail(error, "CLI request failed", { code });
      this.send(socket, { ...envelope, ok: false, error: { code, message: text } });
    }
  }

  private send(socket: WebSocket, message: unknown): void {
    const envelope = isRecord(message) ? message : {};
    const context = { operationId: validOperationId(envelope.operationId) };
    const data = { requestId: validOperationId(envelope.requestId) };
    if (socket.readyState !== socket.OPEN) {
      this.logging.logger("cli-endpoint").info("CLI response not delivered after client disconnected", data, context);
      return;
    }
    socket.send(JSON.stringify(message), (error) => {
      if (error) this.logging.logger("cli-endpoint").error("CLI response send failed", error, data, context);
    });
  }
}
