import { createRelayHttpServer } from "./httpServer.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import { RuntimeRelay } from "./runtimeRelay.js";
import { parseArgs, publicUrl } from "./config.js";
import { LegacyRelay, probePythonWorker } from "./pythonWorker.js";
import { WebSocketGateway } from "./websocketGateway.js";
import { stopAiRunsForSession } from "./localAiRunner.js";

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
  gateway.onDisconnected((sessionId, reason) => stopAiRunsForSession(sessionId, reason));
  const legacyRelay = new LegacyRelay(config);
  const relay = new RuntimeRelay(config, gateway, legacyRelay);
  const finalServer = createRelayHttpServer(config, relay, undefined, undefined, logging);
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
