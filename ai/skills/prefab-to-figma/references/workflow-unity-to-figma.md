# 工作流 1: Unity Prefab → Figma

本文件定义从 Unity UGUI Prefab 导入到 Figma 的完整工作流步骤。

## Unity Prefab to Figma Workflow

0. Hard loading gate: this workflow is valid only after the caller has loaded `references/workflow-unity-to-figma.md` and `references/pitfalls-unity-to-figma.md`, and the modification plan contains `已加载 workflow: references/workflow-unity-to-figma.md` plus `已加载 pitfalls: references/pitfalls-unity-to-figma.md`.
1. Read `references/supported-components.md` and `references/pitfalls-unity-to-figma.md`.
2. Confirm required inputs: Prefab path, Figma file URL/key, canvas size, component mode, and `.tmp` output directory.
3. After user approval for the `.tmp` output, run `scripts/prefab_to_figma.py` with project root, Prefab path, canvas size, and output directory.
4. Review generated `prefab_export_audit_report.json`. Stop if `allPass=false` or `blockingErrors` is not empty. Warnings must be carried as structured report data instead of ignored.
5. Run `scripts/build_figma_write_plan.py` to generate `figma_write_plan.json` and `figma_write_plan_audit_report.json`. Stop if the plan audit has blocking errors.
6. In the default no-LLM flow, MCP Relay Server proceeds automatically when audits pass. In command-line debug mode, ask for one batch confirmation before any Figma write.
7. Read `references/figma-layer-mapping.md` before writing to Figma.
8. Use local `figmaMcpRelay` as the AI-facing control plane. For command-line debugging only, use the MCP-backed wrapper `scripts/prefab_to_figma_mcp_client.py` to submit `PREFAB_TO_FIGMA_WRITE`; do not POST directly to the localhost relay. The Figma plugin creates the top-level Frame. If JSON `visualBounds` exceeds the root RectTransform, it creates `<rootName>__ImportBounds` as the generated wrapper and places the original Unity root inside it.
9. Recursively create one same-name Figma Frame for every Unity node. Names must equal JSON `name` exactly. Every node must carry JSON `rectTransform` and `constraints` converted from the Unity RectTransform anchors.
10. Create generated child layers only with reserved names: `__image`, `__text`, `__text_underlay`, `__unsupported`, or `__slice_*`. When JSON `text.figmaTextLayerName` exists, use it for the generated text layer name.
11. Handle nested Prefab instances when `figma_write_plan.json.operations.prefabInstanceWrites` is not empty.
12. Add nine-slice source image metadata when `figma_write_plan.json.operations.nineSliceWrites` requires it.
13. Convert the final top-level import node into a Figma Component by default. Skip only when the user explicitly opts out.
14. Image bytes are served by the runtime relay `/assets/{requestId}/{assetId}` and consumed by the Figma plugin. Do not use official/generic Figma MCP `upload_assets` as the standard path.
15. Verify TMP Material Preset metadata from `figma_write_verify_report.json` after writing to Figma. This is a hard completion gate; see "TMP Material Preset 验证门槛" below.
16. Report imported node count, image count, text count, nine-slice count, missing resources, downgrades, nested component count, component mode result, and TMP Material Preset verification result.

## 确定性流水线模式

Unity → Figma 默认采用“脚本/插件/服务端执行并判定，AI 只转述”的模式：

1. `prefab_to_figma.py` 输出：
   - `prefab-to-figma.json`
   - `report.md`
   - `prefab_export_audit_report.json`
2. `verify_export_package.py` 可单独复核 `prefab-to-figma.json` 并重新生成导出审核报告。
3. `build_figma_write_plan.py` 输出：
   - `figma_write_plan.json`
   - `figma_write_plan_audit_report.json`
4. `figmaMcpRelay` / `prefab_to_figma_mcp_client.py` 输出：
   - `prefab_to_figma_mcp_result.json`
   - `figma_write_result.json`
   - `figma_write_verify_report.json`
5. MCP server / runtime relay 根据结构化报告中的 `allPass`、`blockingErrors`、`warnings`、`summary`、`checks`、`artifacts` 更新任务状态。
6. AI 只读取和转述任务状态，不重新判断 warning 是否阻塞，不手算坐标、旋转矩阵、九宫 CROP、图片 hash、节点数量；这些必须来自脚本报告或 Figma 读回验证。

统一审核结构：

```json
{
  "allPass": true,
  "blockingErrors": [],
  "warnings": [],
  "summary": {},
  "checks": {},
  "artifacts": {}
}
```

判定规则：

- `blockingErrors` 非空：服务端禁止进入下一阶段或宣称完成。
- `warnings` 非空：脚本或插件必须结构化记录；需要用户决策时必须产出明确 decision 信息。
- `summary/checks/artifacts` 只作为证据，不允许 AI 重新计算并覆盖。

## 无大模型后台导入入口

AI 侧应通过本地 `figmaMcpRelay` 调用：

```text
figma_prefab_import_start
figma_prefab_import_status
```

