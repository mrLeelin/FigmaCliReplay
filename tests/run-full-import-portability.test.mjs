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

  const mcpClient = runPython("figma_to_prefab_mcp_client.py", ["--help"], env);
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
