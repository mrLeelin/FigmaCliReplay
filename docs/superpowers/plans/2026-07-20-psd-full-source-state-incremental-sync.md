# PSD Full Source-State Incremental Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every supported PSD-derived field participate in preview, confirmed incremental apply, rollback, and verification while preserving organized Figma identity and hierarchy.

**Architecture:** The PSD exporter emits a canonical schema-v3 `sourceState` for every layer. A pure JavaScript module performs field-level source-state diffing and geometry math; the Figma runtime merges only changed PSD-owned fields onto live organized nodes, stores the last applied source state in `SharedPluginData`, and treats structure as an invariant. The gateway and UI expose ready, blocked, no-change, and baseline-required previews plus a distinct metadata-only baseline-adoption action.

**Tech Stack:** Python 3 PSD parser and `unittest`, Figma Plugin JavaScript, Node.js 22 test runner, TypeScript gateway, HTML/CSS/JavaScript plugin UI, PowerShell verification commands.

---

## Scope and File Structure

This is one end-to-end feature rather than several independent products: each slice feeds the same PSD-to-Figma transaction and is not useful without the others.

- Modify `ai/skills/psd-layer-to-figma/scripts/export_psd_layers.py`: normalize every safely representable PSD field into schema-v3 `sourceState`, including reliable text rotation and explicit unsupported-field records.
- Modify `ai/skills/psd-layer-to-figma/scripts/summarize_manifest.py`: preserve schema-v3 source state for callers that use the standalone summary path.
- Create `ai/skills/psd-layer-to-figma/tests/test_export_psd_source_state.py`: parser/source-state regression tests.
- Modify `code/06_psd_incremental.mjs`: canonical state normalization, stable hashing, field-level diff groups, preview status selection, and pure transform/geometry calculations.
- Modify `tests/psd-incremental-diff.test.mjs`: source-state, no-change, unsupported-change, baseline, and geometry tests.
- Modify `code/05_utils.js`: normalize incoming states, persist schema-v3 metadata, collect live baselines, adopt legacy baselines, build fingerprints, apply/rollback/verify every PSD-owned field, and preserve structural invariants.
- Modify `code/01_handlers.js`: route `incremental-baseline-adopt` in addition to preview/apply/initial import.
- Create `tests/psd-incremental-runtime.test.mjs`: runtime source-contract tests for metadata, structural protection, complete rollback, and no fake apply.
- Modify `ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py`: accept all preview terminal statuses and baseline adoption.
- Modify `ai/skills/psd-layer-to-figma/tests/test_submit_psd_incremental_status.py`: terminal-status regression tests.
- Modify `src/psdImportTask.ts`: model the four preview states and start a metadata-only baseline-adoption task.
- Modify `src/httpServer.ts`: add the baseline-adoption endpoint.
- Modify `tests/psd-incremental-task.test.mjs`: gateway lifecycle contract tests.
- Modify `ui.html`: render field categories and before/after rows, disable no-op confirmation, and expose a separate baseline-adoption action.
- Modify `tests/psd-incremental-ui.test.mjs`: UI state and action-gate tests.
- Regenerate `.build_version` and `code.js` with `python scripts/build.py`; never hand-edit `code.js`.
- Verify against `docs/superpowers/specs/2026-07-20-psd-full-source-state-incremental-sync-design.md` and the retained Layer ID `406` manifests under `.tmp/psd-to-figma/`.

Specification coverage is intentionally one-to-one: Task 1 covers manifest normalization and unsupported parser data; Task 2 covers canonical diff, category summaries, and root/parent transform math; Task 3 covers schema-v3 metadata and legacy adoption; Task 4 covers ownership, structural safety, fingerprinting, transaction, rollback, and verification; Tasks 5-6 cover gateway/UI states; Tasks 7-8 cover automated and live success criteria.

### Task 1: Emit complete schema-v3 PSD source state

**Files:**
- Modify: `ai/skills/psd-layer-to-figma/scripts/export_psd_layers.py:652-675,886-939,2251-2398,2626-2721`
- Modify: `ai/skills/psd-layer-to-figma/scripts/summarize_manifest.py:27-129`
- Create: `ai/skills/psd-layer-to-figma/tests/test_export_psd_source_state.py`

- [ ] **Step 1: Write failing source-state tests**

```python
import importlib.util
import math
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_psd_layers.py"
SPEC = importlib.util.spec_from_file_location("export_psd_layers", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PsdSourceStateTests(unittest.TestCase):
    def test_source_state_contains_geometry_display_text_and_content(self):
        layer = {
            "layerId": 406,
            "x": 580,
            "y": 1514,
            "width": 363,
            "height": 140,
            "opacity": 128,
            "visible": False,
            "blend": "mul ",
        }
        text = {
            "characters": "Play",
            "fontFamily": "Arial",
            "effectiveFontSize": 36,
            "leading": 42,
            "lineHeightMode": "PIXELS",
            "textAlignHorizontal": "CENTER",
            "fillColor": {"r": 1, "g": 0.5, "b": 0.25, "a": 1},
            "textTransform": {"rotation": 15},
            "effects": {"stroke": None, "dropShadow": None},
            "figma": {"fontFallbackCandidates": [{"family": "Arial", "style": "Regular"}]},
        }

        state = MODULE._build_psd_source_state(
            layer=layer,
            mode="text",
            content_hash="hash-406",
            constraints={"horizontal": "CENTER", "vertical": "MAX"},
            text_info=text,
            nine_slice_info=None,
        )

        self.assertEqual(state["version"], 3)
        self.assertEqual(state["layerId"], "406")
        self.assertEqual(state["geometry"], {
            "x": 580.0, "y": 1514.0, "width": 363.0, "height": 140.0, "rotation": 15.0,
        })
        self.assertAlmostEqual(state["display"]["opacity"], 128 / 255)
        self.assertEqual(state["display"]["blendMode"], "MULTIPLY")
        self.assertEqual(state["text"]["characters"], "Play")
        self.assertEqual(state["content"]["contentHash"], "hash-406")
        self.assertEqual(state["unsupported"], [])

    def test_unknown_blend_is_explicitly_unsupported(self):
        state = MODULE._build_psd_source_state(
            layer={
                "layerId": 7, "x": 0, "y": 0, "width": 10, "height": 10,
                "opacity": 255, "visible": True, "blend": "zzzz",
            },
            mode="image",
            content_hash="hash-7",
            constraints={},
            text_info=None,
            nine_slice_info=None,
        )
        self.assertEqual(state["display"]["blendMode"], None)
        self.assertEqual(state["unsupported"], [{"path": "display.blendMode", "value": "zzzz"}])

    def test_undecoded_placed_transform_is_fingerprinted_as_unsupported(self):
        state = MODULE._build_psd_source_state(
            layer={
                "layerId": 8, "x": 0, "y": 0, "width": 10, "height": 10,
                "opacity": 255, "visible": True, "blend": "norm",
                "_tagPayloads": {"SoLd": b"placed-transform-record"},
            },
            mode="image",
            content_hash="hash-8",
            constraints={},
            text_info=None,
            nine_slice_info=None,
        )
        unsupported = state["unsupported"][0]
        self.assertEqual(unsupported["path"], "geometry.rotation")
        self.assertEqual(unsupported["value"]["tag"], "SoLd")
        self.assertEqual(len(unsupported["value"]["sha256"]), 64)

    def test_rotation_is_emitted_only_for_a_non_skewed_text_transform(self):
        transform = MODULE._normalize_text_rotation({
            "matrix": [math.sqrt(0.5), math.sqrt(0.5), -math.sqrt(0.5), math.sqrt(0.5), 0, 0]
        })
        self.assertAlmostEqual(transform, -45.0)
        self.assertIsNone(MODULE._normalize_text_rotation({"matrix": [1, 0.5, 0, 1, 0, 0]}))

    def test_summary_preserves_source_state_verbatim(self):
        source_state = {
            "version": 3,
            "layerId": "406",
            "geometry": {"x": 1, "y": 2, "width": 3, "height": 4, "rotation": 0},
            "display": {"visible": True, "opacity": 1, "blendMode": "NORMAL", "constraints": {}},
            "content": {"contentHash": "abc"},
            "text": None,
            "nineSlice": None,
            "unsupported": [],
        }
        summary = MODULE._generate_summary({
            "canvas": {"width": 100, "height": 100},
            "layers": [{
                "index": 1, "layerId": 406, "name": "Button", "mode": "image",
                "x": 1, "y": 2, "width": 3, "height": 4,
                "opacity": 255, "visible": True, "constraints": {},
                "path": "1.png", "contentHash": "abc", "sourceState": source_state,
            }],
        })
        self.assertEqual(summary["layers"][0]["sourceState"], source_state)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the focused parser test and verify failure**

Run:

```powershell
python -m unittest ai.skills.psd-layer-to-figma.tests.test_export_psd_source_state -v
```

Expected: FAIL because `_build_psd_source_state` and `_normalize_text_rotation` do not exist.

- [ ] **Step 3: Implement normalization helpers in the exporter**

Add these helpers near the existing text-transform helpers:

```python
FIGMA_BLEND_MODE_BY_PSD_KEY = {
    "norm": "NORMAL",
    "mul ": "MULTIPLY",
    "scrn": "SCREEN",
    "over": "OVERLAY",
    "dark": "DARKEN",
    "lite": "LIGHTEN",
    "idiv": "COLOR_DODGE",
    "div ": "COLOR_BURN",
    "hLit": "HARD_LIGHT",
    "sLit": "SOFT_LIGHT",
    "diff": "DIFFERENCE",
    "smud": "EXCLUSION",
    "hue ": "HUE",
    "sat ": "SATURATION",
    "colr": "COLOR",
    "lum ": "LUMINOSITY",
}


def _normalize_text_rotation(transform: Optional[Dict[str, Any]]) -> Optional[float]:
    matrix = transform.get("matrix") if isinstance(transform, dict) else None
    if not isinstance(matrix, list) or len(matrix) != 6:
        return None
    xx, xy, yx, yy = (float(matrix[index]) for index in range(4))
    length_x = math.hypot(xx, yx)
    length_y = math.hypot(xy, yy)
    if length_x <= 0.0 or length_y <= 0.0:
        return None
    normalized_dot = (xx * xy + yx * yy) / (length_x * length_y)
    if abs(normalized_dot) > 1e-6:
        return None
    return round(math.degrees(math.atan2(yx, xx)), 6)