Figma 插件 UI 的 Prefab 导入按钮仍调用 runtime relay：

```text
POST /prefab-to-figma/import
GET  /prefab-to-figma/import/{taskId}/status
```

请求由 AI MCP client 或 UI 提供 `prefabPaths`、`canvasByPrefabPath`、`figmaUrl/fileKey`、`componentMode`、`nestedPrefabComponentMode`。MCP server / runtime relay 负责串联导出、校验、写入和读回验证；UI 只展示状态、日志、错误和输出路径。AI 不参与该路径的中间判断。

## 阶段一命令模板

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/prefab_to_figma.py" `
  --project-root "." `
  --prefab "<PrefabPath>" `
  --canvas "<1080x1920|auto>" `
  --out ".tmp/prefab-to-figma/<Name>"
```

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/verify_export_package.py" `
  --package ".tmp/prefab-to-figma/<Name>/prefab-to-figma.json" `
  --output-report ".tmp/prefab-to-figma/<Name>/prefab_export_audit_report.json"
```

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/build_figma_write_plan.py" `
  --package ".tmp/prefab-to-figma/<Name>/prefab-to-figma.json" `
  --figma-url "<FigmaUrl>" `
  --target-node-id "<nodeId>" `
  --component-mode component `
  --out ".tmp/prefab-to-figma/<Name>"
```

## RectTransform anchors 与 Figma Constraints

Unity → Figma 导出必须保留 Unity 原始 RectTransform anchor 语义：

- `prefab_to_figma.py` 输出每个节点的 `rectTransform.anchorMin/anchorMax/pivot/anchoredPosition/sizeDelta`。
- 同一个节点还必须输出标准化 `constraints`，供 Figma 插件直接设置 `node.constraints`。
- Figma 插件写入节点时必须优先使用 JSON `constraints`；只有缺失时才按 `rectTransform.anchorMin/anchorMax` 现场转换。

映射规则固定为：

| Unity anchors | Figma Constraints |
| --- | --- |
| x `0 → 0` | horizontal `MIN` |
| x `0.5 → 0.5` | horizontal `CENTER` |
| x `1 → 1` | horizontal `MAX` |
| x `0 → 1` | horizontal `STRETCH` |
| y `1 → 1` | vertical `MIN` |
| y `0.5 → 0.5` | vertical `CENTER` |
| y `0 → 0` | vertical `MAX` |
| y `0 → 1` | vertical `STRETCH` |

读回验证必须检查导入节点 constraints 与 JSON 一致；否则视为布局回写风险，不能只按位置尺寸通过。

## 阶段二命令模板

AI 标准路径使用 `figmaMcpRelay`；下面命令只用于调试或兼容旧脚本：

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/prefab_to_figma_mcp_client.py" `
  --package ".tmp/prefab-to-figma/<Name>/prefab-to-figma.json" `
  --write-plan ".tmp/prefab-to-figma/<Name>/figma_write_plan.json" `
  --result ".tmp/prefab-to-figma/<Name>/prefab_to_figma_mcp_result.json"
```

执行前可先检查 runtime relay：

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/prefab_to_figma_mcp_client.py" --health
```

## TMP Material Preset 验证门槛

Unity Prefab → Figma 写入完成后，必须遍历 JSON 中所有带 `text.materialTag` 的文本节点，并由 Figma MCP Relay 插件读回目标 Figma 节点生成 `figma_write_verify_report.json`。不能只凭写入代码或肉眼检查宣称完成。

对每个带 `text.materialTag` 的文本节点，必须验证：

1. Figma TEXT 节点名等于 JSON `text.figmaTextLayerName`，例如 `__text(NotoSansSC-Medium_SDF_Material)`。
2. TEXT 节点 Shared Plugin Data 命名空间 `prefab_to_figma` 中：
   - `tmpMaterialTag` 等于 JSON `text.materialTag`
   - `tmpMaterialName` 等于 JSON `text.sharedMaterial.name`
   - `tmpMaterialGuid` 等于 JSON `text.sharedMaterial.guid`
3. 如果使用了字体降级，仍然必须保留上述 TMP Material Preset 元数据，并额外写入 `fontFallback=true`、`unityFontFamily`、`figmaFontFamily`。

任一文本节点验证失败时，必须先修复并重新读回验证，不允许结束任务。最终回复必须列出每个已验证文本层的 Figma 节点 ID、层名、`tmpMaterialTag`、`tmpMaterialGuid` 和字体降级状态。

## 完成后截图/读回验收是硬性步骤

Unity Prefab → Figma 写入完成后，必须进入插件/服务端可复现的读回验收闭环，不能只凭节点数量或 JSON 结构宣称完成：

