import { Server as HttpServer } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { logInfo, logWarn } from "./utils/logger.js";
import type { RelayJob, PluginGatewayStatus, PluginSessionStatus, PluginSessionTarget } from "./types.js";
import { isAllowedLocalRequest, isRecord } from "./utils.js";
import type { RelayCliEndpoint } from "./relayCliEndpoint.js";
import { RELAY_CLI_PATH } from "./relayProtocol.js";

const HEARTBEAT_TIMEOUT_MS = 120_000;
const DEFAULT_ACK_TIMEOUT_MS = 3_000;

interface PluginSession {
  socket: WebSocket;
  authenticated: boolean;
  pending: Set<string>;
  websocketResults: Set<string>;
  capabilities: string[];
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

interface RunSubscription {
  request: RelayClientRequest;
  timer?: NodeJS.Timeout;
  previous: string;
  sequence: number;
  cancelled: boolean;
}

export class WebSocketGateway {
  private readonly server: WebSocketServer;
  private readonly sessions = new Map<WebSocket, PluginSession>();
  private activeSocket?: WebSocket;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private onJobReceived?: (requestId: string, operationId?: string) => void;
  private onJobUndelivered?: (requestId: string, reason: string) => void;
  private onSessionDisconnected?: (sessionId: string, reason: string) => void;
  private onRelayClientRequest?: RelayClientRequestHandler;
  private onJobResult?: (requestId: string, result: Record<string, unknown>) => boolean;
  private taskControlHandler?: (action: string, payload: Record<string, unknown>, sessionId: string) => Record<string, unknown>;
  private cliEndpoint?: RelayCliEndpoint;
  private readonly ackTimers = new Map<string, NodeJS.Timeout>();
  private readonly runSubscriptions = new Map<WebSocket, RunSubscription>();
  private readonly subscriptionEpochs = new WeakMap<WebSocket, number>();
  private readonly importSubscriptions = new Map<WebSocket, RunSubscription>();
  private readonly psdSubscriptions = new Map<WebSocket, RunSubscription>();
  private readonly figmaPrefabSubscriptions = new Map<WebSocket, RunSubscription>();
  private readonly figmaPrefabEpochs = new WeakMap<WebSocket, number>();
  private readonly psdSubscriptionEpochs = new WeakMap<WebSocket, number>();
  private readonly importSubscriptionEpochs = new WeakMap<WebSocket, number>();

  constructor(private readonly ingestLogEvents?: (events: unknown[]) => unknown) {
    this.server = new WebSocketServer({ noServer: true });
    this.server.on("connection", (socket) => this.attach(socket));
    this.heartbeatTimer = setInterval(() => this.pruneStaleSession(), 5_000);
  }

  attachServer(httpServer: HttpServer, cliEndpoint?: RelayCliEndpoint): void {
    this.cliEndpoint = cliEndpoint;
    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === RELAY_CLI_PATH && cliEndpoint) {
        cliEndpoint.handleUpgrade(request, socket, head);
        return;
      }
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
    for (const socket of this.runSubscriptions.keys()) this.clearRunSubscription(socket);
    for (const socket of this.importSubscriptions.keys()) this.clearRunSubscription(socket, true);
    for (const socket of this.psdSubscriptions.keys()) this.clearRunSubscription(socket, "psd");
    for (const socket of this.figmaPrefabSubscriptions.keys()) this.clearRunSubscription(socket, "figma");
    this.cliEndpoint?.close();
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

  onResult(callback: (requestId: string, result: Record<string, unknown>) => boolean): void {
    this.onJobResult = callback;
  }

