import fs from "node:fs";
import path from "node:path";

import { PLUGIN_ROOT } from "./config.js";
import { normalizeUnityProjectPath } from "./unityProjectRegistry.js";

export interface UnityBridgeInstallResult {
  ok: true;
  projectPath: string;
  bridgePath: string;
}

export function installUnityBridge(
  projectPath: string,
  sourceEditorPath = path.join(PLUGIN_ROOT, "unity", "Assets", "Editor")
): UnityBridgeInstallResult {
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
  return { ok: true, projectPath: normalizedProjectPath, bridgePath: targetBridge };
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
