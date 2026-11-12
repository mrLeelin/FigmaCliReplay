import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { INSTALL_ROOT, PLUGIN_ROOT } from "./config.js";
import { isRecord } from "./utils.js";

export type AiSkillTarget = "all" | "codex" | "claude";
export type AiSkillInstallState = "installed" | "missing" | "outdated" | "modified" | "error";
export interface AiSkillOptions {
  home?: string;
  /** Internal dependency for packaging/tests; never accepted from plugin payloads. */
  projectRoot?: string;
  target?: string;
}
export interface AiSkillInstallation {
  agent: "codex" | "claude";
  directory: string;
  status: AiSkillInstallState;
  installed: boolean;
  current: boolean;
  canInstall: boolean;
  message: string;
}
export interface AiSkillStatus {
  ok: true;
  skill: "figma-relay";
  sourceAvailable: boolean;
  sourceError?: string;
  installations: AiSkillInstallation[];
}
export interface AiSkillService {
  status(target?: AiSkillTarget): AiSkillStatus;
  install(target?: AiSkillTarget): AiSkillStatus;
}

const manifestName = ".figma-relay-install.json";
const requiredFiles = ["SKILL.md", "agents/openai.yaml", "references/installation.md"] as const;
const hash = (content: string | Buffer): string => crypto.createHash("sha256").update(content).digest("hex");
const psLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function targetFrom(value: string | undefined): AiSkillTarget {
  if (value === undefined) return "all";
  if (value !== "all" && value !== "codex" && value !== "claude") throw new Error("--target must be all, codex or claude.");
  return value;
}

function locations(home: string, target: AiSkillTarget) {
  return ([
    { agent: "codex" as const, directory: path.join(path.resolve(home), ".agents", "skills", "figma-relay") },
    { agent: "claude" as const, directory: path.join(path.resolve(home), ".claude", "skills", "figma-relay") },
  ]).filter((entry) => target === "all" || entry.agent === target);
}

function expectedContents(projectRoot: string): Record<string, string> {
  const cliRoot = INSTALL_ROOT && path.resolve(projectRoot) === PLUGIN_ROOT ? INSTALL_ROOT : projectRoot;
  const cliPath = path.join(cliRoot, "dist", "cli.js");
  if (!fs.statSync(cliPath).isFile()) throw new Error("Build the project CLI before installing the skill: npm run build.");
  const sourceRoot = path.join(projectRoot, "ai", "skills", "figma-relay");
  return {
    "SKILL.md": fs.readFileSync(path.join(sourceRoot, "SKILL.md"), "utf8"),
    "agents/openai.yaml": fs.readFileSync(path.join(sourceRoot, "agents", "openai.yaml"), "utf8"),
    "references/installation.md": [
      "# Installed Relay CLI", "",
      `Relay repository root: ${cliRoot}`, "",
      "Preferred command: `figma-relay`. If the command is absent from PATH, use this absolute fallback with the same arguments:", "",
      "```powershell", `node ${psLiteral(cliPath)} --help`, "```", "",
      `Workflow documentation: ${path.join(projectRoot, "docs", "cli.md")}`,
      `Specialized skills: ${path.join(projectRoot, "ai", "skills")}`, "",
      "The CLI executable is a local client; it does not start or stop the Relay service.", "",
    ].join("\n"),
  };
}

