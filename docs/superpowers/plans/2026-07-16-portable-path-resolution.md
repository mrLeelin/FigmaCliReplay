# Portable Path Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove fixed `JellybeanUnity`, `.figma/plugins/figma-mcp-relay`, drive-letter, and user-profile path dependencies from executable workflows and current workflow documentation.

**Architecture:** Python entrypoints derive the Relay root from the bundled client marker and derive Unity projects only from an explicit argument, `FIGMA_UNITY_PROJECT`, or existing Relay registry context. Cross-process Unity asset paths use `Assets/...`; readers accept one generic legacy project prefix without knowing its name. Tests execute real CLIs and scan current workflow surfaces so path coupling cannot return silently.

**Tech Stack:** Python 3, Node.js test runner, TypeScript, Unity Editor C#, PowerShell verification.

---

### Task 1: Lock the portable path contract with failing tests

**Files:**
- Create: `tests/path-portability.test.mjs`
- Modify: `tests/release-portability.test.mjs`

- [ ] **Step 1: Add real CLI startup coverage**

Create a Node test that invokes every affected Python entrypoint with `--help` from the standalone Relay root:

```js
const portableCliScripts = [
  "ai/skills/figma-hierarchy-cleanup-mcp/scripts/figma_hierarchy_cleanup_mcp_client.py",
  "ai/skills/prefab-to-figma/scripts/prefab_to_figma_mcp_client.py",
  "ai/skills/psd-layer-to-figma/scripts/grid_component_creator.py",
  "ai/skills/psd-layer-to-figma/scripts/psd_import_phase_evidence.py",
  "ai/skills/figma-to-prefab/scripts/figma_to_prefab_phase_evidence.py",
  "ai/skills/figma-to-prefab/scripts/run_import_benchmark.py",
  "ai/skills/figma-to-prefab/scripts/verify_spec_contract.py"
];

for (const relativePath of portableCliScripts) {
  const result = spawnSync("python", [path.join(repoRoot, relativePath), "--help"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `${relativePath}: ${result.stderr || result.stdout}`);
}
```

- [ ] **Step 2: Add arbitrary Unity project coverage**

Create a temporary project named `PortableGame` containing `Assets/` and `ProjectSettings/`. Verify explicit `--unity-project` works and overrides a deliberately invalid `FIGMA_UNITY_PROJECT` value.

```js
const unityProject = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-paths-")), "PortableGame");
fs.mkdirSync(path.join(unityProject, "Assets"), { recursive: true });
fs.mkdirSync(path.join(unityProject, "ProjectSettings"));

const result = runPython("run_full_import.py", ["--unity-project", unityProject, "--help"], {
  FIGMA_UNITY_PROJECT: path.join(unityProject, "missing")
});
assert.equal(result.status, 0, result.stderr || result.stdout);
```

- [ ] **Step 3: Add forbidden-path source scans**

Scan executable Python, Unity Bridge C#, current skills, prompts, README, and active references. Assert there are no machine-local absolute paths and no fixed-root discovery expressions.

```js
assert.doesNotMatch(currentWorkflowText, /[A-Za-z]:[\\/](?:Project|Users)[\\/]/);
assert.doesNotMatch(executableText, /["']JellybeanUnity["']/);
assert.doesNotMatch(executableText, /\.figma[\\/]plugins[\\/]figma-mcp-relay/);
```

- [ ] **Step 4: Run the targeted tests and confirm RED**

Run:

```powershell
node --test tests/path-portability.test.mjs tests/release-portability.test.mjs
```

Expected: failures identify the currently broken CLI startup paths and current absolute-path documentation.

---

### Task 2: Make bundled Python MCP clients locate the standalone Relay

**Files:**
- Modify: `ai/skills/figma-hierarchy-cleanup-mcp/scripts/figma_hierarchy_cleanup_mcp_client.py`
- Modify: `ai/skills/prefab-to-figma/scripts/prefab_to_figma_mcp_client.py`
- Modify: `ai/skills/psd-layer-to-figma/scripts/grid_component_creator.py`
- Modify: `ai/skills/psd-layer-to-figma/scripts/psd_import_phase_evidence.py`
- Modify: `ai/skills/figma-to-prefab/scripts/figma_to_prefab_phase_evidence.py`
- Modify: `ai/skills/figma-to-prefab/scripts/run_import_benchmark.py`
- Modify: `ai/skills/figma-to-prefab/scripts/verify_spec_contract.py`

- [ ] **Step 1: Replace repository-name discovery with the Relay marker**

