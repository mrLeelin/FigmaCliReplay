import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireLock, parseSignedManifest, writeJsonAtomic } from "../scripts/update_common.mjs";
import { DATA_ROOT, INSTALL_ROOT, PLUGIN_ROOT, SERVER_VERSION } from "./config.js";
import { UnityProjectRegistry } from "./unityProjectRegistry.js";
import { installUnityBridge } from "./unityBridgeInstaller.js";
import { callUnityBridge } from "./unityBridgeClient.js";
import { unityProjectKey, unitySessionStatus } from "./unitySessionRegistry.js";
import { isRecord } from "./utils.js";

export interface BridgeUpdateOptions {
  installRoot?: string;
  dataRoot?: string;
  projectRoot?: string;
  currentVersion?: string;
  bridgeToken?: string;
  registry?: Pick<UnityProjectRegistry, "list">;
  install?: (projectPath: string, sourceEditorPath: string, token: string) => unknown;
  probe?: (projectPath: string, version: string) => Promise<boolean>;
  timeoutMs?: number;
  pollMs?: number;
  settleTimeoutMs?: number;
}

const targets = ["Assets/Editor/FigmaBridge", "Assets/Editor/FigmaBridge.meta", "ProjectSettings/FigmaBridgeImportSettings.json"] as const;
const inProgress = new Set<string>();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function read(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(value)) throw new Error("Expected a JSON object: " + path.basename(file));
    return value;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
}

/** All destructive operations are restricted to these three fixed project targets. */
function targetPath(project: string, relative: string): string {
  if (!(targets as readonly string[]).includes(relative)) throw new Error("Unexpected Bridge backup target.");
  const target = path.resolve(project, relative);
  const contained = path.relative(project, target);
  if (!contained || contained.startsWith("..") || path.isAbsolute(contained)) throw new Error("Bridge target escaped the Unity project.");
  let candidate = project;
  for (const segment of contained.split(path.sep)) {
    candidate = path.join(candidate, segment);
    if (exists(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error("Bridge targets must not contain symbolic links or junctions.");
  }
  return target;
}

function assertTreeIsOrdinary(file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error("Bridge backup contains a symbolic link or junction.");
  if (stat.isDirectory()) for (const entry of fs.readdirSync(file)) assertTreeIsOrdinary(path.join(file, entry));
  else if (!stat.isFile()) throw new Error("Bridge backup contains an unsupported file type.");
}

function copyOrdinaryTree(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error("Bridge backup contains a symbolic link or junction.");
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) copyOrdinaryTree(path.join(source, entry), path.join(destination, entry));
  } else if (stat.isFile()) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  else throw new Error("Bridge backup contains an unsupported file type.");
}

function removeOrdinaryTree(file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error("Bridge targets must not contain symbolic links or junctions.");
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(file)) removeOrdinaryTree(path.join(file, entry));
    fs.rmdirSync(file);
  } else if (stat.isFile()) fs.unlinkSync(file);
  else throw new Error("Bridge target contains an unsupported file type.");
}

function prepareBackup(project: string, backup: string): void {
  if (exists(backup)) throw new Error("An existing Bridge backup requires recovery before another installation.");
  fs.mkdirSync(backup, { recursive: true });
  const entries = targets.map((relative) => {
    const source = targetPath(project, relative);
    const present = exists(source);
    if (present) {
      assertTreeIsOrdinary(source);
      const destination = path.join(backup, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      copyOrdinaryTree(source, destination);
    }
    return { relative, existed: present };
  });
  writeJsonAtomic(path.join(backup, "backup.json"), { schemaVersion: 1, projectPath: project, entries });
}

function restoreBackup(project: string, backup: string): void {
  const manifest = read(path.join(backup, "backup.json"));
  if (manifest?.schemaVersion !== 1 || manifest.projectPath !== project || !Array.isArray(manifest.entries)
    || manifest.entries.length !== targets.length) throw new Error("Bridge backup is incomplete; manual recovery is required.");
  // Validate the full backup before deleting even the first current target.
  for (let index = 0; index < targets.length; index++) {
    const entry = manifest.entries[index];
    if (!isRecord(entry) || entry.relative !== targets[index] || typeof entry.existed !== "boolean") throw new Error("Invalid Bridge backup manifest.");
    targetPath(project, targets[index]);
    if (entry.existed) assertTreeIsOrdinary(path.join(backup, targets[index]));
  }
  for (const entry of manifest.entries) {
    const target = targetPath(project, entry.relative);
    if (exists(target)) {
      assertTreeIsOrdinary(target);
      removeOrdinaryTree(target);
    }
    if (entry.existed) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      copyOrdinaryTree(path.join(backup, entry.relative), target);
    }
  }
}

async function probeUnity(project: string, version: string): Promise<boolean> {
  if (!unitySessionStatus().some((session) => unityProjectKey(session.projectPath) === unityProjectKey(project) && session.clientVersion === version)) return false;
  const result = await callUnityBridge(project, "unity.health", {}, { timeoutMs: 3000 });
  return result.connected === true && result.version === version && result.isCompiling === false;
}

