# PSD to Figma Incremental Update Design

## Goal

Extend the existing PSD drag-and-drop workflow so the same drop gesture supports both initial import and incremental update:

- With no Figma selection, preserve the current behavior and create a new Figma hierarchy from the PSD.
- With exactly one selected `FRAME` or `COMPONENT`, treat that node as the incremental-update target.
- Preview the PSD-to-Figma differences and require an explicit confirmation before changing the selected target.
- Preserve the target's organized Figma names, hierarchy, order, component structure, and layout while updating PSD-owned visual content.
- Do not introduce Unity-side Figma or PSD identifiers, external mapping JSON, or a second hierarchy snapshot.

This design covers only PSD-to-Figma incremental update and its interaction with the existing organization step. Figma-to-Unity incremental synchronization is intentionally deferred.

## User Workflow

### Initial import

1. The user leaves the Figma canvas selection empty.
2. The user drags a PSD into the plugin.
3. The plugin runs the existing PSD import workflow unchanged.
4. Every imported source node receives hidden PSD source metadata in Figma `SharedPluginData`.
5. The user may rename, move, group, reorder, or otherwise organize the imported nodes.

### Incremental update

1. The user selects exactly one previously imported or organized `FRAME` or `COMPONENT`.
2. The user drags the updated PSD into the plugin.
3. The plugin detects the selection and enters incremental mode instead of initial-import mode.
4. The PSD is parsed without creating a second permanent Figma hierarchy.
5. The plugin compares PSD layers with PSD source metadata under the selected target.
6. A confirmation dialog summarizes the proposed changes.
7. Confirm applies the update to the selected target. Cancel makes no Figma changes.
8. The plugin reports the applied, skipped, new, missing, and conflicting layers.

### Invalid selection

- More than one selected node: reject the drop and ask the user to select one target or clear the selection.
- One selected node that is not a `FRAME` or `COMPONENT`: reject the drop without mutating Figma.
- A selected `FRAME` or `COMPONENT` without usable PSD source metadata: show that the target has no incremental-update baseline and offer no apply action.

## Source Identity

### PSD document identity

The selected target root stores a small source identity in the existing `psd_layer_to_figma_bridge` `SharedPluginData` namespace:

- `psdSourceKey`: a normalized source filename plus a document fingerprint suitable for detecting the wrong PSD.
- `psdCanvasWidth` and `psdCanvasHeight`: validation hints, not identity by themselves.
- `psdImportSchemaVersion`: metadata schema version.

The source key must not contain an absolute machine-local path. Moving or renaming the PSD file must not silently bind it to an unrelated target; when the filename changes but the layer identity set strongly matches, the dialog reports the rename and requires confirmation.

### PSD layer identity

The PSD parser must extract the Photoshop internal Layer ID from the PSD additional-layer-information `lyid` record. The import manifest carries this as `layerId`; the current order-based `idx` remains available only for display and ordering.

Each imported Figma source node stores:

- `psdLayerId`: Photoshop internal Layer ID.
- `psdOriginalName`: source-layer name at the last successful update.
- `psdContentHash`: hash of the last successfully applied PSD-owned content.
- `psdOwnership`: the fields that PSD is allowed to update for this node.

The metadata is embedded in the Figma node and moves with it during normal rename, reparent, and reorder operations. It is not written into node names, Unity assets, or an external JSON file.

### Metadata transfer during organization

Organization operations that keep the original node automatically keep its metadata. Operations that replace a source node with another node must explicitly transfer its PSD source metadata before removing the original.

Before incremental apply, the plugin scans the selected target and builds a `psdLayerId -> Figma node` index. Duplicate IDs are blocking conflicts; the plugin never guesses which duplicate should receive an update.

## Ownership Rules

Incremental update is a merge, not a re-import. Ownership is divided as follows:

| Data | Owner | Incremental behavior |
| --- | --- | --- |
| Raster image pixels | PSD | Replace when content changed |
| Source text characters | PSD by default | Replace characters only |
| Figma node name | Organized Figma | Preserve |
| Parent, grouping, and sibling order | Organized Figma | Preserve |
| Position, dimensions, rotation, and constraints | Organized Figma | Preserve |
| Component and instance structure | Organized Figma | Preserve |
| Figma effects added during organization | Organized Figma | Preserve unless explicitly PSD-owned |
| Nine-slice/component conversion policy | Organized Figma | Protect and report; do not flatten or recreate |

The first implementation updates raster image content and source text characters. It does not apply PSD layout, visibility, opacity, naming, or hierarchy changes to an already organized target.

## Diff Model

For every PSD layer in the new manifest, compare `psdLayerId` with the selected target index.

### Matched and unchanged

The Layer ID exists and the PSD-owned content hash is unchanged. Skip it without mutating the node.

### Matched and changed

The Layer ID exists and the PSD-owned content hash changed. Update only the fields permitted by `psdOwnership`, then persist the new content hash after the Figma mutation succeeds.

### New PSD layer

The Layer ID does not exist under the selected target. Do not guess a location in the organized hierarchy. The confirmation dialog reports it as new. On confirmation, create it under a dedicated direct child container named `__PSD新增待整理` within the selected target.

