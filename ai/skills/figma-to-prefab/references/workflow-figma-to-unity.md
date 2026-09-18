# 工作流 2: Figma → Unity（同步 + 新建）

本文件定义从 Figma 节点同步回 Unity 或新建 Unity Prefab 的完整工作流步骤。

## Figma → Unity 同步行为规则

当用户要求将 Figma 节点同步回 Unity 时（如"同步回去"、"更新 Unity"），必须遵守以下规则：

1. **不要质疑用户是否做了修改**。用户说同步就直接执行，不要问"你是否做了修改"。
2. **直接读取 Figma 最新状态**，和 Unity Prefab 文件中的实际当前值对比。
3. **对比基准是 Unity Prefab 文件的当前内容**，不是记忆中的"原始值"或"导入时的值"。
4. **有差异就列出修改计划并停止**。按 AGENTS.md 规则，必须等待用户明确确认后才能写 Prefab、PNG、`.meta` 或其他 Unity 资产。
5. **没有差异就简短说明"无需修改"**，不要长篇解释。

### 同步流程

1. 通过 Relay 读取 Figma 节点最新状态（位置、尺寸、文字、颜色、图片、截图）。
2. 通过脚本读取 Unity Prefab 文件中对应节点的当前值。
3. 调用固化脚本生成差异/审核报告，LLM 只读取报告，不逐节点手算。
4. 坐标转换由 `gen_spec.py` 完成，并写入 `spec_audit_report.json` 的检查项。
5. 输出修改计划，等待用户确认。
6. 确认后通过脚本和 `uloop execute-dynamic-code` 修改 Prefab 文件，禁止手写 YAML。
7. **检查脚本挂载**：修改完成后，检查 Prefab 根节点或相关节点上挂载的 MonoBehaviour 脚本，查看其序列化字段（如 `sureBtn`、`closeBtnText`、`title` 等引用字段）。如果新增或替换了节点，需要更新脚本上的引用绑定，确保字段指向正确的子节点 fileID。该步骤只输出建议，执行绑定前需要二次确认。

### 完成后截图验收是硬性步骤

Figma → Unity 同步、导入或新建 Prefab 完成后，必须进入截图验收闭环，不能只凭静态文件 diff 宣称完成：

1. 截取 Figma 目标节点或用户提供的目标图，作为视觉基准。
2. 截取 Unity 中目标 Prefab、场景或 UI 实际渲染结果，作为实现结果。
3. 对比位置、尺寸、层级、文字、颜色、透明度、图片边缘、九宫格拉伸、按钮状态和遮罩裁切。
4. 如果截图存在差距，必须先列出具体差异，再继续调整 Unity 资源或 Prefab，并重新截图验证。
5. 只有截图差异已修正，或因字体、引擎渲染、Figma 表达能力、资源缺失等限制无法继续自动修正且已明确说明原因时，才可以结束。
6. 截图只用于视觉验收和差异定位；严禁用截图生成 Unity Sprite，图片资源写回仍以 Relay 导出的原始图片/base64 和脚本 MD5 对比为准。

### 图片对比是强制步骤，不可跳过

即使布局、文字、颜色全部一致，也**必须**对每张图片执行以下验证才能得出"无需修改"的结论：

1. Relay 导出源图真实像素尺寸、图片 base64 或下载 URL、imageHash 和预期 MD5。
2. `gen_spec.py` 写入 `image_download_plan.json` 和 `spec_audit_report.json`。
3. `process_images.py` 写入 PNG 并输出 `image_process_report.json`。
4. 通过 Prefab 中的 Sprite GUID 找到 Unity 本地对应图片文件。
5. 由脚本计算 Unity 本地图片 MD5。
6. MD5 不同 = 图片已变更，必须列入修改计划。
7. MD5 相同 = 图片未变更，**不需要替换**，保留原始 Sprite 引用。

**严禁仅凭"布局数值一致"就跳过图片验证。** 图片替换不会改变节点尺寸或位置。

**严禁仅凭 imageHash 不同就判定图片已变更。** 不同 Figma 节点可能有不同的 imageHash 但源图内容相同（例如同一张图重新上传后 hash 会变）。必须以导出图片 MD5 对比为最终依据。

### 图片导出必须使用 Relay 原始图片数据，严禁截图合成

导出 Figma 中的图片资源到 Unity 时，**必须使用 Figma Relay 插件在 Figma 内获取原始图片数据**，然后由脚本写入 Unity Sprite PNG。LLM 不直接调用 Figma 远程工具导出图片。