/** Resume only the current signed update's explicitly selected Unity project. */
export async function resumeRequestedBridgeUpdate(options: BridgeUpdateOptions = {}): Promise<void> {
  const installRoot = options.installRoot ?? INSTALL_ROOT;
  if (!installRoot) return;
  const dataRoot = options.dataRoot ?? DATA_ROOT;
  const directory = path.join(dataRoot, "updates");
  const statusFile = path.join(directory, "status.json");
  const plan = read(path.join(directory, "plan.json"));
  if (!plan || typeof plan.updateBridgeProjectId !== "string" || typeof plan.updateBridgeProjectPath !== "string") return;
  if (typeof plan.planId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(plan.planId)) return;
  if (inProgress.has(directory)) return;
  inProgress.add(directory);
  let release: (() => void) | undefined;
  const projectId = plan.updateBridgeProjectId;
  const writeBridge = (phase: string, message: string) => {
    const status = read(statusFile);
    if (!status || status.planId !== plan.planId || status.phase !== "restart-required") return;
    writeJsonAtomic(statusFile, { ...status, bridge: { projectId, phase, message }, updatedAt: new Date().toISOString() });
  };
  try {
    const version = options.currentVersion ?? SERVER_VERSION;
    const record = read(path.join(installRoot, "install.json"));
    if (plan.schemaVersion !== 1 || path.resolve(String(plan.installRoot || "")) !== path.resolve(installRoot)
      || record?.schemaVersion !== 1 || record.currentVersion !== version || typeof record.publicKey !== "string") return;
    const manifest = parseSignedManifest(plan.envelope, record.publicKey);
    if (manifest.version !== version) return;
    const settleDeadline = Date.now() + (options.settleTimeoutMs ?? 30_000);
    let status = read(statusFile);
    while (status?.planId === plan.planId && status?.phase === "installing" && Date.now() < settleDeadline) {
      await sleep(options.pollMs ?? 500);
      status = read(statusFile);
    }
    if (status?.planId !== plan.planId || status.phase !== "restart-required") return;
    release = acquireLock(path.join(directory, "bridge.lock"));
    status = read(statusFile);
    const previous = isRecord(status?.bridge) ? status.bridge : undefined;
    if (previous?.projectId !== projectId || ["completed", "failed", "rolled-back", "recovery-required", "rejected"].includes(String(previous?.phase))) return;
    const registry = options.registry ?? new UnityProjectRegistry(path.join(dataRoot, ".local", "projects.json"));
    const projects = registry.list();
    const registered = projects.projects.find((project) => project.id === projectId);
    if (!registered?.valid || projects.lastSelectedProjectId !== projectId
      || unityProjectKey(registered.path) !== unityProjectKey(plan.updateBridgeProjectPath)) {
      writeBridge("rejected", "当前 Unity 工程已变化，未更新 Bridge。请在设置中为需要的工程手动更新。");
      return;
    }
    const project = fs.realpathSync(registered.path);
    const backup = path.join(directory, "bridge-backups", plan.planId);
    if (previous?.phase === "installing") {
      try {
        restoreBackup(project, backup);
        writeBridge("rolled-back", "上次 Bridge 安装中断，已恢复工程原文件。请在设置中重新更新 Bridge。");
      } catch (error) { writeBridge("recovery-required", "Bridge 恢复失败，请保留备份并手动恢复：" + errorText(error)); }
      return;
    }
    if (!["waiting-for-unity", "pending-reconnect"].includes(String(previous?.phase))) {
      try {
        prepareBackup(project, backup);
        writeBridge("installing", "正在更新当前 Unity 工程的 Bridge，已备份原文件。");
        const token = options.bridgeToken ?? process.env.FIGMA_RELAY_BRIDGE_TOKEN ?? process.env.FIGMA_RELAY_TOKEN
          ?? fs.readFileSync(path.join(dataRoot, ".local", "admin-token.txt"), "utf8").trim();
        (options.install ?? installUnityBridge)(project, path.join(options.projectRoot ?? PLUGIN_ROOT, "unity", "Assets", "Editor"), token);
        writeBridge("waiting-for-unity", "Bridge 文件已更新，等待 Unity 编译完成并重新连接。");
      } catch (error) {
        if (exists(path.join(backup, "backup.json"))) {
          try { restoreBackup(project, backup); writeBridge("rolled-back", "Bridge 更新失败，已恢复工程原文件：" + errorText(error)); }
          catch (restoreError) { writeBridge("recovery-required", "Bridge 更新及恢复失败，请保留备份并手动恢复：" + errorText(restoreError)); }
        } else writeBridge("failed", "Bridge 更新准备失败，工程未改动：" + errorText(error));
        return;
      }
    }
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    do {
      try {
        if (await (options.probe ?? probeUnity)(project, version)) {
          writeBridge("completed", "当前工程 Bridge 已更新，Unity 已以新版本重新连接并通过健康检查。");
          return;
        }
      } catch { /* Compilation and domain reload temporarily disconnect the Bridge. */ }
      if (Date.now() >= deadline) break;
      await sleep(options.pollMs ?? 1000);
    } while (true);
    writeBridge("pending-reconnect", "Bridge 文件已更新；请打开 Unity，等待编译完成后重新连接。目前尚未验证编译及连接。");
  } catch (error) {
    writeBridge("failed", "无法完成当前工程 Bridge 更新：" + errorText(error));
  } finally {
    release?.();
    inProgress.delete(directory);
  }
}