  onTaskControl(callback: (action: string, payload: Record<string, unknown>, sessionId: string) => Record<string, unknown>): void {
    this.taskControlHandler = callback;
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
      job: job.job,
      ...(job.resultToken ? { resultToken: job.resultToken } : {}),
      ...(job.requiredTransport === "websocket" ? { resultTransport: "websocket" } : {})
    };
    session.pending.add(job.requestId);
    if (job.requiredTransport === "websocket") session.websocketResults.add(job.requestId);
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
      this.clearRunSubscription(socket, "figma");
      this.clearRunSubscription(socket);
      this.clearRunSubscription(socket, true);
      this.clearRunSubscription(socket, "psd");
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
      this.clearRunSubscription(socket, "figma");
      this.clearRunSubscription(socket);
      this.clearRunSubscription(socket, true);
      this.clearRunSubscription(socket, "psd");
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
        websocketResults: new Set<string>(),
        capabilities: Array.isArray(message.capabilities) ? message.capabilities.filter((item): item is string => typeof item === "string") : [],
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
        if (session.websocketResults.has(id)) return;
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

  sendCancel(job: RelayJob): boolean {
    const session = this.pickSession({ sessionId: job.targetSessionId, fileKey: job.targetFileKey });
    if (!session || session.socket.readyState !== session.socket.OPEN || !session.capabilities.includes("job.cancel")) return false;
    session.socket.send(JSON.stringify({ type: "command.cancel", id: job.requestId, requestId: job.requestId, operationId: job.operationId, resultToken: job.resultToken }));
    logInfo("WebSocket cancel request sent", { requestId: job.requestId, sessionId: session.sessionId });
    return true;
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
    if (["job.result", "job.reconcile", "job.cancel-status"].includes(action)) {
      const jobId = typeof payload.requestId === "string" ? payload.requestId : "";
      try {
        const accepted = this.taskControlHandler
          ? this.taskControlHandler(action, payload, session.sessionId)
          : session.websocketResults.has(jobId) && isRecord(payload.result) && this.onJobResult?.(jobId, payload.result)
            ? { accepted: true }
            : undefined;
        if (!accepted) {
          throw new Error("Unknown WebSocket job for this session.");
        }
        if (action === "job.result" || accepted.terminal === true) session.pending.delete(jobId);
        else {
          session.pending.add(jobId);
          session.websocketResults.add(jobId);
        }
        this.clearAckTimer(jobId);
        this.sendRelayClientResponse(socket, requestId, true, accepted);
      } catch (error) {
        logWarn("WebSocket job result rejected", {
          requestId: jobId, sessionId: session.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.sendRelayClientResponse(socket, requestId, false, undefined, "WebSocket result could not be accepted for this session.");
      }
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
      if (["ai.run.unsubscribe", "cleanup.run.unsubscribe", "prefab.import.unsubscribe", "psd.import.unsubscribe", "figma.prefab.unsubscribe"].includes(action)) {
        this.clearRunSubscription(socket, action.startsWith("figma.prefab.") ? "figma" : action.startsWith("psd.import.") ? "psd" : action.startsWith("prefab.import."));
        this.sendRelayClientResponse(socket, requestId, true, { ok: true });
        return;
      }
      if (["ai.run.subscribe", "cleanup.run.subscribe", "prefab.import.subscribe", "psd.import.subscribe", "figma.prefab.subscribe"].includes(action)) {
        const isImport = action.startsWith("figma.prefab.") ? "figma" : action.startsWith("psd.import.") ? "psd" : action.startsWith("prefab.import.");
        const epochs = isImport === "figma" ? this.figmaPrefabEpochs : isImport === "psd" ? this.psdSubscriptionEpochs : isImport ? this.importSubscriptionEpochs : this.subscriptionEpochs;
        const subscriptions = isImport === "figma" ? this.figmaPrefabSubscriptions : isImport === "psd" ? this.psdSubscriptions : isImport ? this.importSubscriptions : this.runSubscriptions;
        const epoch = (epochs.get(socket) || 0) + 1;
        epochs.set(socket, epoch);
        const readRequest = { ...request, action: action.replace(/subscribe$/, "get") };
        // Authenticate before replacing a valid subscription or acknowledging acceptance.
        const initial = await this.onRelayClientRequest(readRequest);
        if (epochs.get(socket) !== epoch) {
          this.sendRelayClientResponse(socket, requestId, false, undefined, "Run subscription superseded.");
          return;
        }
        if (socket.readyState !== socket.OPEN) return;
        if (this.sessions.get(socket) !== session) return;
        this.clearRunSubscription(socket, isImport);
        const subscription: RunSubscription = { request: readRequest, previous: "", sequence: 0, cancelled: false };
        subscriptions.set(socket, subscription);
        this.sendRelayClientResponse(socket, requestId, true, { ok: true, subscriptionId: requestId });
        this.publishRunView(socket, subscription, initial);
        this.scheduleRunView(socket, subscription);
        return;
      }
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

  private clearRunSubscription(socket: WebSocket, isImport: boolean | "psd" | "figma" = false): void {
    const epochs = isImport === "figma" ? this.figmaPrefabEpochs : isImport === "psd" ? this.psdSubscriptionEpochs : isImport ? this.importSubscriptionEpochs : this.subscriptionEpochs;
    const subscriptions = isImport === "figma" ? this.figmaPrefabSubscriptions : isImport === "psd" ? this.psdSubscriptions : isImport ? this.importSubscriptions : this.runSubscriptions;
    epochs.set(socket, (epochs.get(socket) || 0) + 1);
    const subscription = subscriptions.get(socket);
    if (!subscription) return;
    subscription.cancelled = true;
    clearTimeout(subscription.timer);
    subscriptions.delete(socket);
    logInfo("Run subscription released", { subscriptionId: subscription.request.requestId, sessionId: subscription.request.sessionId });
  }

  private publishRunView(socket: WebSocket, subscription: RunSubscription, value: unknown): void {
    if (subscription.cancelled || socket.readyState !== socket.OPEN || !isRecord(value)) return;
    const output = Array.isArray(value.output) ? value.output : [];
    const state = JSON.stringify({ ...value, output: undefined });
    if (state === subscription.previous && output.length === 0) return;
    socket.send(JSON.stringify({ type: "relay.event", subscriptionId: subscription.request.requestId, runId: subscription.request.payload.runId, taskId: subscription.request.payload.taskId, sequence: ++subscription.sequence, result: value }));
    subscription.previous = state;
    for (const entry of output) {
      if (isRecord(entry) && typeof entry.sequence === "number" && Number.isFinite(entry.sequence)) {
        subscription.request.payload.afterSequence = Math.max(Number(subscription.request.payload.afterSequence) || 0, entry.sequence);
      }
    }
    logInfo("Run subscription updated", { subscriptionId: subscription.request.requestId, runId: subscription.request.payload.runId, sequence: subscription.sequence, outputCount: output.length });
  }

  private scheduleRunView(socket: WebSocket, subscription: RunSubscription): void {
    if (subscription.cancelled) return;
    subscription.timer = setTimeout(async () => {
      if (subscription.cancelled || socket.readyState !== socket.OPEN) return;
      try {
        const value = await this.onRelayClientRequest!(subscription.request);
        this.publishRunView(socket, subscription, value);
        this.scheduleRunView(socket, subscription);
      } catch (error) {
        if (!subscription.cancelled && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "relay.event", subscriptionId: subscription.request.requestId, runId: subscription.request.payload.runId, taskId: subscription.request.payload.taskId, error: error instanceof Error ? error.message : String(error) }));
        }
        const isImport = subscription.request.action.startsWith("figma.prefab.") ? "figma" : subscription.request.action.startsWith("psd.import.") ? "psd" : subscription.request.action.startsWith("prefab.import.");
        if ((isImport === "figma" ? this.figmaPrefabSubscriptions : isImport === "psd" ? this.psdSubscriptions : isImport ? this.importSubscriptions : this.runSubscriptions).get(socket) === subscription) this.clearRunSubscription(socket, isImport);
      }
    }, 250);
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
      session.websocketResults.delete(requestId);
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
    session.websocketResults.clear();
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
      capabilities: session.capabilities,
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
