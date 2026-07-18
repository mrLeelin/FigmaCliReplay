import fs from "node:fs";
import path from "node:path";

import { getLoggingRuntime } from "./logging/loggingRuntime.js";

const logger = getLoggingRuntime().logger("unity-gateway-discovery");

export type UnityGatewayDiscoveryResult =
  | { found: true; gatewayUrl: string; updatedAtUtc: string }
  | { found: false };

export function readUnityGatewayDiscovery(projectPath: string): UnityGatewayDiscoveryResult {
  const operation = logger.startOperation("unity.gateway-discover", "开始发现 Unity Bridge Gateway", {
    data: { projectName: path.basename(projectPath) }
  });
  operation.step("discover", "正在扫描 Unity Bridge Gateway 记录");
  const normalizedProjectPath = path.resolve(projectPath);
  const discoveryDirectory = path.join(normalizedProjectPath, "Library", "FigmaBridge", "gateways");
  try {
    const records = fs.readdirSync(discoveryDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
      .map((entry) => readRecord(path.join(discoveryDirectory, entry.name), entry.name, normalizedProjectPath))
      .filter((record): record is ValidGatewayRecord => Boolean(record))
      .sort((left, right) => Date.parse(right.updatedAtUtc) - Date.parse(left.updatedAtUtc));
    const latest = records[0];
    if (!latest) {
      operation.succeed("未发现可用的 Unity Bridge Gateway", { found: false });
      return { found: false };
    }
    const result = {
      found: true,
      gatewayUrl: new URL(latest.gatewayUrl).origin,
      updatedAtUtc: latest.updatedAtUtc
    } as const;
    operation.step("connect", "已找到 Unity Bridge Gateway", { found: true });
    operation.succeed("Unity Bridge Gateway 发现完成", { found: true });
    return result;
  } catch (error) {
    if (isMissingDirectory(error)) {
      operation.succeed("未发现 Unity Bridge Gateway 目录", { found: false });
      return { found: false };
    }
    operation.fail(error, "Unity Bridge Gateway 发现失败");
    return { found: false };
  }
}

function isMissingDirectory(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

interface ValidGatewayRecord {
  gatewayUrl: string;
  updatedAtUtc: string;
}

function readRecord(filePath: string, fileName: string, projectPath: string): ValidGatewayRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    if (!Number.isInteger(parsed.processId) || fileName !== `${parsed.processId}.json`) return null;
    if (typeof parsed.projectPath !== "string" || pathKey(parsed.projectPath) !== pathKey(projectPath)) return null;
    if (typeof parsed.gatewayUrl !== "string" || !isAllowedGatewayUrl(parsed.gatewayUrl)) return null;
    if (typeof parsed.updatedAtUtc !== "string" || !isIsoUtcTimestamp(parsed.updatedAtUtc)) return null;
    return { gatewayUrl: parsed.gatewayUrl, updatedAtUtc: parsed.updatedAtUtc };
  } catch {
    return null;
  }
}

function isAllowedGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const port = Number.parseInt(url.port, 10);
    return url.protocol === "http:"
      && (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]")
      && port >= 32129
      && port <= 32135
      && url.pathname === "/"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isIsoUtcTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
