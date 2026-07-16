import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonTimeoutMs = 15_000;

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
  "ui.html",
  "client/figma_mcp_client.py",
  "prompts/prefab-to-figma.md",
  "ai/skills/figma-to-prefab/SKILL.md",
  "ai/skills/figma-to-prefab/scripts/run_full_import.py",
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
    timeout: pythonTimeoutMs,
    env: {
      ...process.env,
      ...env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    }
  });
}

function formatSpawnFailure(result) {
  return [
    result.stderr,
    result.stdout,
    `error: ${result.error?.stack || result.error?.message || result.error || "<none>"}`,
    `signal: ${result.signal || "<none>"}`
  ]
    .filter(Boolean)
    .join("\n");
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

function extractNamedFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} should exist`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === "async " ? functionStart - 6 : functionStart;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} should have a complete body`);
}

for (const relativePath of portableCliScripts) {
  test(`${relativePath} starts from the standalone Relay`, () => {
    const result = runPython(relativePath, ["--help"]);
    assert.equal(result.status, 0, formatSpawnFailure(result));
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
      timeout: pythonTimeoutMs,
      env: {
        ...process.env,
        FIGMA_UNITY_PROJECT: path.join(fixtureRoot, "MissingProject"),
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      }
    });

    assert.equal(result.status, 0, formatSpawnFailure(result));
    assert.equal(path.resolve(result.stdout.trim()), path.resolve(unityProject));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("legacy relay normalizes one generic project prefix to Assets paths", () => {
  const probe = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, "server"))})`,
    "from figma_mcp_relay_server import normalize_prefab_import_paths",
    "print(json.dumps(normalize_prefab_import_paths(['Assets/UI/A.prefab', 'PortableGame/Assets/UI/B.prefab', '../Assets/UI/C.prefab', 'C:/Game/Assets/UI/D.prefab'])))"
  ].join("; ");
  const result = spawnSync("python", ["-c", probe], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: pythonTimeoutMs,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
  });

  assert.equal(result.status, 0, formatSpawnFailure(result));
  assert.deepEqual(JSON.parse(result.stdout), ["Assets/UI/A.prefab", "Assets/UI/B.prefab"]);
});

test("legacy crop resolves Assets only inside an explicitly supplied Unity project", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-crop-"));
  const unityProject = path.join(fixtureRoot, "PortableGame");
  const assetPath = path.join(unityProject, "Assets", "UI", "image.png");

  try {
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.mkdirSync(path.join(unityProject, "ProjectSettings"));
    fs.writeFileSync(assetPath, "fixture");
    const probe = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, "server"))})`,
      "from crop_jiugong import resolve_export_target_dir, resolve_unity_project_root, resolve_unity_asset_path",
      `root = resolve_unity_project_root({'unityProjectPath': ${JSON.stringify(unityProject)}})`,
      "valid = resolve_unity_asset_path('Assets/UI/image.png', root)",
      "invalid = resolve_unity_asset_path('../Assets/UI/image.png', root)",
      "invalid_target = resolve_export_target_dir('ProjectSettings', root)",
      "print(json.dumps({'root': str(root), 'valid': str(valid), 'invalid': invalid is None, 'invalidTarget': invalid_target is None}))"
    ].join("; ");
    const result = spawnSync("python", ["-c", probe], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: pythonTimeoutMs,
      env: { ...process.env, FIGMA_UNITY_PROJECT: path.join(fixtureRoot, "Missing"), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
    });

    assert.equal(result.status, 0, formatSpawnFailure(result));
    const resolved = JSON.parse(result.stdout);
    assert.equal(path.resolve(resolved.root), path.resolve(unityProject));
    assert.equal(path.resolve(resolved.valid), path.resolve(assetPath));
    assert.equal(resolved.invalid, true);
    assert.equal(resolved.invalidTarget, true);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Unity Bridge emits Assets paths and accepts one generic legacy project prefix", () => {
  const bridgeFiles = [
    "unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs",
    "unity/Assets/Editor/FigmaBridge/FigmaBridgeWindow.cs",
    "unity/Assets/Editor/FigmaBridge/PrefabToLksConverter.cs",
    "unity/Assets/Editor/FigmaBridge/PrefabExport/PrefabToFigmaExporter.cs",
    "unity/Assets/Editor/FigmaBridge/PrefabExport/PrefabToFigmaImageExporter.cs",
    "ai/skills/figma-to-prefab/roslyn-templates/import_sprites_and_generate_prefabs.cs"
  ];
  const sources = Object.fromEntries(
    bridgeFiles.map((relativePath) => [relativePath, fs.readFileSync(path.join(repoRoot, relativePath), "utf8")])
  );

  assert.match(sources[bridgeFiles[0]], /firstSlash[\s\S]*Assets\//);
  assert.match(sources[bridgeFiles[2]], /firstSlash[\s\S]*Assets\//);
  assert.doesNotMatch(sources[bridgeFiles[3]], /return\s+[^;]*\+\s*prefabPath/);
  assert.doesNotMatch(sources[bridgeFiles[4]], /return\s+[^;]*\+\s*assetPath/);
  for (const [relativePath, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /JellybeanUnity/, relativePath);
  }
});