1. 截取 Unity 源 Prefab、场景或用户提供的 Unity 参考图，作为视觉基准。
2. 截取 Figma 中生成的目标节点，作为实现结果。
3. 对比位置、尺寸、层级、文字、颜色、透明度、图片边缘、九宫格切片、按钮状态和外溢视觉范围。
4. 如果截图或读回几何存在差距，必须把差异固化进脚本、插件验证或错误报告，再重新运行流水线验证。
5. 只有截图/读回差异已修正，或因字体、TMP 材质、粒子、Animator、MMFeedbacks、运行时加载资源等不支持项无法继续自动修正且报告中已结构化说明原因时，才可以结束。
6. 截图只用于视觉验收和差异定位；严禁用截图替代源图元数据，图片写入 Figma 仍应保留 `spriteGuid`、`spritePath`、`spriteBorder`、`originalPixelSize` 等可回写信息。

## Nested Prefab Rules

For each nested child Prefab:

1. Resolve the child Prefab file path from its GUID.
2. Search the target Figma file for an existing same-name local Component by traversing `figma.root` inside the MCP Relay plugin. Do not rely only on `search_design_system`, because it does not find local unpublished Components.
3. If a matching Component exists, create an Instance from it.
4. If no matching Component exists, parse the child Prefab and create its full hierarchy as a Component before placing it in the parent.
5. Set child Component constraints before resizing any Instance; see `references/figma-layer-mapping.md`.
6. Use the child Prefab original root RectTransform width/height as the child root size. If the child has visual overflow, create and componentize its `__ImportBounds` wrapper; do not replace the root RectTransform size with `visualBounds`.
7. Read parent Prefab override values from `m_Modification`: `m_AnchoredPosition`, `m_SizeDelta`, `m_Name`, text/color changes, sprite changes, added/removed nodes.
8. Simple override means only position, size, name, or text. Use the default Component Instance and apply Instance-level resize/text changes.
9. Complex override means sprite replacement, added/removed GameObjects, added components, or broad material/color changes. Create or upgrade to a Component Set and add a variant named `Override=<父PrefabName>`; if multiple variants are needed for the same parent, append `_1`, `_2`, etc.

## Nine-Slice Source Image Rule

When JSON node has `image.sourceImage`:

1. After creating all `__slice_*` child layers, add an invisible IMAGE fill at the beginning of the nine-slice parent Frame `fills` array.
2. Set the fill to `{ type: "IMAGE", imageHash: <source image hash>, scaleMode: "FILL", opacity: 0 }`.
3. Write Shared Plugin Data on the nine-slice parent using namespace `prefab_to_figma`:
   - `sourceImageFillIndex` = `"0"`
   - `spriteGuid` = `image.sourceImage.spriteGuid`
   - `spritePath` = `image.sourceImage.spritePath`（Unity 图片文件相对路径，如 `Assets/_Art/Texture/GUI/_Common/Bg/底.png`）
   - `spriteBorder` = `"{left},{bottom},{right},{top}"`（Unity spriteBorder 的 x,y,z,w 值）
   - `originalPixelSize` = `"{width}x{height}"`
   - `imageType` = `"Sliced"` 或 `"Simple"`
4. Do not create a new `__source_image` child node. `__source_image` is a legacy compatibility path only for old imports.
5. If JSON lacks `image.sourceImage`, create only the reported `__slice_*` layers and record the limitation.
6. Users may replace the parent `fills[0]` image in Figma, then run `.figma/nine-slice-sync/` to refresh slices before syncing back to Unity.

## Figma MCP Relay / Runtime Relay Notes

- Use local `figmaMcpRelay` tools for the standard AI-facing write path.
- `/jobs`, `/figma/pending`, `/figma/result`, and `/assets/{requestId}/{assetId}` are private runtime relay endpoints between the MCP server and the Figma plugin. Command-line wrappers must call `figmaMcpRelay`, not those endpoints directly.
- The Figma plugin handles frames, text, rectangles, fills, screenshots, and shared plugin data in one controlled execution context.
- Official/generic Figma MCP `use_figma` / `upload_assets` is a fallback/debug channel only after the user explicitly approves fallback.
- Figma has no native Unity-equivalent nine-slice node. Represent nine-slice images with generated `__slice_*` child layers.
- Nine-slice layer count is dynamic from JSON `image.slices`: create exactly the reported 1 to 9 layers, never assume only 3 horizontal slices.
- Store source metadata on generated nodes with `setSharedPluginData("prefab_to_figma", key, value)` when useful.
- **`__slice_*` 节点元数据增强**：创建每个 `__slice_*` 节点后，追加写入以下 Shared Plugin Data（命名空间 `prefab_to_figma`）：
  - `nodeRole` = `"slice"`：标识节点角色为切片。
  - `sourceImageFillIndex` = `"0"` when the parent has the invisible source fill.
- If JSON `visualBounds` exceeds the root RectTransform, create `<rootName>__ImportBounds` as a generated wrapper so screenshots and exports include overflow visuals.
- Component mode converts the top-level import node only after all children, generated layers, metadata, and images are written. Use the wrapper when one exists; otherwise use the original Prefab root node.
- Component mode must preserve the node name, hierarchy, size, position, and generated layer names. If Figma component creation fails, report the error and leave the imported Frame intact instead of silently skipping it.
