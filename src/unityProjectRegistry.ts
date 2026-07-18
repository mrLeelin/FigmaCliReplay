import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { LOCAL_DIR } from "./config.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import type { RelayLogger } from "./logging/relayLogger.js";

export interface UnityProjectRecord {
  id: string;
  name: string;
  path: string;
  lastSeenAt: string;
}

export interface UnityProjectStatus extends UnityProjectRecord {
  valid: boolean;
  bridgeInstalled: boolean;
  settingsConfigured: boolean;
}

interface UnityProjectRegistryData {
  schemaVersion: 1;
  projects: UnityProjectRecord[];
  lastSelectedProjectId: string;
}

export class UnityProjectRegistry {
  private readonly logger: RelayLogger;

  constructor(private readonly registryPath = path.join(LOCAL_DIR, "projects.json")) {
    this.logger = getLoggingRuntime().logger("unity-project-registry");
  }

  list(): { projects: UnityProjectStatus[]; lastSelectedProjectId: string } {
    const operation = this.logger.startOperation("unity-project.read", "开始读取 Unity 项目注册表");
    try {
      operation.step("read", "正在读取 Unity 项目注册表");
      const data = this.read();
      const result = {
        projects: data.projects.map(projectStatus),
        lastSelectedProjectId: data.lastSelectedProjectId
      };
      operation.succeed("Unity 项目注册表读取完成", { projectCount: result.projects.length });
      return result;
    } catch (error) {
      operation.fail(error, "Unity 项目注册表读取失败");
      throw error;
    }
  }

  add(projectPath: string): UnityProjectStatus {
    const operation = this.logger.startOperation("unity-project.write", "开始添加 Unity 项目");
    try {
      const normalizedPath = normalizeUnityProjectPath(projectPath);
      assertUnityProject(normalizedPath);
      const data = this.read();
      const key = pathKey(normalizedPath);
      let record = data.projects.find((item) => pathKey(item.path) === key);
      if (record) {
        record.path = normalizedPath;
        record.name = path.basename(normalizedPath);
        record.lastSeenAt = new Date().toISOString();
      } else {
        record = {
          id: projectId(normalizedPath),
          name: path.basename(normalizedPath),
          path: normalizedPath,
          lastSeenAt: new Date().toISOString()
        };
        data.projects.push(record);
      }
      operation.step("write", "正在写入 Unity 项目注册表", { projectId: record.id, name: record.name });
      if (!data.lastSelectedProjectId) data.lastSelectedProjectId = record.id;
      this.write(data);
      const result = projectStatus(record);
      operation.succeed("Unity 项目添加完成", { projectId: record.id, valid: result.valid });
      return result;
    } catch (error) {
      operation.fail(error, "Unity 项目添加失败");
      throw error;
    }
  }

  remove(projectIdToRemove: string): void {
    const operation = this.logger.startOperation("unity-project.delete", "开始移除 Unity 项目", {
      operationId: `unity-project:${projectIdToRemove}`,
      data: { projectId: projectIdToRemove }
    });
    operation.step("delete", "正在移除 Unity 项目", { projectId: projectIdToRemove });
    try {
      const data = this.read();
      data.projects = data.projects.filter((item) => item.id !== projectIdToRemove);
      if (data.lastSelectedProjectId === projectIdToRemove) {
        data.lastSelectedProjectId = data.projects[0]?.id || "";
      }
      this.write(data);
      operation.succeed("Unity 项目移除完成", { projectId: projectIdToRemove });
    } catch (error) {
      operation.fail(error, "Unity 项目移除失败", { projectId: projectIdToRemove });
      throw error;
    }
  }

  select(projectIdToSelect: string): UnityProjectStatus {
    const operation = this.logger.startOperation("unity-project.connect", "开始选择 Unity 项目", {
      operationId: `unity-project:${projectIdToSelect}`,
      data: { projectId: projectIdToSelect }
    });
    operation.step("connect", "正在验证并选择 Unity 项目", { projectId: projectIdToSelect });
    try {
      const data = this.read();
      const record = data.projects.find((item) => item.id === projectIdToSelect);
      if (!record) throw new Error(`unknown Unity project: ${projectIdToSelect}`);
      assertUnityProject(record.path);
      record.lastSeenAt = new Date().toISOString();
      data.lastSelectedProjectId = record.id;
      this.write(data);
      const result = projectStatus(record);
      operation.succeed("Unity 项目选择完成", { projectId: record.id, valid: result.valid });
      return result;
    } catch (error) {
      operation.fail(error, "Unity 项目选择失败", { projectId: projectIdToSelect });
      throw error;
    }
  }

  snapshot(projectIdToUse?: string): UnityProjectStatus {
    const data = this.read();
    const selectedId = projectIdToUse || data.lastSelectedProjectId;
    const record = data.projects.find((item) => item.id === selectedId);
    if (!record) {
      if (selectedId) throw new Error(`unknown Unity project: ${selectedId}`);
      throw new Error("no Unity project selected");
    }
    assertUnityProject(record.path);
    return projectStatus(record);
  }

  private read(): UnityProjectRegistryData {
    if (!fs.existsSync(this.registryPath)) return emptyRegistry();
    const parsed = JSON.parse(fs.readFileSync(this.registryPath, "utf8")) as Partial<UnityProjectRegistryData>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects)) {
      throw new Error(`invalid Unity project registry: ${this.registryPath}`);
    }
    return {
      schemaVersion: 1,
      projects: parsed.projects.filter(isProjectRecord),
      lastSelectedProjectId: typeof parsed.lastSelectedProjectId === "string" ? parsed.lastSelectedProjectId : ""
    };
  }

  private write(data: UnityProjectRegistryData): void {
    fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
    const temporaryPath = `${this.registryPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, this.registryPath);
  }
}

export function normalizeUnityProjectPath(projectPath: string): string {
  if (!projectPath || typeof projectPath !== "string") throw new Error("Unity project path is required");
  return path.resolve(projectPath.trim());
}

function assertUnityProject(projectPath: string): void {
  if (!fs.statSync(projectPath, { throwIfNoEntry: false })?.isDirectory()
    || !fs.statSync(path.join(projectPath, "Assets"), { throwIfNoEntry: false })?.isDirectory()
    || !fs.statSync(path.join(projectPath, "ProjectSettings"), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Unity project must contain Assets and ProjectSettings: ${projectPath}`);
  }
}

function projectStatus(record: UnityProjectRecord): UnityProjectStatus {
  const valid = isDirectory(record.path)
    && isDirectory(path.join(record.path, "Assets"))
    && isDirectory(path.join(record.path, "ProjectSettings"));
  return {
    ...record,
    valid,
    bridgeInstalled: valid && isDirectory(path.join(record.path, "Assets", "Editor", "FigmaBridge")),
    settingsConfigured: valid && fs.existsSync(path.join(record.path, "ProjectSettings", "FigmaBridgeImportSettings.json"))
  };
}

function projectId(projectPath: string): string {
  return createHash("sha256").update(pathKey(projectPath)).digest("hex").slice(0, 16);
}

function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isDirectory(value: string): boolean {
  return fs.statSync(value, { throwIfNoEntry: false })?.isDirectory() === true;
}

function isProjectRecord(value: unknown): value is UnityProjectRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.name === "string"
    && typeof record.path === "string"
    && typeof record.lastSeenAt === "string";
}

function emptyRegistry(): UnityProjectRegistryData {
  return { schemaVersion: 1, projects: [], lastSelectedProjectId: "" };
}