Use this contract in MCP-client entrypoints:

```python
def find_relay_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "client" / "figma_mcp_client.py").is_file():
            return parent
    raise RuntimeError("Unable to locate the Figma MCP Relay root containing client/figma_mcp_client.py.")


RELAY_ROOT = find_relay_root()
MCP_CLIENT_DIR = RELAY_ROOT / "client"
```

Evidence-only scripts use `RELAY_ROOT` for Relay-local `.tmp` artifacts and do not resolve a Unity project unless a Unity artifact is requested.

- [ ] **Step 2: Make benchmark and contract tools accept Unity context explicitly**

Add `--unity-project` and resolve it after argument parsing. Remove module-import-time Unity project discovery.

```python
parser.add_argument("--unity-project", default="", help="Unity project root containing Assets and ProjectSettings")
unity_project = resolve_unity_project(args.unity_project)
```

- [ ] **Step 3: Re-run targeted tests and confirm GREEN for CLI startup**

Run:

```powershell
node --test tests/path-portability.test.mjs
```

Expected: all `--help` startup checks pass; remaining scan failures point only to later tasks.

---

### Task 3: Centralize Unity project resolution and remove fixed-name defaults

**Files:**
- Create: `ai/skills/figma-to-prefab/scripts/unity_project_paths.py`
- Modify: `ai/skills/figma-to-prefab/scripts/run_full_import.py`
- Modify: `ai/skills/figma-to-prefab/scripts/gen_spec.py`
- Modify: `ai/skills/figma-to-prefab/scripts/process_images.py`
- Modify: `ai/skills/figma-to-prefab/scripts/common_texture.py`
- Modify: `ai/skills/figma-to-prefab/scripts/auto_componentset_specs.py`
- Modify: `ai/skills/figma-to-prefab/scripts/crop_jiugong.py`
- Modify: `ai/skills/figma-to-prefab/scripts/verify_prefab.py`
- Modify: `ai/skills/figma-to-prefab/scripts/run_golden_tests.py`
- Modify: `ai/skills/prefab-to-figma/scripts/dump_unity_prefab_truth.py`
- Modify: `ai/skills/prefab-to-figma/scripts/prefab_to_figma.py`

- [ ] **Step 1: Add the shared resolver**

```python
def resolve_unity_project(explicit: str = "", env: Mapping[str, str] | None = None) -> Path:
    values = env or os.environ
    raw = explicit.strip() or values.get("FIGMA_UNITY_PROJECT", "").strip()
    if not raw:
        raise RuntimeError(
            "Unity project is required. Pass --unity-project <path> or set FIGMA_UNITY_PROJECT."
        )
    root = Path(raw).expanduser().resolve()
    missing = [name for name in ("Assets", "ProjectSettings") if not (root / name).is_dir()]
    if missing:
        raise RuntimeError(f"Invalid Unity project {root}: missing {', '.join(missing)}")
    return root
```

Add a generic compatibility normalizer:

```python
def normalize_asset_path(raw: str) -> str:
    value = raw.replace("\\", "/").lstrip("./")
    marker = "/Assets/"
    if value.startswith("Assets/"):
        return value
    if marker in f"/{value}":
        return "Assets/" + value.split(marker, 1)[1]
    raise ValueError(f"Unity asset path must be under Assets/: {raw}")
```

- [ ] **Step 2: Propagate the resolved project instead of reconstructing it**

Replace defaults such as `JellybeanUnity/.tmp/...` with values derived from `unity_project / ".tmp"`. Child commands receive `--unity-project str(unity_project)` or inherit `FIGMA_UNITY_PROJECT` set to the validated absolute path.

- [ ] **Step 3: Remove fixed project-name path candidates**

Prefab-to-Figma readers accept the explicit project root and normalize `Assets/...` directly. They may read a legacy `<any-name>/Assets/...` path through the generic normalizer, but may not append a directory with a fixed name.

- [ ] **Step 4: Run portability and existing import tests**

Run:

```powershell
node --test tests/path-portability.test.mjs tests/run-full-import-portability.test.mjs
```

Expected: temporary `PortableGame` resolution passes and explicit arguments override the environment.

---

### Task 4: Remove project-name coupling from the legacy relay and Unity Bridge