**严禁使用以下方法导出图片**：
- ❌ `get_screenshot` 截图 → 有抗锯齿、背景混合、缩放，不是原始像素
- ❌ clone 切片 + resize + `figma.flatten()` + 截图 → CROP 变换在 resize 后会重新计算，合成结果错误
- ❌ clone 切片 + resize + `get_design_context` → 同样因为 CROP 变换问题导致错误
- ❌ LLM 手写 PowerShell 下载循环 → 容易漏 MD5/尺寸/九宫最小图门禁

**正确流程**：
1. Relay 在 Figma 插件内获取真实图片、真实尺寸和九宫元数据。
2. CLI + WebSocket wrapper 保存 `image_export_manifest.json`。
3. `gen_spec.py` 从 manifest 生成 Spec 和下载/校验计划。
4. `process_images.py` 写入普通 PNG、合成最小九宫 PNG，并输出 `image_process_report.json`。
5. 九宫格 `spriteBorder` 从 Relay 九宫元数据写入 Spec，不由 LLM 手算。

### 图片变更时的写入策略

当 MD5 对比确认图片已变更时，**优先覆盖已有文件，而非新建文件**：

1. **有 `spritePath` 元数据**：直接覆盖 `spritePath` 指向的文件（如 `底.png`），更新 `.meta` 中的 `spriteBorder`。Prefab 引用不需要改。
2. **无 `spritePath` 但有 `spriteGuid`**：通过 GUID 在项目 `.meta` 文件中反查图片路径，然后覆盖该文件。
3. **无元数据（旧导入或手动复制的节点）**：通过 Prefab 中的 `m_Sprite` GUID 反查图片路径，然后覆盖该文件。
4. **覆盖前检查引用数**：如果该图片被多个 Prefab 引用，提示用户选择：
   - 覆盖（影响所有引用方）
   - 新建副本（只影响当前 Prefab，需要改 Prefab 引用）

**严禁每次都新建文件**。新建文件会导致：
- 项目中出现大量冗余图片（`底_TwoBtnTips2.png`、`底_TwoBtnTips2_v2.png`、`底_TwoBtnTips2_804.png`...）
- Prefab 引用需要反复修改
- 原始图片变成孤立资源

### spriteBorder 重算规则

当新图尺寸与旧图不同时，必须重算 `spriteBorder`：

1. 从 Figma 切片尺寸和容器尺寸计算比例：`ratio = sliceSize / containerSize`
2. 用比例乘以新图尺寸：`newBorder = ratio × newImageSize`
3. 取整后验证：`left + right < imageWidth` 且 `top + bottom < imageHeight`
4. 如果不满足，提示用户手动设置

### 九宫格图片同步 — Source Image 优先导出

同步九宫格（Nine_Slice_Container）图片变更时，必须遵守以下优先级流程：

1. **检查父节点的隐藏源图 fill**：在 Nine_Slice_Container 父节点上，查找 Shared Plugin Data `sourceImageFillIndex` 是否存在。
2. **如果找到 `sourceImageFillIndex`**：
   a. 读取父节点 `fills[sourceImageFillIndex]` 的 imageHash，作为九宫格源图导出入口。
   b. 使用 `getImageByHash` 导出父节点该 fill 对应的完整源图，并计算导出 MD5。
   c. 用 `spritePath` / `spriteGuid` / Prefab `m_Sprite` GUID 定位 Unity 本地图片，计算 Unity MD5。
   d. MD5 不同 = 图片已变更，按“图片变更时的写入策略”列入修改计划；MD5 相同 = 不替换图片。
   e. 如果该 fill 缺失或损坏：记录 warning，不使用截图或切片拼接生成 Sprite。
3. **如果未找到 `sourceImageFillIndex`**：检查是否有旧版 `__source_image` 子节点（`nodeRole == "source_image"`），如果有则按旧逻辑从源图节点导出并做 MD5 对比；如果也没有（旧导入产物），只能同步布局/文字等非图片属性，图片写回必须先重新导入升级为父节点源图 fill，或由用户提供明确源图。

### 九宫格同步 — 向后兼容与不一致处理

