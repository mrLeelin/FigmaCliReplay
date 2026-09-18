import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.slice(1));
const scriptsRoot = path.join(repoRoot, "ai", "skills", "figma-to-prefab", "scripts");

function createUnityProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-unity-"));
  fs.mkdirSync(path.join(projectRoot, "Assets"));
  fs.mkdirSync(path.join(projectRoot, "ProjectSettings"));
  return projectRoot;
}

function runPython(script, args, env = {}) {
  return spawnSync("python", [path.join(scriptsRoot, script), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
}

test("run_full_import accepts an explicit Unity project from the standalone relay", () => {
  const unityProject = createUnityProject();
  const result = runPython("run_full_import.py", ["--unity-project", unityProject, "--help"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--unity-project/);
});

test("import child scripts honor the propagated Unity project root", () => {
  const unityProject = createUnityProject();
  const env = { FIGMA_UNITY_PROJECT: unityProject };

  for (const script of ["gen_spec.py", "process_images.py", "verify_prefab.py"]) {
    const result = runPython(script, ["--help"], env);
    assert.equal(result.status, 0, `${script}: ${result.stderr || result.stdout}`);
  }

  const mcpClient = runPython("figma_to_prefab_cli.py", ["--help"], env);
  assert.equal(mcpClient.status, 0, mcpClient.stderr || mcpClient.stdout);
});

test("run_full_import passes absolute Unity temp artifacts to gen_spec", () => {
  const source = fs.readFileSync(path.join(scriptsRoot, "run_full_import.py"), "utf8");

  for (const option of [
    "--output-spec",
    "--output-plan",
    "--output-audit-report",
    "--output-roslyn-import-plan",
    "--component-spec-dir",
    "--componentset-report"
  ]) {
    assert.match(source, new RegExp(`"${option}"`));
  }
});

test("formal imports split generated assets into Prefab Texture and UiAtlas folders", () => {
  const source = fs.readFileSync(path.join(scriptsRoot, "run_full_import.py"), "utf8");

  assert.match(source, /--formal-layout/);
  assert.match(source, /f"\{base_dir\}Prefab\/\{prefab_name\}\.prefab"/);
  assert.match(source, /f"\{base_dir\}Texture\/"/);
  assert.match(source, /f"\{base_dir\}UiAtlas\/"/);
  assert.match(source, /mkdir\(parents=True, exist_ok=True\)/);
});

test("derive_formal_paths returns the split Unity asset paths", () => {
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(scriptsRoot.replaceAll("\\", "/"))})`,
    "import run_full_import as module",
    "print(json.dumps(module.derive_formal_paths('Assets/Feature', 'Reward Popup', 'split')))"
  ].join("; ");
  const result = spawnSync("python", ["-c", script], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), [
    "UI_RewardPopup",
    "Assets/Feature/Prefab/UI_RewardPopup.prefab",
    "Assets/Feature/Texture/",
    "Assets/Feature/UiAtlas/"
  ]);
});

test("formal path validation accepts the canonical trailing slash on Texture and UiAtlas directories", () => {
  const script = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scriptsRoot.replaceAll("\\", "/"))})`,
    "import run_full_import as module",
    "module.validate_formal_import_paths('Assets/Feature/Prefab/UI.prefab', 'Assets/Feature/Texture/', 'UI')",
    "print('ok')"
  ].join("; ");
  const result = spawnSync("python", ["-c", script], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "ok");
});

test("gen_spec accepts the canonical trailing slash on the formal Texture directory", () => {
  const script = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scriptsRoot.replaceAll("\\", "/"))})`,
    "import gen_spec as module",
    "print(module.canonicalize_writer_paths('Assets/Feature/Prefab/UI.prefab', 'Assets/Feature/Texture/'))"
  ].join("; ");
  const result = spawnSync("python", ["-c", script], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Assets\/Feature\/Texture\//);
});

test("direct import delegates Unity-side generation to the Bridge instead of uLoop", () => {
  const source = fs.readFileSync(path.join(scriptsRoot, "run_full_import.py"), "utf8");

  assert.match(source, /run_unity_bridge_import/);
  assert.match(source, /figma-to-prefab-import/);
  assert.doesNotMatch(source, /def run_uloop_import/);
  assert.doesNotMatch(source, /resolve_uloop_command/);
  assert.match(source, /image_dir = value\.strip\(\)\.replace\([\s\S]*?rstrip\("\/"\)/);
});
