# PSD to Figma Incremental Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PSD drag/drop update a selected organized Figma `FRAME` or `COMPONENT` by Photoshop Layer ID after a preview-and-confirm dialog, while preserving the existing no-selection initial import.

**Architecture:** Extend the PSD parser to expose Photoshop `lyid`, persist that identity in Figma `SharedPluginData`, and add a pure diff module shared by runtime code and Node tests. The gateway runs either initial import, incremental preview, or confirmed incremental apply against the same task artifacts; the UI captures the selected target, renders the preview dialog, and sends a second explicit apply request.

**Tech Stack:** Python 3 PSD binary parser, Figma Plugin JavaScript, Node.js/TypeScript gateway, HTML/CSS/JavaScript plugin UI, Node test runner, Python `unittest`.

---

## File Structure

- Modify `ai/skills/psd-layer-to-figma/scripts/export_psd_layers.py`: parse PSD `lyid`, emit stable `layerId`, and include image content hashes.
- Create `ai/skills/psd-layer-to-figma/tests/test_export_psd_layer_ids.py`: focused binary-payload and manifest tests for Layer ID behavior.
- Create `code/06_psd_incremental.mjs`: pure diff helpers plus Figma preview/apply functions; exports are stripped by the existing plugin build.
- Modify `scripts/build.py`: include `06_psd_incremental.mjs` in the generated `code.js` order.
- Modify `code/01_handlers.js`: route preview/apply job modes and post deterministic results.
- Modify `code/05_utils.js`: write source metadata during initial import and provide existing PSD image/text update primitives to the new module.
- Modify generated `code.js`: rebuilt artifact only; never hand-edit it.
- Modify `ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py`: pass import mode and prepared task identity to the Figma plugin job.
- Modify `src/psdImportTask.ts`: persist preview artifacts, expose preview summary, and apply an existing preview task without re-uploading the PSD.
- Modify `src/httpServer.ts`: add the confirm/apply endpoint.
- Modify `ui.html`: select initial versus incremental mode, render the confirmation modal, and call apply only after confirmation. This file already contains unrelated staged user changes; preserve them.
- Create `tests/psd-incremental-diff.test.mjs`: pure diff and ownership tests.
- Create `tests/psd-incremental-task.test.mjs`: gateway source-contract tests for preview/apply artifact reuse.
- Create `tests/psd-incremental-ui.test.mjs`: UI routing and confirmation-gate tests, avoiding edits to the already-staged `tests/unity-project-ui.test.mjs`.

### Task 1: Extract stable Photoshop Layer IDs

**Files:**
- Modify: `ai/skills/psd-layer-to-figma/scripts/export_psd_layers.py:2131-2173`
- Modify: `ai/skills/psd-layer-to-figma/scripts/export_psd_layers.py:2275-2305`
- Modify: `ai/skills/psd-layer-to-figma/scripts/export_psd_layers.py:2593-2606`
- Create: `ai/skills/psd-layer-to-figma/tests/test_export_psd_layer_ids.py`

- [ ] **Step 1: Write failing parser tests**

```python
import importlib.util
import struct
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_psd_layers.py"
SPEC = importlib.util.spec_from_file_location("export_psd_layers", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class PsdLayerIdTests(unittest.TestCase):
    def test_reads_big_endian_lyid_payload(self):
        self.assertEqual(MODULE._read_psd_layer_id({"lyid": struct.pack(">I", 205)}), 205)

    def test_rejects_missing_or_zero_layer_id(self):
        self.assertIsNone(MODULE._read_psd_layer_id({}))
        self.assertIsNone(MODULE._read_psd_layer_id({"lyid": struct.pack(">I", 0)}))

    def test_summary_keeps_layer_id(self):
        manifest = {
            "canvas": {"width": 100, "height": 100},
            "layers": [{
                "index": 0, "layerId": 205, "name": "Avatar", "mode": "image",
                "x": 0, "y": 0, "width": 32, "height": 32,
                "opacity": 1, "visible": True, "constraints": {}, "path": "0.png",
                "contentHash": "abc123",
            }],
        }
        summary = MODULE._generate_summary(manifest)
        self.assertEqual(summary["layers"][0]["layerId"], 205)
        self.assertEqual(summary["layers"][0]["contentHash"], "abc123")
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
python -m unittest discover -s ai/skills/psd-layer-to-figma/tests -p "test_export_psd_layer_ids.py" -v
```