**Files:**
- Modify: `server/crop_jiugong.py`
- Modify: `server/figma_mcp_relay_server.py`
- Modify: `unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs`
- Modify: `unity/Assets/Editor/FigmaBridge/FigmaBridgeWindow.cs`
- Modify: `unity/Assets/Editor/FigmaBridge/PrefabToLksConverter.cs`
- Modify: `unity/Assets/Editor/FigmaBridge/PrefabExport/PrefabToFigmaExporter.cs`
- Modify: `unity/Assets/Editor/FigmaBridge/PrefabExport/PrefabToFigmaImageExporter.cs`
- Modify: `ai/skills/figma-to-prefab/roslyn-templates/import_sprites_and_generate_prefabs.cs`
- Modify: `tests/figma-bridge-project-health.test.mjs`
- Modify: `tests/path-portability.test.mjs`

- [ ] **Step 1: Add failing path-normalization source contracts**

Assert exporters return `Assets/...`, importers accept a generic leading project segment, and no Unity Bridge production source emits the fixed project name.

- [ ] **Step 2: Emit Unity-native asset paths**

Replace project-name prefixing with slash normalization:

```csharp
private static string NormalizeAssetPath(string assetPath)
{
    return assetPath.Replace('\\', '/');
}
```

Normalize legacy input generically:

```csharp
int assetsIndex = normalized.IndexOf("Assets/", StringComparison.OrdinalIgnoreCase);
if (assetsIndex > 0)
{
    normalized = normalized.Substring(assetsIndex);
}
```

- [ ] **Step 3: Pass Unity root into crop operations**

`crop_jiugong_images` accepts a validated project root supplied by request/config context. `resolve_unity_asset_path` joins only against that root. The legacy server's Prefab path normalization emits `Assets/...`.

- [ ] **Step 4: Run Bridge and portability tests**

Run:

```powershell
npm run build
node --test tests/figma-bridge-project-health.test.mjs tests/path-portability.test.mjs
```

Expected: build succeeds and all path-source contracts pass.

---

### Task 5: Make bundled skills and current documentation portable

**Files:**
- Modify: `ai/skills/figma-to-prefab/SKILL.md`
- Modify: `ai/skills/figma-to-prefab/references/figma-to-unity-import.md`
- Modify: `ai/skills/figma-to-prefab/references/json-spec-format.md`
- Modify: `ai/skills/figma-to-prefab/references/workflow-figma-to-unity.md`
- Modify: `ai/skills/prefab-to-figma/SKILL.md`
- Modify: `ai/skills/psd-layer-to-figma/SKILL.md`
- Modify: `ai/skills/psd-layer-to-figma/references/psd-import-hard-lessons.md`
- Modify: `prompts/prefab-to-figma.md`
- Modify: `README.md`

- [ ] **Step 1: Replace current command paths with placeholders**

Use `<relay-root>`, `<unity-project>`, and `Assets/...`. Commands change directory explicitly or quote placeholders:

```powershell
python "<relay-root>\ai\skills\figma-to-prefab\scripts\run_full_import.py" `
  --unity-project "<unity-project>" `
  --target-prefab "Assets/Feature/Panel.prefab"
```

- [ ] **Step 2: Remove local validator paths**

Replace `C:\Users\...\quick_validate.py` examples with the portable Codex skill validation instruction or a repository-local validation command. Remove commands tied to `E:\Project\...`.

- [ ] **Step 3: Run the path scan**

Run:

```powershell
node --test tests/path-portability.test.mjs
```

Expected: no current executable or workflow-document path violations.

---

### Task 6: Full verification and real workflow smoke tests

**Files:**
- Verify only; modify affected files only if a failing check identifies a scoped regression.

- [ ] **Step 1: Compile Python entrypoints**

```powershell
python -m compileall -q ai server client
```

Expected: exit 0.

- [ ] **Step 2: Run complete repository verification**

```powershell
npm run build
node --test tests/*.test.mjs
npm run typecheck
git diff --check
```

Expected: build and typecheck exit 0; all tests pass; diff check has no errors.

- [ ] **Step 3: Re-run the PSD submission smoke test**

Use the existing generated PSD manifest and live Relay target. Confirm submission no longer depends on the repository layout and returns completed validation gates.

- [ ] **Step 4: Run an arbitrary-name Unity project dry-run**

Create a temporary `PortableGame` Unity marker project and run all non-writing `--help` and resolver checks with `--unity-project <temp>/PortableGame`. Confirm no path is rewritten to a fixed project name.

- [ ] **Step 5: Inspect the final diff scope**

```powershell
git status --short
git diff --name-only
git diff -- tests/path-portability.test.mjs ai/skills server unity README.md prompts
```

Expected: only path-portability files are attributable to this task; pre-existing unrelated changes remain preserved and unstaged.
