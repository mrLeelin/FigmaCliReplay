import { createRelayHttpServer } from "./httpServer.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import { RuntimeRelay } from "./runtimeRelay.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { INSTALL_ROOT, LOCAL_DIR, PLUGIN_ROOT, parseArgs, publicUrl } from "./config.js";
import { probePythonWorker } from "./pythonWorker.js";
import { PythonAlgorithms } from "./pythonAlgorithms.js";
import { WebSocketGateway } from "./websocketGateway.js";
import { createRelayControlHandler } from "./relayControl.js";
import { UnityProjectRegistry } from "./unityProjectRegistry.js";
import { RelayCliEndpoint } from "./relayCliEndpoint.js";
import { getCleanupRuntime } from "./cleanup/cleanupRuntime.js";
import { CleanupExecutor } from "./cleanup/cleanupExecutor.js";
import { createConversationCleanupDispatcher } from "./cleanup/conversationCleanupDispatcher.js";
import { activeLocalAiRunCount, configureLocalAiCleanupDispatcher, stopAiRunsForSession } from "./localAiRunner.js";
import { activePsdImportCount } from "./psdImportTask.js";
import { activeFigmaPrefabImportCount } from "./figmaPrefabImportTask.js";
import { activeRuntimeControls } from "./updateActivity.js";
import { UpdateService, writeUpdateJson } from "./updateService.js";
import { resumeRequestedBridgeUpdate } from "./updateBridge.js";

async function main(): Promise<void> {
  const logging = getLoggingRuntime();
  const processLogger = logging.logger("process");
  const startup = processLogger.startOperation("relay.startup", "开始启动 Figma Relay");
  const config = parseArgs();
  startup.step("config.parsed", "Relay 配置解析完成", {
    host: config.host,
    port: config.port,
    transport: config.transport,
  });
  if (!config.bridgeToken) {
    startup.fail(new Error("FIGMA_RELAY_BRIDGE_TOKEN or FIGMA_RELAY_TOKEN is required for Unity Bridge authentication"), "Relay 启动失败");
    throw new Error("Unity Bridge authentication token is not configured.");
  }
  const gateway = new WebSocketGateway((events) => logging.store.ingest(events), config.bridgeToken);
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
  const algorithms = new PythonAlgorithms(config);
  const relay = new RuntimeRelay(config, gateway, algorithms);
  const cleanupRuntime = getCleanupRuntime();
  configureLocalAiCleanupDispatcher(createConversationCleanupDispatcher(new CleanupExecutor()));
  const unityProjects = new UnityProjectRegistry();
  const update = new UpdateService({
    refreshBridge: () => resumeRequestedBridgeUpdate(),
    activity: () => relay.status().pending + Number(algorithms.status().processRunning) + activeLocalAiRunCount()
      + activePsdImportCount() + activeFigmaPrefabImportCount() + (cleanupRuntime.controller.activeCount?.() ?? 0) + activeRuntimeControls(),
    shutdown: () => void shutdown("update"),
  });
  const cliControlHandler = createRelayControlHandler(relay, cleanupRuntime, undefined, unityProjects, config.bridgeToken, undefined, undefined, update);
  gateway.onClientRequest((request) => cliControlHandler(request.action, {
    ...request.payload,
    sessionId: request.sessionId,
    fileKey: request.fileKey,
    capabilityToken: request.capabilityToken,
  }, request.operationId));
  const finalServer = createRelayHttpServer(config, relay, unityProjects, cleanupRuntime, logging);
  gateway.attachServer(finalServer, new RelayCliEndpoint(config, relay, logging, cliControlHandler));

  await new Promise<void>((resolve, reject) => {
    finalServer.once("error", reject);
    finalServer.listen(config.port, config.host, () => {
      finalServer.off("error", reject);
      resolve();
    });
  });

  const runtimeFile = path.join(LOCAL_DIR, "runtime.json");
  if (INSTALL_ROOT) {
    process.env.FIGMA_RELAY_INSTANCE_ID ||= randomUUID();
    writeUpdateJson(runtimeFile, { schemaVersion: 1, pid: process.pid, entry: path.join(PLUGIN_ROOT, "dist", "index.js"),
      port: config.port, tokenFile: path.join(LOCAL_DIR, "admin-token.txt"), startedAt: new Date().toISOString(), instanceId: process.env.FIGMA_RELAY_INSTANCE_ID });
  }

  const python = config.pythonWorker ? probePythonWorker() : { available: false, scriptExists: false, error: "disabled" };
  startup.succeed("Figma Relay Node gateway 已启动", {
    url: publicUrl(config),
    cliUrl: `ws://${config.publicHost}:${config.port}/relay`,
    websocketUrl: `ws://${config.publicHost}:${config.port}/figma`,
    transport: config.transport,
    pythonTransport: "cli"
  });
  processLogger.writeProtocolOutput({
    status: "listening",
    mode: "node-gateway",
    url: publicUrl(config),
    cliUrl: `ws://${config.publicHost}:${config.port}/relay`,
    websocketUrl: `ws://${config.publicHost}:${config.port}/figma`,
    transport: config.transport,
    pythonTransport: "cli",
    pythonWorker: python,
    message: "Figma Relay Node gateway is running. Keep this process open."
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const operation = processLogger.startOperation("relay.shutdown", "开始关闭 Figma Relay", { signal });
    for (const timer of disconnectGraceTimers.values()) clearTimeout(timer);
    disconnectGraceTimers.clear();
    relay.dispose();
    gateway.close();
    algorithms.close();
    if (INSTALL_ROOT) {
      try {
        if (JSON.parse(fs.readFileSync(runtimeFile, "utf8")).pid === process.pid) fs.unlinkSync(runtimeFile);
      } catch { /* A newer instance may already own the record. */ }
    }
    operation.step("runtime.disposed", "Relay 运行时资源已释放");
    operation.succeed("Figma Relay 已关闭");
    await logging.flush();
    await new Promise<void>((resolve) => finalServer.close(() => resolve()));
    await logging.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  void resumeRequestedBridgeUpdate().catch((error) => processLogger.error("Bridge 更新恢复失败", error));
}

main().catch(async (error) => {
  const logging = getLoggingRuntime();
  logging.logger("process").error("Figma Relay Node gateway 启动失败", error);
  await logging.flush();
  process.exitCode = 1;
});