Expected: FAIL because `_read_psd_layer_id` and the summary fields do not exist.

- [ ] **Step 3: Add `lyid` parsing and manifest fields**

Add the helper:

```python
def _read_psd_layer_id(tag_payloads: Dict[str, bytes]) -> Optional[int]:
    payload = tag_payloads.get("lyid")
    if payload is None or len(payload) < 4:
        return None
    value = struct.unpack(">I", payload[:4])[0]
    return value if value > 0 else None
```

Keep `lyid` while parsing additional-layer information:

```python
if key in ("TySh", "lfx2", "lfx ", "lyid"):
    tag_payloads[key] = payload
```

Add `layerId` to each parsed layer, calculate the PNG SHA-256 after export, and propagate both fields into `manifest_summary.json`:

```python
"layerId": _read_psd_layer_id(tag_payloads),
```

```python
"contentHash": hashlib.sha256(png_path.read_bytes()).hexdigest(),
```

```python
"layerId": layer.get("layerId"),
"contentHash": layer.get("contentHash", ""),
```

Fail export with a clear message when two visible/exported layers carry the same non-empty Layer ID. Keep a warning, rather than inventing an ID, for legacy PSD layers without `lyid`.

- [ ] **Step 4: Run parser tests**

Run:

```powershell
python -m unittest discover -s ai/skills/psd-layer-to-figma/tests -p "test_export_psd_layer_ids.py" -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the parser slice**

```powershell
git add ai/skills/psd-layer-to-figma/scripts/export_psd_layers.py ai/skills/psd-layer-to-figma/tests/test_export_psd_layer_ids.py
git commit -m "让 PSD 图层身份跨整理保持稳定" -m "Constraint: 增量匹配不能依赖图层顺序`nConfidence: high`nScope-risk: narrow`nTested: python unittest discover for test_export_psd_layer_ids.py"
```

### Task 2: Build a pure incremental diff engine

**Files:**
- Create: `code/06_psd_incremental.mjs`
- Modify: `scripts/build.py:27-35`
- Create: `tests/psd-incremental-diff.test.mjs`

- [ ] **Step 1: Write failing diff tests**

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { buildPsdIncrementalDiff } from "../code/06_psd_incremental.mjs";

test("classifies changed, unchanged, new, and missing layers", () => {
  const current = [
    { layerId: "10", nodeId: "1:10", contentHash: "old-a", name: "Avatar_Image" },
    { layerId: "20", nodeId: "1:20", contentHash: "same", name: "Title" },
    { layerId: "30", nodeId: "1:30", contentHash: "gone", name: "OldBadge" },
  ];
  const incoming = [
    { layerId: "10", contentHash: "new-a", name: "头像", mode: "image" },
    { layerId: "20", contentHash: "same", name: "标题", mode: "text" },
    { layerId: "40", contentHash: "new", name: "NewBadge", mode: "image" },
  ];

  const diff = buildPsdIncrementalDiff(current, incoming);
  assert.deepEqual(diff.summary, { changed: 1, unchanged: 1, added: 1, missing: 1, conflicts: 0 });
  assert.equal(diff.changed[0].target.nodeId, "1:10");
  assert.equal(diff.added[0].source.layerId, "40");
  assert.equal(diff.missing[0].target.layerId, "30");
});

test("duplicate stored layer ids are blocking conflicts", () => {
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "10", nodeId: "a" }, { layerId: "10", nodeId: "b" }],
    [{ layerId: "10", contentHash: "new" }],
  );
  assert.equal(diff.summary.conflicts, 1);
  assert.equal(diff.canApply, false);
});
```

- [ ] **Step 2: Run the diff tests and verify failure**

Run:

```powershell
node --test tests/psd-incremental-diff.test.mjs
```

Expected: FAIL because `code/06_psd_incremental.mjs` does not exist.

- [ ] **Step 3: Implement normalized, deterministic diffing**

Create these exports in `code/06_psd_incremental.mjs`:

```javascript
export function normalizePsdLayerId(value) {
  var text = String(value == null ? "" : value).trim();
  return /^\d+$/.test(text) && text !== "0" ? text : "";
}

export function buildPsdIncrementalDiff(currentNodes, incomingLayers) {
  var currentById = new Map();
  var conflicts = [];
  for (var current of currentNodes || []) {
    var id = normalizePsdLayerId(current.layerId);
    if (!id) continue;
    if (currentById.has(id)) {
      conflicts.push({ kind: "duplicate-target-layer-id", layerId: id });
      continue;
    }
    currentById.set(id, current);
  }

  var incomingById = new Map();
  for (var source of incomingLayers || []) {
    var sourceId = normalizePsdLayerId(source.layerId);
    if (!sourceId) {
      conflicts.push({ kind: "missing-source-layer-id", name: source.name || "" });
      continue;
    }
    if (incomingById.has(sourceId)) {
      conflicts.push({ kind: "duplicate-source-layer-id", layerId: sourceId });
      continue;
    }
    incomingById.set(sourceId, source);
  }

  var changed = [];
  var unchanged = [];
  var added = [];
  var missing = [];
  for (var [id, sourceLayer] of incomingById) {
    var target = currentById.get(id);
    if (!target) added.push({ source: sourceLayer });
    else if (String(target.contentHash || "") === String(sourceLayer.contentHash || "")) unchanged.push({ source: sourceLayer, target: target });
    else changed.push({ source: sourceLayer, target: target });
  }
  for (var [currentId, targetNode] of currentById) {
    if (!incomingById.has(currentId)) missing.push({ target: targetNode });
  }
  return {
    changed, unchanged, added, missing, conflicts,
    canApply: conflicts.length === 0,
    summary: { changed: changed.length, unchanged: unchanged.length, added: added.length, missing: missing.length, conflicts: conflicts.length },
  };
}
```

Append `06_psd_incremental.mjs` to `scripts/build.py` `ORDER`. Do not edit `code.js` manually.

- [ ] **Step 4: Run diff tests and build the plugin artifact**

Run:

```powershell
node --test tests/psd-incremental-diff.test.mjs
python scripts/build.py
```

Expected: tests PASS; build reports `06_psd_incremental.mjs` and regenerates `code.js` without syntax errors.

- [ ] **Step 5: Commit the diff slice**

```powershell
git add code/06_psd_incremental.mjs scripts/build.py code.js tests/psd-incremental-diff.test.mjs
git commit -m "让 PSD 增量差异可以在写入前确定" -m "Constraint: 确认前不得修改 Figma`nConfidence: high`nScope-risk: narrow`nTested: node --test tests/psd-incremental-diff.test.mjs; python scripts/build.py"
```

### Task 3: Persist source metadata and preview/apply in Figma

**Files:**
- Modify: `code/01_handlers.js:188-224`
- Modify: `code/05_utils.js:3565-3631`
- Modify: `code/05_utils.js:4233-4253`
- Modify: `code/06_psd_incremental.mjs`
- Modify generated: `code.js`
- Extend test: `tests/psd-incremental-diff.test.mjs`

- [ ] **Step 1: Add failing source-contract tests**

Extend the Node test to assert the built artifact contains separate handlers and protected ownership fields:

```javascript
import fs from "node:fs";

