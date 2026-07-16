import fs from "node:fs";
import path from "node:path";

export type UnityGatewayDiscoveryResult =
  | { found: true; gatewayUrl: string; updatedAtUtc: string }
  | { found: false };

export function readUnityGatewayDiscovery(projectPath: string): UnityGatewayDiscoveryResult {
  const normalizedProjectPath = path.resolve(projectPath);
  const discoveryDirectory = path.join(normalizedProjectPath, "Library", "FigmaBridge", "gateways");
  try {
    const records = fs.readdirSync(discoveryDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
      .map((entry) => readRecord(path.join(discoveryDirectory, entry.name), entry.name, normalizedProjectPath))
      .filter((record): record is ValidGatewayRecord => Boolean(record))
      .sort((left, right) => Date.parse(right.updatedAtUtc) - Date.parse(left.updatedAtUtc));
    const latest = records[0];
    if (!latest) return { found: false };
    return {
      found: true,
      gatewayUrl: new URL(latest.gatewayUrl).origin,
      updatedAtUtc: latest.updatedAtUtc
    };
  } catch {
    return { found: false };
  }
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
