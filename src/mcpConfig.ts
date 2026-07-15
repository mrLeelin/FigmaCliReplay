import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER_NAME = "figmaMcpRelay";
const CLIENT_LABELS: Record<string, string> = {
  codex: "Codex App",
  claude: "Claude Code"
};

interface ConfigEntry {
  exists: boolean;
  url?: string;
  enabled?: boolean;
  transport?: string;
}

export function normalizeMcpClient(value: unknown): string {
  const raw = String(value || "codex").trim().toLowerCase();
  const aliases: Record<string, string> = {
    "codex-app": "codex",
    codex_app: "codex",
    "claude-code": "claude",
    claude_code: "claude"
  };
  const client = aliases[raw] || raw;
  if (!CLIENT_LABELS[client]) {
    throw new Error(`unsupported MCP config client: ${client}`);
  }
  return client;
}

export function desiredMcpUrl(publicUrl: string, mcpPath: string): string {
  const parsed = new URL(publicUrl);
  let host = parsed.hostname || "127.0.0.1";
  if (host === "localhost" || host === "::1") {
    host = "127.0.0.1";
  }
  const pathValue = mcpPath.startsWith("/") ? mcpPath : `/${mcpPath}`;
  return `${parsed.protocol}//${host}:${parsed.port}${pathValue}`;
}

export function mcpConfigStatusForClient(client: string, mcpUrl: string, mcpMounted: boolean) {
  if (client === "claude") {
    return claudeStatus(mcpUrl, mcpMounted);
  }
  return codexStatus(mcpUrl, mcpMounted);
}

export function writeMcpConfigForClient(client: string, mcpUrl: string, mcpMounted: boolean) {
  if (client === "claude") {
    return writeClaudeConfig(mcpUrl, mcpMounted);
  }
  return writeCodexConfig(mcpUrl, mcpMounted);
}

export function deleteMcpConfigForClient(client: string, mcpUrl: string, mcpMounted: boolean) {
  if (client === "claude") {
    return deleteClaudeConfig(mcpUrl, mcpMounted);
  }
  return deleteCodexConfig(mcpUrl, mcpMounted);
}

export function openMcpConfigForClient(client: string) {
  return client === "claude" ? openClaudeConfigLocation() : openCodexConfigFile();
}

function addClientFields<T extends Record<string, unknown>>(status: T, client: string): T & { client: string; clientLabel: string } {
  return {
    ...status,
    client,
    clientLabel: CLIENT_LABELS[client] || client
  };
}

function codexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME;
  return codexHome
    ? path.join(codexHome, "config.toml")
    : path.join(os.homedir(), ".codex", "config.toml");
}

function claudeConfigPath(): string {
  return process.env.CLAUDE_CONFIG_FILE || path.join(os.homedir(), ".claude.json");
}

function describeCodexEntry(text: string, name: string): ConfigEntry {
  const section = findCodexServerSection(text, name);
  if (!section) {
    return { exists: false };
  }
  return {
    exists: true,
    url: String(readTomlScalar(section.body, "url") || ""),
    enabled: readTomlScalar(section.body, "enabled") as boolean | undefined
  };
}