- **旧导入产物（无源图 fill 也无 `__source_image` 子节点）**：Syncer 不允许用截图或切片拼接生成 Sprite。只能跳过图片写回并输出 warning，建议重新导入以升级为父节点源图 fill。
- **旧版 `__source_image` 子节点**：如果父节点没有 `sourceImageFillIndex` 但有 `__source_image` 子节点（`nodeRole == "source_image"`），从该源图节点导出并执行 MD5 对比。建议重新导入以升级为父节点 fill 方案。
- **重新导入时始终设置父节点源图 fill**：当 Importer 重新导入 Prefab 到已有 Figma 文件时，无论之前是否有源图 fill 或 `__source_image` 子节点，都必须在父节点上设置隐藏源图 fill。
- **父节点源图 fill 与 `__slice_*` 的 imageHash 不一致**：当父节点 `fills[0]` 的 imageHash 与某些 `__slice_*` 的 imageHash 不同时（用户替换了源图但未刷新切片），以父节点 fill 为准导出完整图片，并记录 warning 提示切片可能未同步。用户应使用 `.figma/nine-slice-sync/` Plugin 刷新切片后再同步。

## Figma Node to Unity Workflow

Use this workflow when the user asks to import a Figma node into Unity, generate a Prefab, create a new Prefab, or create new image assets. See `references/figma-to-unity-import.md` for Chinese trigger examples.

1. Read `references/figma-to-unity-import.md`.
2. Read `references/component-reuse.md` before deciding Unity component structure.
3. Read `references/figma-ugui-import-conventions.md` before deciding names, hierarchy, reuse, slicing, button structure, or text handling.
4. Use `figmaRelay` or the CLI + WebSocket wrapper to export the exact node. Do not use official/generic Figma MCP for node reads, image export, screenshot export, or validation in the standard flow.
5. Let `gen_spec.py` classify important Figma nodes as structure, image, text, public/common component, or feature-local reusable component before writing assets. ComponentSet detection is enabled by default: Relay component metadata is preferred, and conservative name-pattern grouping is only a fallback.
6. Inspect nearby Unity Prefab and art directories only for read-only suggestions. Prefer project conventions, but do not automatically restructure the generated Prefab.
7. Before any Unity asset write, output target Prefab path, image path, `.meta` paths, reuse strategy, naming strategy, risks, and validation plan. Wait for confirmation.
   - Formal create-new imports must use a business Prefab name. Use `run_full_import.py --infer-formal-names --formal-output-dir <Unity Assets folder>` when the user provides only the selected Unity folder. Do not use benchmark names like `Import_001` or create a `<run-id>/Prefabs/` parent folder.
8. After confirmation, `process_images.py` writes PNG files from Relay manifest/base64. `.meta` files are generated by Unity AssetDatabase, never by LLM.
9. Create a new Prefab via JSON Spec + `FigmaPrefabGenerator.Generate(".tmp/prefab_spec.json")`; never hand-write Prefab YAML.
10. **坐标与锚点转换**：将 Figma 节点位置转换为 Unity RectTransform 时，由 `gen_spec.py` 读取节点 `constraints`，写入 `rectTransform.anchorMin/anchorMax/pivot`，并按这些 anchors 计算 `anchoredPosition + sizeDelta`。LLM 只审核 `spec_audit_report.json`。
11. Validate with script reports, static checks, Console log checks, and the mandatory screenshot acceptance loop above. Compile through `uloop compile` only when `.cs` files were modified.

## Figma UGUI 导入约定检查

执行 Figma → Unity 写入前，必须按 `references/figma-ugui-import-conventions.md` 完成以下检查，并把结论写入修改计划：

1. **公共复用**：`Common_`、`Common_Components`、`Common_Item`、`INSTANCE` 节点先查项目公共 Prefab / 公共 PNG。命中后复用，不自建替代品。
2. **目录归档**：全局公共资源进入 `CommonFigma`；功能内复用资源进入 `功能名_CommonUI`；单界面业务资源进入业务模块目录。
3. **命名**：UI 根使用 `UI_FeatureName`，组件使用 `C_FeatureName_ComponentName`，文本使用 `*_Text`，业务导出图片使用 `FeatureName_` 前缀且同批唯一。
4. **结构**：完整界面检查 `Anchor_Top / Anchor_Middle / Anchor_Bottom`；弹窗检查 `PopupRoot / ContentRoot`；滚动区域检查 `ScrollView / Viewport / Content`。
5. **按钮**：优先复用公共按钮 Prefab；自建时必须使用项目点击父节点结构，包含 `CustomButton`、`Animator`、`NonDrawingGraphic`、`fg`。
6. **文本**：固定文案按 `CustomLanguageText` 规划；动态数字、读表文本、运行时拼接文本按 `CustomText` 规划；不要把可本地化长文案烘焙成图片。
7. **切图**：纯色矩形用颜色填充；纯色圆角优先复用 `RoundSlice9`；`boolean-operation` / `flatten` 切图时按合层整体导出，不拆碎。
8. **清理**：可删除无视觉、无语义、无绑定、无复用价值的空层；保留 Common、绑定节点、裁剪节点、备份素材层。