test("runtime exposes preview and apply without layout ownership", () => {
  const source = fs.readFileSync(new URL("../code/06_psd_incremental.mjs", import.meta.url), "utf8");
  assert.match(source, /previewPsdIncrementalUpdate/);
  assert.match(source, /applyPsdIncrementalUpdate/);
  assert.match(source, /psdLayerId/);
  assert.match(source, /psdContentHash/);
  assert.doesNotMatch(source, /targetNode\.x\s*=/);
  assert.doesNotMatch(source, /targetNode\.name\s*=/);
});
```

- [ ] **Step 2: Verify the contract test fails**

Run:

```powershell
node --test tests/psd-incremental-diff.test.mjs
```

Expected: FAIL because preview/apply runtime functions do not exist.

- [ ] **Step 3: Write metadata on initial import**

Extend normalized manifest layers with `layerId` and `contentHash`. In `writeLayerMetadata`, write only compact source metadata:

```javascript
psdLayerId: String(layer.layerId || ""),
psdOriginalName: String(layer.rawPsdLayerName || layer.name || ""),
psdContentHash: String(layer.contentHash || ""),
psdOwnership: layer.mode === "text" ? "text-content" : "image-content",
```

Write root metadata after `createRootFrame` succeeds:

```javascript
writePluginData(root, {
  psdSourceKey: buildPsdSourceKey(job, manifest),
  psdCanvasWidth: String(manifest.canvas.width || 0),
  psdCanvasHeight: String(manifest.canvas.height || 0),
  psdImportSchemaVersion: "2",
});
```

Do not remove the existing `psdLayerIndex`; retain it for diagnostics and legacy display only.

- [ ] **Step 4: Implement read-only preview**

In `code/06_psd_incremental.mjs`, add:

```javascript
export function previewPsdIncrementalUpdate(job, assets) {
  var target = figma.getNodeById(job && job.targetNodeId || "");
  validatePsdIncrementalTarget(target);
  var current = collectPsdBoundNodes(target);
  var incoming = normalizeManifest(job && job.manifest).layers;
  var diff = buildPsdIncrementalDiff(current, incoming);
  return {
    status: diff.canApply ? "preview-ready" : "preview-blocked",
    mode: "incremental-preview",
    targetNodeId: target.id,
    targetName: target.name,
    targetType: target.type,
    baselineFingerprint: buildPsdTargetFingerprint(target, current),
    summary: diff.summary,
    groups: serializePsdDiffGroups(diff),
    warnings: [],
    errors: diff.conflicts.map(formatPsdIncrementalConflict),
  };
}
```

`collectPsdBoundNodes` recursively reads `psdLayerId`, `psdContentHash`, `psdOwnership`, node type, and node ID. It must not mutate the document.

- [ ] **Step 5: Implement confirmed apply**

Add `applyPsdIncrementalUpdate(job, assets)` that recomputes the diff, compares `job.baselineFingerprint`, rejects stale or conflicting targets, pre-decodes all changed images, then:

- replaces fills for `image-content` nodes without changing name, parent, sibling index, geometry, constraints, effects, component identity, or visibility;
- replaces only `characters` for `text-content` nodes after loading the current font;
- creates new source nodes under one direct child `__PSD新增待整理` container;
- retains missing target nodes unchanged;
- updates `psdOriginalName` and `psdContentHash` only after the corresponding mutation succeeds;
- calls `figma.commitUndo()` once after the complete apply when available.

Use an explicit result:

```javascript
return {
  status: "completed",
  mode: "incremental-apply",
  targetNodeId: target.id,
  summary: diff.summary,
  appliedLayerIds: appliedLayerIds,
  retainedMissingLayerIds: diff.missing.map(function (item) { return item.target.layerId; }),
  warnings: warnings,
  errors: [],
};
```

- [ ] **Step 6: Route modes in the existing handler**

Change `handleImportPsdJob` to select exactly one path:

```javascript
var mode = String(message.job && message.job.mode || "initial");
var result;
if (mode === "incremental-preview") {
  result = previewPsdIncrementalUpdate(message.job, message.assets || []);
} else if (mode === "incremental-apply") {
  result = await applyPsdIncrementalUpdate(message.job, message.assets || []);
} else {
  result = await importPsdJob(message.job, message.assets || []);
}
```

- [ ] **Step 7: Run tests and rebuild**

Run:

```powershell
node --test tests/psd-incremental-diff.test.mjs
python scripts/build.py
```

Expected: tests PASS; `code.js` contains both incremental mode handlers.

- [ ] **Step 8: Commit the Figma runtime slice**

```powershell
git add code/01_handlers.js code/05_utils.js code/06_psd_incremental.mjs code.js tests/psd-incremental-diff.test.mjs
git commit -m "让整理后的 Figma 只接收 PSD 所有的变化" -m "Constraint: 保留命名、层级、布局与组件结构`nRejected: 重新导入整棵 PSD 树 | 会覆盖整理结果`nConfidence: medium`nScope-risk: moderate`nTested: node --test tests/psd-incremental-diff.test.mjs; python scripts/build.py"
```

### Task 4: Add gateway preview and confirm/apply lifecycle

**Files:**
- Modify: `ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py`
- Modify: `src/psdImportTask.ts`
- Modify: `src/httpServer.ts:433-440`
- Create: `tests/psd-incremental-task.test.mjs`

- [ ] **Step 1: Write failing gateway contract tests**

```javascript
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const taskSource = fs.readFileSync(new URL("../src/psdImportTask.ts", import.meta.url), "utf8");
const httpSource = fs.readFileSync(new URL("../src/httpServer.ts", import.meta.url), "utf8");
const submitSource = fs.readFileSync(new URL("../ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py", import.meta.url), "utf8");

