import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.slice(1));
const scriptsDir = path.join(repoRoot, "ai", "skills", "figma-to-prefab", "scripts");
const prefabScriptsDir = path.join(repoRoot, "ai", "skills", "prefab-to-figma", "scripts");
const analyzeReader = path.join(repoRoot, "ai", "skills", "figma-hierarchy-cleanup-mcp", "scripts", "figma_analyze_reader.py");

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

for (const [moduleName, moduleDir] of [
  ["gen_spec", scriptsDir],
  ["run_full_import", scriptsDir]
]) {
  test(`${moduleName} canonicalizes Assets and legacy project-prefixed writer paths`, () => {
    for (const prefix of ["", "PortableGame/"]) {
      const probe = runProbe([
        "import sys",
        `sys.path.insert(0, ${JSON.stringify(moduleDir)})`,
        `from ${moduleName} import canonicalize_writer_paths`,
        `print('|'.join(canonicalize_writer_paths('${prefix}Assets/UI/Panel.prefab', '${prefix}Assets/UI/Images')))`
      ]);

      assert.equal(probe.status, 0, probe.stderr || probe.stdout);
      assert.equal(probe.stdout.trim(), "Assets/UI/Panel.prefab|Assets/UI/Images/");
    }
  });
}

test("golden tests reject an invalid configured Unity project", () => {
  const probe = runProbe([
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(prefabScriptsDir)})`,
    "from run_golden_tests import configured_unity_project",
    "configured_unity_project()"
  ], { FIGMA_UNITY_PROJECT: path.join(os.tmpdir(), "missing-unity-project") });

  assert.notEqual(probe.status, 0);
  assert.match(probe.stderr, /Invalid Unity project/);
});

test("analyze reader has standalone Relay help without nested install paths", () => {
  const source = fs.readFileSync(analyzeReader, "utf8");
  assert.doesNotMatch(source, /\.figma[\\/]plugins[\\/]figma-mcp-relay/);
  const result = spawnSync("python", [analyzeReader, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PYTHONUTF8: "1" }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