## Figma → Unity 坐标与 Constraints 转换规则

从 Figma 节点位置转换到 Unity RectTransform 时，必须遵守以下规则：

### Constraints 到 anchors

`gen_spec.py` 必须优先使用 Relay manifest 中每个节点的 `constraints`，并写入 `NodeSpec.rectTransform`：

| Figma horizontal | Unity anchorMin.x | Unity anchorMax.x |
| --- | --- | --- |
| `MIN` | 0 | 0 |
| `CENTER` | 0.5 | 0.5 |
| `MAX` | 1 | 1 |
| `STRETCH` | 0 | 1 |

| Figma vertical | Unity anchorMin.y | Unity anchorMax.y |
| --- | --- | --- |
| `MIN` | 1 | 1 |
| `CENTER` | 0.5 | 0.5 |
| `MAX` | 0 | 0 |
| `STRETCH` | 0 | 1 |

`pivot` 默认写入 `{x:0.5,y:0.5}`。如果 manifest 缺失或 token 非法，才回退到 `CENTER`，并在审核报告中保留 warning。

### 核心公式

Figma 使用左上角原点 (x, y 向下)，Unity 使用 anchors + pivot (y 向上)。

对于任意由 Constraints 转换来的固定或 stretch anchors：

```text
// Figma 节点相对于父节点: localX, localY, width, height
// 父节点尺寸: parentW, parentH
spanW = (anchorMax.x - anchorMin.x) * parentW
spanH = (anchorMax.y - anchorMin.y) * parentH

sizeDelta.x = width - spanW
sizeDelta.y = height - spanH

pivotX = localX + width * pivot.x
pivotY = parentH - localY - height * (1 - pivot.y)

anchoredPosition.x = pivotX - anchorMin.x * parentW - spanW * pivot.x
anchoredPosition.y = pivotY - anchorMin.y * parentH - spanH * pivot.y
```

`FigmaPrefabGenerator` 必须按 `NodeSpec.rectTransform` 设置 `RectTransform.anchorMin/anchorMax/pivot`，再写入 `rect.x/y` 到 `anchoredPosition`、`rect.w/h` 到 `sizeDelta`。禁止在 Unity 生成阶段重新推断 anchors，也禁止无视 manifest constraints 统一回退中心锚点。

## Figma → Unity TMP 文字同步规则

这些规则只用于从 Figma 写回 Unity，不用于 Unity → Figma 写入。

### TMP 材质硬验收门槛

只要任务涉及 TextMeshProUGUI 或 Figma 文本节点，写入 Unity 前必须完成以下步骤，缺一项就停止：

1. 从 Relay manifest / metadata 返回的节点名称或文本元数据中，检查是否包含材质标记。格式为 `节点名(材质名)`，例如 `[DescText](CommonFont_o_833411_u_833411)`。
2. 如果节点名称包含 `(材质名)` 后缀，只允许精确匹配 `<unity-project>/Assets/**/<材质名>.mat`，不得按颜色、截图、更新时间或相似名称猜测替代材质。
3. 修改计划必须列出：`Figma 节点名 -> Unity 材质路径 -> guid -> 写入字段`。
4. 写入后必须用 Unity 只读检查验证目标 TMP 组件：`fontSharedMaterial.name == <材质名>`。
5. 最终报告必须列出该验证结果；未验证时禁止宣称材质同步完成。
6. 向后兼容：如果节点名称不包含 `(材质名)` 后缀，再检查 Relay manifest 中子节点是否存在旧格式 `__text(<materialName>)` 图层名。

### 字号转换

- Figma `fontSize` 不能直接写入 TMP `m_fontSize`，因为 Figma 字体和 Unity TMP Font Asset 的度量不同。
- Figma → Unity 同步后必须统一保持 `enableAutoSizing = false`（由 `ApplyPostProcessing` 强制关闭）。
- 如果 Unity 中 `enableAutoSizing = true`，必须修正为 `false`，并记录验证结果。

