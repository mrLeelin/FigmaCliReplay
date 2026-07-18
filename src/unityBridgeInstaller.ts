import fs from "node:fs";
import path from "node:path";

import { PLUGIN_ROOT } from "./config.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import { normalizeUnityProjectPath } from "./unityProjectRegistry.js";

const logger = getLoggingRuntime().logger("unity-bridge-installer");

export interface UnityBridgeInstallResult {
  ok: true;
  projectPath: string;
  bridgePath: string;
}

export function installUnityBridge(
  projectPath: string,
  sourceEditorPath = path.join(PLUGIN_ROOT, "unity", "Assets", "Editor")
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
    copyDirectoryContents(sourceBridge, targetBridge);
    fs.copyFileSync(sourceMeta, path.join(targetEditor, "FigmaBridge.meta"));
    operation.succeed("Unity Bridge 安装完成", { projectName: path.basename(normalizedProjectPath) });
    return { ok: true, projectPath: normalizedProjectPath, bridgePath: targetBridge };
  } catch (error) {
    operation.fail(error, "Unity Bridge 安装失败");
    throw error;
  }
}

function copyDirectoryContents(source: string, destination: string): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destinationPath, { recursive: true });
      copyDirectoryContents(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function isDirectory(value: string): boolean {
  return fs.statSync(value, { throwIfNoEntry: false })?.isDirectory() === true;
}
