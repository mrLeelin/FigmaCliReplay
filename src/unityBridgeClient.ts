import { randomUUID } from "node:crypto";

import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import { NO_UNITY_SESSION, callUnitySession, hasUnitySession } from "./unitySessionRegistry.js";

/**
 * 调用 Unity Bridge。
 *
 * 只有一条路径：Unity 主动连入中继的 `/unity` 会话（一条长连接）。
 * 旧的"读取发现文件 + 中继拨入本地端口"兼容路径已删除——它带来的僵尸记录、
 * 端口级联与每命令一次握手都已随出站长连接一并消除。
 */
export async function callUnityBridge(projectPath: string, action: string, payload: Record<string, unknown> = {},
  options: { requestId?: string; operationId?: string; timeoutMs?: number; query?: string; statusOnly?: boolean } = {},
): Promise<Record<string, unknown>> {
  const operation = getLoggingRuntime().logger("unity-bridge-client").startOperation("unity.command", "Call Unity over WebSocket", {
    operationId: options.operationId, data: { action, requestId: options.requestId },
  });
  const requestId = options.requestId || randomUUID();
  if (!hasUnitySession(projectPath)) {
    const unavailable = new Error(
      "Unity is not connected: keep the Unity Editor open with the Bridge installed. "
      + "The Bridge dials ws://127.0.0.1:32130/unity; set EditorPrefs FigmaBridge_RelayPort if the Relay uses another port.",
    );
    operation.fail(unavailable, "Unity command failed", { requestId, dispatched: false, attempt: 1 });
    throw unavailable;
  }
  try {
    operation.step("submit", "Use the connected Unity Bridge session", { requestId, action, transport: "inbound" });
    const result = await callUnitySession(projectPath, action, payload, {
      requestId, operationId: options.operationId, timeoutMs: options.timeoutMs, query: options.query, statusOnly: options.statusOnly,
    });
    operation.succeed("Unity command returned", { requestId, transport: "inbound" });
    return result;
  } catch (error) {
    // 会话在调用瞬间消失时给出可执行的结论，而不是内部哨兵字符串。
    const normalized = error instanceof Error && error.message === NO_UNITY_SESSION
      ? new Error("Unity disconnected before the command was submitted; do not replay.")
      : error;
    operation.fail(normalized instanceof Error ? normalized : new Error(String(normalized)), "Unity command failed", {
      requestId, dispatched: !options.statusOnly, attempt: 1,
    });
    throw normalized;
  }
}
