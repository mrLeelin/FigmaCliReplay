# PSD Full Source-State Incremental Sync Design

**Status:** Approved direction, pending written-spec review
**Date:** 2026-07-20
**Scope:** PSD-to-Figma incremental update only

## Problem

The current incremental updater matches PSD layers to organized Figma nodes by Photoshop Layer ID, but it classifies matched layers only by `contentHash`. This correctly detects raster pixel and text-character changes, yet silently ignores other PSD changes.

The live failure that motivated this design is concrete:

- PSD Layer ID `406` (`ui_anniu_1`) moved from `y=1514` to `y=1196`.
- Its rendered PNG and `contentHash` remained unchanged.
- The preview reported `changed=0` and `unchanged=58`.
- Apply returned `status=applied` with `updatedCount=0`.
- The organized Figma node stayed in its old visual position.

This is not a transport or plugin-connection failure. It is a source-state diff and ownership-model gap.

## Decision

Incremental update will synchronize every PSD-derived property that the parser and Figma Plugin API can represent safely for a matched source layer. Figma will continue to own organization structure.

In practical terms:

- PSD owns source content, source geometry changes, source display state, source text styling, and source nine-slice data.
- Figma owns node identity, node name, parent, grouping, sibling order, component topology, and Figma-only additions.
- PSD geometry changes are merged as deltas onto the current organized Figma node instead of resetting the node to its original import position.
- Unsupported source properties are reported as explicit warnings or blocking conflicts. They are never silently counted as unchanged.

This is a field-level merge, not a subtree re-import.

## Goals

- Detect source changes beyond pixel and character hashes.
- Synchronize position, size, rotation where representable, visibility, opacity, blend mode, inferred constraints, raster content, text content, text style, and nine-slice source state.
- Preserve organized Figma names, parents, groups, sibling order, and component structure.
- Keep PSD/Figma synchronization metadata inside Figma `SharedPluginData`.
- Preserve preview-first confirmation, stale-preview protection, rollback, undo, and post-apply verification.
- Make a zero-mutation update visibly report `no-changes` instead of success.
- Provide a safe migration path for existing schema-v2 imports.

## Non-Goals

- Mirroring the PSD folder/group tree into an already organized Figma subtree.
- Renaming organized Figma nodes when a PSD layer name changes.
- Automatically deleting Figma nodes for missing PSD layers.
- Reparenting matched Figma nodes to reproduce PSD hierarchy changes.
- Storing Figma IDs in Unity or creating an external mapping JSON.
- Guessing identity for recreated PSD layers that have a new Photoshop Layer ID.
- Claiming support for a PSD property that the parser cannot decode reliably.

## Ownership Model

| Data | Owner | Incremental behavior |
| --- | --- | --- |
| Photoshop Layer ID | PSD | Stable matching key |
| Raster pixels | PSD | Replace when the source hash changes |
| Text characters | PSD | Replace when characters change |
| Text font, size, leading, alignment, fill, stroke, shadow | PSD when parsed | Update only fields changed by PSD |
| Source position | PSD delta | Apply root-space delta to current Figma position |
| Source width and height | PSD ratio | Apply source size ratio to current Figma size |
| Source rotation | PSD delta when parsed | Apply angle delta to current Figma rotation |
| Visibility and opacity | PSD | Apply incoming value when PSD changed it |
| Blend mode | PSD when mapping is supported | Apply mapped value or block explicitly |
| Constraints | Derived from PSD geometry | Refresh when geometry/canvas inputs change |
| Nine-slice source image and borders | PSD | Update only PSD-owned slice representation |
| Figma node name | Organized Figma | Preserve |
| Parent, grouping, and sibling order | Organized Figma | Preserve |
| Component/instance topology | Organized Figma | Preserve; block unsafe field writes |
| Figma-only effects and annotations | Organized Figma | Preserve unless the same field is PSD-owned |

"Synchronize all PSD changes" therefore means all supported PSD source fields on matched identities. It does not mean replacing the organized Figma hierarchy.

## Source-State Schema

The Figma metadata schema advances from version 2 to version 3.

Each matched source node stores a canonical JSON value under the existing `psd_layer_to_figma_bridge` namespace:

