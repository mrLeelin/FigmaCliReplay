import fs from "node:fs";
import path from "node:path";
import { LOCAL_DIR } from "../dist/config.js";
import { getLoggingRuntime } from "../dist/logging/loggingRuntime.js";
import { installUnityBridge } from "../dist/unityBridgeInstaller.js";

const logging = getLoggingRuntime();
const operation = logging.logger("bridge-setup").startOperation("unity.bridge-setup", "Install Bridge from the local distribution");
try {
  operation.step("token", "Read local Relay authentication without displaying it");
  const tokenFile = path.join(LOCAL_DIR, "admin-token.txt");
  const token = (process.env.FIGMA_RELAY_BRIDGE_TOKEN || process.env.FIGMA_RELAY_TOKEN ||
    (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8") : "")).trim();
  if (!token) throw new Error("Start this package's Relay first to create its local token, then retry Bridge installation.");
  if (process.argv.length !== 3) throw new Error("Specify one Unity project root directory.");
  operation.step("install", "Use the shared installer to preserve project settings and asset GUIDs");
  installUnityBridge(process.argv[2], undefined, token);
  operation.succeed("Unity Bridge installed");
} catch (error) {
  operation.fail(error, "Unity Bridge setup failed");
  process.exitCode = 1;
} finally {
  await logging.close();
}