function readTomlScalar(block: string, key: string): unknown {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`, "m").exec(block);
  if (!match) {
    return undefined;
  }
  const raw = match[1].split("#", 1)[0].trim();
  if (raw.toLowerCase() === "true") {
    return true;
  }
  if (raw.toLowerCase() === "false") {
    return false;
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function codexStatus(mcpUrl: string, mcpMounted: boolean) {
  const configPath = codexConfigPath();
  const configExists = fs.existsSync(configPath);
  const text = configExists ? fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "") : "";
  const entry = describeCodexEntry(text, SERVER_NAME);
  const legacyFigma = describeCodexEntry(text, "figma");
  const configured = entry.exists && entry.url === mcpUrl && entry.enabled !== false;
  return addClientFields({
    ok: true,
    serverName: SERVER_NAME,
    configPath,
    configExists,
    desiredUrl: mcpUrl,
    mcpMounted,
    entryExists: entry.exists,
    entryUrl: entry.url || "",
    entryEnabled: entry.enabled,
    configured,
    legacyFigma: {
      exists: legacyFigma.exists,
      url: legacyFigma.url || "",
      enabled: legacyFigma.enabled
    },
    managedBy: "Codex user config TOML"
  }, "codex");
}

function writeCodexConfig(mcpUrl: string, mcpMounted: boolean) {
  const url = validateLocalMcpUrl(mcpUrl);
  const configPath = codexConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const oldText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "") : "";
  const backupPath = backupFile(configPath);
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `url = ${tomlQuote(url)}`,
    "enabled = true",
    ""
  ].join("\n");
  const stripped = removeCodexServerSections(oldText, SERVER_NAME);
  const newText = `${stripped.trim() ? `${stripped.trimEnd()}\n\n` : ""}${block}`;
  fs.writeFileSync(configPath, newText, "utf8");
  return {
    ...codexStatus(url, mcpMounted),
    changed: oldText !== newText,
    backupPath
  };
}

function deleteCodexConfig(mcpUrl: string, mcpMounted: boolean) {
  const configPath = codexConfigPath();
  if (!fs.existsSync(configPath)) {
    return { ...codexStatus(mcpUrl, mcpMounted), changed: false, backupPath: "" };
  }
  const oldText = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  if (!findCodexServerSection(oldText, SERVER_NAME) && !hasCodexServerDescendantSection(oldText, SERVER_NAME)) {
    return { ...codexStatus(mcpUrl, mcpMounted), changed: false, backupPath: "" };
  }
  const backupPath = backupFile(configPath);
  const stripped = removeCodexServerSections(oldText, SERVER_NAME).replace(/\n{3,}/g, "\n\n").trim();
  const newText = stripped ? `${stripped}\n` : "";
  fs.writeFileSync(configPath, newText, "utf8");
  return { ...codexStatus(mcpUrl, mcpMounted), changed: true, backupPath };
}

function claudeStatus(mcpUrl: string, mcpMounted: boolean) {
  const configPath = claudeConfigPath();
  const warnings: string[] = [];
  let entry: ConfigEntry = { exists: false };
  try {
    const data = readClaudeConfig(configPath);
    const servers = isRecord(data.mcpServers) ? data.mcpServers : undefined;
    if (servers) {
      const rawEntry = servers[SERVER_NAME];
      if (isRecord(rawEntry)) {
        entry = {
          exists: true,
          url: String(rawEntry.url || ""),
          transport: String(rawEntry.type || rawEntry.transport || ""),
          enabled: rawEntry.disabled === true ? false : true
        };
      }
    } else if (data.mcpServers !== undefined) {
      warnings.push("Claude config mcpServers is not an object");
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  return addClientFields({
    ok: true,
    serverName: SERVER_NAME,
    configPath,
    configExists: fs.existsSync(configPath),
    desiredUrl: mcpUrl,
    mcpMounted,
    entryExists: entry.exists,
    entryUrl: entry.url || "",
    entryEnabled: entry.enabled,
    configured: entry.exists && entry.url === mcpUrl && entry.enabled !== false,
    scope: "user",
    transport: entry.transport || "",
    cliStatus: "",
    warnings,
    managedBy: "Claude user config JSON"
  }, "claude");
}

function writeClaudeConfig(mcpUrl: string, mcpMounted: boolean) {
  const url = validateLocalMcpUrl(mcpUrl);
  const configPath = claudeConfigPath();
  const oldText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "") : "";
  const data = readClaudeConfig(configPath);
  if (!isRecord(data.mcpServers)) {
    data.mcpServers = {};
  }
  const servers = data.mcpServers as Record<string, unknown>;
  const existing = isRecord(servers[SERVER_NAME]) ? servers[SERVER_NAME] : undefined;
  if (
    existing &&
    String(existing.url || "") === url &&
    String(existing.type || existing.transport || "") === "http" &&
    existing.disabled !== true
  ) {
    return { ...claudeStatus(url, mcpMounted), changed: false, backupPath: "" };
  }
  servers[SERVER_NAME] = { type: "http", url };
  const backupPath = backupFile(configPath);
  writeJsonFile(configPath, data);
  const newText = fs.readFileSync(configPath, "utf8");
  return { ...claudeStatus(url, mcpMounted), changed: oldText !== newText, backupPath };
}

function deleteClaudeConfig(mcpUrl: string, mcpMounted: boolean) {
  const configPath = claudeConfigPath();
  if (!fs.existsSync(configPath)) {
    return { ...claudeStatus(mcpUrl, mcpMounted), changed: false, backupPath: "" };
  }
  const oldText = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  const data = readClaudeConfig(configPath);
  if (!isRecord(data.mcpServers) || !(SERVER_NAME in data.mcpServers)) {
    return { ...claudeStatus(mcpUrl, mcpMounted), changed: false, backupPath: "" };
  }
  const backupPath = backupFile(configPath);
  delete data.mcpServers[SERVER_NAME];
  writeJsonFile(configPath, data);
  const newText = fs.readFileSync(configPath, "utf8");
  return { ...claudeStatus(mcpUrl, mcpMounted), changed: oldText !== newText, backupPath };
}

function readClaudeConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  const text = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) {
    return {};
  }
  const data = JSON.parse(text) as unknown;
  if (!isRecord(data)) {
    throw new Error(`Claude config root must be object: ${configPath}`);
  }
  return data;
}

function writeJsonFile(configPath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function openCodexConfigFile() {
  const configPath = codexConfigPath();
  const target = fs.existsSync(configPath) ? configPath : path.dirname(configPath);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
  openPath(target);
  return { ok: true, path: configPath, opened: target, exists: fs.existsSync(configPath) };
}

function openClaudeConfigLocation() {
  const configPath = claudeConfigPath();
  if (!fs.existsSync(configPath)) {
    const targetDir = path.dirname(configPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    openPath(targetDir);
    return {
      ok: true,
      path: configPath,
      opened: targetDir,
      exists: false,
      managedBy: "Claude user config JSON"
    };
  }
  openPath(configPath);
  return {
    ok: true,
    path: configPath,
    opened: configPath,
    exists: fs.existsSync(configPath),
    managedBy: "Claude user config JSON"
  };
}

function openPath(target: string): void {
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "", target], { detached: true, windowsHide: true });
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [target], { detached: true });
    return;
  }
  spawn("xdg-open", [target], { detached: true });
}

function validateLocalMcpUrl(value: string): string {
  const text = String(value || "").trim();
  const parsed = new URL(text);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("MCP URL must be http/https");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("MCP URL must point to local loopback");
  }
  if (parsed.pathname.replace(/\/+$/, "") !== "/mcp") {
    throw new Error("MCP URL path must be /mcp");
  }
  return text;
}

function backupFile(configPath: string): string {
  if (!fs.existsSync(configPath)) {
    return "";
  }
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const backupPath = `${configPath}.bak-figma-mcp-relay-${stamp}`;
  fs.copyFileSync(configPath, backupPath);
  return backupPath;
}

function tomlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface TomlSection {
  start: number;
  end: number;
  name: string;
  body: string;
}

function findCodexServerSection(text: string, name: string): TomlSection | undefined {
  return findTomlSections(text).find((section) => section.name === `mcp_servers.${name}`);
}

function hasCodexServerDescendantSection(text: string, name: string): boolean {
  return findTomlSections(text).some((section) => isCodexServerSectionName(section.name, name));
}

function removeCodexServerSections(text: string, name: string): string {
  const ranges = findTomlSections(text)
    .filter((section) => isCodexServerSectionName(section.name, name))
    .map((section) => ({ start: section.start, end: section.end }))
    .sort((left, right) => right.start - left.start);
  let result = text;
  for (const range of ranges) {
    result = `${result.slice(0, range.start)}${result.slice(range.end)}`;
  }
  return result;
}

function isCodexServerSectionName(sectionName: string, name: string): boolean {
  const prefix = `mcp_servers.${name}`;
  return sectionName === prefix || sectionName.startsWith(`${prefix}.`);
}

function findTomlSections(text: string): TomlSection[] {
  const headerPattern = /^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?$/gm;
  const headers: Array<{ start: number; end: number; name: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(text)) !== null) {
    headers.push({
      start: match.index,
      end: headerPattern.lastIndex,
      name: normalizeTomlDottedKey(match[1])
    });
  }
  return headers.map((header, index) => {
    const end = headers[index + 1]?.start ?? text.length;
    return {
      start: header.start,
      end,
      name: header.name,
      body: text.slice(header.end, end)
    };
  });
}

function normalizeTomlDottedKey(value: string): string {
  return value
    .split(".")
    .map((part) => {
      const trimmed = part.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
          return String(JSON.parse(trimmed));
        } catch {
          return trimmed.slice(1, -1);
        }
      }
      return trimmed;
    })
    .join(".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