```json
{
  "version": 3,
  "layerId": "406",
  "mode": "image",
  "geometry": {
    "x": 580,
    "y": 1514,
    "width": 363,
    "height": 140,
    "rotation": 0
  },
  "display": {
    "visible": true,
    "opacity": 1,
    "blendMode": "NORMAL",
    "constraints": {
      "horizontal": "CENTER",
      "vertical": "CENTER"
    }
  },
  "content": {
    "contentHash": "sha256-value"
  },
  "text": null,
  "nineSlice": null
}
```

The canonical value is written as `psdSourceState`. A stable hash of the canonical value is written as `psdSourceStateHash` for fast fingerprinting and diagnostics.

The existing keys remain during migration:

- `psdLayerId`
- `psdOriginalName`
- `psdContentHash`
- `psdOwnership`

The root stores `psdImportSchemaVersion=3`. No absolute file path, Figma node ID mapping, or external snapshot is added.

## Manifest Normalization

The exporter will produce one normalized source-state record per manifest layer. Normalization keeps pure diff logic independent of raw nested manifest shapes.

### Geometry

- `x`, `y`, `width`, and `height` come from PSD layer bounds.
- Rotation is emitted when it can be decoded reliably.
- Text rotation may be derived from the `TySh` transform matrix.
- Placed/smart-object rotation is emitted only after its transform tag is decoded and tested.
- Raster layers without an independent rotation record rely on rendered pixels and bounds; the manifest must not invent a rotation value.

### Display state

- `visible`
- normalized opacity in the range `0..1`
- mapped Figma blend mode when a supported mapping exists
- inferred constraints derived from source bounds and canvas size

### Text state

When text is represented as editable Figma text, the normalized state includes every parsed and writable field:

- characters
- resolved source/fallback font identity
- effective font size
- line height or leading
- horizontal alignment
- fill color and alpha
- stroke enabled, color, weight, and alignment
- drop-shadow parameters when fully decoded

If a text property is present in PSD data but cannot be represented safely in Figma, preview reports it as unsupported. It must not disappear into the `unchanged` count.

### Nine-slice state

- source content hash
- slice type
- border values
- source rectangles
- target rectangles derived from the incoming source size

Updating nine-slice state may mutate PSD-owned `__slice_*` children, but must preserve the outer source node's identity, name, parent, and non-PSD children.

## Diff Model

`buildPsdIncrementalDiff` will compare three states for every matched Layer ID:

1. The last successfully applied PSD source state stored in Figma.
2. The current live Figma node state.
3. The incoming normalized PSD source state.

The source diff compares state 1 with state 3. State 2 is used for safe merge, stale-preview detection, rollback, and verification.

Each matched layer receives field-level change groups:

- `contentChanges`
- `geometryChanges`
- `displayChanges`
- `textStyleChanges`
- `nineSliceChanges`
- `unsupportedChanges`

A layer can appear in more than one group. Summary totals include both unique affected layers and per-category counts.

The preview statuses are:

- `preview-ready`: at least one safe mutation or new layer is available and no blocking conflict exists.
- `preview-blocked`: one or more blocking conflicts exist.
- `preview-no-changes`: no supported source field changed and no new layer exists.
- `preview-baseline-required`: one or more matched legacy nodes lack the previous PSD source state required for a safe delta.

`preview-no-changes` disables confirmation. It never transitions to an apply task.

## Geometry Merge

PSD geometry is expressed in selected-root coordinate space. Organized Figma nodes may be nested under arbitrary frames, so incoming PSD coordinates must not be assigned directly to `node.x` and `node.y`.

### Position

For every changed position:

```text
sourceDelta = incomingPsdPosition - baselinePsdPosition
desiredAbsolutePosition = currentFigmaAbsolutePosition + sourceDeltaInRootSpace
desiredLocalPosition = inverse(currentParentAbsoluteTransform) * desiredAbsolutePosition
```

The node keeps its current parent and sibling index. Matrix conversion is required for transformed parents; a simple subtraction is allowed only when both root and parent transforms are axis-aligned translations.

For the diagnosed Layer ID `406`, the source delta is `(0, -318)`. The organized Figma node therefore moves upward by 318 pixels in selected-root space without leaving `[BottomBtns]`.

### Size

For positive baseline dimensions:

```text
widthRatio = incomingPsdWidth / baselinePsdWidth
heightRatio = incomingPsdHeight / baselinePsdHeight
newFigmaWidth = currentFigmaWidth * widthRatio
newFigmaHeight = currentFigmaHeight * heightRatio
```

