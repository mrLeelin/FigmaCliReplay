import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.slice(1));
const scriptsDir = path.join(repoRoot, "ai", "skills", "figma-to-prefab", "scripts");

function runProbe(lines, env = {}) {
  return spawnSync("python", ["-c", lines.join("; ")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env, PYTHONUTF8: "1" }
  });
}

test("normalizes Unity asset paths without knowing the project name", () => {
  const probe = runProbe([
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    "from unity_project_paths import normalize_asset_path",
    "print(normalize_asset_path(r'PortableGame\\Assets\\UI\\Panel.prefab'))"
  ]);

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.equal(probe.stdout.trim(), "Assets/UI/Panel.prefab");
});

test("reports every missing Unity project marker clearly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-invalid-unity-"));
  try {
    const probe = runProbe([
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      "from unity_project_paths import resolve_unity_project",
      `resolve_unity_project(${JSON.stringify(root)}, env={})`
    ]);
    assert.notEqual(probe.status, 0);
    assert.match(probe.stderr, /missing Assets, ProjectSettings/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
