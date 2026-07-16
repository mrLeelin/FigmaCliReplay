import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const portableCliScripts = [
  "ai/skills/figma-hierarchy-cleanup-mcp/scripts/figma_hierarchy_cleanup_mcp_client.py",
  "ai/skills/prefab-to-figma/scripts/prefab_to_figma_mcp_client.py",
  "ai/skills/psd-layer-to-figma/scripts/grid_component_creator.py",
  "ai/skills/psd-layer-to-figma/scripts/psd_import_phase_evidence.py",
  "ai/skills/figma-to-prefab/scripts/figma_to_prefab_phase_evidence.py",
  "ai/skills/figma-to-prefab/scripts/run_import_benchmark.py",
  "ai/skills/figma-to-prefab/scripts/verify_spec_contract.py"
];

const activeWorkflowFiles = [
  "README.md",
  "prompts/prefab-to-figma.md",
  "ai/skills/figma-to-prefab/SKILL.md",
  "ai/skills/figma-to-prefab/references/figma-to-unity-import.md",
  "ai/skills/figma-to-prefab/references/json-spec-format.md",
  "ai/skills/figma-to-prefab/references/workflow-figma-to-unity.md",
  "ai/skills/prefab-to-figma/SKILL.md",
  "ai/skills/psd-layer-to-figma/SKILL.md",
  "ai/skills/psd-layer-to-figma/references/psd-import-hard-lessons.md"
];

function runPython(relativePath, args = [], env = {}) {
  return spawnSync("python", [path.join(repoRoot, relativePath), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function collectFiles(relativeRoot, extensions) {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  const files = [];
  const pending = [absoluteRoot];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (extensions.has(path.extname(entry.name))) {
        files.push(path.relative(repoRoot, entryPath).replaceAll("\\", "/"));
      }
    }
  }

  return files.sort();
}

function findViolations(relativeFiles, patterns) {
  const violations = [];
  for (const relativePath of relativeFiles) {
    const lines = fs.readFileSync(path.join(repoRoot, relativePath), "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const { label, pattern } of patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          violations.push(`${relativePath}:${index + 1} [${label}] ${line.trim()}`);
          break;
        }
      }
    }
  }
  return violations;
}

for (const relativePath of portableCliScripts) {
  test(`${relativePath} starts from the standalone Relay`, () => {
    const result = runPython(relativePath, ["--help"]);
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  });
}

test("an explicitly named Unity project overrides an invalid environment default", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-paths-"));
  const unityProject = path.join(fixtureRoot, "PortableGame");
  const scriptsDir = path.join(repoRoot, "ai/skills/figma-to-prefab/scripts");

  try {
    fs.mkdirSync(path.join(unityProject, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(unityProject, "ProjectSettings"));

    const probe = [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      "from unity_project_paths import resolve_unity_project",
      `print(resolve_unity_project(${JSON.stringify(unityProject)}))`
    ].join("; ");
    const result = spawnSync("python", ["-c", probe], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FIGMA_UNITY_PROJECT: path.join(fixtureRoot, "MissingProject")
      }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    assert.equal(path.resolve(result.stdout.trim()), path.resolve(unityProject));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("executable workflows do not discover fixed JellybeanUnity or nested .figma roots", () => {
  const executableFiles = [
    ...collectFiles("ai", new Set([".py"])),
    ...collectFiles("server", new Set([".py"])),
    ...collectFiles("unity/Assets/Editor/FigmaBridge", new Set([".cs"]))
  ];
  const violations = findViolations(executableFiles, [
    { label: "fixed project name", pattern: /JellybeanUnity/ },
    {
      label: "fixed Relay root",
      pattern: /\.figma[\\/]plugins[\\/]figma-mcp-relay|["']\.figma["']\s*\/\s*["']plugins["']\s*\/\s*["']figma-mcp-relay["']/
    }
  ]);

  assert.deepEqual(violations, [], `Fixed executable path dependencies:\n${violations.join("\n")}`);
});

test("current workflow documentation contains no machine-local or fixed repository paths", () => {
  const violations = findViolations(activeWorkflowFiles, [
    { label: "machine-local absolute path", pattern: /[A-Za-z]:[\\/](?:Project|Users)[\\/]/ },
    { label: "fixed project name", pattern: /JellybeanUnity/ },
    { label: "fixed Relay root", pattern: /\.figma[\\/]plugins[\\/]figma-mcp-relay/ }
  ]);

  assert.deepEqual(violations, [], `Fixed workflow path dependencies:\n${violations.join("\n")}`);
});
