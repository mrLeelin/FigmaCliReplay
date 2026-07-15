import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./config.js";
import { isRecord } from "./utils.js";

interface DroppedPrefabFile {
  fileName: string;
  text?: string;
}

interface ResolvedPrefab {
  fileName: string;
  prefabPath: string;
}

interface PrefabConflict {
  fileName: string;
  candidates: string[];
}

interface MissingPrefab {
  fileName: string;
  reason: string;
}

export interface DroppedPrefabResolveResult {
  ok: boolean;
  prefabPaths: string[];
  resolved: ResolvedPrefab[];
  conflicts: PrefabConflict[];
  missing: MissingPrefab[];
  searchedRoots: string[];
}

export function resolveDroppedPrefabs(payload: unknown): DroppedPrefabResolveResult {
  const files = readDroppedPrefabFiles(payload);
  if (files.length === 0) {
    throw new Error("files must contain at least one .prefab file");
  }

  const searchedRoots = prefabSearchRoots();
  const allPrefabs = listPrefabFiles(searchedRoots);
  const resolved: ResolvedPrefab[] = [];
  const conflicts: PrefabConflict[] = [];
  const missing: MissingPrefab[] = [];

  for (const file of files) {
    const matches = findMatchesForDroppedFile(file, allPrefabs);
    if (matches.length === 1) {
      resolved.push({ fileName: file.fileName, prefabPath: matches[0] });
    } else if (matches.length > 1) {
      conflicts.push({ fileName: file.fileName, candidates: matches });
    } else {
      missing.push({ fileName: file.fileName, reason: "no matching prefab under Assets" });
    }
  }

  const prefabPaths = uniqueStrings(resolved.map((item) => item.prefabPath));
  return {
    ok: conflicts.length === 0 && missing.length === 0 && prefabPaths.length === files.length,
    prefabPaths,
    resolved,
    conflicts,
    missing,
    searchedRoots: searchedRoots.map((root) => toRepoPath(root))
  };
}

function readDroppedPrefabFiles(payload: unknown): DroppedPrefabFile[] {
  if (!isRecord(payload) || !Array.isArray(payload.files)) {
    return [];
  }
  const result: DroppedPrefabFile[] = [];
  for (const item of payload.files) {
    if (!isRecord(item)) continue;
    const fileName = safeBaseName(String(item.fileName || item.name || ""));
    if (!/\.prefab$/i.test(fileName)) continue;
    const text = typeof item.text === "string" ? item.text.slice(0, 2_000_000) : undefined;
    result.push({ fileName, text });
  }
  return result;
}

function prefabSearchRoots(): string[] {
  return [
    path.join(REPO_ROOT, "JellybeanUnity", "Assets"),
    path.join(REPO_ROOT, "Assets")
  ].filter((root) => fs.existsSync(root) && fs.statSync(root).isDirectory());
}

function listPrefabFiles(roots: string[]): string[] {
  const result: string[] = [];
  const ignored = new Set(["Library", "Temp", "Obj", "Build", "Builds", "Logs", "UserSettings"]);
  for (const root of roots) {
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!ignored.has(entry.name)) {
            stack.push(fullPath);
          }
          continue;
        }
        if (entry.isFile() && /\.prefab$/i.test(entry.name)) {
          result.push(toRepoPath(fullPath));
        }
      }
    }
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function findMatchesForDroppedFile(file: DroppedPrefabFile, allPrefabs: string[]): string[] {
  const targetName = file.fileName.toLowerCase();
  const byName = allPrefabs.filter((prefabPath) => path.posix.basename(prefabPath).toLowerCase() === targetName);
  if (byName.length <= 1 || !file.text) {
    return byName;
  }

  const droppedGuid = extractPrefabRootGuid(file.text);
  if (!droppedGuid) {
    return byName;
  }
  const byGuid = byName.filter((prefabPath) => {
    try {
      return fs.readFileSync(path.join(REPO_ROOT, prefabPath), "utf8").includes(droppedGuid);
    } catch {
      return false;
    }
  });
  return byGuid.length > 0 ? byGuid : byName;
}

function extractPrefabRootGuid(text: string): string {
  const match = text.match(/\bguid:\s*([a-f0-9]{32})\b/i);
  return match ? match[1] : "";
}

function toRepoPath(fullPath: string): string {
  return path.relative(REPO_ROOT, fullPath).replace(/\\/g, "/");
}

function safeBaseName(value: string): string {
  return path.basename(value.replace(/\\/g, "/"));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}
