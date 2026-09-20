import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PLUGIN_ROOT } from "./config.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import { normalizeUnityProjectPath } from "./unityProjectRegistry.js";

const logger = getLoggingRuntime().logger("unity-bridge-installer");

/** Unity .meta 里唯一标识资产的 GUID 行。 */
const MetaGuidPattern = /^guid:\s*([0-9a-fA-F]{32})\s*$/m;

/**
 * 已从桥模板移除、但仍可能残留在目标工程里的文件。
 * 出站形态不再需要发现文件，留着会让人误以为还有中继拨入路径。
 */
const RetiredBridgeFiles = ["FigmaBridgeGatewayDiscovery.cs", "FigmaBridgeGatewayDiscovery.cs.meta"];

export interface UnityBridgeInstallResult {
  ok: true;
  projectPath: string;
  bridgePath: string;
}

export function installUnityBridge(
  projectPath: string,
  sourceEditorPath = path.join(PLUGIN_ROOT, "unity", "Assets", "Editor"),
  bridgeToken = ""
): UnityBridgeInstallResult {
  const operation = logger.startOperation("unity.bridge-install", "开始安装 Unity Bridge", {
    data: { projectName: path.basename(projectPath) }
  });
  operation.step("install", "正在验证并复制 Unity Bridge 文件");
  try {
    const normalizedProjectPath = normalizeUnityProjectPath(projectPath);
    const assetsPath = path.join(normalizedProjectPath, "Assets");
    const projectSettingsPath = path.join(normalizedProjectPath, "ProjectSettings");
    if (!isDirectory(assetsPath) || !isDirectory(projectSettingsPath)) {
      throw new Error(`Unity project must contain Assets and ProjectSettings: ${normalizedProjectPath}`);
    }

    const sourceBridge = path.join(sourceEditorPath, "FigmaBridge");
    const sourceMeta = path.join(sourceEditorPath, "FigmaBridge.meta");
    if (!isDirectory(sourceBridge) || !fs.existsSync(sourceMeta)) {
      throw new Error(`FigmaBridge source is incomplete: ${sourceEditorPath}`);
    }

    const targetEditor = path.join(assetsPath, "Editor");
    const targetBridge = path.join(targetEditor, "FigmaBridge");
    fs.mkdirSync(targetBridge, { recursive: true });
    const guidIndex = new ProjectMetaGuidIndex(assetsPath);
    copyDirectoryContents(sourceBridge, targetBridge, guidIndex);
    installMetaFile(sourceMeta, path.join(targetEditor, "FigmaBridge.meta"), guidIndex);
    const removed = removeRetiredFiles(targetBridge);
    if (bridgeToken) writeBridgeToken(projectSettingsPath, bridgeToken);

    if (guidIndex.regeneratedGuids.length > 0) {
      operation.step("meta-guid", "已为与工程内既有资产冲突的 .meta 分配新 GUID", {
        files: guidIndex.regeneratedGuids
      });
    }
    if (removed.length > 0) {
      operation.step("retired-files", "已从目标工程移除不再使用的桥文件", { files: removed });
    }
    operation.succeed("Unity Bridge 安装完成", {
      projectName: path.basename(normalizedProjectPath),
      regeneratedGuidCount: guidIndex.regeneratedGuids.length,
      removedCount: removed.length
    });
    return { ok: true, projectPath: normalizedProjectPath, bridgePath: targetBridge };
  } catch (error) {
    operation.fail(error, "Unity Bridge 安装失败");
    throw error;
  }
}

function copyDirectoryContents(source: string, destination: string, guidIndex: ProjectMetaGuidIndex): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destinationPath, { recursive: true });
      copyDirectoryContents(sourcePath, destinationPath, guidIndex);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".meta")) installMetaFile(sourcePath, destinationPath, guidIndex);
      else fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