def _normalize_opacity(value: object) -> float:
    opacity = float(value or 0)
    if opacity > 1.0:
        opacity /= 255.0
    return max(0.0, min(1.0, opacity))


def _build_psd_source_state(
    *,
    layer: Dict[str, object],
    mode: str,
    content_hash: str,
    constraints: Dict[str, object],
    text_info: Optional[Dict[str, Any]],
    nine_slice_info: Optional[Dict[str, Any]],
) -> Dict[str, object]:
    blend_key = str(layer.get("blend", "norm"))
    blend_mode = FIGMA_BLEND_MODE_BY_PSD_KEY.get(blend_key)
    unsupported: List[Dict[str, object]] = []
    if blend_mode is None:
        unsupported.append({"path": "display.blendMode", "value": blend_key})
    text_transform = text_info.get("textTransform") if isinstance(text_info, dict) else None
    rotation = _normalize_text_rotation(text_transform)
    if mode == "text" and text_transform and rotation is None:
        unsupported.append({"path": "geometry.rotation", "value": text_transform.get("matrix")})
    tag_payloads = layer.get("_tagPayloads", {})
    if mode != "text" and isinstance(tag_payloads, dict):
        for tag in ("SoLd", "PlLd", "PlcL"):
            payload = tag_payloads.get(tag)
            if isinstance(payload, bytes):
                unsupported.append({
                    "path": "geometry.rotation",
                    "value": {"tag": tag, "sha256": hashlib.sha256(payload).hexdigest()},
                })
                break
    text_state = None
    if mode == "text" and text_info:
        text_state = {
            "characters": str(text_info.get("characters", "")),
            "fontFamily": text_info.get("fontFamily"),
            "fontFallback": text_info.get("figma", {}).get("fontFallbackCandidates", []),
            "fontSize": text_info.get("fontSize"),
            "effectiveFontSize": text_info.get("effectiveFontSize"),
            "leading": text_info.get("leading"),
            "lineHeightMode": text_info.get("lineHeightMode"),
            "textAlignHorizontal": text_info.get("textAlignHorizontal"),
            "fillColor": text_info.get("fillColor"),
            "stroke": text_info.get("effects", {}).get("stroke"),
            "dropShadow": text_info.get("effects", {}).get("dropShadow"),
        }
    return {
        "version": 3,
        "layerId": str(layer.get("layerId") or ""),
        "mode": mode,
        "geometry": {
            "x": float(layer.get("x", 0)),
            "y": float(layer.get("y", 0)),
            "width": float(layer.get("width", 0)),
            "height": float(layer.get("height", 0)),
            "rotation": rotation,
        },
        "display": {
            "visible": layer.get("visible", True) is not False,
            "opacity": _normalize_opacity(layer.get("opacity", 255)),
            "blendMode": blend_mode,
            "constraints": constraints,
        },
        "content": {"contentHash": str(content_hash or "")},
        "text": text_state,
        "nineSlice": ({
            "contentHash": str(content_hash or ""),
            "sliceType": nine_slice_info.get("sliceType"),
            "border": nine_slice_info.get("border", {}),
            "slices": nine_slice_info.get("slices", []),
        } if mode == "nine-slice" and nine_slice_info else None),
        "unsupported": unsupported,
    }
```

Also add `rotation` to the dictionary returned by `_extract_text_transform_from_tysh`:

```python
transform = {
    "version": version,
    "matrix": [xx, xy, yx, yy, tx, ty],
    "scaleX": scale_x,
    "scaleY": scale_y,
}
transform["rotation"] = _normalize_text_rotation(transform)
return transform
```

- [ ] **Step 4: Attach and preserve `sourceState` in both summary paths**

In `_write_layers`, calculate constraints once and write the state:

```python
constraints = _infer_constraints(
    float(layer["x"]), float(layer["y"]), float(width), float(height),
    float(canvas["width"]), float(canvas["height"]),
)
layer_entry["constraints"] = constraints
layer_entry["sourceState"] = _build_psd_source_state(
    layer=layer,
    mode=mode,
    content_hash=content_hash,
    constraints=constraints,
    text_info=text_info,
    nine_slice_info=nine_slice_info,
)
```

In `_generate_summary`, add this exact field to `entry`:

```python
"sourceState": layer.get("sourceState"),
```

In `summarize_manifest.py`, add the same field plus the fields the compatibility path currently drops:

```python
"contentHash": layer.get("contentHash", ""),
"blend": layer.get("blend", "norm"),
"sourceState": layer.get("sourceState"),
```

For text and nine-slice entries, preserve the complete nested objects:

```python
text_entry = {**base, "text": txt, "chars": txt.get("characters", "")}
nine_slice_entry = {**base, "nineSlice": ns, "border": ns.get("border", {})}
```

- [ ] **Step 5: Run parser and existing Layer ID regressions**

```powershell
python -m unittest ai.skills.psd-layer-to-figma.tests.test_export_psd_source_state ai.skills.psd-layer-to-figma.tests.test_export_psd_layer_ids -v
```

Expected: all source-state and Layer ID tests PASS.

- [ ] **Step 6: Commit the parser slice**

```powershell
git add ai/skills/psd-layer-to-figma/scripts/export_psd_layers.py ai/skills/psd-layer-to-figma/scripts/summarize_manifest.py ai/skills/psd-layer-to-figma/tests/test_export_psd_source_state.py
git commit -m "Preserve every representable PSD field for later merges" -m "Constraint: Unsupported source fields must be explicit rather than silently classified as unchanged." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: Python source-state and Layer ID unit tests." -m "Not-tested: Figma runtime writes are covered by later tasks."
```

### Task 2: Replace content-hash diffing with canonical field-level diffing

**Files:**
- Modify: `code/06_psd_incremental.mjs:1-147`
- Modify: `tests/psd-incremental-diff.test.mjs`

- [ ] **Step 1: Replace the old classification test with failing field-level cases**

Add a test helper and these tests:

```javascript
function state(overrides = {}) {
  return {
    version: 3,
    layerId: "406",
    mode: "image",
    geometry: { x: 580, y: 1514, width: 363, height: 140, rotation: 0 },
    display: {
      visible: true,
      opacity: 1,
      blendMode: "NORMAL",
      constraints: { horizontal: "CENTER", vertical: "CENTER" },
    },
    content: { contentHash: "same-pixels" },
    text: null,
    nineSlice: null,
    unsupported: [],
    ...overrides,
  };
}

test("position-only source changes are affected even when content hash is unchanged", () => {
  const baseline = state();
  const incoming = state({ geometry: { ...baseline.geometry, y: 1196 } });
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "7195:882", sourceState: baseline }],
    [{ layerId: "406", name: "ui_anniu_1", sourceState: incoming }],
  );
  assert.equal(diff.summary.affected, 1);
  assert.equal(diff.summary.position, 1);
  assert.equal(diff.summary.content, 0);
  assert.equal(diff.changed[0].changes[0].path, "geometry.y");
  assert.equal(diff.changed[0].changes[0].delta, -318);
});

test("one layer contributes to multiple categories but one affected total", () => {
  const baseline = state();
  const incoming = state({
    geometry: { ...baseline.geometry, width: 726 },
    display: { ...baseline.display, opacity: 0.5, visible: false },
    content: { contentHash: "new-pixels" },
  });
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "n", sourceState: baseline }],
    [{ layerId: "406", sourceState: incoming }],
  );
  assert.equal(diff.summary.affected, 1);
  assert.equal(diff.summary.size, 1);
  assert.equal(diff.summary.display, 1);
  assert.equal(diff.summary.content, 1);
});

test("legacy matched nodes require baseline adoption", () => {
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "n", sourceState: null }],
    [{ layerId: "406", sourceState: state() }],
  );
  assert.equal(diff.status, "preview-baseline-required");
  assert.equal(diff.canApply, false);
});

test("identical canonical source state produces preview-no-changes", () => {
  const baseline = state();
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "n", sourceState: baseline }],
    [{ layerId: "406", sourceState: JSON.parse(JSON.stringify(baseline)) }],
  );
  assert.equal(diff.status, "preview-no-changes");
  assert.equal(diff.summary.affected, 0);
  assert.equal(diff.canApply, false);
});