test("executable workflows do not discover fixed JellybeanUnity or nested .figma roots", () => {
  const executableFiles = [
    "ui.html",
    "client/figma_mcp_client.py",
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

test("UI derives quoted executable paths from Relay health and injects the full import script path", async () => {
  const ui = fs.readFileSync(path.join(repoRoot, "ui.html"), "utf8");
  const cacheKeySource = extractNamedFunction(ui, "relayPluginRootCacheKey");
  const readCacheSource = extractNamedFunction(ui, "readCachedRelayRuntimePaths");
  const loadSource = extractNamedFunction(ui, "loadRelayRuntimePaths");
  const normalizerSource = extractNamedFunction(ui, "normalizeRelayPluginRoot");
  const quoteSource = extractNamedFunction(ui, "quoteWindowsCommandPath");
  const resolverSource = extractNamedFunction(ui, "resolveRelayRuntimePaths");
  const normalizeRelayPluginRoot = Function(`${normalizerSource}; return normalizeRelayPluginRoot;`)();
  const quoteWindowsCommandPath = Function(`${quoteSource}; return quoteWindowsCommandPath;`)();
  const resolveRelayRuntimePaths = Function(
    "normalizeRelayPluginRoot",
    "quoteWindowsCommandPath",
    `${resolverSource}; return resolveRelayRuntimePaths;`
  )(normalizeRelayPluginRoot, quoteWindowsCommandPath);
  const relayPluginRootCacheKey = Function(`${cacheKeySource}; return relayPluginRootCacheKey;`)();
  const readCachedRelayRuntimePaths = Function(
    "resolveRelayRuntimePaths",
    `${readCacheSource}; return readCachedRelayRuntimePaths;`
  )(resolveRelayRuntimePaths);
  const loadRelayRuntimePaths = Function(
    "resolveRelayRuntimePaths",
    "readCachedRelayRuntimePaths",
    `${loadSource}; return loadRelayRuntimePaths;`
  )(resolveRelayRuntimePaths, readCachedRelayRuntimePaths);
  const resolved = resolveRelayRuntimePaths({ gateway: { pluginRoot: "C:\\Portable Relay\\Folder\\..\\" } });

  assert.equal(resolved.pluginRoot, "C:/Portable Relay");
  assert.equal(resolved.mcpStartBatPath, '"C:/Portable Relay/启动MCP.bat"');
  assert.equal(
    resolved.fullImportScriptPath,
    '"C:/Portable Relay/ai/skills/figma-to-prefab/scripts/run_full_import.py"'
  );
  const templatesStart = ui.indexOf("const AiPromptTemplates = {");
  const templatesEnd = ui.indexOf("// END_AI_PROMPT_TEMPLATES", templatesStart);
  const templatesSource = ui.slice(templatesStart, ui.lastIndexOf(";", templatesEnd) + 1);
  const templates = Function(`${templatesSource}; return AiPromptTemplates;`)();
  const readTemplate = Function(
    "AiPromptTemplates",
    `${extractNamedFunction(ui, "readAiPromptTemplate")}; return readAiPromptTemplate;`
  )(templates);
  const renderTemplate = Function(
    "readAiPromptTemplate",
    `${extractNamedFunction(ui, "renderAiPromptTemplate")}; return renderAiPromptTemplate;`
  )(readTemplate);
  const rendered = renderTemplate("unity", { relayFullImportScriptPath: resolved.fullImportScriptPath });

  assert.match(rendered, /\/health[\s\S]*gateway\.pluginRoot/);
  assert.match(rendered, /python "C:\/Portable Relay\/ai\/skills\/figma-to-prefab\/scripts\/run_full_import\.py"/);
  assert.doesNotMatch(rendered, /python "ai\/skills\/figma-to-prefab\/scripts\/run_full_import\.py"/);
  assert.doesNotMatch(rendered, /\{\{relayFullImportScriptPath\}\}/);
  assert.match(ui, /if \(aiPromptTemplateSelect\.value === "unity"\)[\s\S]*?await refreshRelayRuntimePaths\(\)/);
  assert.match(ui, /relayFullImportScriptPath:\s*relayRuntimePaths\.fullImportScriptPath/);
  assert.match(ui, /python \{\{relayFullImportScriptPath\}\}/);
  assert.doesNotMatch(ui, /const mcpStartBatPath = "<relay-root>/);

  const unc = resolveRelayRuntimePaths({ gateway: { pluginRoot: "\\\\server\\share\\Relay Root\\" } });
  assert.equal(unc.pluginRoot, "//server/share/Relay Root");
  assert.equal(unc.mcpStartBatPath, '"//server/share/Relay Root/启动MCP.bat"');
  assert.equal(resolveRelayRuntimePaths({ gateway: { pluginRoot: "/opt/relay/../figma-relay/" } }).pluginRoot, "/opt/figma-relay");
  assert.equal(resolveRelayRuntimePaths({ gateway: { pluginRoot: "C:\\" } }).mcpStartBatPath, '"C:/启动MCP.bat"');
  assert.equal(resolveRelayRuntimePaths({ gateway: { pluginRoot: "/" } }).mcpStartBatPath, '"/启动MCP.bat"');

  for (const unsafeRoot of [
    "relative/path",
    "C:/bad&root",
    "C:/bad|root",
    "C:/bad;root",
    "C:/bad$root",
    "C:/bad%root",
    "C:/bad`root",
    'C:/bad"root',
    "C:/bad'root",
    "C:/bad\nroot"
  ]) {
    assert.throws(() => resolveRelayRuntimePaths({ gateway: { pluginRoot: unsafeRoot } }), /pluginRoot/);
  }

  const values = new Map();
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
  const firstKey = relayPluginRootCacheKey("http://localhost:32130");
  const secondKey = relayPluginRootCacheKey("http://localhost:42130");
  assert.notEqual(firstKey, secondKey);
  const healthy = await loadRelayRuntimePaths(
    async () => ({ ok: true, status: 200, json: async () => ({ gateway: { pluginRoot: "D:\\Relay Root\\" } }) }),
    storage,
    firstKey
  );
  assert.equal(healthy.source, "health");
  assert.equal(values.get(firstKey), "D:/Relay Root");

  const cachedAfterFailure = await loadRelayRuntimePaths(
    async () => ({ ok: false, status: 503, json: async () => ({}) }),
    storage,
    firstKey
  );
  assert.equal(cachedAfterFailure.source, "cache");
  assert.equal(cachedAfterFailure.paths.mcpStartBatPath, '"D:/Relay Root/启动MCP.bat"');

  const cachedAfterNonJson = await loadRelayRuntimePaths(
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } }),
    storage,
    firstKey
  );
  assert.equal(cachedAfterNonJson.source, "cache");

  values.set(secondKey, "C:/unsafe&cached");
  assert.equal(readCachedRelayRuntimePaths(storage, secondKey).pluginRoot, "");
  assert.equal(values.has(secondKey), false);
  assert.equal(readCachedRelayRuntimePaths(storage, firstKey).pluginRoot, "D:/Relay Root");
  assert.match(ui, /async function refreshRelayRuntimePaths\(\)[\s\S]*?syncRelayUrlInput\(\)/);
  assert.match(ui, /previousRelayUrl !== relayUrl[\s\S]*?readCachedRelayRuntimePaths/);

  const unsafeStorage = { getItem() { return null; }, setItem() { throw new Error("unsafe root must not persist"); }, removeItem() {} };
  await assert.rejects(
    loadRelayRuntimePaths(
      async () => ({ ok: true, status: 200, json: async () => ({ gateway: { pluginRoot: "C:/bad&root" } }) }),
      unsafeStorage,
      firstKey
    ),
    /pluginRoot/
  );

  const runRelayOpenFolderRequest = Function(
    `${extractNamedFunction(ui, "runRelayOpenFolderRequest")}; return runRelayOpenFolderRequest;`
  )();
  let resolveHealth;
  const deferredHealth = new Promise((resolve) => { resolveHealth = resolve; });
  const requestContext = { relayUrl: "http://relay-a:32130", generation: 1 };
  let currentContext = requestContext;
  let publishedRoot = "B-safe";
  const persistedRoots = [];
  const requestedUrls = [];
  const request = runRelayOpenFolderRequest(
    requestContext,
    async (url) => {
      requestedUrls.push(url);
      if (url.endsWith("/health")) return deferredHealth;
      return { ok: true, status: 200, json: async () => ({ ok: true, path: "unused" }) };
    },
    () => currentContext === requestContext,
    (payload) => {
      publishedRoot = payload.gateway.pluginRoot;
      persistedRoots.push(payload.gateway.pluginRoot);
    }
  );
  currentContext = { relayUrl: "http://relay-b:32130", generation: 2 };
  resolveHealth({ ok: true, status: 200, json: async () => ({ gateway: { pluginRoot: "C:/RelayA" } }) });
  const staleResult = await request;
  assert.equal(staleResult.stale, true);
  assert.equal(publishedRoot, "B-safe");
  assert.deepEqual(persistedRoots, []);
  assert.deepEqual(requestedUrls, ["http://relay-a:32130/health"]);
  assert.match(ui, /refreshRelayRuntimePaths[\s\S]*?requestRelayUrl[\s\S]*?requestGeneration[\s\S]*?stale/);
});
