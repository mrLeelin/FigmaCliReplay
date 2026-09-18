import { randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocket } from "ws";

import { SERVER_VERSION } from "./config.js";
import { RELAY_PROTOCOL_VERSION } from "./relayProtocol.js";
import { logInfo, logWarn } from "./utils/logger.js";
import { isRecord } from "./utils.js";

/**
 * Unity 主动连入的会话注册表（出站倒置的接收侧）。
 *
 * 与旧的"中继按发现文件拨入"并存：中继优先走已连入的会话，没有会话时再回退到拨入。
 * 这样倒置可以分两步上线——中继先具备接收能力（本模块），Unity 侧再切到出站，期间现有用法不受影响。
 *
 * 帧词汇沿用桥已有的那套，Unity 侧的执行逻辑因此几乎不用改：
 *   Unity → 中继: bridge.register / bridge.response / bridge.heartbeat
 *   中继 → Unity: bridge.registered / bridge.request / bridge.get
 */

const UnityHeartbeatTimeoutMs = 30_000;
const PollIntervalMs = 250;

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  poll?: NodeJS.Timeout;
  dispatched: boolean;
  statusOnly: boolean;
  settled: boolean;
}

interface UnitySession {
  socket: WebSocket;
  projectPath: string;
  clientVersion: string;
  protocolVersion: number;
  capabilities: string[];
  lastHeartbeatAt: number;
  pending: Map<string, PendingCall>;
}

const sessions = new Map<string, UnitySession>();

/** 会话在调用瞬间消失时的哨兵错误，供调用方决定是否回退到拨入路径。 */
export const NO_UNITY_SESSION = "NO_UNITY_SESSION";

export function unityProjectKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface UnityRegisterResult {
  ok: boolean;
  error?: string;
  serverVersion?: string;
  projectPath?: string;
}

/** 处理 bridge.register：校验协议与版本，登记会话，回 bridge.registered。 */
export function registerUnitySession(socket: WebSocket, message: Record<string, unknown>): UnityRegisterResult {
  const projectPath = typeof message.projectPath === "string" ? message.projectPath.trim() : "";
  const clientVersion = typeof message.clientVersion === "string" ? message.clientVersion : "";
  const protocolVersion = typeof message.protocolVersion === "number" ? message.protocolVersion : 0;

  if (!projectPath) return failUnityRegister(socket, "Unity Bridge register is missing projectPath.");
  if (protocolVersion !== RELAY_PROTOCOL_VERSION) {
    return failUnityRegister(socket, `Unity Bridge protocol mismatch: expected ${RELAY_PROTOCOL_VERSION}, got ${protocolVersion}.`);
  }
  if (clientVersion !== SERVER_VERSION) {
    return failUnityRegister(socket, `Unity Bridge version mismatch: expected ${SERVER_VERSION}, got ${clientVersion || "<empty>"}.`);
  }

  const key = unityProjectKey(projectPath);
  const previous = sessions.get(key);
  if (previous && previous.socket !== socket) {
    // 同一工程只保留一条会话：新连接取代旧连接，旧的挂起调用按"结果不明"结束。
    unregisterUnitySession(previous.socket, "replaced by a newer Unity Bridge session");
  }
  const capabilities = Array.isArray(message.capabilities)
    ? message.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  sessions.set(key, {
    socket,
    projectPath,
    clientVersion,
    protocolVersion,
    capabilities,
    lastHeartbeatAt: Date.now(),
    pending: new Map(),
  });
  socket.send(JSON.stringify({
    type: "bridge.registered",
    serverVersion: SERVER_VERSION,
    protocolVersion: RELAY_PROTOCOL_VERSION,
    projectPath,
  }));
  logInfo("Unity Bridge session registered", { projectPath, clientVersion, capabilities: capabilities.length });
  return { ok: true, serverVersion: SERVER_VERSION, projectPath };
}

function failUnityRegister(socket: WebSocket, error: string): UnityRegisterResult {
  try {
    socket.send(JSON.stringify({ type: "bridge.error", error, serverVersion: SERVER_VERSION }));
  } catch {
    // 对端可能已断开
  }
  logWarn("Unity Bridge session rejected", { error });
  return { ok: false, error, serverVersion: SERVER_VERSION };
}

/** 会话断开：挂起调用按"结果不明"结束，避免上层重放写入。 */
export function unregisterUnitySession(socket: WebSocket, reason: string): void {
  for (const [key, session] of sessions) {
    if (session.socket !== socket) continue;
    sessions.delete(key);
    for (const [requestId, pending] of session.pending) {
      finishPending(pending, new Error(
        `Unity disconnected; request ${requestId} ${pending.dispatched ? "has an unknown outcome; do not replay" : "was not submitted"}.`,
      ));
    }
    session.pending.clear();
    logInfo("Unity Bridge session released", { projectPath: session.projectPath, reason, pending: session.pending.size });
    return;
  }
}