The container is created only when at least one new layer is applied. New nodes receive normal PSD source metadata so they participate in later updates. Their names initially use the PSD layer names and remain available for a later organization pass.

### Missing PSD layer

A stored Layer ID exists in Figma but not in the new PSD. Do not delete or hide the Figma node automatically. Report it as source-missing so the user can decide whether the organized result should retain it.

### Recreated PSD layer

Deleting a Photoshop layer and creating a same-named replacement produces a new Layer ID. Treat this as one missing layer plus one new layer. Name, position, size, or image similarity may be displayed as a possible relationship, but the first implementation must not auto-rebind it.

### Conflicts

Block apply when any of the following occurs:

- Two Figma nodes under the target have the same `psdLayerId`.
- The selected target belongs to a clearly different PSD document.
- A changed PSD layer maps to a Figma node type that cannot accept the owned content safely.
- Required raster bytes are missing or corrupt.
- The manifest contains duplicate or invalid Layer IDs.

## Confirmation Dialog

The dialog appears only after the PSD has been parsed and the diff has been computed. No Figma node mutation occurs before confirmation.

It displays:

- PSD filename.
- Selected target name and type.
- Matched changed count.
- Matched unchanged count.
- New-layer count.
- Missing-layer count.
- Conflict count.
- A short expandable list of affected layer names grouped by status.

Actions:

- `取消`: close the dialog and discard the prepared update without canvas changes.
- `确认增量更新`: enabled only when there are no blocking conflicts; applies the prepared diff to the same selected target captured when the PSD was dropped.

If the live Figma selection changes while the dialog is open, apply still targets the captured node only if it still exists and its baseline fingerprint is unchanged. Otherwise the prepared update expires and must be recomputed.

## Apply Transaction and Recovery

Figma does not provide a general multi-node transaction API, so the update must minimize partial writes:

1. Parse and validate the entire PSD payload.
2. Build and validate the complete diff.
3. Export or decode all required image bytes before touching the target.
4. Revalidate the captured target and source metadata.
5. Apply matched content replacements.
6. Create the new-layer staging container and new nodes, if needed.
7. Persist content hashes only after each corresponding mutation succeeds.
8. Run a post-apply verification scan and report any failure precisely.

The plugin must create a Figma undo checkpoint for the apply action so the user can undo the incremental update as one logical operation where supported by the Figma plugin runtime.

Cancel, parse failure, validation failure, or a blocking conflict must leave the selected Figma target unchanged.

## Interaction With Existing PSD Import

The existing drag/drop UI remains the single entry point. Mode selection is deterministic:

| Current Figma selection | Mode |
| --- | --- |
| Empty | Existing initial import |
| One `FRAME` | Incremental preview |
| One `COMPONENT` | Incremental preview |
| One other node type | Validation error |
| Multiple nodes | Validation error |

Initial import must write the new document and layer identity fields so future drops can use incremental mode. Existing imported targets that only contain `psdLayerIndex` are legacy baselines. They are not silently upgraded by index because layer order is unstable. A separate explicit baseline-adoption path may be designed later; it is outside this change.

## Testing

### PSD parser tests

- Extract `lyid` into the full manifest and `manifest_summary.json`.
- Preserve distinct Layer IDs across reorder and rename fixtures.
- Detect missing, malformed, and duplicate Layer IDs.
- Demonstrate that replacing pixel content on the same PSD layer retains Layer ID and changes content hash.

### Figma plugin unit tests

- Empty selection dispatches the existing initial import path.
- One `FRAME` or `COMPONENT` dispatches incremental preview.
- Invalid and multiple selections do not start import.
- Rename, reparent, and reorder of a Figma node do not break Layer ID matching.
- Changed image content updates only the image payload.
- Figma name, parent, order, geometry, and component structure remain unchanged.
- New layers go only to `__PSD新增待整理`.
- Missing layers are reported and retained.
- Duplicate IDs block apply.
- Cancel leaves the document unchanged.
- A stale captured target blocks apply.

### Integration verification

- Initial import a PSD through the real drag/drop UI.
- Organize the resulting Figma tree by renaming and regrouping nodes.
- Modify image pixels in the original PSD without recreating the layer.
- Select the organized root and drop the updated PSD.
- Verify the confirmation counts before apply.
- Confirm and verify only the expected visual content changed.
- Verify the organized hierarchy and names are identical before and after.
- Reopen the Figma file and repeat an update to prove metadata persistence.

## Success Criteria

- Existing no-selection PSD import behavior remains unchanged.
- Selecting one `FRAME` or `COMPONENT` and dropping a PSD always enters preview-first incremental mode.
- No Figma mutation occurs before explicit confirmation.
- Raster changes from the same PSD layer update the corresponding organized Figma node after rename or reparent.
- Organized Figma hierarchy, names, order, layout, and component structure are preserved.
- New and missing layers are handled conservatively without guessing or destructive deletion.
- No Unity object receives a PSD/Figma identity component.
- No external synchronization JSON or duplicate hierarchy snapshot is introduced.