This preserves organization-time scaling while applying the PSD size change. Zero, non-finite, or unsupported dimensions are blocking conflicts.

Text resizing must use the existing font-loading and fitting rules, then restore the node's intended text auto-resize mode. Nine-slice resizing must rebuild only PSD-owned slice geometry.

### Rotation

When both baseline and incoming rotation are reliable:

```text
rotationDelta = incomingPsdRotation - baselinePsdRotation
newFigmaRotation = currentFigmaRotation + rotationDelta
```

If the parser cannot establish a reliable source rotation, no rotation change is claimed.

## Non-Geometry Field Merge

Only fields changed between baseline PSD state and incoming PSD state are written.

- PSD unchanged, Figma changed: keep the Figma value.
- PSD changed, Figma unchanged: apply the PSD value.
- PSD changed, Figma changed the same field: PSD wins because the user approved full PSD source synchronization.
- PSD change cannot be written safely to the current node representation: block before mutation.

Visibility, opacity, mapped blend mode, constraints, text style, and nine-slice fields use this rule. This prevents an unchanged PSD field from erasing intentional Figma organization work.

## Structural Safety

The following invariants must hold before and after apply for every existing matched node:

- node ID unchanged
- node name unchanged
- parent ID unchanged
- sibling index unchanged
- component/instance identity unchanged
- non-PSD children unchanged

The protected snapshot is updated so geometry and PSD-owned fields may change when planned, while the structural invariants remain strict.

An `INSTANCE`, `COMPONENT`, or converted representation may accept only fields that the Figma API exposes without detaching, replacing, or flattening it. Unsafe writes are blocking conflicts.

## Legacy Schema-v2 Migration

Schema-v2 nodes do not store previous PSD geometry or style state. Their organized Figma coordinates cannot be treated as the old PSD baseline because organization may already have moved or resized them.

The general migration is explicit:

1. Selecting a schema-v2 target and dropping a PSD produces `preview-baseline-required`.
2. The dialog offers `Adopt this PSD as source baseline` as a separate non-canvas-mutation action.
3. Adoption writes `psdSourceState` and advances the root to schema 3 without changing node content, geometry, style, name, or hierarchy.
4. Subsequent PSD drops use full field-level incremental sync.

Adoption is allowed only when Layer ID coverage and document identity pass the existing validation rules.

The currently diagnosed Figma target has retained pre-change artifacts under `.tmp`. A one-time migration may use the retained earlier manifest as the baseline so the known `y=1514` to `y=1196` delta can still be applied. This is a local recovery path, not a runtime dependency. If the earlier manifest is unavailable, the generic product must not guess the missing baseline.

## Preview UI

The confirmation dialog shows:

- unique affected-layer count
- pixel/content changes
- text-content changes
- position changes
- size changes
- rotation changes
- visibility/opacity/blend changes
- text-style changes
- nine-slice changes
- new layers
- missing layers retained
- unsupported changes
- blocking conflicts

Each affected layer includes a concise before/after description, for example:

```text
ui_anniu_1 (Layer ID 406)
Position: y 1514 -> 1196 (delta -318)
Figma structure: parent and order preserved
```

The confirm button is enabled only for `preview-ready`. Baseline adoption uses a distinct action and wording. `preview-no-changes` explains that the PSD file bytes may have changed while all supported source fields remained equivalent.

## Apply Transaction

Apply remains preview-bound and fingerprinted:

1. Re-parse and normalize the incoming manifest.
2. Re-collect live target nodes and schema-v3 source states.
3. Recompute the field-level diff.
4. Verify the preview fingerprint, target identity, and structural snapshot.
5. Preload all fonts, image bytes, and nine-slice update plans.
6. Capture rollback values for every field that will be written.
7. Apply content, text/style, geometry, display, and nine-slice mutations.
8. Verify planned field values and structural invariants.
9. Persist the incoming `psdSourceState` only for successfully verified nodes.
10. Update root metadata, then call `figma.commitUndo()` once.

Any failure rolls back all mutated fields, created nodes, source-state metadata, and root metadata. Rollback verification reports remaining drift precisely.

## Fingerprinting and Stale Preview Protection

The preview fingerprint includes:

- target root ID
- current node IDs and structural relationships
- current live values for fields eligible to change
- stored `psdSourceStateHash` values
- incoming normalized source-state hashes
- new/missing Layer ID sets