test("PSD task supports preview followed by apply using the same artifacts", () => {
  assert.match(taskSource, /mode: PsdImportMode/);
  assert.match(taskSource, /applyPsdImportTask/);
  assert.match(taskSource, /baselineFingerprint/);
  assert.match(taskSource, /readResultSummary/);
  assert.match(httpSource, /\/psd-to-figma\/import\/[^/]+\/apply/);
  assert.match(submitSource, /--import-mode/);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
node --test tests/psd-incremental-task.test.mjs
```

Expected: FAIL because the lifecycle fields and apply endpoint do not exist.

- [ ] **Step 3: Extend task state and submit arguments**

Define:

```typescript
type PsdImportMode = "initial" | "incremental-preview" | "incremental-apply";
type PsdImportTaskStatus = "queued" | "running" | "preview-ready" | "completed" | "error";
```

Add task fields:

```typescript
mode: PsdImportMode;
baselineFingerprint?: string;
preview?: unknown;
```

The initial POST chooses `incremental-preview` only when its validated target contains one `FRAME` or `COMPONENT`; otherwise it uses `initial`. Pass `--import-mode` and, for apply, `--baseline-fingerprint` through `submit_psd_import_job.py` into the plugin job.

After the submit script exits, parse `task.resultPath`:

```typescript
function readResultSummary(resultPath: string): unknown {
  const parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  return isRecord(parsed) && "result" in parsed ? parsed.result : parsed;
}
```

When preview returns `preview-ready`, retain the task artifacts and expose `task.preview` without marking the update applied.

- [ ] **Step 4: Add explicit apply of an existing preview task**

Export:

```typescript
export function applyPsdImportTask(config: GatewayConfig, taskId: string, payload: unknown): PsdImportTask {
  const task = tasks.get(taskId);
  if (!task || task.status !== "preview-ready") throw new Error("PSD incremental preview is not ready");
  if (!isRecord(payload) || stringValue(payload.baselineFingerprint) !== task.baselineFingerprint) {
    throw new Error("PSD incremental preview fingerprint does not match");
  }
  task.mode = "incremental-apply";
  task.status = "queued";
  void runPsdImportTask(config, task, { reuseExportArtifacts: true });
  return serializePsdImportTask(task);
}
```

`reuseExportArtifacts: true` skips PSD export and reuses the task's existing manifest and image files. The Figma runtime still recomputes and validates the target diff before mutation.

- [ ] **Step 5: Add the HTTP endpoint**

Handle:

```typescript
if (/^\/psd-to-figma\/import\/[^/]+\/apply$/.test(pathname)) {
  const taskId = pathname.split("/")[3];
  try {
    jsonResponse(response, 200, { ok: true, task: applyPsdImportTask(config, taskId, payload) });
  } catch (error) {
    jsonResponse(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return;
}
```

- [ ] **Step 6: Run gateway tests and typecheck**

Run:

```powershell
node --test tests/psd-incremental-task.test.mjs
npm run typecheck
```

Expected: tests PASS and TypeScript reports no errors.

- [ ] **Step 7: Commit the gateway slice**

```powershell
git add ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py src/psdImportTask.ts src/httpServer.ts tests/psd-incremental-task.test.mjs
git commit -m "让 PSD 更新必须经过预览任务确认" -m "Constraint: 确认应用必须复用同一份已解析 PSD 产物`nConfidence: high`nScope-risk: moderate`nTested: node --test tests/psd-incremental-task.test.mjs; npm run typecheck"
```

### Task 5: Add selection routing and confirmation dialog

**Files:**
- Modify: `ui.html:314-380`
- Modify: `ui.html:706-710`
- Modify: `ui.html:1322-1334`
- Modify: `ui.html:2239-2360`
- Modify: `ui.html:2401-2434`
- Create: `tests/psd-incremental-ui.test.mjs`

- [ ] **Step 1: Write failing UI contract tests**

```javascript
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

test("single FRAME or COMPONENT routes PSD drop to incremental preview", () => {
  assert.match(ui, /function resolvePsdDropMode/);
  assert.match(ui, /node\.type === "FRAME" \|\| node\.type === "COMPONENT"/);
  assert.match(ui, /mode: dropMode\.mode/);
});

test("incremental apply is gated by an explicit modal confirmation", () => {
  assert.match(ui, /id="psdIncrementalDialog"/);
  assert.match(ui, /确认增量更新/);
  assert.match(ui, /function showPsdIncrementalPreview/);
  assert.match(ui, /function confirmPsdIncrementalUpdate/);
  assert.match(ui, /\/apply/);
  assert.match(ui, /取消/);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
node --test tests/psd-incremental-ui.test.mjs
```

Expected: FAIL because the mode resolver and modal do not exist.

- [ ] **Step 3: Add the modal markup and state**

Add an accessible in-panel dialog containing PSD filename, captured target name/type, five counts, expandable affected-layer groups, cancel, and confirm buttons:

```html
<div class="modal-backdrop" id="psdIncrementalDialog" hidden>
  <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="psdIncrementalDialogTitle">
    <h2 id="psdIncrementalDialogTitle">确认 PSD 增量更新</h2>
    <div id="psdIncrementalDialogSummary" class="status-box"></div>
    <details><summary>查看受影响图层</summary><div id="psdIncrementalDialogDetails"></div></details>
    <div class="button-row">
      <button class="secondary" id="cancelPsdIncrementalBtn">取消</button>
      <button id="confirmPsdIncrementalBtn">确认增量更新</button>
    </div>
  </section>
</div>
```

Store only the active gateway task ID, baseline fingerprint, and captured target summary in UI memory. Do not store another hierarchy snapshot.

- [ ] **Step 4: Route selection deterministically**

Add:

```javascript
function resolvePsdDropMode(selection) {
  var nodes = Array.isArray(selection && selection.nodes) ? selection.nodes : [];
  if (nodes.length === 0) return { mode: "initial", targetNodeId: "" };
  if (nodes.length !== 1) throw new Error("PSD 增量更新只能选择一个 FRAME 或 COMPONENT");
  var node = nodes[0] || {};
  if (node.type !== "FRAME" && node.type !== "COMPONENT") {
    throw new Error("PSD 增量更新目标必须是 FRAME 或 COMPONENT");
  }
  return { mode: "incremental-preview", targetNodeId: String(node.id || ""), targetName: node.name || "", targetType: node.type };
}
```

Replace `buildPsdImportTarget` with a payload that carries `mode`, `fileKey`, and the captured target. Batch drop remains allowed only for initial mode; if a target is selected and multiple PSD files are dropped, reject before uploading.

- [ ] **Step 5: Render preview and confirm apply**

When polling reaches `preview-ready`, stop the busy progress state and call `showPsdIncrementalPreview(task.preview)`. Disable confirm when conflicts are non-zero.

Confirm POSTs:

```javascript
await fetchWithTimeout(relayEndpoint("/psd-to-figma/import/" + encodeURIComponent(taskId) + "/apply"), {
  method: "POST",
  headers: relayRuntimeHeaders({ "Content-Type": "application/json" }),
  body: JSON.stringify({ baselineFingerprint: activePsdIncrementalPreview.baselineFingerprint }),
}, 30000);
```

Cancel clears the active preview state and closes the dialog without calling `/apply`.

- [ ] **Step 6: Run UI tests**

Run:

```powershell
node --test tests/psd-incremental-ui.test.mjs tests/figma-ui-initialization.test.mjs
```

Expected: all tests PASS; existing window-level PSD drop remains registered.

- [ ] **Step 7: Commit only the incremental UI files**

Before committing, inspect the already-staged `ui.html` diff and preserve it. Do not include or modify `tests/unity-project-ui.test.mjs`.

```powershell
git add ui.html tests/psd-incremental-ui.test.mjs
git commit --only ui.html tests/psd-incremental-ui.test.mjs -m "让选中的 Figma 目标先预览再接收 PSD 更新" -m "Constraint: FRAME 与 COMPONENT 都触发增量模式`nConfidence: medium`nScope-risk: moderate`nDirective: 取消和冲突状态不得调用 apply 端点`nTested: node --test tests/psd-incremental-ui.test.mjs tests/figma-ui-initialization.test.mjs"
```

### Task 6: Full verification and live plugin smoke test

**Files:**
- Verify: all changed files
- Do not modify: `tests/unity-project-ui.test.mjs` unless its pre-existing owner requests it

- [ ] **Step 1: Run all focused automated tests**

```powershell
python -m unittest discover -s ai/skills/psd-layer-to-figma/tests -p "test_export_psd_layer_ids.py" -v
node --test tests/psd-incremental-diff.test.mjs tests/psd-incremental-task.test.mjs tests/psd-incremental-ui.test.mjs tests/figma-ui-initialization.test.mjs
npm run typecheck
```

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 2: Rebuild and verify generated artifacts**

```powershell
python scripts/build.py
git diff --check
```

Expected: `code.js` rebuild succeeds; no whitespace errors. Reopen `ui.html`, `code/01_handlers.js`, `code/05_utils.js`, and `code/06_psd_incremental.mjs` and verify Chinese text contains no `???`, `\uXXXX`, or new mojibake.

- [ ] **Step 3: Run the broader Node regression suite**

```powershell
node --test tests/*.test.mjs
```

Expected: all repository Node tests pass. If an unrelated pre-existing staged test fails, record the exact failure and prove the focused incremental suite remains green.

- [ ] **Step 4: Package the active plugin build**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package_release.ps1
```

Expected: release packaging succeeds and includes the rebuilt `code.js`, updated `ui.html`, PSD scripts, and gateway build.

- [ ] **Step 5: Perform a real Figma smoke test**

Use a disposable PSD fixture with two raster layers:

1. Clear Figma selection and drag the PSD into the plugin; verify a new root is created.
2. Rename the root, move one imported image under a new group, and convert the root between `FRAME`/`COMPONENT` as appropriate.
3. Edit pixels on the same Photoshop layer without deleting it.
4. Select the organized root and drag the updated PSD.
5. Verify the dialog reports one changed layer and no mutation occurs before confirmation.
6. Cancel once and verify the image remains unchanged.
7. Repeat, confirm, and verify only the matched image content changes.
8. Verify names, parents, sibling order, geometry, and component structure match the pre-apply snapshot.
9. Add a new PSD layer and remove an old one; verify the new node enters `__PSD新增待整理` and the missing Figma node is retained.

- [ ] **Step 6: Commit final verification fixes if needed**

If verification required a narrow code correction, commit only those files with the exact tests rerun. If no correction was needed, do not create an empty commit.

```powershell
git status --short
git log -6 --oneline
```

Expected: only pre-existing unrelated user changes remain; the incremental feature commits are present and the working tree contains no uncommitted feature files.
