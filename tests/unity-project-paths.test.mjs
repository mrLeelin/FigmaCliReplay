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

for (const invalidPath of [
  "../Assets/UI/Panel.prefab",
  "Assets/../Secrets.txt",
  "C:/Game/Assets/UI/Panel.prefab",
  "/Game/Assets/UI/Panel.prefab",
  "Parent/PortableGame/Assets/UI/Panel.prefab",
  "./Assets/UI/Panel.prefab"
]) {
  test(`rejects unsafe Unity asset path: ${invalidPath}`, () => {
    const probe = runProbe([
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      "from unity_project_paths import normalize_asset_path",
      `normalize_asset_path(${JSON.stringify(invalidPath)})`
    ]);
    assert.notEqual(probe.status, 0);
    assert.match(probe.stderr, /Unity asset path/);
  });
}

test("an invalid explicit Unity project does not fall back to a valid environment project", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "relay-explicit-project-"));
  const validProject = path.join(fixture, "ValidGame");
  fs.mkdirSync(path.join(validProject, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(validProject, "ProjectSettings"));
  try {
    const probe = runProbe([
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      "from unity_project_paths import resolve_unity_project",
      `resolve_unity_project(${JSON.stringify(path.join(fixture, "MissingGame"))})`
    ], { FIGMA_UNITY_PROJECT: validProject });
    assert.notEqual(probe.status, 0);
    assert.match(probe.stderr, /MissingGame/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("common texture caches are isolated under each Unity project", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "relay-texture-cache-"));
  const projects = ["GameA", "GameB"].map((name, index) => {
    const root = path.join(fixture, name);
    fs.mkdirSync(path.join(root, "Assets", "_Art", "Texture", "GUI", "_Common"), { recursive: true });
    fs.mkdirSync(path.join(root, "ProjectSettings"));
    fs.writeFileSync(path.join(root, "Assets", "_Art", "Texture", "GUI", "_Common", `Texture${index}.png`), "");
    return root;
  });
  try {
    for (const project of projects) {
      const result = spawnSync("python", [path.join(scriptsDir, "common_texture.py"), "--unity-project", project, "--rebuild"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PYTHONUTF8: "1" }
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.ok(fs.existsSync(path.join(project, ".tmp", "common_texture_index.json")));
    }
    assert.notEqual(
      fs.readFileSync(path.join(projects[0], ".tmp", "common_texture_index.json"), "utf8"),
      fs.readFileSync(path.join(projects[1], ".tmp", "common_texture_index.json"), "utf8")
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("process_images rejects absolute output directories outside Unity Assets", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "relay-output-boundary-"));
  const project = path.join(fixture, "Game");
  fs.mkdirSync(path.join(project, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(project, "ProjectSettings"));
  try {
    const probe = runProbe([
      "import sys",
      "from pathlib import Path",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      "import process_images",
      `process_images.UNITY_PROJECT_ROOT = Path(${JSON.stringify(project)})`,
      `process_images.resolve_output_dir(${JSON.stringify(path.join(fixture, "Outside"))})`
    ]);
    assert.notEqual(probe.status, 0);
    assert.match(probe.stderr, /must remain under Unity Assets/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