Changing a target field, moving a node, editing a style, modifying the PSD, or adopting a baseline while the dialog is open invalidates the preview.

## Component Boundaries

Implementation remains split along existing boundaries:

- `export_psd_layers.py`: parse and emit complete normalized PSD source fields.
- `summarize_manifest.py` / manifest compatibility: preserve the source-state fields used by the plugin payload.
- `code/06_psd_incremental.mjs`: pure normalization, canonicalization, source-state diff, and summary logic.
- `code/05_utils.js`: collect Figma baselines, convert root/absolute/local geometry, validate writable targets, apply, rollback, and verify.
- `src/psdImportTask.ts`: expose the new preview statuses without treating them as apply success.
- `ui.html`: show category counts, baseline adoption, no-change state, and confirmation rules.
- `scripts/build.py`: regenerate `code.js` from source modules.

No new dependency or external service is required.

## Error Handling

Blocking conflicts include:

- missing or duplicate Layer ID
- wrong PSD document identity
- missing schema-v3 baseline during normal apply
- invalid baseline or incoming geometry
- unsupported node type for a changed PSD-owned field
- missing or corrupt image bytes
- unavailable font required for a text mutation
- unsafe component/instance write
- unsupported changed blend/effect/rotation data that would otherwise be silently lost
- stale preview fingerprint
- structural drift during apply
- rollback drift

Warnings include source filename rename with strong Layer ID overlap and representational approximations that have explicit verified fallbacks.

## Testing Strategy

### Pure diff tests

- Same content hash with changed `x/y` produces `geometryChanges`.
- Same content hash with changed size, visibility, opacity, or style is not unchanged.
- One layer can contribute to multiple category counts but one unique affected count.
- Unsupported changed fields create conflicts.
- No field changes produce `preview-no-changes`.
- Missing baseline produces `preview-baseline-required`.
- Canonical hashes are stable across object-key order.

### Geometry tests

- Root-level position delta.
- Nested translated parent.
- Nested scaled/rotated parent using matrix inversion.
- Organization-time offset is preserved.
- Size ratios preserve organization-time scaling.
- Rotation deltas compose with current Figma rotation.
- Zero-size baseline blocks apply.

### Runtime apply tests

- Image content and geometry can change in one transaction.
- Text characters and every supported text-style field update together.
- Visibility, opacity, mapped blend mode, and constraints update only when PSD changed them.
- Nine-slice border changes update PSD-owned slices without touching non-PSD children.
- Parent, name, order, and component identity remain unchanged.
- Failed verification restores content, style, geometry, display state, and metadata.
- Source state persists only after verification succeeds.

### Gateway and UI tests

- `preview-no-changes` never enables apply.
- `preview-baseline-required` exposes only baseline adoption.
- Category counts and before/after details render safely.
- Apply requires the exact preview fingerprint.
- Baseline adoption does not mutate the canvas.

### Parser tests

- Existing bounds, visibility, opacity, blend, text, and nine-slice fields survive summary generation.
- Text transform rotation is decoded from fixtures.
- Unsupported transform records are reported rather than guessed.
- Source-state output remains stable for semantically identical PSD layers.

### Live Figma verification

Using the currently connected file and diagnosed target:

1. Record the selected target and Layer ID `406` node structure.
2. Adopt or recover the old schema-v3 source baseline with `y=1514`.
3. Preview the newer PSD with `y=1196`.
4. Verify the preview reports one position change with delta `-318`.
5. Confirm apply.
6. Verify the node moved by `-318` in selected-root space.
7. Verify its node ID, name, `[BottomBtns]` parent, sibling order, size, and image content are otherwise unchanged.
8. Repeat the same PSD and verify `preview-no-changes`.
9. Reopen the Figma file and repeat to prove metadata persistence.

## Success Criteria

- The diagnosed position-only PSD change is detected and applied.
- Every supported PSD-derived field participates in diff, preview, apply, rollback, and verification.
- Unsupported changed source fields are visible and block unsafe apply.
- Organized Figma structure remains unchanged.
- Schema-v3 metadata is stored only inside Figma.
- Existing schema-v2 files migrate explicitly without guessing source geometry.
- Zero-mutation updates no longer report applied success.
- Preview cancellation and all blocking failures leave the canvas unchanged.
- Fresh automated tests pass, generated `code.js` matches its modules, and live Figma verification proves the real canvas changed as intended.