function readOptional(file: string): Buffer | undefined {
  try { return fs.readFileSync(file); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function readManifest(directory: string): Record<string, string> | undefined {
  const content = readOptional(path.join(directory, manifestName));
  if (!content) return undefined;
  const manifest: unknown = JSON.parse(content.toString("utf8"));
  if (!isRecord(manifest) || manifest.name !== "figma-relay" || !isRecord(manifest.files)
    || Object.values(manifest.files).some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error(`Invalid Skill installation record: ${path.join(directory, manifestName)}`);
  }
  return manifest.files as Record<string, string>;
}

function checkDirectoryPath(directory: string): void {
  let candidate = directory;
  for (;;) {
    try {
      if (!fs.statSync(candidate).isDirectory()) throw new Error(`Not a directory: ${candidate}`);
      return;
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function inspectInstallation(
  entry: { agent: "codex" | "claude"; directory: string },
  expected: Record<string, string> | undefined,
  sourceError?: string,
): AiSkillInstallation {
  const base = { ...entry, installed: false, current: false, canInstall: false };
  try {
    checkDirectoryPath(entry.directory);
    const existing = Object.fromEntries(requiredFiles.map((relative) => [relative, readOptional(path.join(entry.directory, relative))]));
    const installed = requiredFiles.every((relative) => existing[relative] !== undefined);
    if (!expected) return { ...base, installed, status: "error", message: `Skill 安装源不可用：${sourceError}` };
    const managed = readManifest(entry.directory);
    const missing = requiredFiles.filter((relative) => existing[relative] === undefined);
    const different = requiredFiles.filter((relative) => existing[relative] !== undefined && !existing[relative]!.equals(Buffer.from(expected[relative])));
    const modified = different.filter((relative) => managed?.[relative] !== hash(existing[relative]!));
    if (modified.length) return {
      ...base, installed, status: "modified",
      message: `Skill 文件已被本地修改或属于其他安装，已保留：${path.join(entry.directory, modified[0])}`,
    };
    if (missing.length) return {
      ...base, installed, canInstall: true, status: "missing",
      message: missing.length === requiredFiles.length ? "尚未写入 Skill，点击“写入 Skill”即可安装。" : "Skill 文件不完整，请重新写入以修复。",
    };
    if (different.length) return { ...base, installed, canInstall: true, status: "outdated", message: "已写入的 Skill 版本或 Relay 路径需要更新。" };
    return { ...base, installed, current: true, canInstall: true, status: "installed", message: "Skill 已写入，文件内容和 Relay 路径均为当前版本。" };
  } catch (error) {
    return { ...base, status: "error", message: `无法检查 Skill：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Inspect actual files without creating directories, changing records, or installing anything. */
export function getAiSkillStatus(options: AiSkillOptions = {}): AiSkillStatus {
  const target = targetFrom(options.target);
  const projectRoot = path.resolve(options.projectRoot ?? PLUGIN_ROOT);
  let expected: Record<string, string> | undefined;
  let sourceError: string | undefined;
  try { expected = expectedContents(projectRoot); }
  catch (error) { sourceError = error instanceof Error ? error.message : String(error); }
  return {
    ok: true, skill: "figma-relay", sourceAvailable: expected !== undefined,
    ...(sourceError ? { sourceError } : {}),
    installations: locations(options.home ?? os.homedir(), target).map((entry) => inspectInstallation(entry, expected, sourceError)),
  };
}

/** Reuse the same inspected contract for CLI installation and authenticated plugin controls. */
export function installAiSkill(options: AiSkillOptions = {}): AiSkillStatus {
  const status = getAiSkillStatus(options);
  if (!status.sourceAvailable) throw new Error(`Skill 安装源不可用：${status.sourceError}`);
  // Preflight the complete requested set before writing either client's files.
  const blocked = status.installations.find((entry) => !entry.canInstall);
  if (blocked) throw new Error(`Preserving an existing or locally edited skill file: ${blocked.directory}. ${blocked.message}`);
  const projectRoot = path.resolve(options.projectRoot ?? PLUGIN_ROOT);
  const contents = expectedContents(projectRoot);
  for (const { directory } of status.installations) {
    for (const [relative, content] of Object.entries(contents)) {
      const destination = path.join(directory, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content, "utf8");
    }
    fs.writeFileSync(path.join(directory, manifestName), JSON.stringify({
      name: "figma-relay", source: projectRoot,
      files: Object.fromEntries(Object.entries(contents).map(([relative, content]) => [relative, hash(content)])),
    }, null, 2) + "\n", "utf8");
  }
  return getAiSkillStatus(options);
}

export function createAiSkillService(options: Omit<AiSkillOptions, "target"> = {}): AiSkillService {
  return {
    status: (target = "all") => getAiSkillStatus({ ...options, target }),
    install: (target = "all") => installAiSkill({ ...options, target }),
  };
}