export function handleUnityMessage(socket: WebSocket, message: Record<string, unknown>): void {
  const type = message.type;
  if (type === "bridge.register") {
    registerUnitySession(socket, message);
    return;
  }
  const session = sessionFor(socket);
  if (!session) return;
  session.lastHeartbeatAt = Date.now();
  if (type === "bridge.heartbeat") return;
  if (type !== "bridge.response") return;

  const requestId = typeof message.requestId === "string" ? message.requestId : "";
  const pending = requestId ? session.pending.get(requestId) : undefined;
  if (!pending) return;

  if (pending.statusOnly) {
    finishPending(pending, undefined, message);
    return;
  }
  const status = typeof message.status === "string" ? message.status : "";
  if (status === "queued" || status === "running") {
    clearTimeout(pending.poll);
    pending.poll = setTimeout(() => {
      const current = session.pending.get(requestId);
      if (current !== pending || pending.settled) return;
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "bridge.get", requestId }));
      } catch {
        // 发送失败由 close/heartbeat 兜底
      }
    }, PollIntervalMs);
    return;
  }
  if (status === "unknown") {
    finishPending(pending, new Error("Unknown Unity task; do not replay"));
    return;
  }
  if (status !== "completed" && status !== "failed") {
    finishPending(pending, new Error("Invalid Unity task state"));
    return;
  }
  let body: unknown = {};
  try {
    body = typeof message.body === "string" && message.body ? JSON.parse(message.body) : {};
  } catch {
    finishPending(pending, new Error("Invalid Unity response body"));
    return;
  }
  if (status === "failed") {
    finishPending(pending, new Error(isRecord(body) ? String(body.error || "Unity command failed") : "Unity command failed"));
    return;
  }
  if (!isRecord(body)) {
    finishPending(pending, new Error("Unity command result must be an object"));
    return;
  }
  finishPending(pending, undefined, body);
}

function finishPending(pending: PendingCall, error?: Error, value?: Record<string, unknown>): void {
  if (pending.settled) return;
  pending.settled = true;
  clearTimeout(pending.timer);
  clearTimeout(pending.poll);
  if (error) pending.reject(error); else pending.resolve(value ?? {});
}

function sessionFor(socket: WebSocket): UnitySession | undefined {
  for (const session of sessions.values()) {
    if (session.socket === socket) return session;
  }
  return undefined;
}

export interface UnitySessionStatus {
  projectPath: string;
  clientVersion: string;
  protocolVersion: number;
  capabilities: string[];
  pending: number;
  lastHeartbeatAt: string;
}

export function unitySessionStatus(): UnitySessionStatus[] {
  return [...sessions.values()].map((session) => ({
    projectPath: session.projectPath,
    clientVersion: session.clientVersion,
    protocolVersion: session.protocolVersion,
    capabilities: [...session.capabilities],
    pending: session.pending.size,
    lastHeartbeatAt: new Date(session.lastHeartbeatAt).toISOString(),
  }));
}

export function pruneUnitySessions(now = Date.now()): void {
  for (const session of [...sessions.values()]) {
    if (now - session.lastHeartbeatAt <= UnityHeartbeatTimeoutMs) continue;
    logWarn("Unity Bridge session timed out", {
      projectPath: session.projectPath,
      heartbeatAgeMs: now - session.lastHeartbeatAt,
      timeoutMs: UnityHeartbeatTimeoutMs,
    });
    unregisterUnitySession(session.socket, "heartbeat timeout");
    try { session.socket.close(); } catch { /* 已断开 */ }
  }
}

export function closeUnitySessions(): void {
  for (const session of [...sessions.values()]) {
    unregisterUnitySession(session.socket, "relay shutting down");
    try { session.socket.close(); } catch { /* 已断开 */ }
  }
}

export function hasUnitySession(projectPath: string): boolean {
  return sessions.has(unityProjectKey(projectPath));
}

export interface UnityCallOptions {
  requestId?: string;
  operationId?: string;
  timeoutMs?: number;
  query?: string;
  statusOnly?: boolean;
}

/** 通过已连入的会话发一条命令；错误文案与拨入路径保持一致。 */
export function callUnitySession(
  projectPath: string,
  action: string,
  payload: Record<string, unknown> = {},
  options: UnityCallOptions = {},
): Promise<Record<string, unknown>> {
  const session = sessions.get(unityProjectKey(projectPath));
  if (!session) return Promise.reject(new Error(NO_UNITY_SESSION));
  const requestId = options.requestId || randomUUID();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const pending: PendingCall = {
      resolve, reject, dispatched: false, statusOnly: Boolean(options.statusOnly), settled: false,
      timer: setTimeout(() => finishPending(pending, new Error(
        `Unity response timed out; request ${requestId} ${pending.dispatched ? "may have executed; do not replay" : "was not submitted"}.`,
      )), options.timeoutMs ?? 30_000),
    };
    const frame = JSON.stringify({
      type: options.statusOnly ? "bridge.get" : "bridge.request",
      requestId,
      operationId: options.operationId,
      action,
      body: JSON.stringify(payload),
      query: options.query || "",
    });
    if (Buffer.byteLength(frame) > 16 * 1024 * 1024) {
      finishPending(pending, new Error("Unity request exceeds 16 MiB"));
      return;
    }
    if (session.socket.readyState !== WebSocket.OPEN) {
      finishPending(pending, new Error(`Unity disconnected; request ${requestId} was not submitted.`));
      return;
    }
    pending.dispatched = !options.statusOnly;
    session.pending.set(requestId, pending);
    try {
      session.socket.send(frame);
    } catch (error) {
      finishPending(pending, error instanceof Error ? error : new Error(String(error)));
    }
  });
}
