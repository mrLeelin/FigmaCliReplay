# Figma 图层映射参考

本参考用于把 `prefab-to-figma.json` 写入 Figma。写入阶段必须保持 Unity 节点的名称、尺寸、位置和层级顺序。

## 写入计划门禁

写入 Figma 前必须先生成并审核 `figma_write_plan.json`：

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/build_figma_write_plan.py" `
  --package ".tmp/prefab-to-figma/<Name>/prefab-to-figma.json" `
  --figma-url "<FigmaUrl>" `
  --target-node-id "<nodeId>" `
  --component-mode component `
  --out ".tmp/prefab-to-figma/<Name>"
```

只有 `figma_write_plan_audit_report.json.allPass == true` 且 `blockingErrors` 为空时，才能进入 Figma 写入。标准 AI 执行路径必须通过 `figmaMcpRelay` 提交任务；命令行调试可通过 `prefab_to_figma_mcp_client.py` 提交 `PREFAB_TO_FIGMA_WRITE`。最终都由 `<relay-root>` 下的插件按计划中的 `operations` 执行：

- `imageUploads`：上传图片并验证 40 位 `imageHash`。
- `placeholderCleanup`：`figmaMcpRelay` / runtime relay 路径不使用官方/通用 Figma MCP `upload_assets`，因此不会产生占位节点；如果走用户明确批准的 MCP fallback，仍必须单独清理。
- `textWrites`：按 `fontColor`、outline、underlay、TMP Material metadata 写文本。
- `nineSliceWrites`：按 source rect 生成 CROP transform，并写隐藏源图 fill。
- `prefabInstanceWrites`：全文件搜索 Component，创建 INSTANCE，禁止 FRAME 占位。
- `rotationTransforms` / `flipTransforms`：必须使用 `relativeTransform`。

LLM 不得跳过写入计划，也不得从终端输出手抄坐标、hash 或节点数量来替代脚本计划。

## 根节点

- 顶层 Figma Frame 使用 Prefab 文件名或 JSON `root.name`。
- 顶层 Frame 尺寸使用 JSON `canvas.width`、`canvas.height`。
- 顶层 Frame 写入共享元数据命名空间 `prefab_to_figma`，记录 Prefab 路径和导入版本。
- 如果 JSON `visualBounds` 超出根节点 `rect`，先创建生成辅助层 `<rootName>__ImportBounds` 包住完整视觉范围，再把 Unity 原始根节点放在其中并按 `-visualBounds.x/y` 偏移，避免截图或导出根节点时裁掉外溢视觉。

## 组件模式（默认开启）

- 导入完成后默认把最外层导入节点转换为 Figma Component。
- 仅当用户明确说 `不要组件`、`no component`、`frame only`、`不打组件` 时，跳过组件化。
- 如果存在 `<rootName>__ImportBounds`，组件化这个外层包围节点；否则组件化 Prefab 根节点。
- 组件化必须在所有 Unity 节点、`__image`、`__text`、`__slice_*` 和共享元数据写入完成后执行。
- 组件化不得改变节点名称、层级、尺寸、位置或生成子层命名。
- 推荐优先使用 Figma Plugin API 的 `figma.createComponentFromNode(topLevelNode)`；如果 API 不可用或失败，必须向用户报告失败原因，并保留原始导入 Frame。

## 嵌套 PrefabInstance 组件复用规则

当 JSON `prefabInstances` 不为空时，说明 Prefab 中引用了子 Prefab。导入时必须遵守以下流程：

### 流程

1. **搜索现有组件**：对每个嵌套子 Prefab，先查找 Figma 文件中是否已有同名 Component。
   - **必须搜索本地 Component**：`search_design_system` 只搜索已发布到库的组件，不包含文件内的本地 Component。必须由 Figma MCP Relay 插件遍历文件所有页面查找本地 Component：`figma.root.findAll(n => n.type === "COMPONENT" && n.name === "子PrefabName")`。
   - 如果找到匹配的 Component，直接创建 Instance 引用它，不要重复创建。
2. **创建子 Prefab Component**：如果 Figma 中没有现成组件，先独立创建子 Prefab 的完整层级（按正常导入流程），然后转为 Figma Component。
   - 子 Prefab Component 放在与父 Prefab 同一个 Frame/Page 中（或用户指定的组件库页面）。
   - 子 Prefab Component 使用子 Prefab 自身的 `root.name` 命名。
   - 子 Prefab 根节点尺寸使用子 Prefab 原始 `root.rect` 的 width/height。若 `visualBounds` 超出根节点，另建 `<rootName>__ImportBounds` 包围层并组件化包围层，不要用 `visualBounds` 覆盖 root RectTransform 尺寸。
3. **在父 Prefab 中引用**：在父 Prefab 的对应位置创建子 Component 的 Instance。
   - Instance 的位置和尺寸使用父 Prefab 中 PrefabInstance 的 override 值（`m_AnchoredPosition`、`m_SizeDelta`）。
   - Instance 的名称使用父 Prefab 中的 override `m_Name`（如果有），否则使用子 Prefab 原始名称。
   - 如果父 Prefab 中有文本、颜色等 override，通过 Instance 的属性覆盖实现。

### 位置计算

嵌套 PrefabInstance 的位置信息来自父 Prefab 文件中的 `m_Modification` 段：

- `m_AnchoredPosition.x/y`：子 Prefab 根节点在父节点中的锚点偏移。
- `m_SizeDelta.x/y`：子 Prefab 根节点在父节点中的尺寸覆盖。
- 使用标准固定锚点 (0.5, 0.5) 公式转换为 Figma 坐标。

### Constraints 设置（关键）

子 Prefab Component 内部必须设置正确的 Constraints，使 Instance resize 时九宫格能自动适配：

- **AnimationRoot**：`horizontal: STRETCH, vertical: STRETCH`（跟随 Component 尺寸）
- **Icon（九宫格容器）**：`horizontal: STRETCH, vertical: CENTER`（宽度跟随拉伸，高度居中）
- **__slice_left**：`horizontal: MIN, vertical: STRETCH`（固定在左侧）
- **__slice_center**：`horizontal: STRETCH, vertical: STRETCH`（中间拉伸）
- **__slice_right**：`horizontal: MAX, vertical: STRETCH`（固定在右侧）
- **__slice_top**：`horizontal: STRETCH, vertical: MIN`（固定在顶部）
- **__slice_bottom**：`horizontal: STRETCH, vertical: MAX`（固定在底部）
- **__slice_top_left**：`horizontal: MIN, vertical: MIN`
- **__slice_top_right**：`horizontal: MAX, vertical: MIN`
- **__slice_bottom_left**：`horizontal: MIN, vertical: MAX`
- **__slice_bottom_right**：`horizontal: MAX, vertical: MAX`
- **PreLevel（文本容器）**：`horizontal: STRETCH, vertical: CENTER`
- **__text**：`horizontal: STRETCH, vertical: STRETCH`

这样当父 Prefab 通过 `m_SizeDelta` override 改变子 Prefab 尺寸时，Figma Instance resize 后内部九宫格会正确响应。

### 注意事项

- 子 Prefab 的内部结构（子节点、图片、文本）由子 Prefab 自身的 JSON 决定，不受父 Prefab override 影响（除非 override 明确修改了内部节点）。
- 如果同一个子 Prefab 在多个父 Prefab 中被引用，只创建一次 Component，后续全部用 Instance。
- 子 Prefab Component 创建后，写入共享元数据 `prefabPath` 指向子 Prefab 的路径。
- Component 的默认尺寸使用子 Prefab 原始 `root.rect` 的 width/height（不是 visualBounds）。

### 复杂 Override 的变体策略

当父 Prefab 对子 Prefab 有复杂修改（不仅仅是尺寸/位置/文本）时，使用 Figma **Variant（变体）** 来表达。

#### 判断是否需要新变体

解析父 Prefab 的 `m_Modification` 段，按以下规则判断：

| Override 类型 | 处理方式 |
| --- | --- |
| 仅 `m_AnchoredPosition`、`m_SizeDelta` | 不需要新变体，直接 resize Instance |
| 仅 `m_text`、`m_fontColor` 等文本属性 | 不需要新变体，Instance 内部修改文本 |
| `m_Sprite` 图片替换 | 需要新变体 |
| `m_AddedGameObjects` 新增节点 | 需要新变体 |
| `m_RemovedGameObjects` 删除节点 | 需要新变体 |
| `m_AddedComponents` 新增组件 | 需要新变体 |
| 大量颜色/材质修改（超过 3 个属性） | 需要新变体 |

#### 变体创建流程

1. **首次遇到子 Prefab**：创建为 Component Set（而非单个 Component），默认变体属性为 `Override=Default`。
2. **遇到复杂 override**：在 Component Set 中新增变体，属性值为 `Override=<父PrefabName>`（如 `Override=TwoBtnTips`）。
3. **变体内容**：基于默认变体复制，然后应用父 Prefab 中的所有 override（换图、加节点、删节点、改颜色等）。
4. **在父 Prefab 中引用**：使用对应变体的 Instance。

#### 变体命名规则

- 属性名固定为 `Override`
- 默认值：`Default`（子 Prefab 原始状态）
- Override 值：使用父 Prefab 的 `root.name`（如 `TwoBtnTips`、`ShopPanel`）
- 如果同一个父 Prefab 中同一个子 Prefab 出现多次且 override 不同，追加序号：`TwoBtnTips_1`、`TwoBtnTips_2`

#### 示例

```text
RedBtn (Component Set)
├── Override=Default        ← 原始 RedBtn.prefab
├── Override=TwoBtnTips     ← 在 TwoBtnTips 中的版本（换了图）
└── Override=ShopPanel      ← 在 ShopPanel 中的版本（加了角标）
```

#### 变体与 Instance 的关系

- 简单 override → 使用 Default 变体的 Instance + resize + 文本修改
- 复杂 override → 使用对应命名变体的 Instance + resize

#### 首次只有简单 override 时的处理

如果首次导入时子 Prefab 只有简单 override（尺寸/文本），创建为单个 Component（不是 Component Set）。后续如果遇到复杂 override，再升级为 Component Set 并添加变体。这样避免不必要的复杂度。

## Unity 节点到 Figma 节点

- 每个 Unity 节点创建一个同名 Figma Frame。
- Frame 名称必须等于 JSON 节点 `name`，不要为了唯一性改名。
- Frame 的相对位置和尺寸来自 JSON 节点 `rect.x/y/width/height`。
- 子节点创建顺序必须跟 JSON `children` 顺序一致。
- 非激活节点不删除；可写入 `active=false` 元数据，必要时降低透明度由用户确认。

## 生成子层命名

生成层必须使用保留名称，避免改变 Unity 原节点名：

- 图片层：`__image`
- 文本层：`__text`
- 不支持组件标记层：`__unsupported`
- 九宫层：
  - `__slice_top_left`
  - `__slice_top`
  - `__slice_top_right`
  - `__slice_left`
  - `__slice_center`
  - `__slice_right`
  - `__slice_bottom_left`
  - `__slice_bottom`
  - `__slice_bottom_right`
- 源图层：`__source_image`（已废弃，旧版导入产物可能存在此子节点；新版改为在九宫格父节点的 `fills[0]` 存储隐藏源图 fill，不再创建子节点）

## 九宫动态切片规则

- 九宫切片数量必须以 JSON `image.slices` 为准，不能硬编码为 3 个。
- 可生成的切片数量范围是 1 到 9 个：
  - 四边 border 都为 0 时，可退化为 1 个中心或 simple 图片。
  - 只有左右 border 时，通常是横向 3 段：left / center / right。
  - 只有上下 border 时，通常是纵向 3 段：top / center / bottom。
  - 四边 border 都存在时，最多是 3 x 3 的 9 宫。
- 写入 Figma 时必须逐个遍历 `image.slices`，按每个 slice 的 `name`、`target`、`source` 创建层。
- 不允许假设一定存在 `__slice_left`、`__slice_center`、`__slice_right`；缺失哪些层取决于源 Sprite border。
- 任何像素对齐修正都只能基于 `target` 和实际截图验证，不能用固定偏移修补所有九宫。

## 图片写入

- 使用 runtime relay `/assets/{requestId}/{assetId}` 将 PNG 原图字节交给 Figma 插件，插件内调用 `figma.createImage` 生成 `imageHash`。
- 使用 `<relay-root>` 下的 `PREFAB_TO_FIGMA_WRITE` handler 创建矩形、Frame、文字、共享元数据和截图。
- Simple / RawImage：创建 `__image`，尺寸覆盖父 Frame。
- Nine-slice：按 JSON `image.slices` 创建 1 到 9 个 `__slice_*` 子层；每个子层保留目标矩形和源矩形元数据。
- Tiled / 非完整 Filled：第一版不还原真实效果，创建 `__unsupported` 或简单占位，并写入 warning 摘要。

## 文本写入

- TextMeshProUGUI 映射基础文本、字号、颜色、描边和阴影。
- 当 TMP 的 `m_EditorClassIdentifier` 为空时，可通过 `m_text` 与 `m_fontSize` 识别为文本组件。
- 默认生成文本层名为 `__text`，放在原 Unity 文本节点 Frame 内，不改变原节点名称。
- TMP 材质标记已提升到节点自身名称上：如果 JSON `text.materialTag` 存在，节点名称格式为 `原名(材质标记)`，例如 `[DescText](CommonFont_o_833411_u_833411)`。文本子图层统一命名为 `__text`。
- 如果 JSON `text.figmaTextLayerName` 存在（旧版兼容），仍使用该字段作为文本层名。
- TMP 材质标识来自 JSON `text.materialTag`，通常由 `CommonFont_` 前缀后的材质名生成；例如 `CommonFont_Btn_GreenBtn` → `Btn_GreenBtn`。
- 写入共享元数据时，必须在文本层上保存 `tmpMaterialTag`、`tmpMaterialName`、`tmpMaterialGuid`，便于 Figma → Unity 回写时恢复 TMP Material Preset。只要 JSON `text.materialTag` 存在，这三个字段就是必填元数据；缺失任一字段都视为导入未完成。
- **颜色优先级**：JSON `text.fontColor` > `text.color`。`fontColor` 是 TMP 实际渲染颜色（`m_fontColor`），`color` 是 Graphic 基类颜色（`m_Color`），通常为白色。写入 Figma 时以 `fontColor` 为准。
- **文字对齐映射**：JSON `text.alignment.horizontal` 是 TMP 的 HorizontalAlignment 枚举值，必须正确映射到 Figma 的 `textAlignHorizontal`：
  - 1 = Left → `"LEFT"`
  - 2 = Center → `"CENTER"`
  - 4 = Right → `"RIGHT"`
  - 8 = Justified → `"JUSTIFIED"`
  - 16 = Flush → `"JUSTIFIED"`
  - 32 = Geometry Center → `"CENTER"`
  - 其他/未知 → 默认 `"CENTER"`
- **垂直对齐映射**：JSON `text.alignment.vertical` 是 TMP 的 VerticalAlignment 枚举值：
  - 256 = Top → `"TOP"`
  - 512 = Middle → `"CENTER"`
  - 1024 = Bottom → `"BOTTOM"`
  - 2048 = Baseline → `"CENTER"`
  - 4096 = Midline → `"CENTER"`
  - 8192 = Capline → `"TOP"`
  - 其他/未知 → 默认 `"CENTER"`
- 踩坑案例：FbBtn 的 PreLevel 文字 alignment.horizontal=32（Geometry Center），但导入时写死了 LEFT，导致文字在 Figma 中偏左。
- **描边映射**：如果 JSON `text.effects.outline` 存在且 `width > 0`，在 Figma 文本节点上添加 Stroke 效果。转换规则：
  - `strokeWeight = outline.width × fontSize × 0.2`（TMP 的 outlineWidth 是 SDF 归一化值 0-1，不是像素值；经验系数 0.2 将其转为近似像素粗细）
  - `strokeAlign = "OUTSIDE"`
  - `outline.color` 映射为 Stroke 颜色
- **字号映射**：
  - 如果 `text.autoSize.enabled = false`，直接使用 `text.fontSize`。
  - 如果 `text.autoSize.enabled = true`，Figma 不支持 autoSize，需要估算实际渲染字号：取 `text.fontSize` 和 `textFrameWidth / (charCount × 0.6)` 的较小值（0.6 是平均字符宽度比例）。如果估算值仍然导致换行，继续缩小直到文字单行显示。
  - 踩坑：直接用 `autoSize.max` 会导致文字溢出换行；直接用 `fontSize` 也可能太大。必须考虑容器宽度。
- **TMP SDF 转换系数说明**：TMP 使用 SDF 渲染，描边/阴影参数是归一化值（0-1），不是像素值。上述系数（0.2、0.3、0.5）是经验值，可能需要根据实际截图对比微调。如果效果差异明显，优先以 Unity 截图为准手动调整。
- 字体、材质、富文本动画不强行模拟；需要在报告中说明降级。
- **TMP Material Preset 不允许静默降级**：即使 Figma 字体无法加载、必须使用替代字体，仍必须保留 `__text(<materialTag>)` 文本层命名和 `tmpMaterialTag`、`tmpMaterialName`、`tmpMaterialGuid` 共享元数据。字体降级只影响视觉字体，不允许丢失 Unity TMP Material Preset 标识。

### TMP 字体、字号、描边与 Underlay 校准补充规则

- **Unity TMP 字号不等于 Figma 字号**：Unity TMP `fontSize` 基于 TMP SDF Font Asset 的度量；Figma `fontSize` 基于 Figma 当前字体度量。两者名称相同，但字体族不一致时视觉大小不保证相等。
- **字体族匹配优先**：写入前优先读取 TMP Font Asset 的 `m_FamilyName`、`m_StyleName`、`m_PointSize`、`m_LineHeight`、`m_CapLine` 等度量信息，并用 `figma.listAvailableFontsAsync()` 检查 Figma 是否有同名字体。
  - 如果 Figma 有同名字体，优先使用同名字体和对应样式。
  - 如果 Figma 没有同名字体，必须标记为字体降级；此时 Unity TMP 字号只能作为视觉校准起点，不能与 Figma 字号做 1:1 数值对应。
  - 字体降级时，最终报告应说明 Unity 字体族、Figma 替代字体，以及字号是否经过人工或视觉校准。
- **Auto Size 不要直接固定用最大值**：`text.autoSize.enabled = true` 时，`autoSize.max` 只能作为上限。优先以 `fontSizeBase`（如果 JSON 提供）或 `text.fontSize` 作为初始字号，再结合文本框宽度、字体差异和截图校准。
- **描边需要视觉上限**：`strokeWeight = outline.width × fontSize × 0.2` 只能作为初始值。Stroke 过粗会压缩字面白色区域；按钮文字通常优先在约 `2px` 到 `4px` 区间微调。人工调整后写入共享元数据 `outlineAdjusted=true`。
- **TMP Underlay 默认用复制文本层模拟**：TMP Underlay 更像背后一层偏移暗字，不应默认直接转成 Figma 大面积 Drop Shadow。
  - 创建下层暗色文字 `__text_underlay`，内容、字体、字号与 `__text` 一致，位于同一个 Unity 文本节点 Frame 内，并放在 `__text` 下方。
  - `underlay.color` 映射为 `__text_underlay` 填充颜色。
  - `underlay.offsetX`、`underlay.offsetY` 映射为 `__text_underlay` 相对 `__text` 的偏移；Figma Y 轴向下为正，方向必须通过截图校准。
  - `underlay.dilate` 可用 `__text_underlay` 的轻微 Stroke 或字重模拟。
  - `underlay.softness` 不要默认转成大半径模糊；最多使用极弱模糊。仅当 Underlay 是很轻的普通阴影且视觉验证通过时，才允许用 Figma Drop Shadow 近似。
  - 使用复制文本层时，写入共享元数据 `shadowModel=duplicated_underlay_text`。
- **人工校准元数据**：发生字体降级或视觉校准时，建议写入 `fontFallback=true`、`unityFontFamily`、`figmaFontFamily`、`unityFontSize`、`figmaFontSize`、`fontSizeAdjusted=true`、`outlineAdjusted=true`、`shadowModel`。
- **1:1 还原优先级**：如果用户要求文字 1:1，优先级为：Figma 安装并使用 Unity 同款字体；其次使用 Unity/TMP 渲染文字为透明 PNG 后导入；最后才使用 Figma 近似字体并人工校准字号、描边和 Underlay。

## Figma → Unity 文字同步位置

本文件只描述 Unity JSON 写入 Figma 的图层映射。Figma 文本同步回 Unity TMP 的规则在 `../../figma-to-prefab/references/workflow-figma-to-unity.md`，不要在本文件中执行反向写入决策。

## 元数据建议

用 `setSharedPluginData("prefab_to_figma", key, value)` 写入：

根节点元数据：
- `prefabPath`：Prefab 文件相对路径（如 `Assets/MagicWarrior/_Resources/Prefabs/UGUI/Tips/TwoBtnTips_2.prefab`）
- `prefabGuid`：Prefab 的 GUID
- `unityPath`
- `gameObjectId`
- `rectTransformId`

Image 节点元数据（每个含图片的节点）：
- `spriteGuid`：Unity Sprite 的 GUID
- `spritePath`：Unity 图片文件相对路径（如 `Assets/_Art/Texture/GUI/_Common/Bg/底.png`）
- `spriteBorder`：`"{left},{bottom},{right},{top}"`（Unity spriteBorder 的 x,y,z,w 值，仅九宫格）
- `originalPixelSize`：`"{width}x{height}"`（源图真实像素尺寸）
- `imageType`：`"Sliced"` 或 `"Simple"`
- `sourceImageFillIndex`：隐藏源图 fill 的索引（仅九宫格，通常为 `"0"`）
- `imageGuid`：（兼容旧字段）

其他元数据：
- `sourceRect`
- `unsupportedComponents`

共享元数据用于后续二次导入或差异核对，不应改变视觉层级。
