import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { SERVER_VERSION } from "./config.js";
import { readUnityGatewayDiscovery } from "./unityGatewayDiscovery.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import { isRecord } from "./utils.js";

export async function callUnityBridge(projectPath: string, action: string, payload: Record<string, unknown> = {},
  options: { requestId?: string; operationId?: string; timeoutMs?: number; query?: string; statusOnly?: boolean } = {},
  discover = readUnityGatewayDiscovery): Promise<Record<string, unknown>> {
  const operation = getLoggingRuntime().logger("unity-bridge-client").startOperation("unity.command", "Call Unity over WebSocket", {
    operationId: options.operationId, data: { action, requestId: options.requestId },
  });
  const requestId = options.requestId || randomUUID();
  let dispatched = false;
  try {
    operation.step("discover", "Read the explicitly selected project's Bridge record");
    const discovery = discover(projectPath, true);
    if (!discovery.found || !discovery.bridgeToken) throw new Error("Unity Bridge WebSocket discovery unavailable. Upgrade the Bridge in the selected project.");
    const url = new URL(discovery.gatewayUrl);
    url.protocol = "ws:";
    url.pathname = "/bridge";
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${discovery.bridgeToken}` }, maxPayload: 16 * 1024 * 1024 });
      let finished = false;
      let ready = false;
      let poll: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => finish(new Error(`Unity response timed out; request ${requestId} ${dispatched ? "may have executed; do not replay" : "was not submitted"}.`)), options.timeoutMs ?? 30_000);
      function finish(error?: Error, value?: Record<string, unknown>) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(poll);
        socket.terminate();
        if (error) reject(error); else resolve(value!);
      }
      socket.on("open", () => socket.send(JSON.stringify({ type: "bridge.hello", role: "relay", protocolVersion: 1, clientVersion: SERVER_VERSION, projectPath })));
      socket.on("error", error => finish(error));
      socket.on("close", () => finish(new Error(`Unity disconnected; request ${requestId} ${dispatched ? "has an unknown outcome; do not replay" : "was not submitted"}.`)));
      socket.on("message", raw => {
        try {
          const message: unknown = JSON.parse(String(raw));
          if (!isRecord(message)) throw new Error("Invalid Unity response");
          if (!ready) {
            if (message.type === "bridge.error") throw new Error(String(message.error || "Unity Bridge handshake rejected"));
            const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
            if (message.type !== "bridge.ready" || message.protocolVersion !== 1 || message.serverVersion !== SERVER_VERSION
              || typeof message.projectPath !== "string" || key(message.projectPath) !== key(projectPath)) throw new Error("Unity Bridge handshake version or project mismatch");
            ready = true;
            operation.step("submit", "Unity identity verified; send command once", { requestId, action });
            const frame = JSON.stringify({ type: options.statusOnly ? "bridge.get" : "bridge.request", requestId,
              operationId: operation.operationId, action, body: JSON.stringify(payload), query: options.query || "" });
            if (Buffer.byteLength(frame) > 16 * 1024 * 1024) throw new Error("Unity request exceeds 16 MiB");
            dispatched = !options.statusOnly;
            socket.send(frame);
            return;
          }
          if (message.type !== "bridge.response" || message.requestId !== requestId) throw new Error("Unity response identity mismatch");
          if (options.statusOnly) { finish(undefined, message); return; }
          if (message.status === "queued" || message.status === "running") {
            operation.step("progress", "Unity command accepted", { requestId, status: message.status });
            clearTimeout(poll);
            poll = setTimeout(() => {
              if (!finished && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "bridge.get", requestId }));
            }, 250);
            return;
          }
          if (message.status === "unknown") throw new Error("Unknown Unity task; do not replay");
          if (message.status !== "completed" && message.status !== "failed") throw new Error("Invalid Unity task state");
          const body: unknown = typeof message.body === "string" && message.body ? JSON.parse(message.body) : {};
          if (message.status === "failed") throw new Error(isRecord(body) ? String(body.error || "Unity command failed") : "Unity command failed");
          if (!isRecord(body)) throw new Error("Unity command result must be an object");
          finish(undefined, body);
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    operation.succeed("Unity command returned", { requestId });
    return result;
  } catch (error) {
    operation.fail(error, "Unity command failed", { requestId, dispatched, attempt: 1 });
    throw error;
  }
}
