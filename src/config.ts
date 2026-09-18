import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RelayLogger } from "./logging/relayLogger.js";

export const SERVER_NAME = "figmaRelay";
// BEGIN_RELEASE_VERSION
export const SERVER_VERSION = "0.1.48";
// END_RELEASE_VERSION
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PUBLIC_HOST = "localhost";
export const DEFAULT_PORT = 32130;
export const DEFAULT_TRANSPORT = "websocket";

export type RelayTransport = "websocket";

export interface GatewayConfig {
  host: string;
  publicHost: string;
  port: number;
  transport: RelayTransport;
  verbose: boolean;
  pythonWorker: boolean;
  adminToken: string;
  assetRoots: string[];
}

const __filename = fileURLToPath(import.meta.url);
const protocolLogger = new RelayLogger({ module: "config", emit: () => undefined });
export const DIST_DIR = path.dirname(__filename);
export const PLUGIN_ROOT = path.resolve(DIST_DIR, "..");
export const SERVER_DIR = path.join(PLUGIN_ROOT, "server");
export const LOG_DIR = path.join(PLUGIN_ROOT, ".logs");
export const LOCAL_DIR = path.join(PLUGIN_ROOT, ".local");

export function parseArgs(argv: string[] = process.argv.slice(2)): GatewayConfig {
  const config: GatewayConfig = {
    host: DEFAULT_HOST,
    publicHost: DEFAULT_PUBLIC_HOST,
    port: DEFAULT_PORT,
    transport: DEFAULT_TRANSPORT,
    verbose: false,
    pythonWorker: true,
    adminToken: process.env.FIGMA_RELAY_TOKEN || "",
    assetRoots: defaultAssetRoots()
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--host" && next) {
      config.host = next;
      index += 1;
    } else if (arg === "--public-host" && next) {
      config.publicHost = next;
      index += 1;
    } else if (arg === "--port" && next) {
      config.port = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--transport" && next) {
      if (next !== "websocket") {
        throw new Error(`invalid --transport: ${next}`);
      }
      config.transport = next as RelayTransport;
      index += 1;
    } else if (arg === "--admin-token" && next) {
      config.adminToken = next;
      index += 1;
    } else if (arg === "--asset-root" && next) {
      config.assetRoots.push(path.resolve(next));
      index += 1;
    } else if (arg === "--no-python-worker") {
      config.pythonWorker = false;
    } else if (arg === "--verbose") {
      config.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}; upgrade to CLI/WebSocket options.`);
    }
  }

  if (!Number.isFinite(config.port) || config.port <= 0) {
    throw new Error(`invalid --port: ${config.port}`);
  }
  config.assetRoots = uniquePaths(config.assetRoots.map((item) => path.resolve(item)));
  return config;
}

export function publicUrl(config: GatewayConfig): string {
  return `http://${config.publicHost}:${config.port}`;
}

function printHelp(): void {
  protocolLogger.writeProtocolOutput(`Figma Relay Gateway

Options:
  --host <host>              Bind host. Default: ${DEFAULT_HOST}
  --public-host <host>       Host shown to plugin clients. Default: ${DEFAULT_PUBLIC_HOST}
  --port <port>              HTTP/WebSocket port. Default: ${DEFAULT_PORT}
  --transport <mode>         websocket. Default: ${DEFAULT_TRANSPORT}
  --admin-token <token>      Token required by CLI WebSocket connections.
  --asset-root <path>        Additional local root allowed for /assets files.
  --no-python-worker         Disable optional Python worker probing.
  --verbose                  Enable verbose logging.
`);
}

function defaultAssetRoots(): string[] {
  return uniquePaths([
    path.join(PLUGIN_ROOT, ".tmp"),
    path.join(os.tmpdir(), "figma-relay")
  ].map((item) => path.resolve(item)));
}

function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = process.platform === "win32" ? value.toLowerCase() : value;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}
