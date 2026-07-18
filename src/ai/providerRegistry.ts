import { spawn, spawnSync } from "node:child_process";

import { claudeCodeCliProvider } from "./claudeCodeCliProvider.js";
import { codexCliProvider } from "./codexCliProvider.js";
import type { PlanningProvider, PlanningProviderId, ProviderAvailability } from "./planningProvider.js";
import { getLoggingRuntime } from "../logging/loggingRuntime.js";
import { logInfo, logDebug, logError } from "../utils/logger.js";

export interface PlanningProviderRegistryOptions {
  commandAvailable?: (command: string) => Promise<boolean>;
  commandVersion?: (command: string) => Promise<string | undefined>;
  now?: () => number;
  cacheMs?: number;
}

export interface PlanningProviderRegistry {
  list(): Promise<ProviderAvailability[]>;
  resolve(id: unknown): Promise<PlanningProvider>;
  refresh(): void;
}

const Providers: readonly PlanningProvider[] = [codexCliProvider, claudeCodeCliProvider];

export function createPlanningProviderRegistry(options: PlanningProviderRegistryOptions = {}): PlanningProviderRegistry {
  const operationLogger = getLoggingRuntime().logger("provider-registry");
  const commandAvailable = options.commandAvailable || defaultCommandAvailable;
  const commandVersion = options.commandVersion || defaultCommandVersion;
  const now = options.now || Date.now;
  const cacheMs = options.cacheMs ?? 30_000; // Increased from 5s to 30s
  let cachedAt = 0;
  let cached: ProviderAvailability[] | undefined;

  async function list(): Promise<ProviderAvailability[]> {
    const current = now();
    if (cached && current - cachedAt < cacheMs) {
      logDebug("Using cached provider list", { cacheAge: current - cachedAt });
      return cached.map((item) => ({ ...item }));
    }
    const operation = operationLogger.startOperation("provider-probe", "开始探测 AI Provider");
    const results: ProviderAvailability[] = [];
    try {
      for (const provider of Providers) {
        const available = await commandAvailable(provider.command);
        const version = available ? await commandVersion(provider.command) : undefined;
        operation.step("provider-probe", "Provider 探测完成", {
          providerId: provider.id,
          available,
          version,
        });
        results.push({
          id: provider.id,
          label: provider.label,
          available,
          ...(version ? { version } : {}),
          ...(!available ? { reason: `command not found: ${provider.command}` } : {}),
        });
      }
    } catch (error) {
      operation.fail(error, "AI Provider 探测失败");
      throw error;
    }
    cached = results;
    cachedAt = current;
    operation.succeed("AI Provider 探测完成", {
      availableCount: results.filter(r => r.available).length,
      totalCount: results.length,
    });
    return cached.map((item) => ({ ...item }));
  }

  return {
    list,
    async resolve(id: unknown): Promise<PlanningProvider> {
      const provider = Providers.find((candidate) => candidate.id === id);
      if (!provider) {
        logError("Unknown planning provider requested", { providerId: String(id || "missing") });
        throw new Error(`unknown planning provider: ${String(id || "missing")}`);
      }
      const availability = (await list()).find((item) => item.id === provider.id);
      if (!availability?.available) {
        logError("Planning provider not available", {
          providerId: provider.id,
          reason: availability?.reason || "unknown reason",
        });
        throw new Error(`planning provider ${provider.label} is not available: ${availability?.reason || "unknown reason"}`);
      }
      logInfo("Planning provider resolved", {
        providerId: provider.id,
        label: provider.label,
        version: availability.version,
      });
      return provider;
    },
    refresh(): void {
      logInfo("Provider cache cleared");
      cached = undefined;
      cachedAt = 0;
    },
  };
}

export function planningProviderId(value: unknown): PlanningProviderId {
  if (value === "codex" || value === "claude-code") return value;
  throw new Error(`unknown planning provider: ${String(value || "missing")}`);
}

async function defaultCommandAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(process.platform === "win32" ? "where.exe" : "which", [command], {
      windowsHide: true,
      stdio: "ignore",
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

async function defaultCommandVersion(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let output = "";
    const proc = spawn(command, ["--version"], {
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
    proc.stderr?.on("data", (data: Buffer) => { output += data.toString(); });
    proc.on("close", (code: number | null) => {
      if (code !== 0) return resolve(undefined);
      const version = output.trim().split(/\r?\n/)[0]?.trim();
      resolve(version || undefined);
    });
    proc.on("error", () => resolve(undefined));
    // Timeout after 3 seconds
    setTimeout(() => {
      proc.kill();
      resolve(undefined);
    }, 3_000);
  });
}
