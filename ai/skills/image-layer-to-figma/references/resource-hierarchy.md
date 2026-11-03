# Resource hierarchy delivery

Use this after the raster resources have been imported, or when the user accepts the images but requests useful nesting. This phase reorganizes existing Figma nodes. It does not resubmit decomposition, replace image bytes, create ComponentSets, turn raster text into Text, or import Unity assets.

## Plan against the current root

1. Lock the authorized file, page and imported root through project CLI sessions and a targeted include-hidden analysis. Use `ai/skills/figma-hierarchy-cleanup/scripts/figma_hierarchy_cleanup_cli.py analyze --file-key <key> --session-id <session> --node-id <root> --include-hidden --output <analysis.json>`. Use the adjacent analysis reader for large results.
2. Describe the complete final tree using the actual root's direct child IDs. Every original direct child, including hidden ones, must occur exactly once. An existing Frame, Instance or nine-slice container is one indivisible resource reference; keep its descendants inside it.
3. Choose useful semantic depth from the UI. For example, a card can contain its base image, title group, complete illustration, rewards, fixed benefit entries and purchase button. Keep independent values and complete icons under their corresponding controls. These are examples, not a required screen template.
4. Keep sibling containers ordered by their earliest original member. A resource may cross another resource's original stacking position only when their bounds do not overlap. The executor conservatively rejects overlapping crossings; revise the tree rather than disabling that gate.

Groups have at least two direct children. A complete illustration can stay a leaf. Large flat groups with twelve or more direct resource children must be expanded into functional subgroups. New group names use `[EnglishId｜中文说明]` or another meaningful bracketed name. Existing leaf names and image data remain unchanged.

## Plan format

```json
{
  "schemaVersion": 1,
  "target": {"fileKey": "<file-key>", "pageId": "<page-id>", "nodeId": "<imported-root-id>"},
  "children": [
    {"nodeId": "<background-node-id>"},
    {
      "name": "[PurchaseButton｜购买按钮]",
      "children": [
        {"nodeId": "<complete-button-art-node-id>"},
        {"nodeId": "<price-node-id>"}
      ]
    }
  ]
}
```

The complete live plan must enumerate all real IDs; placeholders are only for explaining the schema. Add nested groups through `children`. Set `layoutIntent: "static-horizontal"` on a fixed strip whose children are item groups. Its geometry must show disjoint horizontal items, aligned vertical centers, stable spacing (confidence at least 0.85) and unique ownership. The check uses geometry, not names. The flag cannot exempt vertical or overlapping lists from scrolling requirements.

## Validate, apply, verify

From the repository root, validate without connecting to Figma:

```powershell
python -X utf8 ai/skills/image-layer-to-figma/scripts/structure_resources.py --plan <hierarchy.json> --analysis <analysis.json> --output-dir <validation-dir>
```

Review `hierarchy-tree.txt` and `compiled-hierarchy.json`, which contain the full original ID/name to final parent/order mapping. This is an explicit semantic plan; the executor does not infer a screen from naming prefixes or indices.

Within an already-authorized task, execute into a new run directory:

```powershell
python -X utf8 ai/skills/image-layer-to-figma/scripts/structure_resources.py --plan <hierarchy.json> --session-id <verified-session> --apply --output-dir <run-dir>
```

The script obtains a fresh analysis and native snapshot, resolves the root's containing Page (including roots inside Frames/Sections), and checks every source node's identity, parent, order and geometry before writing. It then submits one native cleanup transaction through the project CLI. The transaction creates tightly bounded, unfilled, non-clipping Frames with actual returned IDs. Operational failure uses the existing transaction rollback. No temporary containers, guessed IDs, helper renames or repeated root apply are needed.

Afterward, fresh analysis must match every planned parent/order, retain all original IDs and resource subtrees, preserve bounds within 0.01 Figma units, and produce an identical RGBA screenshot. Readback depth covers the native snapshot depth plus the proposed new groups so protected descendants are not truncated. Initial import screenshots can precede full image decoding; obtain the hierarchy baseline from a fresh export after the accepted assets render. On pixel mismatch, retain the reports and stop downstream delivery; a geometry check alone is not acceptance.

`report.json` reports `completed` only after live verification. Offline `validated`, a successful import and a native transaction `succeeded` are separate evidence. Raster text and inferred hidden pixels retain their existing limitations. Existing Unity Prefabs are not updated by this phase.

## Submission recovery

`state.json` saves the plan hash and request ID **before** submitting the write. Preserve the run directory. Once it contains a submission, any new offline validation or `--apply` in that directory is rejected without overwriting its baseline or compiled artifacts; use a separate directory for new validation. A timeout or lost response is recovered only with:

```powershell
python -X utf8 ai/skills/image-layer-to-figma/scripts/structure_resources.py --plan <same-hierarchy.json> --session-id <verified-session> --recover --output-dir <same-run-dir>
```

Recovery queries the recorded task and reruns read-only verification; it never submits another write. An unknown or unavailable task remains unresolved. The script does not manage Relay lifecycle or fall back to another port. Structured operation logs go to stderr; stdout contains compact JSON status only.
