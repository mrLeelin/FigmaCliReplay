---
name: image-layer-to-figma
description: Split a flattened UI screenshot or PNG into complete transparent resources and deliver a nested business hierarchy in Figma through the project Relay CLI, or consolidate an over-fragmented decomposition. Existing PSD layers use psd-layer-to-figma.
---

# Image Layer To Figma

## Resource granularity

Default to assets the user can independently use, replace, resize, or animate. The goal is useful resource boundaries and faithful appearance. Layer count is a report field, not a quality target.

For each candidate split, identify a concrete independent use. Keep decorative parts of one illustration together when they serve the same use. A complaint about missing elements calls for a coverage review at the current granularity; it does not imply maximum-detail decomposition.

| Content | Default resource boundary | Reason to split further |
|---|---|---|
| Gift | Complete gift including bow, ribbon, and its own shading | User needs a lid/bow animation or independent replacement |
| Card illustration | Card, attached plants, tray, coins, and local decorative sparkles as one illustration | User requests individual animation or reuse of a particular object |
| Character | Complete character including attached accessories | Rigging or accessory variants are requested |
| Purchase button | Button artwork including fixed ornaments; price/label separate | A symbol has its own state, action, or replacement requirement |
| Benefit entry | Complete icon and separate caption | An icon part has an independent behavior |
| Currency bar | Reusable bar artwork, complete currency icon, balance, complete add button | A button state or skin requires a separate asset |
| Text | Whole meaningful line or changing value | A portion changes independently |

These defaults are contextual. Honor a requested finer or coarser boundary for that task. Maintain a brief resource list with each asset's intended use and any justified internal split. Show that list in a progress update when useful; existing task authorization covers routine planning and execution.

## Source and provider

Lock the supplied file/page/node IDs through fresh project CLI sessions and a targeted node read. An explicit node ID is sufficient; selection is a check, not a requirement to make the user click it again. Stop on identity mismatch. Export the original screenshot and retain its hash.

When using DXX, read the adjacent project-local [dxx-image Skill](../dxx-image/SKILL.md) and use its bundled `scripts/dxx_image.py`. It shares the plugin Settings configuration at `<relay-root>/.local/dxx-config.json`; no global DXX Skill is required. Follow its decomposition/recovery contract. DXX performs image decomposition; this skill owns resource planning and acceptance. Do not infer an upstream model name from the service name. Keep request/task IDs, original response, manifest, and ZIP. An unknown task outcome is queried using its saved ID, not submitted as a fresh paid task.

State complete resource boundaries in the prompt, for example: “礼盒的主体、缎带和蝴蝶结合为一个完整透明资源；卡牌、附属植物、托盘和局部闪光合为完整插画；购买价格独立。” Request only justified separate assets. Review missing or over-merged resources before scheduling another regional decomposition. Backend layer count or a `completed` status does not establish semantic correctness.

Map DXX document dimensions, placement, opacity and z-order into the project import manifest. PNG pixel dimensions alone do not determine its document bounds. Identify inferred hidden pixels and raster text in the delivery.

## Correct an over-fragmented result

Reuse existing images first. Write an explicit resource plan mapping every source layer exactly once; see [resource-plan.example.json](references/resource-plan.example.json). `members` contains source `idx` values, while source array order defines bottom-to-top stacking. Keep source files and provenance available as the detailed backup.

Use the offline compositor from the repository root (Python with Pillow):

```powershell
python -X utf8 ai/skills/image-layer-to-figma/scripts/compose_resources.py --manifest <source-manifest.json> --plan <resource-plan.json> --out-dir <new-empty-directory> --pixels-per-unit 2
```

The output is one actual transparent PNG per resource plus a compatible `manifest.json`, `resource-map.json`, and `verification.json`. A Figma folder containing many fragments is still fragmented on export; actual PNG composition is necessary for a single reusable image.

The compositor preserves source stacking and checks unsafe crossings for noncontiguous members. `anchor` defaults to `last`; use `first` when complete button artwork must remain below its separate price. Both placements check the members that cross intervening layers. If neither placement is safe, revise the resource boundary or separately preserve the occlusion; do not disable that check to satisfy a desired count. Single members retain their image bytes and floating-point placement. Merged members are rasterized at the recorded sampling scale, which may introduce resampling differences. Local comparison is not live Figma rendering proof.

Inspect complete resources on light/dark backgrounds, especially the gift, attached decorations, and illustration edges. Compare recomposition with the pre-merge composite. This verifies the consolidation; compare separately with the original screenshot to assess extraction fidelity. Consolidation cannot recover detail already changed by the model or make bitmap text editable.

## Figma delivery

Use the adjacent [psd-layer-to-figma](../psd-layer-to-figma/SKILL.md) import wrapper for the compatible image manifest. Despite the wrapper name, these inputs are image resources, not a claim of PSD recovery. Pass explicit file/session/target page and constrain component lookup to the authorized scope.

Default screenshot-to-Figma delivery includes a **nested business hierarchy**, not a flat collection of numbered images. A successful import or its `stopAfterSummary` ends the import phase, not this delivery. Leave flat output only when the user explicitly requests raw layers. Resource granularity and hierarchy are separate: keep each complete PNG intact while grouping existing nodes into useful functional containers.

After import, read [resource-hierarchy.md](references/resource-hierarchy.md), capture a fresh include-hidden analysis, and write the complete target tree. Group major regions, then titles, reward information, fixed benefit entries, currency bars and purchase controls where the actual UI supports them. A button's artwork and independent price belong under one button container; a benefit's complete icon and caption belong under one benefit container. Do not copy a particular screen's names, counts, coordinates, or node IDs into reusable code.

Use `scripts/structure_resources.py` to validate the entire node mapping and execute the already-authorized tree through the adjacent cleanup transaction helper. It preserves original nodes and protected subtrees, creates transparent non-clipping Frames, and checks bounds, sibling order and fresh rendered pixels. Unchanged complete resources may remain direct children; do not manufacture single-child wrappers. Mark a fixed horizontal row explicitly with `layoutIntent: "static-horizontal"`; geometry must pass before treating its item groups as a static strip. Scrolling lists keep their ScrollView structure.

Use the existing task authorization for the normal decomposition-and-hierarchy delivery. This does not authorize ComponentSet creation, editable text reconstruction, Unity Prefab writes, or bypassing a plugin cleanup session's server-side approval stage. Report Figma completion separately from any subsequent Unity import.

Create a separately named resource version when revising a prior delivery. Verify populated IMAGE fills, layer order/positions, independently exported complete resources, foreground hide/show, the live composite, and unchanged original source. Retain the earlier detailed version for traceability. Report semantic resource acceptance separately from operation checks and disclose remaining alpha, occlusion, and fidelity limits.