/**
 * 安装一个 .meta。目标已存在时保留工程里的那份：GUID 是既有资产引用的锚点，
 * Unity 在发现冲突时会自行改 GUID，覆盖回去等于把冲突再引进来。
 */
function installMetaFile(sourcePath: string, destinationPath: string, guidIndex: ProjectMetaGuidIndex): void {
  if (fs.existsSync(destinationPath)) return;
  guidIndex.writeNewMeta(sourcePath, destinationPath);
}

/**
 * 工程 Assets 下已被占用的 .meta GUID 索引。
 * 安装模板里烘焙的 GUID 可能与本工程其它资产重名（例如工程自带的同名运行时脚本），
 * 直接写入会让 Unity 报 "GUID ... conflicts with ... Assigning a new guid"，
 * 进而触发重新导入与域重载。仅在确实要新建 .meta 时才扫描一次。
 */
class ProjectMetaGuidIndex {
  private guids: Set<string> | null = null;

  /** 因冲突而被重新分配的 .meta，供安装日志诊断。 */
  readonly regeneratedGuids: string[] = [];

  constructor(private readonly assetsPath: string) {}

  writeNewMeta(sourcePath: string, destinationPath: string): void {
    const content = fs.readFileSync(sourcePath, "utf8");
    const guid = readMetaGuid(content);
    if (!guid) {
      fs.writeFileSync(destinationPath, content);
      return;
    }
    const occupied = this.occupiedGuids();
    if (!occupied.has(guid)) {
      occupied.add(guid);
      fs.writeFileSync(destinationPath, content);
      return;
    }
    const replacement = this.allocateGuid(occupied);
    fs.writeFileSync(destinationPath, replaceMetaGuid(content, replacement));
    this.regeneratedGuids.push(`${path.basename(destinationPath)}: ${guid} -> ${replacement}`);
  }

  private occupiedGuids(): Set<string> {
    if (this.guids) return this.guids;
    const found = new Set<string>();
    const pending = [this.assetsPath];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (error) {
        throw new Error(`Unable to scan Unity Assets directory ${current}: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".meta")) continue;
        try {
          const guid = readMetaGuid(fs.readFileSync(fullPath, "utf8"));
          if (guid) found.add(guid);
        } catch (error) {
          throw new Error(`Unable to inspect Unity meta file ${fullPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    this.guids = found;
    return found;
  }

  private allocateGuid(occupied: Set<string>): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = randomUUID().replace(/-/g, "");
      if (!occupied.has(candidate)) {
        occupied.add(candidate);
        return candidate;
      }
    }
    throw new Error("unable to allocate a unique Unity asset GUID");
  }
}

function readMetaGuid(content: string): string {
  const match = MetaGuidPattern.exec(content);
  return match ? match[1].toLowerCase() : "";
}

function replaceMetaGuid(content: string, guid: string): string {
  return content.replace(MetaGuidPattern, `guid: ${guid}`);
}

/** 删除模板里已退役、但目标工程可能仍残留的文件；返回实际删除的文件名。 */
function removeRetiredFiles(targetBridge: string): string[] {
  const removed: string[] = [];
  for (const name of RetiredBridgeFiles) {
    const target = path.join(targetBridge, name);
    try {
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { force: true });
      removed.push(name);
    } catch (error) {
      throw new Error(`Unable to remove retired Unity Bridge file ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return removed;
}

function writeBridgeToken(projectSettingsPath: string, bridgeToken: string): void {
  const settingsPath = path.join(projectSettingsPath, "FigmaBridgeImportSettings.json");
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch (error) {
      throw new Error(`FigmaBridgeImportSettings.json is invalid JSON; refusing to overwrite it: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("FigmaBridgeImportSettings.json must contain a JSON object");
    }
    settings = parsed as Record<string, unknown>;
  }
  settings.relayToken = bridgeToken;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function isDirectory(value: string): boolean {
  return fs.statSync(value, { throwIfNoEntry: false })?.isDirectory() === true;
}
