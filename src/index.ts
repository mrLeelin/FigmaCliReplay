import { createRelayHttpServer } from "./httpServer.js";
import { RuntimeRelay } from "./runtimeRelay.js";
import { parseArgs, publicUrl } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { LegacyRelay, probePythonWorker } from "./pythonWorker.js";
import { WebSocketGateway } from "./websocketGateway.js";
import { stopAiRunsForSession } from "./localAiRunner.js";

async function main(): Promise<void> {
  const config = parseArgs();
  const gateway = new WebSocketGateway();
  gateway.onDisconnected((sessionId, reason) => stopAiRunsForSession(sessionId, reason));
  const legacyRelay = new LegacyRelay(config);
  const relay = new RuntimeRelay(config, gateway, legacyRelay);
  const finalServer = createRelayHttpServer(config, relay);
  gateway.attachServer(finalServer);

  await new Promise<void>((resolve, reject) => {
    finalServer.once("error", reject);
    finalServer.listen(config.port, config.host, () => {
      finalServer.off("error", reject);
      resolve();
    });
  });

  const python = config.pythonWorker ? probePythonWorker() : { available: false, scriptExists: false, error: "disabled" };
  logInfo("Figma MCP Relay Node gateway listening", {
    url: publicUrl(config),
    mcpUrl: `${publicUrl(config)}${config.mcpPath}`,
    websocketUrl: `ws://${config.publicHost}:${config.port}/figma`,
    transport: config.transport,
    legacyRelayUrl: legacyRelay.url
  });
  console.log(JSON.stringify({
    status: "listening",
    mode: "node-gateway",
    url: publicUrl(config),
    mcpUrl: `${publicUrl(config)}${config.mcpPath}`,
    websocketUrl: `ws://${config.publicHost}:${config.port}/figma`,
    transport: config.transport,
    legacyRelayUrl: legacyRelay.url,
    pythonWorker: python,
    message: "Figma MCP Relay Node gateway is running. Keep this process open."
  }, null, 2));

  const shutdown = () => {
    logInfo("Figma MCP Relay Node gateway shutting down");
    relay.dispose();
    gateway.close();
    legacyRelay.close();
    finalServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  logError("Figma MCP Relay Node gateway failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