### 图片 RaycastTarget

- Figma → Unity 同步后，所有 `Image` / `CustomImage` / Simple Image / Sliced Image / 九宫图 Image 必须统一 `raycastTarget = false`。
- 除非用户明确指定具体图片节点用于点击拦截，否则不允许保留 `raycastTarget = true`。
- 最终验证必须报告图片组件总数、`raycastTarget=false` 数量和未批准的 `raycastTarget=true` 残留数量。

### 描边和阴影转换

- Figma `strokeWeight` → TMP `_OutlineWidth`，公式：`_OutlineWidth = strokeWeight / (fontSize × 0.2)`，结果限制在 0 到 1。
- Figma Stroke 颜色 → TMP `_OutlineColor`。该值通常在 Material Preset 中，不是 TMP 组件字段。
- Figma Drop Shadow → TMP Underlay 时需要转换 `_UnderlayOffsetY`、`_UnderlaySoftness`、`_UnderlayColor`。这些通常也在 Material Preset 中。
- 修改 Material Preset 属于资源写入，必须在计划中单独列出路径和风险，并等待确认。
- 如果 Figma 文本节点名匹配 `节点名(<materialName>)` 格式（如 `[DescText](CommonFont_o_833411_u_833411)`），`<materialName>` 必须视为 Unity TMP Material Preset 的精确资产名。回写 Unity 时只允许先匹配同名 `<materialName>.mat`，不得自动拼接 `CommonFont_` 等前缀，也不得根据颜色、截图、更新时间或相似命名猜测其他材质。
- 如果 Relay manifest 返回的节点名称不包含 `(材质名)` 后缀，必须检查目标文本节点或子节点是否存在旧格式 `__text(...)` 标记；只有确认是否存在材质标记后，才能选择或保持 TMP 材质。Relay 字段不足时应补 Relay 或询问用户，不要切回 Figma MCP 主流程。
- 找不到材质标记对应的 Unity `.mat` 时，必须停止并询问用户，禁止替换为其他材质。修改 Prefab 上的 `m_sharedMaterial` 属于 Prefab 引用写入，修改 `.mat` 属性属于资源写入，两者都必须先列路径、GUID、风险和验证方式并等待确认。
- 修改计划和最终报告中必须列出 TMP 材质映射：`Figma 节点名 -> Unity 材质路径 -> guid -> 写入字段`。

### 对齐、颜色和内容

- `"LEFT"` → `m_HorizontalAlignment: 1`
- `"CENTER"` → `m_HorizontalAlignment: 2`
- `"RIGHT"` → `m_HorizontalAlignment: 4`
- `"JUSTIFIED"` → `m_HorizontalAlignment: 8`
- `"TOP"` → `m_VerticalAlignment: 256`
- `"CENTER"` → `m_VerticalAlignment: 512`
- `"BOTTOM"` → `m_VerticalAlignment: 1024`
- Figma 文本填充颜色写入 TMP `m_fontColor`，不要写入 Graphic 基类 `m_Color`。
- Figma `characters` 写入 TMP `m_text`，保留换行。

### 不自动同步的属性

- 字体族和 Font Asset。
- TMP 富文本标签。
- Material Preset 选择默认不自动同步；只有用户明确要求，且 Figma 节点名称包含 `(材质标记)` 后缀或存在旧格式 `__text(<materialTag>)` 子节点或等价共享元数据时，才可按上方规则列计划后回写。
- `m_fontSizeBase` 等 TMP 内部基准字段。

### 从 Figma 节点名称解析材质标记

从 Figma 同步回 Unity 时，解析节点名称中的材质标记：

1. 正则匹配：`^(?P<baseName>.+?)\((?P<materialTag>[^)]+)\)$`
2. 例如 `[DescText](CommonFont_o_833411_u_833411)` → baseName=`[DescText]`, materialTag=`CommonFont_o_833411_u_833411`
3. Unity 中的 GameObject 名称使用 `baseName`（不含材质后缀）
4. TMP 材质使用 `CommonFont_` + materialTag 的完整名称匹配 `.mat` 文件（如果 materialTag 本身已包含完整材质名则直接匹配）
5. 向后兼容：如果节点名称不包含 `(...)` 后缀，检查子节点是否有旧格式 `__text(<materialTag>)` 命名
