import { createRelayHttpServer } from "./httpServer.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import { RuntimeRelay } from "./runtimeRelay.js";
import { parseArgs, publicUrl } from "./config.js";
import { LegacyRelay, probePythonWorker } from "./pythonWorker.js";
import { WebSocketGateway } from "./websocketGateway.js";
import { getCleanupRuntime } from "./cleanup/cleanupRuntime.js";
import { CleanupExecutor } from "./cleanup/cleanupExecutor.js";
import { createConversationCleanupDispatcher } from "./cleanup/conversationCleanupDispatcher.js";
import { configureLocalAiCleanupDispatcher, followupAiRun, getAiRun, runLocalAiPrompt, stopAiRun, stopAiRunsForSession } from "./localAiRunner.js";

async function main(): Promise<void> {
  const logging = getLoggingRuntime();
  const processLogger = logging.logger("process");
  const startup = processLogger.startOperation("relay.startup", "开始启动 Figma MCP Relay");
  const config = parseArgs();
  startup.step("config.parsed", "Relay 配置解析完成", {
    host: config.host,
    port: config.port,
    transport: config.transport,
  });
  const gateway = new WebSocketGateway((events) => logging.store.ingest(events));
  const disconnectGraceTimers = new Map<string, NodeJS.Timeout>();
  gateway.onDisconnected((sessionId, reason) => {
    const existingTimer = disconnectGraceTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    processLogger.info("Figma 插件会话断开，进入 AI 会话重连宽限期", {
      sessionId,
      reason,
      graceMs: 5000,
    });
    disconnectGraceTimers.set(sessionId, setTimeout(() => {
      disconnectGraceTimers.delete(sessionId);
      if (gateway.hasLiveSessionId(sessionId)) {
        processLogger.info("Figma 插件会话已在宽限期内恢复，保留 AI 会话", { sessionId, reason });
        return;
      }
      const stopped = stopAiRunsForSession(sessionId, reason);
      processLogger.warn("Figma 插件会话未在宽限期内恢复，已停止关联 AI 会话", {
        sessionId,
        reason,
        stopped,
      });
    }, 5000));
  });
  const legacyRelay = new LegacyRelay(config);
  const relay = new RuntimeRelay(config, gateway, legacyRelay);
  const cleanupRuntime = getCleanupRuntime();
  configureLocalAiCleanupDispatcher(createConversationCleanupDispatcher(new CleanupExecutor()));
  gateway.onClientRequest((request) => {
    const runId = typeof request.payload.runId === "string" ? request.payload.runId.trim() : "";
    const afterSequence = typeof request.payload.afterSequence === "number"
      ? Math.max(0, Math.trunc(request.payload.afterSequence))
      : 0;
    switch (request.action) {
      case "ai.run.start":
        return runLocalAiPrompt({ ...request.payload, sessionId: request.sessionId });
      case "ai.run.get":
        if (!runId) throw new Error("AI run id is required.");
        return cleanupRuntime.controller.has(runId)
          ? cleanupRuntime.controller.get(runId, request.capabilityToken, afterSequence)
          : getAiRun(runId, request.capabilityToken, afterSequence);
      case "ai.run.followup":
        if (!runId) throw new Error("AI run id is required.");
        return followupAiRun(runId, request.capabilityToken, request.payload);
      case "ai.run.stop":
        if (!runId) throw new Error("AI run id is required.");
        return stopAiRun(runId, request.capabilityToken);
      case "cleanup.run.get":
        if (!runId) throw new Error("Cleanup run id is required.");
        return cleanupRuntime.controller.get(runId, request.capabilityToken, afterSequence);
      case "cleanup.run.cancel":
        if (!runId) throw new Error("Cleanup run id is required.");
        return cleanupRuntime.controller.cancel(runId, request.capabilityToken);
      case "cleanup.run.confirm-component-sets":
        if (!runId) throw new Error("Cleanup run id is required.");
        return cleanupRuntime.controller.confirmComponentSets(runId, request.capabilityToken, {
          satisfied: request.payload.satisfied === true,
          ...(typeof request.payload.feedback === "string" ? { feedback: request.payload.feedback } : {}),
        });
      default:
        throw new Error(`Unsupported Relay control action: ${request.action}`);
    }
  });
  const finalServer = createRelayHttpServer(config, relay, undefined, cleanupRuntime, logging);
  gateway.attachServer(finalServer);

  await new Promise<void>((resolve, reject) => {
    finalServer.once("error", reject);
    finalServer.listen(config.port, config.host, () => {
      finalServer.off("error", reject);
      resolve();
    });
  });

  const python = config.pythonWorker ? probePythonWorker() : { available: false, scriptExists: false, error: "disabled" };
  startup.succeed("Figma MCP Relay Node gateway 已启动", {
    url: publicUrl(config),
    mcpUrl: `${publicUrl(config)}${config.mcpPath}`,
    websocketUrl: `ws://${config.publicHost}:${config.port}/figma`,
    transport: config.transport,
    legacyRelayUrl: legacyRelay.url
  });
  processLogger.writeProtocolOutput({
    status: "listening",
    mode: "node-gateway",
    url: publicUrl(config),
    mcpUrl: `${publicUrl(config)}${config.mcpPath}`,
    websocketUrl: `ws://${config.publicHost}:${config.port}/figma`,
    transport: config.transport,
    legacyRelayUrl: legacyRelay.url,
    pythonWorker: python,
    message: "Figma MCP Relay Node gateway is running. Keep this process open."
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const operation = processLogger.startOperation("relay.shutdown", "开始关闭 Figma MCP Relay", { signal });
    for (const timer of disconnectGraceTimers.values()) clearTimeout(timer);
    disconnectGraceTimers.clear();
    relay.dispose();
    gateway.close();
    legacyRelay.close();
    operation.step("runtime.disposed", "Relay 运行时资源已释放");
    operation.succeed("Figma MCP Relay 已关闭");
    await logging.flush();
    await new Promise<void>((resolve) => finalServer.close(() => resolve()));
    await logging.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(async (error) => {
  const logging = getLoggingRuntime();
  logging.logger("process").error("Figma MCP Relay Node gateway 启动失败", error);
  await logging.flush();
  process.exitCode = 1;
});
