import { spawnSync } from "node:child_process";

import { claudeCodeCliProvider } from "./claudeCodeCliProvider.js";
import { codexCliProvider } from "./codexCliProvider.js";
import type { PlanningProvider, PlanningProviderId, ProviderAvailability } from "./planningProvider.js";

export interface PlanningProviderRegistryOptions {
  commandAvailable?: (command: string) => boolean;
  commandVersion?: (command: string) => string | undefined;
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
  const commandAvailable = options.commandAvailable || defaultCommandAvailable;
  const commandVersion = options.commandVersion || defaultCommandVersion;
  const now = options.now || Date.now;
  const cacheMs = options.cacheMs ?? 5_000;
  let cachedAt = 0;
  let cached: ProviderAvailability[] | undefined;

  async function list(): Promise<ProviderAvailability[]> {
    const current = now();
    if (cached && current - cachedAt < cacheMs) return cached.map((item) => ({ ...item }));
    cached = Providers.map((provider) => {
      const available = commandAvailable(provider.command);
      const version = available ? commandVersion(provider.command) : undefined;
      return {
        id: provider.id,
        label: provider.label,
        available,
        ...(version ? { version } : {}),
        ...(!available ? { reason: `command not found: ${provider.command}` } : {}),
      };
    });
    cachedAt = current;
    return cached.map((item) => ({ ...item }));
  }

  return {
    list,
    async resolve(id: unknown): Promise<PlanningProvider> {
      const provider = Providers.find((candidate) => candidate.id === id);
      if (!provider) throw new Error(`unknown planning provider: ${String(id || "missing")}`);
      const availability = (await list()).find((item) => item.id === provider.id);
      if (!availability?.available) throw new Error(`planning provider ${provider.label} is not available: ${availability?.reason || "unknown reason"}`);
      return provider;
    },
    refresh(): void {
      cached = undefined;
      cachedAt = 0;
    },
  };
}

export function planningProviderId(value: unknown): PlanningProviderId {
  if (value === "codex" || value === "claude-code") return value;
  throw new Error(`unknown planning provider: ${String(value || "missing")}`);
}

function defaultCommandAvailable(command: string): boolean {
  return spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], { windowsHide: true }).status === 0;
}

function defaultCommandVersion(command: string): string | undefined {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    timeout: 3_000,
  });
  if (result.status !== 0) return undefined;
  const output = String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0]?.trim();
  return output || undefined;
}
