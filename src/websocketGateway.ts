import { Server as HttpServer } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { logInfo, logWarn } from "./utils/logger.js";
import type { RelayJob, PluginGatewayStatus, PluginSessionStatus, PluginSessionTarget } from "./types.js";
import { isAllowedLocalRequest, isRecord } from "./utils.js";

const HEARTBEAT_TIMEOUT_MS = 120_000;
const DEFAULT_ACK_TIMEOUT_MS = 3_000;

interface PluginSession {
  socket: WebSocket;
  authenticated: boolean;
  pending: Set<string>;
  sessionId?: string;
  fileKey?: string;
  fileName?: string;
  currentPageId?: string;
  currentPageName?: string;
  editorType?: string;
  lastHeartbeatAt?: number;
}

export interface RelayClientRequest {
  requestId: string;
  action: string;
  payload: Record<string, unknown>;
  capabilityToken: string;
  sessionId: string;
  fileKey?: string;
}

type RelayClientRequestHandler = (request: RelayClientRequest) => Promise<unknown> | unknown;

export class WebSocketGateway {
  private readonly server: WebSocketServer;
  private readonly sessions = new Map<WebSocket, PluginSession>();
  private activeSocket?: WebSocket;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private onJobReceived?: (requestId: string, operationId?: string) => void;
  private onJobUndelivered?: (requestId: string, reason: string) => void;
  private onSessionDisconnected?: (sessionId: string, reason: string) => void;
  private onRelayClientRequest?: RelayClientRequestHandler;
  private readonly ackTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly ingestLogEvents?: (events: unknown[]) => unknown) {
    this.server = new WebSocketServer({ noServer: true });
    this.server.on("connection", (socket) => this.attach(socket));
    this.heartbeatTimer = setInterval(() => this.pruneStaleSession(), 5_000);
  }

  attachServer(httpServer: HttpServer): void {
    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/figma" || !isAllowedLocalRequest(request)) {
        logWarn("WebSocket upgrade rejected", { path: url.pathname });
        socket.destroy();
        return;
      }
      this.server.handleUpgrade(request, socket, head, (ws) => {
        this.server.emit("connection", ws, request);
      });
    });
  }

  close(): void {
    clearInterval(this.heartbeatTimer);
    for (const timer of this.ackTimers.values()) {
      clearTimeout(timer);
    }
    this.ackTimers.clear();
    this.server.close();
    for (const session of this.sessions.values()) {
      this.notifySessionDisconnected(session, "gateway closed");
      session.socket.close();
    }
    this.sessions.clear();
    this.activeSocket = undefined;
  }

  onReceived(callback: (requestId: string, operationId?: string) => void): void {
    this.onJobReceived = callback;
  }

  onUndelivered(callback: (requestId: string, reason: string) => void): void {
    this.onJobUndelivered = callback;
  }

  onDisconnected(callback: (sessionId: string, reason: string) => void): void {
    this.onSessionDisconnected = callback;
  }

  onClientRequest(callback: RelayClientRequestHandler): void {
    this.onRelayClientRequest = callback;
  }

  sendJob(job: RelayJob, ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS): boolean {
    const session = this.pickSession({
      sessionId: job.targetSessionId,
      fileKey: job.targetFileKey
    });
    if (!session || session.socket.readyState !== session.socket.OPEN) {
      return false;
    }
    const payload = {
      type: "command.request",
      id: job.requestId,
      requestId: job.requestId,
      operationId: job.operationId,
      job: job.job
    };
    session.pending.add(job.requestId);
    this.resetAckTimer(job.requestId, ackTimeoutMs, session);
    session.socket.send(JSON.stringify(payload), (error) => {
      if (error) {
        logWarn("WebSocket job send failed", {
          requestId: job.requestId,
          error: error.message || "websocket send failed"
        });
        this.clearAckTimer(job.requestId);
        session.pending.delete(job.requestId);
        this.onJobUndelivered?.(job.requestId, error.message || "websocket send failed");
      }
    });
    logInfo("WebSocket job sent", {
      requestId: job.requestId,
      sessionId: session.sessionId,
      fileKey: session.fileKey,
      jobType: String(job.job.type || "")
    });
    return true;
  }

  requiresExplicitTarget(target: PluginSessionTarget): boolean {
    return !target.sessionId && !target.fileKey && this.liveSessions().length > 1;
  }

  hasLiveSessionId(sessionId: string): boolean {
    const value = String(sessionId || "").trim();
    return Boolean(value) && this.liveSessions().some((session) => session.sessionId === value);
  }

  status(): PluginGatewayStatus {
    const sessions = this.liveSessions();
    if (sessions.length === 0) {
      return {
        connected: false,
        authenticated: false,
        sessions: [],
        sessionCount: 0
      };
    }
    return {
      connected: true,
      authenticated: sessions.some((session) => session.authenticated),
      activeSessionId: this.sessions.get(this.activeSocket as WebSocket)?.sessionId,
      sessions: sessions.map((session) => this.sessionStatus(session)),
      sessionCount: sessions.length
    };
  }

  private attach(socket: WebSocket): void {
    socket.on("message", (raw) => this.handleMessage(socket, String(raw)));
    socket.on("close", () => {
      const session = this.sessions.get(socket);
      if (session) {
        logInfo("Figma plugin WebSocket disconnected", {
          sessionId: session.sessionId,
          fileKey: session.fileKey,
          pending: session.pending.size
        });
        this.failPendingForSession(session, "websocket session closed");
        this.notifySessionDisconnected(session, "websocket session closed");
        this.sessions.delete(socket);
        if (this.activeSocket === socket) {
          this.activeSocket = this.liveSessions().at(-1)?.socket;
        }
      }
    });
    socket.on("error", () => {
      const session = this.sessions.get(socket);
      if (session) {
        logWarn("Figma plugin WebSocket error", {
          sessionId: session.sessionId,
          fileKey: session.fileKey,
          pending: session.pending.size
        });
        this.failPendingForSession(session, "websocket session error");
        this.notifySessionDisconnected(session, "websocket session error");
        this.sessions.delete(socket);
        if (this.activeSocket === socket) {
          this.activeSocket = this.liveSessions().at(-1)?.socket;
        }
      }
    });
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    const type = message.type;
    if (type === "plugin.register") {
      const figma = isRecord(message.figma) ? message.figma : {};
      const session: PluginSession = {
        socket,
        authenticated: true,
        pending: new Set<string>(),
        sessionId: typeof message.sessionId === "string" ? message.sessionId : undefined,
        fileKey: typeof figma.fileKey === "string" ? figma.fileKey : undefined,
        fileName: typeof figma.fileName === "string" ? figma.fileName : undefined,
        currentPageId: typeof figma.currentPageId === "string" ? figma.currentPageId : undefined,
        currentPageName: typeof figma.currentPageName === "string" ? figma.currentPageName : undefined,
        editorType: typeof figma.editorType === "string" ? figma.editorType : undefined,
        lastHeartbeatAt: Date.now()
      };
      this.sessions.set(socket, session);
      this.activeSocket = socket;
      socket.send(JSON.stringify({ type: "plugin.registered", sessionId: session.sessionId }));
      logInfo("Figma plugin WebSocket registered", {
        sessionId: session.sessionId,
        fileKey: session.fileKey,
        fileName: session.fileName,
        page: session.currentPageName,
        editorType: session.editorType
      });
      return;
    }
    if (type === "relay.request") {
      void this.handleRelayClientRequest(socket, message);
      return;
    }
    if (type === "log.events") {
      const session = this.sessions.get(socket);
      if (!session?.authenticated || !Array.isArray(message.events)) {
        logWarn("WebSocket log batch rejected", {
          authenticated: Boolean(session?.authenticated),
          hasEvents: Array.isArray(message.events)
        });
        return;
      }
      try {
        this.ingestLogEvents?.(message.events);
        logInfo("WebSocket log batch ingested", {
          sessionId: session.sessionId,
          count: message.events.length
        });
      } catch (error) {
        logWarn("WebSocket log batch rejected", {
          sessionId: session.sessionId,
          count: message.events.length,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
    if (type === "command.received") {
      const id = typeof message.id === "string" ? message.id : typeof message.requestId === "string" ? message.requestId : "";
      const session = this.sessions.get(socket);
      if (id && session?.pending.has(id)) {
        this.clearAckTimer(id);
        this.onJobReceived?.(id, typeof message.operationId === "string" ? message.operationId : undefined);
        logInfo("Figma plugin acknowledged job", {
          requestId: id,
          sessionId: session.sessionId,
          fileKey: session.fileKey
        });
      }
      return;
    }
    if (type === "plugin.heartbeat") {
      const session = this.sessions.get(socket);
      if (session) {
        const figma = isRecord(message.figma) ? message.figma : {};
        session.fileKey = typeof figma.fileKey === "string" ? figma.fileKey : session.fileKey;
        session.fileName = typeof figma.fileName === "string" ? figma.fileName : session.fileName;
        session.currentPageId = typeof figma.currentPageId === "string" ? figma.currentPageId : session.currentPageId;
        session.currentPageName = typeof figma.currentPageName === "string" ? figma.currentPageName : session.currentPageName;
        session.editorType = typeof figma.editorType === "string" ? figma.editorType : session.editorType;
        session.lastHeartbeatAt = Date.now();
      }
      return;
    }
    if (type === "command.response") {
      const id = typeof message.id === "string" ? message.id : "";
      const session = this.sessions.get(socket);
      if (id && session?.pending.has(id)) {
        session.pending.delete(id);
        this.clearAckTimer(id);
        logInfo("Figma plugin completed command response", {
          requestId: id,
          sessionId: session.sessionId,
          fileKey: session.fileKey
        });
      }
    }
  }

  private async handleRelayClientRequest(socket: WebSocket, message: Record<string, unknown>): Promise<void> {
    const requestId = typeof message.requestId === "string" ? message.requestId.trim() : "";
    const action = typeof message.action === "string" ? message.action.trim() : "";
    const payload = isRecord(message.payload) ? message.payload : {};
    const capabilityToken = typeof message.capabilityToken === "string" ? message.capabilityToken : "";
    const session = this.sessions.get(socket);
    if (!session?.authenticated || !session.sessionId || !requestId || !action) {
      logWarn("Figma plugin relay request rejected", {
        requestId: requestId || undefined,
        action: action || undefined,
        authenticated: Boolean(session?.authenticated),
        hasSessionId: Boolean(session?.sessionId),
        reason: "missing authenticated session, requestId, or action"
      });
      this.sendRelayClientResponse(socket, requestId, false, undefined, "Invalid Relay request.");
      return;
    }
    if (!this.onRelayClientRequest) {
      logWarn("Figma plugin relay request rejected", {
        requestId,
        action,
        sessionId: session.sessionId,
        fileKey: session.fileKey,
        reason: "request handler unavailable"
      });
      this.sendRelayClientResponse(socket, requestId, false, undefined, "Relay control handler is unavailable.");
      return;
    }
    const request: RelayClientRequest = {
      requestId,
      action,
      payload,
      capabilityToken,
      sessionId: session.sessionId,
      fileKey: session.fileKey
    };
    logInfo("Figma plugin relay request received", {
      requestId,
      action,
      sessionId: session.sessionId,
      fileKey: session.fileKey
    });
    try {
      const result = await this.onRelayClientRequest(request);
      this.sendRelayClientResponse(socket, requestId, true, result);
      logInfo("Figma plugin relay request completed", {
        requestId,
        action,
        sessionId: session.sessionId,
        fileKey: session.fileKey
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendRelayClientResponse(socket, requestId, false, undefined, errorMessage);
      logWarn("Figma plugin relay request failed", {
        requestId,
        action,
        sessionId: session.sessionId,
        fileKey: session.fileKey,
        error: errorMessage
      });
    }
  }

  private sendRelayClientResponse(socket: WebSocket, requestId: string, ok: boolean, result?: unknown, error?: string): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "relay.response", requestId, ok, ...(ok ? { result } : { error }) }), (sendError) => {
        if (sendError) {
          logWarn("Figma plugin relay response send failed", {
            requestId,
            error: sendError.message || "websocket send failed"
          });
        }
      });
    } catch (sendError) {
      logWarn("Figma plugin relay response send failed", {
        requestId,
        error: sendError instanceof Error ? sendError.message : String(sendError)
      });
    }
  }

  private pruneStaleSession(): void {
    for (const session of this.sessions.values()) {
      if (!session.lastHeartbeatAt) {
        continue;
      }
      if (Date.now() - session.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        this.failPendingForSession(session, "websocket heartbeat timeout");
        // Figma may throttle UI timers while the plugin is in the background. Treat a
        // missed heartbeat as a transport reconnect, not as an explicit panel close.
        this.sessions.delete(session.socket);
        session.socket.close();
        logWarn("Figma plugin WebSocket heartbeat timeout", {
          sessionId: session.sessionId,
          fileKey: session.fileKey,
          pending: session.pending.size,
          lastHeartbeatAt: new Date(session.lastHeartbeatAt).toISOString(),
          heartbeatAgeMs: Date.now() - session.lastHeartbeatAt,
          heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
          recovery: "close-stale-socket-and-let-plugin-reconnect"
        });
        if (this.activeSocket === session.socket) {
          this.activeSocket = this.liveSessions().at(-1)?.socket;
        }
      }
    }
  }

  private resetAckTimer(requestId: string, timeoutMs: number, session: PluginSession): void {
    this.clearAckTimer(requestId);
    const timer = setTimeout(() => {
      this.ackTimers.delete(requestId);
      session.pending.delete(requestId);
      logWarn("WebSocket delivery acknowledgement timeout", {
        requestId,
        sessionId: session.sessionId,
        fileKey: session.fileKey
      });
      this.onJobUndelivered?.(requestId, "websocket delivery acknowledgement timeout");
    }, timeoutMs);
    this.ackTimers.set(requestId, timer);
  }

  private clearAckTimer(requestId: string): void {
    const timer = this.ackTimers.get(requestId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.ackTimers.delete(requestId);
  }

  private failPendingForSession(session: PluginSession, reason: string): void {
    for (const requestId of session.pending) {
      this.clearAckTimer(requestId);
      this.onJobUndelivered?.(requestId, reason);
    }
    session.pending.clear();
  }

  private notifySessionDisconnected(session: PluginSession, reason: string): void {
    if (session.sessionId) this.onSessionDisconnected?.(session.sessionId, reason);
  }

  private pickSession(target: PluginSessionTarget): PluginSession | undefined {
    const sessions = this.liveSessions();
    if (target.sessionId) {
      return sessions.find((session) => session.sessionId === target.sessionId);
    }
    if (target.fileKey) {
      const matching = sessions.filter((session) => session.fileKey === target.fileKey);
      return matching.length === 1 ? matching[0] : undefined;
    }
    if (sessions.length === 1) {
      return sessions[0];
    }
    return undefined;
  }

  private liveSessions(): PluginSession[] {
    return [...this.sessions.values()].filter((session) => session.socket.readyState === session.socket.OPEN);
  }

  private sessionStatus(session: PluginSession): PluginSessionStatus {
    return {
      connected: true,
      authenticated: session.authenticated,
      sessionId: session.sessionId,
      fileKey: session.fileKey,
      fileName: session.fileName,
      currentPageId: session.currentPageId,
      currentPageName: session.currentPageName,
      editorType: session.editorType,
      lastHeartbeatAt: session.lastHeartbeatAt ? new Date(session.lastHeartbeatAt).toISOString() : undefined,
      queueLength: session.pending.size
    };
  }
}