test("changed unsupported state is blocking", () => {
  const baseline = state();
  const incoming = state({ unsupported: [{ path: "display.blendMode", value: "zzzz" }] });
  const diff = buildPsdIncrementalDiff(
    [{ layerId: "406", nodeId: "n", sourceState: baseline }],
    [{ layerId: "406", sourceState: incoming }],
  );
  assert.equal(diff.status, "preview-blocked");
  assert.equal(diff.conflicts[0].kind, "unsupported-source-change");
});
```

- [ ] **Step 2: Add failing canonical-hash and matrix tests**

```javascript
test("canonical hashes ignore object key insertion order", () => {
  assert.equal(
    hashPsdSourceState({ b: 2, a: { d: 4, c: 3 } }),
    hashPsdSourceState({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("geometry target preserves organized offset under transformed parents", () => {
  const target = computePsdGeometryTarget({
    baseline: { x: 580, y: 1514, width: 363, height: 140, rotation: 0 },
    incoming: { x: 580, y: 1196, width: 726, height: 140, rotation: 15 },
    currentAbsolute: { x: 1000, y: 2000 },
    currentSize: { width: 500, height: 200 },
    currentRotation: 5,
    rootAbsoluteTransform: [[2, 0, 100], [0, 2, 50]],
    parentAbsoluteTransform: [[1, 0, 400], [0, 1, 600]],
  });
  assert.deepEqual(target.localPosition, { x: 600, y: 764 });
  assert.deepEqual(target.size, { width: 1000, height: 200 });
  assert.equal(target.rotation, 20);
});

test("zero baseline size blocks geometry planning", () => {
  assert.throws(() => computePsdGeometryTarget({
    baseline: { x: 0, y: 0, width: 0, height: 10, rotation: 0 },
    incoming: { x: 0, y: 0, width: 20, height: 10, rotation: 0 },
    currentAbsolute: { x: 0, y: 0 },
    currentSize: { width: 10, height: 10 },
    currentRotation: 0,
    rootAbsoluteTransform: [[1, 0, 0], [0, 1, 0]],
    parentAbsoluteTransform: [[1, 0, 0], [0, 1, 0]],
  }), /invalid-baseline-size/);
});
```

- [ ] **Step 3: Run the Node test and verify failure**

```powershell
node --test tests/psd-incremental-diff.test.mjs
```

Expected: FAIL because canonical source-state helpers, field groups, preview statuses, and geometry math do not exist.

- [ ] **Step 4: Implement canonical state and stable hashing**

Add these exports to `code/06_psd_incremental.mjs`:

```javascript
export function canonicalizePsdSourceState(value) {
  if (Array.isArray(value)) return value.map(canonicalizePsdSourceState);
  if (!value || typeof value !== "object") return value;
  var result = {};
  for (var key of Object.keys(value).sort()) {
    var child = value[key];
    if (typeof child !== "undefined") result[key] = canonicalizePsdSourceState(child);
  }
  return result;
}

export function stablePsdSourceStateJson(value) {
  return JSON.stringify(canonicalizePsdSourceState(value));
}

export function hashPsdSourceState(value) {
  var text = stablePsdSourceStateJson(value);
  var hash = 2166136261;
  for (var index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function normalizePsdSourceState(layer) {
  var sourceLayer = layer || {};
  var raw = sourceLayer.sourceState && typeof sourceLayer.sourceState === "object"
    ? layer.sourceState
    : layer;
  if (!raw || typeof raw !== "object") return null;
  var geometry = raw.geometry || {};
  var display = raw.display || {};
  var geometryX = geometry.x != null ? geometry.x : sourceLayer.x;
  var geometryY = geometry.y != null ? geometry.y : sourceLayer.y;
  var geometryWidth = geometry.width != null
    ? geometry.width
    : (sourceLayer.w != null ? sourceLayer.w : sourceLayer.width);
  var geometryHeight = geometry.height != null
    ? geometry.height
    : (sourceLayer.h != null ? sourceLayer.h : sourceLayer.height);
  var rotation = geometry.rotation == null ? null : Number(geometry.rotation);
  return canonicalizePsdSourceState({
    version: 3,
    layerId: normalizePsdLayerId(raw.layerId || sourceLayer.layerId),
    mode: String(raw.mode || sourceLayer.mode || "image"),
    geometry: {
      x: Number(geometryX == null ? 0 : geometryX),
      y: Number(geometryY == null ? 0 : geometryY),
      width: Number(geometryWidth == null ? 0 : geometryWidth),
      height: Number(geometryHeight == null ? 0 : geometryHeight),
      rotation: Number.isFinite(rotation) ? rotation : null,
    },
    display: {
      visible: (display.visible != null ? display.visible : sourceLayer.visible) !== false,
      opacity: Number(display.opacity != null ? display.opacity : (sourceLayer.opacity != null ? sourceLayer.opacity : 1)),
      blendMode: display.blendMode != null ? display.blendMode : null,
      constraints: display.constraints || sourceLayer.constraints || {},
    },
    content: raw.content || { contentHash: String(sourceLayer.contentHash || "") },
    text: raw.text || null,
    nineSlice: raw.nineSlice || null,
    unsupported: Array.isArray(raw.unsupported) ? raw.unsupported : [],
  });
}
```

Retain placed/smart-object transform records beside the existing text/effect/identity records while parsing layer tags:

```python
if key in ("TySh", "lfx2", "lfx ", "lyid", "SoLd", "PlLd", "PlcL"):
    tag_payloads[key] = payload
```

This release does not guess a rotation from undecoded placed-object descriptors. The stable payload hash makes a changed transform visible as an unsupported blocking change. Raster layers with no independent transform record keep `geometry.rotation=null` and rely on rendered pixels plus bounds.

- [ ] **Step 5: Implement field descriptors and diff status selection**

Use one descriptor table so grouping and summary names cannot drift:

```javascript
var PSD_SOURCE_FIELD_DESCRIPTORS = [
  ["content.contentHash", "content"],
  ["geometry.x", "position"], ["geometry.y", "position"],
  ["geometry.width", "size"], ["geometry.height", "size"],
  ["geometry.rotation", "rotation"],
  ["display.visible", "display"], ["display.opacity", "display"],
  ["display.blendMode", "display"], ["display.constraints", "display"],
  ["text.characters", "textContent"], ["text.fontFamily", "textStyle"],
  ["text.fontFallback", "textStyle"], ["text.fontSize", "textStyle"],
  ["text.effectiveFontSize", "textStyle"], ["text.leading", "textStyle"],
  ["text.lineHeightMode", "textStyle"], ["text.textAlignHorizontal", "textStyle"],
  ["text.fillColor", "textStyle"], ["text.stroke", "textStyle"],
  ["text.dropShadow", "textStyle"],
  ["nineSlice", "nineSlice"],
];

function valueAtPsdPath(value, path) {
  return path.split(".").reduce(function (current, key) {
    return current == null ? undefined : current[key];
  }, value);
}

export function diffPsdSourceStates(baseline, incoming) {
  var changes = [];
  for (var descriptor of PSD_SOURCE_FIELD_DESCRIPTORS) {
    var before = valueAtPsdPath(baseline, descriptor[0]);
    var after = valueAtPsdPath(incoming, descriptor[0]);
    if (stablePsdSourceStateJson(before) === stablePsdSourceStateJson(after)) continue;
    changes.push({
      path: descriptor[0],
      category: descriptor[1],
      before: before,
      after: after,
      delta: typeof before === "number" && typeof after === "number" ? after - before : null,
    });
  }
  var unsupportedChanged = stablePsdSourceStateJson(baseline.unsupported || [])
    !== stablePsdSourceStateJson(incoming.unsupported || []);
  return { changes: changes, unsupportedChanged: unsupportedChanged };
}

function categoryLayerCount(changed, category) {
  return changed.filter(function (pair) {
    return pair.changes.some(function (change) { return change.category === category; });
  }).length;
}
```

Rewrite `buildPsdIncrementalDiff` so each matched pair uses stored `target.sourceState` versus normalized incoming `sourceState`. Return category arrays, unique `changed`, explicit conflicts, and this status priority:

```javascript
var status = conflicts.length > 0
  ? "preview-blocked"
  : baselineRequired.length > 0
    ? "preview-baseline-required"
    : changed.length === 0 && added.length === 0
      ? "preview-no-changes"
      : "preview-ready";

return {
  status: status,
  changed: changed,
  unchanged: unchanged,
  added: added,
  missing: missing,
  baselineRequired: baselineRequired,
  conflicts: conflicts,
  canApply: status === "preview-ready",
  summary: {
    affected: changed.length,
    unchanged: unchanged.length,
    added: added.length,
    missing: missing.length,
    conflicts: conflicts.length,
    content: categoryLayerCount(changed, "content"),
    textContent: categoryLayerCount(changed, "textContent"),
    position: categoryLayerCount(changed, "position"),
    size: categoryLayerCount(changed, "size"),
    rotation: categoryLayerCount(changed, "rotation"),
    display: categoryLayerCount(changed, "display"),
    textStyle: categoryLayerCount(changed, "textStyle"),
    nineSlice: categoryLayerCount(changed, "nineSlice"),
    baselineRequired: baselineRequired.length,
  },
};
```

While building the result, enforce two additional safety rules:

```javascript
if (fieldDiff.changes.some(function (change) {
  return change.path === "geometry.rotation"
    && (!Number.isFinite(change.before) || !Number.isFinite(change.after));
})) {
  conflicts.push({ kind: "unreliable-rotation-delta", layerId: layerId });
}
if (fieldDiff.unsupportedChanged) {
  conflicts.push({ kind: "unsupported-source-change", layerId: layerId });
}
```

New layers whose incoming state already contains `unsupported` records also create `unsupported-source-change`; they must not be staged as if the unsupported field were representable.

- [ ] **Step 6: Implement pure transform and geometry helpers**

```javascript
function transformPsdVector(matrix, vector) {
  return {
    x: matrix[0][0] * vector.x + matrix[0][1] * vector.y,
    y: matrix[1][0] * vector.x + matrix[1][1] * vector.y,
  };
}

function inversePsdTransformPoint(matrix, point) {
  var a = matrix[0][0], c = matrix[0][1], tx = matrix[0][2];
  var b = matrix[1][0], d = matrix[1][1], ty = matrix[1][2];
  var determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) {
    throw new Error("non-invertible-parent-transform");
  }
  var x = point.x - tx;
  var y = point.y - ty;
  return {
    x: (d * x - c * y) / determinant,
    y: (-b * x + a * y) / determinant,
  };
}

export function computePsdGeometryTarget(input) {
  var baseline = input.baseline;
  var incoming = input.incoming;
  if (!(baseline.width > 0) || !(baseline.height > 0)) throw new Error("invalid-baseline-size");
  var sourceDelta = { x: incoming.x - baseline.x, y: incoming.y - baseline.y };
  var pageDelta = transformPsdVector(input.rootAbsoluteTransform, sourceDelta);
  var desiredAbsolute = {
    x: input.currentAbsolute.x + pageDelta.x,
    y: input.currentAbsolute.y + pageDelta.y,
  };
  return {
    localPosition: inversePsdTransformPoint(input.parentAbsoluteTransform, desiredAbsolute),
    size: {
      width: input.currentSize.width * incoming.width / baseline.width,
      height: input.currentSize.height * incoming.height / baseline.height,
    },
    rotation: Number.isFinite(baseline.rotation) && Number.isFinite(incoming.rotation)
      ? input.currentRotation + incoming.rotation - baseline.rotation
      : input.currentRotation,
  };
}
```

- [ ] **Step 7: Run the pure diff tests**

```powershell
node --test tests/psd-incremental-diff.test.mjs
```

Expected: all identity, ownership, field-level diff, status, canonical hash, and geometry tests PASS.

- [ ] **Step 8: Commit the pure diff slice**

```powershell
git add code/06_psd_incremental.mjs tests/psd-incremental-diff.test.mjs
git commit -m "Detect PSD source changes beyond rendered content" -m "Constraint: Geometry must merge as source deltas without resetting organized Figma layout." -m "Rejected: Content-hash-only classification | It misses position, size, display, style, and nine-slice changes." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: Node field-level diff and transform tests."
```

### Task 3: Persist schema-v3 baselines and support metadata-only adoption

**Files:**
- Modify: `code/05_utils.js:3746-3816,4124-4322,4811-4835`
- Modify: `code/01_handlers.js:70-103`
- Create: `tests/psd-incremental-runtime.test.mjs`

- [ ] **Step 1: Write failing runtime metadata contracts**

```javascript
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const utils = fs.readFileSync(new URL("../code/05_utils.js", import.meta.url), "utf8");
const handlers = fs.readFileSync(new URL("../code/01_handlers.js", import.meta.url), "utf8");

test("initial import stores schema-v3 source state inside Figma", () => {
  assert.match(utils, /psdImportSchemaVersion:\s*"3"/);
  assert.match(utils, /psdSourceState:\s*stablePsdSourceStateJson/);
  assert.match(utils, /psdSourceStateHash:\s*hashPsdSourceState/);
  assert.match(utils, /readSharedPluginData\(node, "psdSourceState"\)/);
});

test("legacy adoption is metadata-only and separately routed", () => {
  assert.match(utils, /async function adoptPsdIncrementalBaseline\(/);
  assert.match(utils, /status:\s*"baseline-adopted"/);
  assert.match(handlers, /incremental-baseline-adopt/);
  assert.match(handlers, /adoptPsdIncrementalBaseline/);
});

test("stored baseline parse failure is explicit", () => {
  assert.match(utils, /invalid-stored-source-state/);
  assert.doesNotMatch(utils, /sourceState\s*=\s*buildPsdLiveNodeState/);
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test tests/psd-incremental-runtime.test.mjs
```

Expected: FAIL because schema-v3 keys and baseline adoption do not exist.

- [ ] **Step 3: Normalize and persist source state**

In `normalizeLayer`, add:

```javascript
normalized.sourceState = normalizePsdSourceState({ ...normalized, sourceState: layer.sourceState });
normalized.sourceStateHash = hashPsdSourceState(normalized.sourceState);
```

Replace the PSD-specific part of `writeLayerMetadata` with:

```javascript
var sourceState = normalizePsdSourceState(layer);
Object.assign(metadata, {
  psdLayerId: normalizePsdLayerId(layer.layerId),
  psdOriginalName: String(layer.rawPsdLayerName || layer.name || ""),
  psdContentHash: String(layer.contentHash || ""),
  psdOwnership: psdOwnershipForMode(layer.mode),
  psdSourceState: stablePsdSourceStateJson(sourceState),
  psdSourceStateHash: hashPsdSourceState(sourceState),
});
```

Change root metadata to version 3:

```javascript
schemaVersion: "3",
psdSchemaVersion: "3",
psdImportSchemaVersion: "3",
```

Add the two source-state keys to every metadata capture/rollback key list.

- [ ] **Step 4: Parse stored state without guessing from live Figma geometry**

```javascript
function readStoredPsdSourceState(node) {
  var raw = readSharedPluginData(node, "psdSourceState");
  if (!raw) return { state: null, error: "" };
  try {
    var parsed = JSON.parse(raw);
    var state = normalizePsdSourceState({ sourceState: parsed });
    return state && state.layerId
      ? { state: state, error: "" }
      : { state: null, error: "invalid-stored-source-state" };
  } catch (error) {
    return { state: null, error: "invalid-stored-source-state" };
  }
}
```

Extend `collectPsdBoundNodes` with `sourceState`, `sourceStateHash`, `sourceStateError`, live writable-field signature, parent ID, and sibling index. Do not synthesize a PSD baseline from `node.x`, `node.y`, width, height, or styles.

- [ ] **Step 5: Implement metadata-only baseline adoption**

```javascript
async function adoptPsdIncrementalBaseline(job, assets) {
  var prepared = await preparePsdIncrementalUpdate(job, assets);
  var matched = prepared.diff.baselineRequired;
  if (prepared.diff.conflicts.length > 0 || matched.length === 0) {
    return buildPsdIncrementalResult(prepared, "baseline-adopt-blocked");
  }
  var protectedBefore = capturePsdProtectedSnapshot(prepared.target);
  var nodeMetadataBefore = matched.map(function (pair) {
    return { node: pair.target.node, metadata: capturePsdLayerMetadata(pair.target.node) };
  });
  var rootMetadataBefore = capturePsdRootMetadata(prepared.target);
  try {
    for (var pair of matched) writeLayerMetadata(pair.target.node, pair.source, {});
    writePsdRootMetadata(prepared.target, job, prepared.manifest);
    var errors = verifyPsdProtectedSnapshot(protectedBefore);
    if (errors.length) throw new Error(errors.join("; "));
    if (typeof figma.commitUndo === "function") figma.commitUndo();
    return {
      status: "baseline-adopted",
      targetNodeId: prepared.target.id,
      adoptedCount: matched.length,
      warnings: prepared.context.warnings,
      errors: [],
    };
  } catch (error) {
    for (var record of nodeMetadataBefore) writePluginData(record.node, record.metadata);
    writePluginData(prepared.target, rootMetadataBefore);
    throw error;
  }
}
```

The adoption path must use the same document-identity, duplicate Layer ID, and source-state validation as preview. It must never call `resize`, assign geometry/style/content, create/remove nodes, or reparent anything.

Introduce the metadata capture helper used by adoption and later rollback:

```javascript
function capturePsdLayerMetadata(node) {
  var keys = [
    "rawPsdLayerName", "normalizedLayerName", "semanticMode", "normalizationWarnings",
    "psdLayerIndex", "psdLayerId", "psdOriginalName", "psdContentHash", "psdOwnership",
    "psdSourceState", "psdSourceStateHash",
  ];
  var values = {};
  for (var key of keys) values[key] = readSharedPluginData(node, key);
  return values;
}
```

Task 4 replaces `capturePsdProtectedSnapshot` with the narrower structural snapshot after writable fields have their own rollback/verification path. Task 3 intentionally uses the existing protected snapshot because baseline adoption must change no canvas field at all.

- [ ] **Step 6: Route baseline adoption in the plugin handler**

```javascript
if (mode === "incremental-preview") {
  result = await previewPsdIncrementalUpdate(message.job, message.assets || []);
} else if (mode === "incremental-baseline-adopt") {
  result = await adoptPsdIncrementalBaseline(message.job, message.assets || []);
} else if (mode === "incremental-apply") {
  result = await applyPsdIncrementalUpdate(message.job, message.assets || []);
} else {
  result = await importPsdJob(message.job, message.assets || []);
}
```

- [ ] **Step 7: Run metadata contracts and pure regressions**

```powershell
node --test tests/psd-incremental-runtime.test.mjs tests/psd-incremental-diff.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 8: Commit baseline metadata support**

```powershell
git add code/01_handlers.js code/05_utils.js tests/psd-incremental-runtime.test.mjs
git commit -m "Keep the last applied PSD source truth inside Figma" -m "Constraint: Legacy organized nodes cannot derive an old PSD baseline from their current layout." -m "Rejected: External mapping JSON | It would create a second source of truth." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: Runtime metadata and baseline-adoption source contracts plus pure diff tests."
```

### Task 4: Apply all planned PSD-owned fields transactionally

**Files:**
- Modify: `code/05_utils.js:3640-4163,4456-4561,4660-4825`
- Modify: `code/06_psd_incremental.mjs`
- Modify: `tests/psd-incremental-diff.test.mjs`
- Modify: `tests/psd-incremental-runtime.test.mjs`

- [ ] **Step 1: Add failing mutation-plan and structural-contract tests**

```javascript
test("mutation plan names every writable category for one layer", () => {
  const baseline = state();
  const incoming = state({
    geometry: { x: 600, y: 1200, width: 726, height: 280, rotation: 10 },
    display: { ...baseline.display, visible: false, opacity: 0.5 },
    content: { contentHash: "new" },
  });
  const plan = buildPsdLayerMutationPlan({
    source: { layerId: "406", sourceState: incoming },
    target: { sourceState: baseline, nodeId: "n" },
    changes: diffPsdSourceStates(baseline, incoming).changes,
  });
  assert.deepEqual(plan.categories, ["content", "display", "position", "rotation", "size"]);
});
```

Extend `tests/psd-incremental-runtime.test.mjs`:

```javascript
test("transaction captures and restores every mutable PSD-owned field", () => {
  for (const field of [
    "x", "y", "width", "height", "rotation", "visible", "opacity", "blendMode",
    "constraints", "characters", "fontName", "fontSize", "lineHeight",
    "textAlignHorizontal", "fills", "strokes", "strokeWeight", "strokeAlign", "effects",
  ]) {
    assert.match(utils, new RegExp("\\b" + field + "\\b"));
  }
  assert.match(utils, /capturePsdMutationRollback/);
  assert.match(utils, /rollbackPsdIncrementalMutation/);
  assert.match(utils, /verifyPsdAppliedFields/);
  assert.match(utils, /capturePsdStructuralSnapshot/);
  assert.match(utils, /verifyPsdStructuralSnapshot/);
});

test("organized identity and hierarchy are structural invariants", () => {
  assert.match(utils, /parentId/);
  assert.match(utils, /siblingIndex/);
  assert.match(utils, /componentIdentity/);
  assert.doesNotMatch(utils, /pair\.target\.node\.name\s*=/);
  assert.doesNotMatch(utils, /appendChild\(pair\.target\.node\)/);
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test tests/psd-incremental-diff.test.mjs tests/psd-incremental-runtime.test.mjs
```

Expected: FAIL because mutation plans and full-field transaction helpers do not exist.

- [ ] **Step 3: Build deterministic mutation plans**

Add this pure export:

```javascript
export function buildPsdLayerMutationPlan(pair) {
  var categories = Array.from(new Set(pair.changes.map(function (change) {
    return change.category;
  }))).sort();
  return {
    layerId: normalizePsdLayerId(pair.source.layerId),
    nodeId: String(pair.target.nodeId || ""),
    source: pair.source,
    target: pair.target,
    categories: categories,
    changedPaths: pair.changes.map(function (change) { return change.path; }).sort(),
    baseline: pair.target.sourceState,
    incoming: normalizePsdSourceState(pair.source),
  };
}
```

`preparePsdIncrementalUpdate` must create one plan per changed pair, validate that the current node exposes every planned property, and turn unsupported node types, auto-layout geometry, unavailable fonts, invalid dimensions, non-invertible transforms, and unsafe component/instance writes into blocking conflicts before any mutation.

Resolve expected geometry during preflight so apply and verification share one value:

```javascript
for (var plan of plans) {
  if (plan.categories.some(function (category) {
    return category === "position" || category === "size" || category === "rotation";
  })) {
    plan.expectedGeometry = computePsdGeometryTarget({
      baseline: plan.baseline.geometry,
      incoming: plan.incoming.geometry,
      currentAbsolute: getHierarchyNodeAbsolutePosition(plan.target.node),
      currentSize: { width: plan.target.node.width, height: plan.target.node.height },
      currentRotation: numericOr(plan.target.node.rotation, 0),
      rootAbsoluteTransform: target.absoluteTransform,
      parentAbsoluteTransform: plan.target.node.parent.absoluteTransform,
    });
  }
}
```

- [ ] **Step 4: Separate structural protection from writable-field verification**

Replace `capturePsdProtectedSnapshot` with `capturePsdStructuralSnapshot`. Each record contains:

```javascript
{
  node: node,
  id: node.id,
  name: String(node.name || ""),
  parentId: node.parent ? node.parent.id : "",
  siblingIndex: node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : -1,
  type: String(node.type || ""),
  componentIdentity: buildPsdComponentIdentity(node),
  nonPsdChildIds: "children" in node
    ? node.children.filter(function (child) { return !isPsdOwnedSliceChild(child); }).map(function (child) { return child.id; })
    : [],
}
```

Skip PSD-owned slice children while walking the structural snapshot because their representation is explicitly replaceable. Define the helpers used above:

```javascript
function isPsdOwnedSliceChild(node) {
  if (!node) return false;
  if (readSharedPluginData(node, "psdSliceRole") === "slice") return true;
  return !!readSharedPluginData(node, "parentLayerIndex")
    && String(node.name || "").startsWith("__slice");
}

function buildPsdComponentIdentity(node) {
  var mainComponentId = "mainComponent" in node && node.mainComponent
    ? String(node.mainComponent.id || "")
    : "";
  return [String(node.type || ""), String(node.id || ""), mainComponentId].join(":");
}
```

`verifyPsdStructuralSnapshot` always checks ID, name, parent, sibling order, type/component identity, and non-PSD child IDs. It accepts an `allowedAddedNodeIds` set for the staging frame/new layers; those IDs are the only structural additions it ignores. Geometry, display, content, and text are verified separately against the mutation plan.

- [ ] **Step 5: Capture complete rollback data before the first write**

```javascript
function capturePsdMutationRollback(node) {
  return {
    node: node,
    x: "x" in node ? node.x : null,
    y: "y" in node ? node.y : null,
    width: "width" in node ? node.width : null,
    height: "height" in node ? node.height : null,
    rotation: "rotation" in node ? node.rotation : null,
    visible: "visible" in node ? node.visible : null,
    opacity: "opacity" in node ? node.opacity : null,
    blendMode: "blendMode" in node ? node.blendMode : null,
    constraints: "constraints" in node ? cloneObject(node.constraints) : null,
    characters: "characters" in node ? node.characters : null,
    fontName: "fontName" in node ? cloneObject(node.fontName) : null,
    fontSize: "fontSize" in node ? node.fontSize : null,
    lineHeight: "lineHeight" in node ? cloneObject(node.lineHeight) : null,
    textAlignHorizontal: "textAlignHorizontal" in node ? node.textAlignHorizontal : null,
    textAutoResize: "textAutoResize" in node ? node.textAutoResize : null,
    fills: "fills" in node ? cloneObject(node.fills) : null,
    strokes: "strokes" in node ? cloneObject(node.strokes) : null,
    strokeWeight: "strokeWeight" in node ? node.strokeWeight : null,
    strokeAlign: "strokeAlign" in node ? node.strokeAlign : null,
    effects: "effects" in node ? cloneObject(node.effects) : null,
    sliceChildren: capturePsdSliceChildren(node),
    metadata: capturePsdLayerMetadata(node),
  };
}
```

Capture slice children as data rather than cloning the selected subtree:

```javascript
function capturePsdSliceChildren(node) {
  if (!("children" in node)) return [];
  return node.children.filter(isPsdOwnedSliceChild).map(function (child) {
    return {
      index: node.children.indexOf(child),
      name: String(child.name || ""),
      x: numericOr(child.x, 0),
      y: numericOr(child.y, 0),
      width: positiveOr(child.width, 1),
      height: positiveOr(child.height, 1),
      fills: cloneObject(child.fills),
      constraints: cloneObject(child.constraints),
      metadata: {
        sourceRect: readSharedPluginData(child, "sourceRect"),
        parentLayerIndex: readSharedPluginData(child, "parentLayerIndex"),
        psdParentLayerId: readSharedPluginData(child, "psdParentLayerId"),
        psdSliceRole: readSharedPluginData(child, "psdSliceRole"),
      },
    };
  });
}
```

Rollback restores scalar fields, uses `resize` for dimensions, restores paints/effects/text data after required fonts are preloaded, recreates only PSD-owned slice children from `sliceChildren`, then restores source-state metadata. It processes records in reverse order and verifies both field values and structural snapshots after rollback.

- [ ] **Step 6: Apply geometry and display changes from the plan**

```javascript
function applyPsdGeometryPlan(plan, node) {
  var target = plan.expectedGeometry;
  if (plan.changedPaths.includes("geometry.width") || plan.changedPaths.includes("geometry.height")) {
    node.resize(target.size.width, target.size.height);
  }
  if (plan.changedPaths.includes("geometry.x") || plan.changedPaths.includes("geometry.y")) {
    node.x = target.localPosition.x;
    node.y = target.localPosition.y;
  }
  if (plan.changedPaths.includes("geometry.rotation")) node.rotation = target.rotation;
}

function applyPsdDisplayPlan(plan, node) {
  var display = plan.incoming.display;
  if (plan.changedPaths.includes("display.visible")) node.visible = display.visible;
  if (plan.changedPaths.includes("display.opacity")) node.opacity = display.opacity;
  if (plan.changedPaths.includes("display.blendMode")) node.blendMode = display.blendMode;
  if (plan.changedPaths.includes("display.constraints")) node.constraints = cloneObject(display.constraints);
}
```

- [ ] **Step 7: Apply content, complete text style, and nine-slice changes**

Before entering the transaction, preload every changed image, font, and nine-slice paint. Then use category-specific helpers:

```javascript
async function applyPsdTextPlan(plan, pair, prepared) {
  var node = pair.target.node;
  var text = plan.incoming.text || {};
  if (plan.changedPaths.some(function (path) { return path.startsWith("text.font"); })) {
    node.fontName = prepared.resolvedFonts.get(plan.layerId);
  }
  if (plan.changedPaths.includes("text.characters")) node.characters = String(text.characters || "");
  if (plan.changedPaths.includes("text.effectiveFontSize")) node.fontSize = positiveOr(text.effectiveFontSize, text.fontSize);
  if (plan.changedPaths.includes("text.leading")) {
    node.lineHeight = text.lineHeightMode === "PIXELS" && Number(text.leading) > 0
      ? { unit: "PIXELS", value: Number(text.leading) }
      : { unit: "AUTO" };
  }
  if (plan.changedPaths.includes("text.textAlignHorizontal")) node.textAlignHorizontal = text.textAlignHorizontal;
  if (plan.changedPaths.includes("text.fillColor")) node.fills = [solidPaintFromManifest(text.fillColor || {}, 1)];
  if (plan.changedPaths.includes("text.stroke")) applyPsdTextStroke(node, text.stroke);
  if (plan.changedPaths.includes("text.dropShadow")) applyPsdTextShadow(node, text.dropShadow);
  node.textAutoResize = "NONE";
}
```

Use exact field writers that retain unrelated Figma effects:

```javascript
function applyPsdTextStroke(node, stroke) {
  if (!stroke || stroke.enabled !== true) {
    node.strokes = [];
    return;
  }
  var color = stroke.color || stroke;
  node.strokes = [solidPaintFromManifest(color, 1)];
  node.strokeWeight = numericOr(stroke.size, 1);
  node.strokeAlign = "OUTSIDE";
}

function applyPsdTextShadow(node, shadow) {
  var retained = Array.isArray(node.effects)
    ? node.effects.filter(function (effect) { return !effect || effect.type !== "DROP_SHADOW"; })
    : [];
  if (!shadow || shadow.enabled !== true) {
    node.effects = retained;
    return;
  }
  var color = shadow.color || {};
  var angleRadians = numericOr(shadow.angle, 0) * Math.PI / 180;
  var distance = numericOr(shadow.distance, 0);
  retained.push({
    type: "DROP_SHADOW",
    color: {
      r: numericOr(color.r, 0),
      g: numericOr(color.g, 0),
      b: numericOr(color.b, 0),
      a: numericOr(shadow.opacity, numericOr(color.a, 1)),
    },
    offset: {
      x: Math.cos(angleRadians) * distance,
      y: -Math.sin(angleRadians) * distance,
    },
    radius: Math.max(0, numericOr(shadow.blur, 0)),
    spread: Math.max(0, numericOr(shadow.spread, 0)),
    visible: true,
    blendMode: "NORMAL",
  });
  node.effects = retained;
}
```

Image content continues to use `replacePsdOwnedImageHash`. Nine-slice apply removes/recreates only children for which `isPsdOwnedSliceChild` is true, stores `psdParentLayerId` and `psdSliceRole` on new slices, updates the outer source image/border metadata, and preserves the outer node plus every non-PSD child.

```javascript
async function applyPsdNineSlicePlan(plan, pair, prepared) {
  var node = pair.target.node;
  if (!("children" in node)) throw new Error("unsupported-nine-slice-target");
  var imagePaint = prepared.imagePaints.get(plan.layerId);
  if (!imagePaint || !imagePaint.imageHash) throw new Error("missing-nine-slice-image");
  node.fills = replacePsdOwnedImageHash(node.fills, imagePaint);
  for (var child of node.children.slice().reverse()) {
    if (isPsdOwnedSliceChild(child)) child.remove();
  }
  var slices = Array.isArray(pair.source.slices) ? pair.source.slices : [];
  for (var slice of slices) {
    var sliceNode = figma.createRectangle();
    sliceNode.name = String(slice.name || "__slice");
    node.appendChild(sliceNode);
    var target = normalizeRectArray(slice.target);
    sliceNode.x = target[0];
    sliceNode.y = target[1];
    sliceNode.resize(positiveOr(target[2], 1), positiveOr(target[3], 1));
    sliceNode.fills = [createImagePaintFromHash(
      imagePaint.imageHash,
      "CROP",
      buildCropTransform(slice, pair.source),
      1,
    )];
    sliceNode.strokes = [];
    sliceNode.constraints = inferSliceConstraints(sliceNode, node);
    writePluginData(sliceNode, {
      sourceRect: JSON.stringify(normalizeRectArray(slice.source)),
      parentLayerIndex: String(pair.source.idx),
      psdParentLayerId: plan.layerId,
      psdSliceRole: "slice",
    });
  }
}
```

Rollback calls `restorePsdSliceChildren(record.node, record.sliceChildren)`: remove only current PSD-owned slice children, recreate rectangles from the captured name/geometry/paint/constraint/metadata values, and insert them in ascending captured index. Non-PSD children are never removed or recreated.

The orchestrator uses the plan categories without writing unrelated fields:

```javascript
async function applyPsdMutationPlans(prepared) {
  for (var plan of prepared.plans) {
    var pair = { source: plan.source, target: plan.target };
    var node = plan.target.node;
    if (plan.categories.includes("content") && plan.incoming.mode === "image") {
      node.fills = replacePsdOwnedImageHash(node.fills, prepared.imagePaints.get(plan.layerId));
    }
    if (plan.categories.includes("textContent") || plan.categories.includes("textStyle")) {
      await applyPsdTextPlan(plan, pair, prepared);
    }
    if (plan.categories.some(function (category) {
      return category === "position" || category === "size" || category === "rotation";
    })) {
      applyPsdGeometryPlan(plan, node);
    }
    if (plan.categories.includes("display")) applyPsdDisplayPlan(plan, node);
    if (plan.categories.includes("nineSlice")) await applyPsdNineSlicePlan(plan, pair, prepared);
  }
}
```

Preload incoming assets and both current/incoming fonts before capturing the transaction snapshot:

```javascript
async function preloadPsdMutationAssets(prepared) {
  prepared.imagePaints = new Map();
  prepared.resolvedFonts = new Map();
  for (var plan of prepared.plans) {
    if (plan.target.node.type === "TEXT" && plan.target.node.fontName) {
      await figma.loadFontAsync(plan.target.node.fontName);
    }
    if (plan.categories.includes("textContent") || plan.categories.includes("textStyle")) {
      prepared.resolvedFonts.set(plan.layerId, await loadBestFont(plan.source, prepared.context));
    }
    if (plan.categories.includes("content") || plan.categories.includes("nineSlice")) {
      prepared.imagePaints.set(
        plan.layerId,
        await createImagePaint(plan.source, prepared.context, "FILL", null),
      );
    }
  }
}
```

Define the added-layer transaction used by the final apply sequence:

```javascript
function preparePsdAddedLayerTransaction() {
  return {
    stagingFrame: null,
    createdStagingFrame: false,
    existingChildIds: new Set(),
    createdNodes: [],
    createdNodeIds: new Set(),
  };
}

async function applyPsdAddedLayers(prepared, transaction) {
  if (prepared.diff.added.length === 0) return;
  transaction.stagingFrame = findPsdIncrementalStagingFrame(prepared.target);
  if (!transaction.stagingFrame) {
    transaction.stagingFrame = createPsdIncrementalStagingFrame(prepared.target);
    transaction.createdStagingFrame = true;
  } else {
    transaction.existingChildIds = new Set(transaction.stagingFrame.children.map(function (child) {
      return child.id;
    }));
  }
  transaction.createdNodeIds.add(transaction.stagingFrame.id);
  for (var item of prepared.diff.added) {
    var node = await createLayerNode(transaction.stagingFrame, item.source, prepared.context);
    if (!node) continue;
    transaction.createdNodes.push(node);
    transaction.createdNodeIds.add(node.id);
  }
}
```

`verifyPsdAppliedFields` compares every `changedPath` against the incoming display/text/content/nine-slice value or `plan.expectedGeometry`, using numeric tolerance `0.01`. It also calls the existing image-hash and nine-slice image-hash verifiers. A missing property, mixed Figma value, wrong font, or unmatched slice is a verification error; no source-state metadata is written while any error exists.

- [ ] **Step 8: Rewrite apply around preflight, one transaction, verification, and state persistence**

The final order in `applyPsdIncrementalUpdate` is:

```javascript
var prepared = await preparePsdIncrementalUpdate(job, assets);
if (prepared.diff.status !== "preview-ready") return buildPsdIncrementalResult(prepared, "apply-blocked");
assertPsdPreviewFingerprint(job.baselineFingerprint, prepared.baselineFingerprint);
await preloadPsdMutationAssets(prepared);
var structureBefore = capturePsdStructuralSnapshot(prepared.target);
var rollbackRecords = prepared.plans.map(function (plan) {
  return capturePsdMutationRollback(plan.target.node);
});
var addedTransaction = preparePsdAddedLayerTransaction();
try {
  await applyPsdAddedLayers(prepared, addedTransaction);
  await applyPsdMutationPlans(prepared);
  var verificationErrors = verifyPsdStructuralSnapshot(structureBefore, addedTransaction.createdNodeIds)
    .concat(verifyPsdAppliedFields(prepared.plans));
  if (verificationErrors.length) throw new Error(verificationErrors.join("; "));
  for (var plan of prepared.plans) writeLayerMetadata(plan.target.node, plan.source, {});
  writePsdRootMetadata(prepared.target, job, prepared.manifest);
  if (typeof figma.commitUndo === "function") figma.commitUndo();
} catch (error) {
  var rollbackErrors = await rollbackPsdIncrementalMutation(rollbackRecords, addedTransaction, prepared);
  rollbackErrors.push(...verifyPsdStructuralSnapshot(structureBefore, new Set()));
  if (rollbackErrors.length) throw new Error(String(error) + "; rollback drift: " + rollbackErrors.join("; "));
  throw error;
}
return buildPsdIncrementalResult(prepared, "applied");
```

`preparePsdAddedLayerTransaction` retains the existing staging-frame behavior: new layers are appended under the staging frame, each new node receives schema-v3 metadata, and rollback removes only nodes/staging containers created by this transaction. Missing source layers remain untouched. Only successfully verified existing and added nodes receive the incoming `psdSourceState`. `updatedCount` equals unique changed existing nodes, not per-field writes. Calling apply for a no-change or baseline-required preview remains blocked.

- [ ] **Step 9: Expand preview serialization and fingerprinting**

`buildPsdIncrementalResult` serializes each field change as `{path, category, before, after, delta}` and exposes the category summary. The fingerprint includes target ID, node/parent/order/type, live writable-field signatures, stored source-state hashes, incoming source-state hashes, and added/missing Layer ID sets.

- [ ] **Step 10: Run focused runtime tests**

```powershell
node --test tests/psd-incremental-diff.test.mjs tests/psd-incremental-runtime.test.mjs
```

Expected: all mutation-plan, structural, rollback, identity, and diff tests PASS.

- [ ] **Step 11: Commit the Figma transaction slice**

```powershell
git add code/05_utils.js code/06_psd_incremental.mjs tests/psd-incremental-diff.test.mjs tests/psd-incremental-runtime.test.mjs
git commit -m "Merge approved PSD changes without dismantling organized Figma nodes" -m "Constraint: Node identity, names, hierarchy, order, component boundaries, and non-PSD children remain Figma-owned." -m "Rejected: Subtree re-import | It would discard organization-time work." -m "Confidence: medium" -m "Scope-risk: broad" -m "Directive: New PSD fields must join diff, preflight, rollback, verification, and source-state persistence together." -m "Tested: Node pure diff and runtime transaction contract tests." -m "Not-tested: Live Figma canvas behavior is covered after gateway and UI integration."
```

### Task 5: Expose all preview states and baseline adoption through the gateway

**Files:**
- Modify: `ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py:595-601,624-705`
- Modify: `ai/skills/psd-layer-to-figma/tests/test_submit_psd_incremental_status.py`
- Modify: `src/psdImportTask.ts:12-245`
- Modify: `src/httpServer.ts` at the existing PSD import routes
- Modify: `tests/psd-incremental-task.test.mjs`

- [ ] **Step 1: Write failing Python terminal-status tests**

```python
def test_preview_accepts_every_non_error_terminal_preview(self):
    for status in (
        "preview-ready",
        "preview-blocked",
        "preview-no-changes",
        "preview-baseline-required",
    ):
        self.assertTrue(
            MODULE.is_successful_import_status(status, "incremental-preview"),
            status,
        )

def test_baseline_adoption_requires_baseline_adopted(self):
    self.assertTrue(MODULE.is_successful_import_status(
        "baseline-adopted", "incremental-baseline-adopt"
    ))
    self.assertFalse(MODULE.is_successful_import_status(
        "applied", "incremental-baseline-adopt"
    ))
```

- [ ] **Step 2: Write failing gateway lifecycle contracts**

```javascript
test("gateway preserves all preview terminal states", () => {
  for (const status of [
    "preview-ready", "preview-blocked", "preview-no-changes", "preview-baseline-required",
  ]) {
    assert.match(taskSource, new RegExp(status));
  }
  assert.match(taskSource, /const previewStatus = stringValue\(result\.status\)/);
});

test("baseline adoption reuses artifacts but cannot call apply", () => {
  assert.match(taskSource, /adoptPsdImportBaseline/);
  assert.match(taskSource, /incremental-baseline-adopt/);
  assert.match(httpSource, /\/adopt-baseline/);
  assert.match(submitSource, /baseline-adopted/);
});

test("only preview-ready can enter incremental apply", () => {
  assert.match(taskSource, /task\.status !== "preview-ready"/);
  assert.match(taskSource, /task\.status !== "preview-baseline-required"/);
});
```

- [ ] **Step 3: Run and verify failure**

```powershell
python -m unittest ai.skills.psd-layer-to-figma.tests.test_submit_psd_incremental_status -v
node --test tests/psd-incremental-task.test.mjs
```

Expected: FAIL because no-change, baseline-required, and adoption are not modeled.

- [ ] **Step 4: Extend submit-script modes and terminal statuses**

```python
def is_successful_import_status(status: str, import_mode: str) -> bool:
    if import_mode == "incremental-preview":
        return status in {
            "preview-ready",
            "preview-blocked",
            "preview-no-changes",
            "preview-baseline-required",
        }
    if import_mode == "incremental-baseline-adopt":
        return status == "baseline-adopted"
    if import_mode == "incremental-apply":
        return status == "applied"
    return status == "completed"
```

Add `incremental-baseline-adopt` to the `--import-mode` choices. It requires `--target-node-id` but does not require `--baseline-fingerprint`.

- [ ] **Step 5: Model terminal preview states in `psdImportTask.ts`**

```typescript
type PsdImportMode =
  | "initial"
  | "incremental-preview"
  | "incremental-baseline-adopt"
  | "incremental-apply";

type PsdPreviewStatus =
  | "preview-ready"
  | "preview-blocked"
  | "preview-no-changes"
  | "preview-baseline-required";

type PsdImportTaskStatus =
  | "queued"
  | "running"
  | PsdPreviewStatus
  | "baseline-adopted"
  | "completed"
  | "error";
```

When a preview result returns, validate `result.status` against the four-value preview set, retain `preview` and `baselineFingerprint`, and set `task.status` to the exact preview status. A fingerprint remains required for every preview terminal state so stale UI state can be rejected.

- [ ] **Step 6: Add a distinct baseline-adoption task action**

```typescript
export function adoptPsdImportBaseline(
  config: GatewayConfig,
  taskId: string,
  payload: unknown
): PsdImportTask {
  const task = tasks.get(taskId);
  if (!task || task.status !== "preview-baseline-required") {
    throw new Error("PSD source baseline adoption is not available");
  }
  const providedFingerprint = isRecord(payload) ? stringValue(payload.baselineFingerprint) : "";
  if (!providedFingerprint || providedFingerprint !== task.baselineFingerprint) {
    throw new Error("PSD baseline preview fingerprint does not match");
  }
  task.mode = "incremental-baseline-adopt";
  task.status = "queued";
  task.stage = "queued_baseline_adopt";
  task.percent = 0;
  task.error = undefined;
  task.updatedAt = Date.now();
  void runPsdImportTask(config, task, { reuseExportArtifacts: true });
  return serializePsdImportTask(task);
}
```

`runPsdImportTask` accepts only `baseline-adopted` for this mode and reports completion without claiming canvas mutation.

- [ ] **Step 7: Add the HTTP route**

Next to the existing `/apply` route:

```typescript
const psdBaselineMatch = pathname.match(/^\/psd-to-figma\/import\/([^/]+)\/adopt-baseline$/);
if (request.method === "POST" && psdBaselineMatch) {
  const payload = await readJsonBody(request);
  try {
    jsonResponse(response, 200, {
      ok: true,
      task: adoptPsdImportBaseline(config, decodeURIComponent(psdBaselineMatch[1]), payload),
    });
  } catch (error) {
    jsonResponse(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return;
}
```

- [ ] **Step 8: Run gateway tests and typecheck**

```powershell
python -m unittest ai.skills.psd-layer-to-figma.tests.test_submit_psd_incremental_status -v
node --test tests/psd-incremental-task.test.mjs
npm run typecheck
```

Expected: Python and Node tests PASS; TypeScript reports no errors.

- [ ] **Step 9: Commit the gateway lifecycle slice**

```powershell
git add ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py ai/skills/psd-layer-to-figma/tests/test_submit_psd_incremental_status.py src/psdImportTask.ts src/httpServer.ts tests/psd-incremental-task.test.mjs
git commit -m "Distinguish no-op, blocked, and baseline-required PSD previews" -m "Constraint: Only preview-ready may enter canvas mutation; baseline adoption is metadata-only." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: Python terminal-status tests, Node gateway contracts, and TypeScript typecheck."
```

### Task 6: Render field-level preview and prevent fake success in the UI

**Files:**
- Modify: `ui.html:3040-3221` and the existing PSD incremental dialog markup/style
- Modify: `tests/psd-incremental-ui.test.mjs`

- [ ] **Step 1: Write failing UI state/action tests**

```javascript
test("polling stops for every preview terminal state", () => {
  assert.match(ui, /PSD_PREVIEW_TERMINAL_STATUSES/);
  for (const status of [
    "preview-ready", "preview-blocked", "preview-no-changes", "preview-baseline-required",
  ]) {
    assert.match(ui, new RegExp(status));
  }
});

test("confirmation is enabled only for preview-ready", () => {
  assert.match(ui, /preview\.status === "preview-ready"/);
  assert.match(ui, /confirmPsdIncrementalBtn\.disabled = !canApply/);
  assert.match(ui, /preview-no-changes/);
  assert.match(ui, /没有可同步的 PSD 变化/);
});

test("baseline adoption uses a distinct button and endpoint", () => {
  assert.match(ui, /id="adoptPsdBaselineBtn"/);
  assert.match(ui, /function adoptPsdIncrementalBaseline/);
  assert.match(ui, /\/adopt-baseline/);
});

test("preview renders category totals and before-after field rows", () => {
  for (const field of ["position", "size", "rotation", "display", "textStyle", "nineSlice"]) {
    assert.match(ui, new RegExp(field));
  }
  assert.match(ui, /change\.before/);
  assert.match(ui, /change\.after/);
  assert.match(ui, /change\.delta/);
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test tests/psd-incremental-ui.test.mjs
```

Expected: FAIL because only `preview-ready` is recognized and the dialog lacks no-change/baseline actions.

- [ ] **Step 3: Add preview-state constants and stop polling deterministically**

```javascript
var PSD_PREVIEW_TERMINAL_STATUSES = new Set([
  "preview-ready",
  "preview-blocked",
  "preview-no-changes",
  "preview-baseline-required",
]);

if (PSD_PREVIEW_TERMINAL_STATUSES.has(task.status)) {
  psdImportBusy = false;
  clearPsdImportPollTimer();
  showPsdIncrementalPreview(task.preview, {
    taskId: task.taskId,
    fileName: task.fileName,
    targetName: task.target && task.target.targetName || "",
    targetType: task.target && task.target.targetType || "",
  });
  return;
}
```

- [ ] **Step 4: Render the complete category summary and changes**

Use one category definition table:

```javascript
var PSD_DIFF_CATEGORIES = [
  ["content", "图像内容"],
  ["textContent", "文字内容"],
  ["position", "位置"],
  ["size", "尺寸"],
  ["rotation", "旋转"],
  ["display", "显隐/透明度/混合/约束"],
  ["textStyle", "文字样式"],
  ["nineSlice", "九宫切片"],
];
```

Each changed layer row displays source name, Layer ID, and escaped field rows formatted as `path: before -> after`; numeric deltas append `(delta +N)` or `(delta -N)`. The summary includes affected, added, retained missing, unchanged, unsupported/conflict, and baseline-required counts.

- [ ] **Step 5: Gate confirm, baseline adoption, and no-change behavior**

```javascript
var canApply = preview.status === "preview-ready"
  && preview.canApply === true
  && !!activePsdIncrementalPreview.baselineFingerprint;
confirmPsdIncrementalBtn.disabled = !canApply;
confirmPsdIncrementalBtn.hidden = preview.status !== "preview-ready";
adoptPsdBaselineBtn.hidden = preview.status !== "preview-baseline-required";
adoptPsdBaselineBtn.disabled = preview.status !== "preview-baseline-required";

if (preview.status === "preview-no-changes") {
  summaryLines.push("没有可同步的 PSD 变化，Figma 不会执行写入。");
}
```

`preview-blocked` lists conflicts and offers only close/cancel. `preview-no-changes` never calls `/apply` and completes the drop promise as `{status: "preview-no-changes"}` rather than applied success.

- [ ] **Step 6: Add baseline-adoption button and handler**

```html
<button class="secondary" id="adoptPsdBaselineBtn" hidden>采用当前 PSD 作为同步基线</button>
```

```javascript
async function adoptPsdIncrementalBaseline() {
  var active = activePsdIncrementalPreview;
  if (!active || adoptPsdBaselineBtn.disabled) return;
  adoptPsdBaselineBtn.disabled = true;
  var response = await fetchWithTimeout(
    relayEndpoint("/psd-to-figma/import/" + encodeURIComponent(active.taskId) + "/adopt-baseline"),
    {
      method: "POST",
      headers: relayRuntimeHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ baselineFingerprint: active.baselineFingerprint }),
    },
    30000,
  );
  var data = await response.json().catch(function () { return {}; });
  if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
  psdIncrementalDialog.hidden = true;
  psdImportBusy = true;
  renderPsdImportTaskStatus(data.task);
  pollPsdImportTaskStatus();
}
```

Register the button click next to the existing cancel/confirm listeners. The completion message must say the synchronization baseline was stored and the canvas was not changed.

Handle the baseline terminal task before the normal completed/error branch:

```javascript
if (task.status === "baseline-adopted") {
  psdImportBusy = false;
  clearPsdImportPollTimer();
  activePsdIncrementalPreview = null;
  setAiPromptStatus("PSD 同步基线已保存，Figma 画布内容和布局未发生变化。");
  finishPsdImportTaskPromise(null, task);
  return;
}
```

- [ ] **Step 7: Run UI and initialization regressions**

```powershell
node --test tests/psd-incremental-ui.test.mjs tests/figma-ui-initialization.test.mjs
```

Expected: all tests PASS and the inline UI script remains syntactically valid.

- [ ] **Step 8: Check edited Chinese text before committing**

```powershell
rg -n "\\u[0-9A-Fa-f]{4}|\?\?\?|�|锟|鏂|寰|鍙|纭|澧" ui.html tests/psd-incremental-ui.test.mjs
```

Expected: no newly introduced escape sequences, replacement characters, question-mark corruption, or mojibake markers. Existing unrelated legacy mojibake must not be broadened or rewritten in this slice.

- [ ] **Step 9: Commit the UI slice**

```powershell
git add ui.html tests/psd-incremental-ui.test.mjs
git commit -m "Show users exactly which PSD fields will change" -m "Constraint: No-change and blocked previews must never present an enabled apply action." -m "Confidence: high" -m "Scope-risk: moderate" -m "Directive: Keep baseline adoption visually and semantically separate from canvas mutation." -m "Tested: PSD incremental UI and plugin initialization Node tests plus UTF-8 marker scan."
```

### Task 7: Rebuild and run the full automated verification gate

**Files:**
- Regenerate: `.build_version`
- Regenerate: `code.js`
- Verify: every feature file from Tasks 1-6

- [ ] **Step 1: Run all focused tests from a clean command invocation**

```powershell
python -m unittest ai.skills.psd-layer-to-figma.tests.test_export_psd_source_state ai.skills.psd-layer-to-figma.tests.test_export_psd_layer_ids ai.skills.psd-layer-to-figma.tests.test_submit_psd_incremental_status -v
node --test tests/psd-incremental-diff.test.mjs tests/psd-incremental-runtime.test.mjs tests/psd-incremental-task.test.mjs tests/psd-incremental-ui.test.mjs tests/figma-ui-initialization.test.mjs
npm run typecheck
```

Expected: every Python and Node test PASS; TypeScript reports zero errors.

- [ ] **Step 2: Rebuild generated plugin code**

```powershell
python scripts/build.py
```

Expected: build output lists `06_psd_incremental.mjs`, increments `.build_version`, and regenerates `code.js` without syntax errors.

- [ ] **Step 3: Prove the generated artifact contains the schema-v3 implementation**

```powershell
rg -n "psdSourceState|preview-no-changes|preview-baseline-required|incremental-baseline-adopt|computePsdGeometryTarget" code.js
```

Expected: every marker exists in `code.js`.

- [ ] **Step 4: Run the broad Node regression suite**

```powershell
node --test tests/*.test.mjs
```

Expected: all repository Node tests PASS. If an unrelated pre-existing test fails, record its exact name/output and keep the focused suite green; do not edit unrelated user files to hide it.

- [ ] **Step 5: Run whitespace, scope, and encoding checks**

```powershell
git diff --check
git status --short
git diff --name-only HEAD~6..HEAD
rg -n "\\u[0-9A-Fa-f]{4}|\?\?\?|�" ai/skills/psd-layer-to-figma/scripts/export_psd_layers.py ai/skills/psd-layer-to-figma/scripts/summarize_manifest.py code/01_handlers.js code/05_utils.js code/06_psd_incremental.mjs src/psdImportTask.ts ui.html tests/psd-incremental-*.mjs
```

Expected: no whitespace errors; only intended feature files plus generated artifacts differ; no newly introduced corruption markers.

- [ ] **Step 6: Commit generated artifacts**

```powershell
git add .build_version code.js
git commit -m "Ship the verified schema-v3 PSD incremental runtime" -m "Constraint: Generated code must match the reviewed source modules exactly." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: Focused Python and Node suites, TypeScript typecheck, plugin build, broad Node regression, diff and encoding checks."
```

### Task 8: Recover and verify the diagnosed Layer ID 406 update in live Figma

**Files:**
- Read only: `.tmp/psd-to-figma/psd-1784529404575-d41d4e/layers/manifest_summary.json`
- Read only: `.tmp/psd-to-figma/psd-1784529520599-cc73a4/layers/manifest_summary.json`
- Write temporary evidence only under a new `.tmp/psd-full-state-live-verification/` directory
- Do not commit temporary evidence

- [ ] **Step 1: Verify the live relay/plugin and retained manifests**

```powershell
$relay = Invoke-RestMethod -Uri 'http://127.0.0.1:32130/health' -Method Get
$relay | ConvertTo-Json -Depth 8
Test-Path -LiteralPath '.tmp/psd-to-figma/psd-1784529404575-d41d4e/layers/manifest_summary.json'
Test-Path -LiteralPath '.tmp/psd-to-figma/psd-1784529520599-cc73a4/layers/manifest_summary.json'
```

Expected: relay health is `ok`, plugin is connected, and both manifests exist. If the live session/file changed, resolve the current file key and target from the actual selection before continuing.

- [ ] **Step 2: Capture the target structure before mutation**

```powershell
New-Item -ItemType Directory -Force -Path '.tmp/psd-full-state-live-verification' | Out-Null
@'
import json
from pathlib import Path
from client.figma_mcp_client import query_node_children

result = query_node_children("7195:855", file_key="ly2b1kkcvLtNBFPSQi4XO4")
Path(".tmp/psd-full-state-live-verification/before.json").write_text(
    json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
)
'@ | python -
```

Expected: evidence includes Layer ID `406` node `7195:882`, its current parent/name/order, and geometry. If those IDs no longer exist, re-resolve by `psdLayerId=406` rather than guessing.

- [ ] **Step 3: Adopt the retained old manifest as the schema-v3 baseline**

```powershell
python ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py .tmp/psd-to-figma/psd-1784529404575-d41d4e/layers/manifest_summary.json --import-mode incremental-baseline-adopt --file-key ly2b1kkcvLtNBFPSQi4XO4 --target-node-id 7195:855 --source-file-name source.psd --relay-url http://127.0.0.1:32130 --wait --timeout 240 --result-output .tmp/psd-full-state-live-verification/baseline-result.json
```

Expected: result status is `baseline-adopted`; canvas geometry/content/structure are unchanged; stored Layer ID `406` source state has `geometry.y=1514`.

- [ ] **Step 4: Preview the newer manifest and prove the position delta**

```powershell
python ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py .tmp/psd-to-figma/psd-1784529520599-cc73a4/layers/manifest_summary.json --import-mode incremental-preview --file-key ly2b1kkcvLtNBFPSQi4XO4 --target-node-id 7195:855 --source-file-name source.psd --relay-url http://127.0.0.1:32130 --wait --timeout 240 --result-output .tmp/psd-full-state-live-verification/preview-result.json
$previewEnvelope = Get-Content -LiteralPath '.tmp/psd-full-state-live-verification/preview-result.json' -Raw | ConvertFrom-Json
$preview = if ($previewEnvelope.result) { $previewEnvelope.result } else { $previewEnvelope }
$preview | ConvertTo-Json -Depth 20
```

Expected: status `preview-ready`; Layer ID `406` reports `geometry.y: 1514 -> 1196`, delta `-318`; category summary includes one position change; content remains unchanged.

- [ ] **Step 5: Apply the exact fingerprinted preview**

```powershell
$fingerprint = [string]$preview.baselineFingerprint
if (-not $fingerprint) { throw 'Preview fingerprint missing' }
python ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py .tmp/psd-to-figma/psd-1784529520599-cc73a4/layers/manifest_summary.json --import-mode incremental-apply --baseline-fingerprint $fingerprint --file-key ly2b1kkcvLtNBFPSQi4XO4 --target-node-id 7195:855 --source-file-name source.psd --relay-url http://127.0.0.1:32130 --wait --timeout 240 --result-output .tmp/psd-full-state-live-verification/apply-result.json
```

Expected: status `applied`, `updatedCount=1`, and no rollback or structural error.

- [ ] **Step 6: Capture after state and compare invariants**

```powershell
@'
import json
from pathlib import Path
from client.figma_mcp_client import query_node_children

result = query_node_children("7195:855", file_key="ly2b1kkcvLtNBFPSQi4XO4")
Path(".tmp/psd-full-state-live-verification/after.json").write_text(
    json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
)
'@ | python -
```

Expected: Layer ID `406` moved upward by 318 selected-root pixels; node ID `7195:882`, name, `[BottomBtns]` parent, sibling order, size, and image content are unchanged.

- [ ] **Step 7: Repeat the same PSD and prove no-op semantics**

```powershell
python ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py .tmp/psd-to-figma/psd-1784529520599-cc73a4/layers/manifest_summary.json --import-mode incremental-preview --file-key ly2b1kkcvLtNBFPSQi4XO4 --target-node-id 7195:855 --source-file-name source.psd --relay-url http://127.0.0.1:32130 --wait --timeout 240 --result-output .tmp/psd-full-state-live-verification/repeat-preview-result.json
```

Expected: status `preview-no-changes`, `affected=0`, and the UI never enables or calls apply.

- [ ] **Step 8: Reopen/reload the plugin and verify metadata persistence**

Reload the active plugin build, query the same target, and repeat Step 7.

Expected: `preview-no-changes` still holds after reload, proving schema-v3 baseline data is stored in Figma rather than in process memory or an external mapping file.

- [ ] **Step 9: Final repository and evidence check**

```powershell
git status --short
git log --oneline -8
```

Expected: temporary evidence remains untracked under `.tmp`; only pre-existing unrelated untracked files remain; all feature commits and automated verification evidence are present.

## Completion Criteria

- Layer ID `406` position-only change is detected and applied as a `-318` root-space delta.
- Every safely representable PSD-derived field is normalized, diffed, previewed, applied, rolled back, verified, and persisted.
- Unsupported changed PSD fields become visible blocking conflicts.
- Node identity, name, parent, sibling order, component/instance identity, and non-PSD children are unchanged.
- Schema-v2 targets require explicit metadata-only baseline adoption; the runtime never guesses the old PSD baseline from organized Figma geometry.
- Repeating an already applied PSD returns `preview-no-changes` and cannot produce fake `applied` success.
- Focused tests, full Node regressions, TypeScript typecheck, build, diff checks, encoding checks, and live Figma verification all pass.
