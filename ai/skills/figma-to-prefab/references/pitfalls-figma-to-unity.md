# 踩坑规则: Figma → Unity 专用

本文件收录 Figma 节点同步/导入到 Unity 方向的已知踩坑与防错规则。执行 Figma → Unity 工作流前必须阅读。

本文件合并了原 `figma-to-unity-sync-rules.md` 的内容。

## process_images.py 不得把复用资源重复写入输出目录

踩坑案例：`UI_FriendPopup_Split1` 导入时，`Common_Texture_Bg_2` 在 `gen_spec.py` 中被正确路由到 `_Common/Bg/`，Prefab 也正确引用该路径。但 `process_images.py` 的 `--output-dir` 指向功能目录，脚本遍历 `base64_by_node` 时没有检查节点是否已标记为 `reuseExistingAsset=true` 且 `targetAssetPath` 在输出目录之外，导致功能目录下生成了无用的副本 `Common_Texture_Bg_2.png`（GUID 不同，Prefab 未引用）。

**规则**：
1. `gen_spec.py` 负责把 `Common_Texture_*` 路由到 `_Common/` 目录。 ✅ 已有
2. `process_images.py` 写入普通图片时，必须检查每个节点的下载计划条目：如果 `reuseExistingAsset=true` 且 `targetAssetPath.parent != output_dir`，跳过写入并记录到 `skipped_existing`。
3. 九宫导出路径也要执行同样的检查。
4. 报告 `summary` 中增加 `reuseOutsideOutputDir` 计数，便于审核。
5. 删除副本不影响 Prefab（Prefab 通过 GUID 引用 `_Common/` 目录的正确文件）。

**修复验证方式**：运行 `process_images.py` 后，检查 `output_dir` 下不存在以 `Common_Texture_` 或 `Common_Prefab_` 开头的 PNG 文件。

## 严禁在未完成图片 MD5 对比前得出"无需修改"结论

踩坑案例：TwoBtnTips_2 同步时，布局/文字/颜色全部一致，AI 错误地得出"无需修改"。实际上两张背景图都已被替换（1024×1024 vs 185×181，256×256 vs 1036×234），但因为图片替换不影响节点尺寸，仅对比布局数值无法发现差异。

**规则**：同步流程中，"无需修改"结论的前提条件是：

1. ✅ 布局/尺寸/位置对比完成
2. ✅ 文字内容/颜色对比完成
3. ✅ **每张图片的 MD5 对比完成**（导出 Figma 图片 vs Unity 本地文件）

三项全部通过才能说"无需修改"。缺少第 3 项就下结论属于违规。

## 严禁用截图合成九宫格 Sprite

踩坑案例：TwoBtnTips_2 的 Bg(1) 同步时，尝试了以下错误方法：

1. ❌ **clone 切片 + resize + flatten + get_design_context**：Figma 切片使用 CROP 变换显示源图局部区域。clone 后 resize 会导致 CROP 变换重新计算，合成结果的颜色和内容与原始渲染完全不同（出现黄色/金色而非深色背景）。
2. ❌ **clone 切片 + resize + flatten + get_screenshot**：截图有抗锯齿和背景混合，不适合做 Sprite 资源。
3. ❌ **Python 拼接切片截图**：用 `get_screenshot` 截取每个切片再拼接。虽然单个切片截图颜色正确，但拼接后的图片尺寸和 border 比例不对，导致 Unity 九宫格拉伸效果与 Figma 不一致。

**正确做法**：用 `getImageByHash` 获取原始源图，直接作为 Unity Sprite。九宫格的 `spriteBorder` 从 Figma 切片尺寸按比例计算。源图本身就是完整的九宫格图片，不需要合成。

## 新建 Prefab 时九宫图必须按 sliceKind 保存为可拉伸尺寸

踩坑案例：`UI_Attack` 导入到 `ShutdownMainView` 时，AI 直接保存了 Figma 可见拉伸后的大尺寸九宫图，例如 `UI_Attack_jiugong_dbbig1.png` 为 964×1656，但其 border 是 L72/R72/T73/B73，正确的最小 Sprite 尺寸应为 146×148。虽然 `.meta` 中 `spriteBorder` 格式正确，资源体积和九宫语义仍然错误。

**规则**：

1. 标准 `9slice` PNG 必须保存为最小可拉伸尺寸：`width = left + right + 2`，`height = top + bottom + 2`。
2. `h3slice` 只压缩横向中心段：`width = left + right + 2`，高度必须保留父节点 `sourceVisibleSize.height`。
3. `v3slice` 只压缩纵向中心段：宽度必须保留父节点 `sourceVisibleSize.width`，`height = top + bottom + 2`。
4. Figma 可见九宫节点的尺寸用于 Unity `RectTransform.sizeDelta`，但 h3/v3 的非拉伸轴也必须用于 PNG 输出尺寸，不能被压成 2px。
5. `image_download_plan.json` 中的 `expectedSize` 必须填写 Relay 实际导出的目标 PNG 尺寸，并携带 `sliceKind` 供校验。
6. 执行 `FigmaPrefabGenerator.Generate()` 前必须检查每张九宫 PNG 的实际尺寸是否符合 `sliceKind` 规则；不相等时必须先裁剪或重新导出，不能继续生成 Prefab。
7. 生成后验证必须逐张列出九宫图：文件名、实际尺寸、border、sliceKind、期望尺寸、是否通过。

**最小尺寸示例**：

| border | PNG 最小尺寸 |
| --- | --- |
| L72/R72/T73/B73 | 146×148 |
| L33/R32/T32/B28 | 67×62 |
| L31/R31/T35/B39 | 64×76 |

## 新建 TextMeshProUGUI 必须绑定 CommonFont 字体和材质

踩坑案例：`UI_Attack` 导入后，`TextMeshProUGUI` 保留了 TMP 默认字体资产 GUID `8f586378b4e144a9851e7b34d9b748ee`，没有使用项目统一字体和材质，导致视觉风格和项目规范不一致。

**规则**：

1. 只要新建或修改 `TextMeshProUGUI`，必须绑定：
   - 字体：`Assets/MagicWarrior/_Resources/Font/Package/CommonFont.asset`
   - 材质：默认使用 `Assets/MagicWarrior/_Resources/Font/Package/CommonFont.mat`；如 Figma 文本明确需要描边/阴影材质，必须来自 spec 声明的 `CommonFont_figma_*` 材质。
2. 当前 `FigmaPrefabGenerator` 只创建静态 TMP 视觉节点，不会自动完成项目级字体/材质绑定；因此导入流程必须在生成 Prefab 后执行 CommonFont 后处理。
3. 验证时必须统计：
   - Prefab 中 `TextMeshProUGUI` 总数
   - `font.name == CommonFont` 数量
   - `fontSharedMaterial.name == CommonFont` 或 spec 声明的 `CommonFont_figma_*` 数量
   - `fallbackCommonFontFigmaMaterial` warning 数量和对应 GUID
   - TMP 默认字体 GUID `8f586378b4e144a9851e7b34d9b748ee` 残留数量
4. 只有 CommonFont 字体数量等于 TMP 总数、材质全部在允许范围内，且默认字体残留为 0，才能报告 TMP 字体/材质完成；若出现 `fallbackCommonFontFigmaMaterial` warning，必须在最终报告中列出并要求人工确认来源。

## TextMeshProUGUI 必须统一关闭 AutoSize

**踩坑案例**：`UI_TipsBgRoot` 导入后，`FigmaPrefabGenerator.ApplyPostProcessing()` 的 `tmp.font = commonFont` 操作触发 TMP 内部序列化重设，使 `enableAutoSizing` 从 `false` 恢复为 `true`，同时 `fontSizeMin/Max` 归零，导致文本字号显示为 0。

**规则**：

1. 只要新建或修改 `TextMeshProUGUI`，必须设置 `enableAutoSizing = false`。
2. `FigmaPrefabGenerator` 的 `ApplyPostProcessing()` 在设置字体和材质后，**必须紧跟 `tmp.enableAutoSizing = false`**，防止 TMP 内部重设。
3. 如确有例外需开启 AutoSize，必须由用户明确指定具体节点路径。
4. 验证时必须统计：
   - Prefab 中 `TextMeshProUGUI` 总数
   - `enableAutoSizing == false` 数量
   - `enableAutoSizing == true` 残留数量
5. 只有 AutoSize=false 数量等于 TMP 总数，且 true 残留为 0，才能报告 TMP AutoSize 完成。

## 图片组件必须统一关闭 RaycastTarget

**规则**：

1. 只要新建或修改图片组件，必须设置 `raycastTarget = false`。
2. 适用范围包括 `UnityEngine.UI.Image`、项目 `CustomImage`、Simple Image、Sliced Image、九宫图 Image。
3. 禁止默认让背景图、装饰图、切片图参与点击射线，避免 UI 输入被无意义图片拦截。
4. 如某张图片确实用于点击拦截，必须由用户明确指定具体节点路径。
5. 验证时必须统计：
   - 图片组件总数
   - `raycastTarget == false` 数量
   - `raycastTarget == true` 残留数量
6. 未获用户明确批准的 `raycastTarget == true` 残留是阻塞失败，不得作为 warning 交付。

## 导入后相似 Prefab 只能用于建议，不能自动套用

**风险**：同目录或相似命名 Prefab 的层级、脚本和字段绑定可能只适用于对应业务。盲目复制会造成字段错绑、按钮事件丢失、ScrollRect 结构错误或运行时空引用。

**规则**：

1. 导入成功后可以只读分析同目录和相似 Prefab，用于推算项目习惯。
2. 分析结论必须引用真实 Prefab 路径、节点路径、组件名或字段名。
3. 禁止自动挂业务 View 脚本。
4. 禁止自动绑定 `[SerializeField]` 字段。
5. 禁止自动移动层级、替换组件或修改现有 Prefab。
6. 如果建议涉及层级调整、挂组件、字段绑定、`CustomLanguageText`、`CustomTouchButton`、`ScrollRect` 或交互结构，必须另行输出修改计划并等待用户二次确认。
7. 不确定时输出候选和证据，不要用“项目通常如此”替代真实代码或资源依据。

## 严禁把导入后推断建议当成执行许可

**风险**：用户确认导入 Prefab 只代表允许完成导入流程，不代表允许根据相似 Prefab 推断结果继续改层级、挂组件或绑定字段。把建议直接落地会绕过用户对高风险资源写入的确认。

**规则**：

1. 导入成功后的推断必须先输出建议报告。
2. 输出建议报告后必须停止，明确询问用户是否执行具体建议项。
3. 用户未再次确认前，禁止执行任何由推断建议产生的 Unity 写入。
4. 用户确认时必须对应到具体建议项；模糊确认不足以自动执行全部建议。
5. 若用户确认执行，必须重新列出影响文件、修改计划、验证方式和风险，再按确认范围执行。

## 严禁仅凭 imageHash 不同就替换图片

踩坑案例：TwoBtnTips_2 有两个 Figma 副本（`768:87` 和 `624:3230`），它们的 imageHash 不同，但通过 `getImageByHash` + `getSizeAsync` 导出后 MD5 与 Unity 本地文件**完全一致**。AI 仅凭 imageHash 不同就错误地替换了图片，导致 Prefab 引用指向了错误的新图片。

**规则**：
- imageHash 不同只是**初步信号**，不是最终判断依据
- **必须导出图片并计算 MD5**，和 Unity 本地文件对比
- MD5 相同 = 不需要替换，保留原始 Sprite 引用
- MD5 不同 = 需要写回，优先覆盖原 Unity 图片；只有用户确认不影响其他 Prefab 时才新建副本

**原因**：同一张图片在 Figma 中重新上传、复制到不同节点、或通过不同方式导入时，imageHash 可能不同，但图片内容完全相同。

## 严禁每次都新建图片文件

踩坑案例：TwoBtnTips_2 同步时，Bg(2) 图片变更，AI 每次都新建文件（`底_TwoBtnTips2.png` → `底_TwoBtnTips2_v2.png` → `底_TwoBtnTips2_804.png`），导致项目中出现大量冗余图片，Prefab 引用反复修改。实际上应该直接覆盖原始的 `底.png`。

**规则**：图片变更时的写入优先级：
1. 有 `spritePath` 元数据 → 直接覆盖该路径的文件
2. 无 `spritePath` 但有 `spriteGuid` → 通过 GUID 反查 `.meta` 找到文件路径 → 覆盖
3. 无元数据 → 通过 Prefab 中 `m_Sprite` 的 GUID 反查 → 覆盖
4. 覆盖前检查该图片是否被多个 Prefab 引用，如果是则提示用户选择覆盖还是新建副本

**严禁默认新建文件**。只有在用户明确要求"不影响其他 Prefab"时才新建副本。

## TMP 文字颜色必须使用 fontColor

解析器 JSON 同时输出 `text.color`（`m_Color`，Graphic 基类）和 `text.fontColor`（`m_fontColor`，TMP 实际渲染颜色）。从 Figma 同步颜色回 Unity 时，写入目标应为 `m_fontColor`（TMP 实际渲染颜色），而非 `m_Color`。

> **注意**：此规则在 Unity → Figma 方向同样适用。详见 `../../prefab-to-figma/references/pitfalls-unity-to-figma.md`。

## 严禁猜测 TMP 字体材质，必须读取 `__text(...)` 图层名

踩坑案例：`BuffChapterDashView_TextMaterialCheck` 同步回 Unity 时，Figma 文本节点真实名称是 `__text(CommonFont_o_833411_u_833411)`，AI 没有对文本子节点调用 `get_metadata` 复查图层名，只根据颜色和 Unity 现有材质命名相似度，错误选择了 `CommonFont_o_65301a_u_612f19.mat`。

**规则**：

1. Figma 文本节点名包含 `__text(<materialName>)` 时，`<materialName>` 就是 Unity TMP Material Preset 的精确资产名。
2. 旧 MCP 流程中的 `get_design_context` 可能只返回节点 ID、字体和颜色，不一定返回完整图层名；标准流程必须改由 Relay manifest / metadata 字段提供材质标记。若 Relay 没有返回材质标记，应停止并补 Relay 字段或询问用户，不要切回 MCP 主流程。
3. 回写 Unity 前必须精确反查 `<materialName>.mat.meta`，拿到路径和 GUID 后再写 Prefab 的 `m_sharedMaterial`。
4. 找不到同名材质时必须停止询问用户，禁止按颜色、截图、更新时间、命名相似度或“看起来更接近”选择替代材质。
5. 修改计划和最终报告必须写明：`Figma 节点名 -> Unity 材质路径 -> guid -> 写入字段`。
6. 写入后必须用 Unity 只读检查验证 `fontSharedMaterial.name == <materialName>`；没有验证结果时禁止报告材质同步完成。
7. 如果本 skill 已触发但计划中没有写明 `已加载 workflow` 和 `已加载 pitfalls`，必须停止执行并补齐加载审计，不得继续写 Prefab。

## 截图只能用于视觉验证，不能用于资源变更判定或 Sprite 生成

Figma 九宫格切片（`__slice_top`、`__slice_center` 等）使用 CROP 变换显示源图片的局部区域。截图能看到渲染结果，但它经过抗锯齿、背景混合和缩放，不是 Unity Sprite 应写入的原始像素数据。

**正确规则**：

1. 图片是否需要写回 Unity，必须以 Relay/脚本导出的源图 MD5 与 Unity 本地文件 MD5 对比为准。
2. `imageHash` 不同只能作为“需要导出并校验”的信号，不能单独判定必须替换。
3. 标准流程的截图由 Relay 导出，只允许用于人工视觉验证，例如确认九宫格切片刷新后在 Figma/Unity 里的显示是否符合预期。
4. 生成或覆盖 Unity PNG 时，严禁使用截图、`figma.flatten()`、切片拼接图作为 Sprite 来源。
5. 九宫格父节点源图 fill 与 `__slice_*` 的 imageHash 不一致时，以父节点源图 fill 作为导出源，并记录 warning 提醒切片可能未同步；必要时先运行 `.figma/nine-slice-sync/` 刷新切片后再同步。

踩坑案例：TwoBtnTips_2 的 `Bg (2)` 有两个切片 `__slice_top` 和 `__slice_center`。旧流程把 imageHash 变化和截图/合成结果混在一起判断，导致先误判图片状态，又用错误的切片合成方式生成 Sprite。现在的规则是：资源写回只认源图导出 MD5；截图只做最终视觉检查。

## 严禁未截图验收就宣称制作完成

Figma → Unity 制作完成后，必须截图验证实际渲染结果。静态文件对比、节点数量一致、Prefab 引用正确、编译通过都不能替代视觉验收。

**规则**：

1. 必须保留 Figma 目标截图或用户提供的目标图，并截取 Unity 实际结果图。
2. 必须对比关键视觉项：位置、尺寸、层级、文字、颜色、透明度、图片边缘、九宫格拉伸、遮罩和外溢范围。
3. 如果有差距，必须继续调整并再次截图；不能只记录“有轻微差异”就结束。
4. 如果差距来自字体、TMP 材质、引擎渲染差异、资源缺失或当前工具无法截图，必须明确写出未闭环原因和剩余风险。
5. 截图验收只用于判断视觉结果是否达标，不改变“图片资源导出必须使用源图 + MD5”的规则。

## 导出原始图片严禁使用 get_screenshot

`get_screenshot` 返回的是 Figma **渲染后的截图**（经过抗锯齿、背景混合、缩放），不是原始图片像素数据。当源图被 FILL 模式拉伸到与原始尺寸不同的节点上时，截图会丢失细节（例如 488×100 的图片被 FILL 到 185×181 的节点上，截图变成纯色）。

**导出原始图片的正确方式**：

1. Figma Relay 插件在 Figma 内读取目标 IMAGE 的原始图片数据、真实尺寸、imageHash 和 base64/下载 URL。
2. `gen_spec.py` 从 `image_export_manifest.json` 生成 `image_download_plan.json`，并计算可用的 `expectedMD5`。
3. `process_images.py` 原样写入普通 PNG，合成最小九宫 PNG，并生成 `image_process_report.json`。
4. 由脚本计算 MD5，与 Unity 本地图片对比。

**严禁用 `get_screenshot` 导出图片再保存为 Unity Sprite。** 截图 API 的用途是视觉对比验证，不是图片资源导出。

踩坑案例：TwoBtnTips_2 的 Bg(1) 源图被替换为 488×100 的蓝色半圆图。导出时创建了 185×181（旧图尺寸）的临时节点并用 `get_screenshot` 截图，结果图片被 FILL 拉伸为纯蓝色，丢失了所有细节。现在必须通过 Relay/脚本导出真实源图并校验 MD5。

## Figma → Unity 同步时新图尺寸可能与旧图不同

用户在 Figma 中替换九宫格源图时，新图的像素尺寸可能与旧图完全不同。同步回 Unity 时必须：

1. 用 `figma.getImageByHash(newHash)` + `getSizeAsync()` 获取新图的**真实像素尺寸**。
2. 如果新图尺寸与旧图不同，`.meta` 中的 `spriteBorder` 必须按比例重新计算，不能直接复用旧值。
3. 比例公式：`newBorder = oldBorder × (newImageSize / oldImageSize)`，分别对 left/right（基于宽度）和 top/bottom（基于高度）计算。
4. 如果比例换算后 border 值不合理（超过图片尺寸的一半），必须提示用户手动设置。

踩坑案例：旧图 `ui_bg_00.png` 是 185×181，border L88/R88/T87/B88。新图是 488×100，如果直接复用旧 border，left=88 + right=88 = 176 > 100（图片高度），九宫格会崩溃。

---

## 图片资源同步规则（原 figma-to-unity-sync-rules.md）

以下规则从原 `references/figma-to-unity-sync-rules.md` 合并而来。

### 图片资源必须逐一验证

从 Figma 同步设计到 Unity 时，必须对 Figma 中每张图片资源执行以下步骤：

1. 读取 Figma 节点的 `imageHash`，将 hash 变化作为需要导出并校验的信号。
2. 按“导出原始图片严禁使用 get_screenshot”规则由 Relay/脚本导出真实图片字节到 `.tmp/` 或目标图片目录。
3. 通过 GUID 找到 Unity Prefab 中引用的对应图片文件路径。
4. 对已经导出的真实图片字节和 Unity 现有图片计算 MD5，MD5 才是是否需要写回的最终依据。
5. 如果 MD5 相同，保留原 Sprite 引用和原文件，不新建也不覆盖。
6. 如果 MD5 不同，优先按 `spritePath` / `spriteGuid` / Prefab `m_Sprite` GUID 定位并覆盖已有图片文件。
7. 只有用户明确要求“不影响其他 Prefab”或引用数检查显示覆盖风险不可接受时，才计划新增 PNG 和 `.meta`，并修改当前 Prefab 引用。

### 禁止假设图片一致

- 不得仅凭文件名、节点名、布局数值相似或文件大小接近就判断"图片一致"
- 必须有导出图片 MD5 与 Unity 本地 MD5 对比结果作为证据；Figma `imageHash` 只能作为辅助线索
- 对比结果必须在修改计划中以表格形式列出，包含：资源名、Figma imageHash、导出图片 MD5、Unity 文件、Unity MD5、是否一致、处理方式

### 修改计划中必须包含图片对比表

示例格式：

| 资源  | Figma imageHash | 导出 MD5 | Unity 文件      | Unity MD5 | 一致 | 处理                |
| ----- | --------------- | -------- | --------------- | --------- | ---- | ------------------- |
| Bg(1) | abc123...       | 111...   | ui_bg_00.png    | def456... | 否   | 覆盖原图并重算 border |
| Bg(2) | xyz789...       | 222...   | 底.png          | 222...    | 是   | 无需修改            |

### 九宫格图片替换注意事项

- 替换九宫格 Sprite 时，必须确认新图片的 `spriteBorder` 设置与 Figma 中的切片参数一致
- 如果新旧图片尺寸不同，需要检查 Prefab 中 RectTransform 的 SizeDelta 是否需要同步调整

### 嵌套 Prefab (PrefabInstance) 修改规则

- GreenBtn、RedBtn 等公共按钮 Prefab 是共享组件，**禁止直接修改源 Prefab**
- 在 TwoBtnTips 等使用方 Prefab 中，通过 PrefabInstance 的 `m_Modifications` override 调整尺寸和位置
- Override 修改的目标格式：

  ```yaml
  - target: {fileID: <子对象fileID>, guid: <源Prefab的GUID>, type: 3}
    propertyPath: m_SizeDelta.x
    value: <新值>
  ```

- 修改前必须确认 target 的 GUID 对应的是哪个源 Prefab，避免改错对象

### Windows PowerShell 环境注意事项（历史排查参考）

- PowerShell 中 `curl` 是 `Invoke-WebRequest` 的别名，语法与 Linux curl 不同
- 标准 figma-to-prefab 流程禁止 LLM 手写 PowerShell 下载循环；图片写入必须由 `process_images.py` 完成
- 如用户明确要求人工排查下载问题，下载文件使用：`Invoke-WebRequest -Uri "<URL>" -OutFile "<路径>"`
- 对比文件 hash 使用：`(Get-FileHash "<路径>" -Algorithm MD5).Hash`
- 读取图片尺寸使用：

  ```powershell
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile("<绝对路径>")
  Write-Host "$($img.Width)x$($img.Height)"
  $img.Dispose()
  ```


## 严禁仅凭数值一致就得出"无需修改"——必须对比组件身份

踩坑案例：TwoBtnTips_2 同步时，Figma 中 `FbBtn`（蓝色 Facebook 按钮）和 Unity 中 `ButtonSureRoot`（GreenBtn，绿色按钮）的位置/尺寸数值完全一致，AI 错误地得出"无需修改"。实际上两者是**完全不同的按钮组件**——外观、图片、图标、文字全部不同。

**规则**：同步流程中，"无需修改"结论的前提条件增加第 4 项：

1. ✅ 布局/尺寸/位置对比完成
2. ✅ 文字内容/颜色对比完成
3. ✅ 每张图片的 MD5 对比完成
4. ✅ **PrefabInstance 的源 Prefab 身份对比完成**

对于 Unity 中的每个 PrefabInstance 子节点，必须确认 Figma 中对应的 Component Instance 来源是否匹配 Unity 的源 Prefab。身份不同 = 需要替换组件，即使位置/尺寸完全一致。

### 对比方法

1. 在 Figma 中，获取目标节点的 `children` 列表，对 `type === "INSTANCE"` 的子节点，检查其 `mainComponent` 或组件名称。
2. 在 Unity 中，通过 PrefabInstance 的 `m_SourcePrefab` GUID 确认源 Prefab 路径和名称。
3. 对比两边的组件名称/路径是否匹配。例如 Figma `FbBtn` 实例应对应 Unity `FbBtn.prefab`，而非 `GreenBtn.prefab`。

## 严禁用父节点 metadata 返回的子节点 bounds 作为子节点尺寸

踩坑案例：OneBtnTips 的 Bg(2) 在对 Root 节点调用 `get_metadata` 时返回 `height="763.27"`，但直接对 Bg(2) 节点本身调用 `get_metadata` 返回的实际 frame 尺寸是 `height="270"`。AI 使用了 763.27 作为 Unity SizeDelta，导致背景拉伸严重变形。

**原因**：父节点 metadata 中子节点的 width/height 可能是包含 overflow/clip 区域的 visual bounds，不是子节点 frame 的实际尺寸。当子节点设置了 `clipContent: true`（overflow clip）时，其内部子节点可能超出 frame 边界，导致 bounds 比 frame 尺寸大。

**规则**：
1. 获取节点尺寸时，**必须使用 Relay manifest 中目标节点自身的 bounds/relativeBounds**，不能使用父节点 metadata 中返回的子节点尺寸。
2. 如果父节点 metadata 返回的子节点尺寸与 Relay manifest 直接节点尺寸不同，以 Relay manifest 直接节点尺寸为准。
3. 特别注意九宫格容器（有 `__slice_*` 子节点的 frame）——它们通常设置了 overflow clip，bounds 可能远大于 frame 尺寸。

## 严禁混用不同 Prefab 的参考值

踩坑案例：OneBtnTips 重建时，把 TwoBtnTips 的 Bg(1) 尺寸 (1041.47×833.3) 和位置 (0, 8) 直接复制过来。但 OneBtnTips 只有一个按钮，背景更小（1042×682），位置也不同 (0, 153)。

**规则**：
1. 即使两个 Prefab 使用相同的背景组件，**尺寸和位置必须从目标 Figma 节点独立计算**，不能从其他 Prefab 复制。
2. 不同弹板的布局不同（按钮数量、内容高度），背景尺寸和位置必然不同。
3. 只有在无法获取 Figma 数据时，才可以参考类似 Prefab 的值，且必须标注为"参考值，需验证"。

## PrefabInstance 的 SizeDelta 必须使用 Figma 设计值，不是源 Prefab 默认值

踩坑案例：OneBtnTips 中 RedBtn 的 SizeDelta override 使用了源 Prefab 默认值 362.56×112，但 Figma 设计中 RedBtn__ImportBounds 的尺寸是 574×150。

**规则**：
1. PrefabInstance 在使用方 Prefab 中的 SizeDelta，**必须使用 Figma 设计中该实例的实际尺寸**。
2. 源 Prefab 的默认 SizeDelta 只是"未 override 时的值"，不代表在当前 Prefab 中应该使用的尺寸。
3. 对于带 `__ImportBounds` 后缀的 Figma 组件实例，其外层 bounds 尺寸就是 Unity 中应该 override 的 SizeDelta。

## 严禁使用 get_design_context 返回的非直接子节点坐标

踩坑案例：TwoBtnTips_2 同步时，`get_design_context` 返回的代码中包含了 `FbBtn`（节点 `490:2858`）和 `RedBtnImportBounds`（节点 `405:11`）。AI 直接用了这两个节点的坐标计算 Unity 位置，但它们实际上是**组件库中的模板节点**（父节点是 `Buttons` 组件库），不是 `TwoBtnTips_2/Root` 的直接子节点。正确的子节点是 `883:51` 和 `860:88`，坐标完全不同。

**规则**：

1. 旧 MCP 流程中的 `get_design_context` 返回节点 ID 可能包含组件内部节点（Component 定义层），不一定是目标节点的直接子节点。
2. 计算 Unity anchoredPosition 时，**必须使用 Relay manifest 中目标父节点的 `childIds` 列表**，确认直接子节点的 ID。
3. 只使用 Relay manifest 中直接子节点的 `x`、`y`、`width`、`height` 做坐标转换，严禁使用旧 `get_design_context` 代码中出现的任意节点坐标。
4. 对于 `type === "INSTANCE"` 的子节点，其内部子节点的坐标是相对于实例本身的，不能用于计算相对于父节点的位置。


## 九宫格必须使用隐藏的小尺寸源图节点，严禁使用可见的拉伸显示节点

踩坑案例：BuffChapterDash 导入时，Figma 设计稿中有两组九宫格节点：
- 隐藏的小尺寸源图节点（`02_jiugong_2` 54×51，`03_jiugong_1` 48×37）— 真正的九宫格源图
- 可见的大尺寸显示节点（`04_jiugong_1` 612×391，`05_jiugong_2` 241×147）— 源图拉伸后的显示效果

AI 错误地导出了可见的大尺寸节点作为 Sprite，虽然设置了 `Image.Type.Sliced` 和 `spriteBorder`，但图片本身已经是拉伸后的大图，九宫格没有实际意义。

**规则**：

1. 导入九宫格时，**必须找到隐藏的小尺寸源图节点**（通常 `visible=false`，尺寸远小于可见的显示节点）。
2. 可见的大尺寸九宫格节点只是"显示效果"，它的图片是源图被 FILL 拉伸后的渲染结果，不能作为 Unity Sprite。
3. 识别方法：在 Figma 中搜索同名或相似名称的隐藏 frame 节点，它们包含 `__slice_*` 子节点且尺寸很小（通常 < 100px）。
4. 从隐藏源图节点的父节点 fill 或切片 fill 中获取 `imageHash`，用 `getImageByHash` + `getSizeAsync` 确认真实尺寸后导出。
5. `spriteBorder` 从隐藏源图节点的 `__slice_top_left` 尺寸获取（left=width, top=height），不是从可见显示节点的切片尺寸获取。
6. 可见显示节点的尺寸用作 Unity 中 `RectTransform.sizeDelta`（即九宫格拉伸后的目标尺寸）。

**判断流程**：
```
1. 遍历所有子节点，找到包含 __slice_* 的 frame
2. 如果该 frame 是 hidden 且尺寸很小 → 这是源图节点，导出它的图片
3. 如果该 frame 是 visible 且尺寸较大 → 这是显示节点，只取它的尺寸作为 sizeDelta
4. 用源图节点的切片尺寸设置 spriteBorder
```

## INSTANCE 类型节点必须使用项目中的公共 Prefab，严禁自建替代品

踩坑案例：BuffChapterDash 导入时，Figma 中绿色按钮是 `INSTANCE` 类型（组件名 `KaTongGreenBtn_1`），项目中有对应的 `_Common/Buttons/New/KaTongGreenBtn_1.prefab`。AI 没有搜索项目中的公共 Prefab，而是用 Image + Button 组件 + 独立图片自建了一个按钮。

**规则**：

1. 对于 Figma 中 `type === "INSTANCE"` 的节点，**必须先在项目中搜索同名公共 Prefab**。
2. 搜索路径优先级：`_Common/Buttons/` → `_Common/` → 全局搜索 `.prefab` 文件。
3. 找到匹配的公共 Prefab 后，使用 `PrefabUtility.InstantiatePrefab` 作为 PrefabInstance 嵌入，**不要自建替代品**。
4. PrefabInstance 嵌入后**保留源 Prefab 的原始名称**，不要改名。如果需要在父 Prefab 中区分，通过 sibling index 或父节点组织区分，不改子节点名。
5. 通过 override 调整 PrefabInstance 的 `anchoredPosition` 和 `sizeDelta` 以匹配 Figma 设计中的位置和尺寸。
6. 如果项目中没有同名 Prefab，才可以用图片 + 组件方式自建，但必须在修改计划中明确说明"未找到公共 Prefab，将自建"。

**匹配规则**：
- Figma 组件名 `KaTongGreenBtn_1` → 搜索 `KaTongGreenBtn_1.prefab`
- Figma 组件名 `RedBtn` → 搜索 `RedBtn.prefab`
- 名称匹配不区分大小写，优先精确匹配，其次模糊匹配

**严禁行为**：
- ❌ 用 Image + Button 替代已有的公共按钮 Prefab
- ❌ 给 PrefabInstance 改名（如把 `KaTongGreenBtn_1` 改成 `[GoBtn]`）
- ❌ 下载公共 Prefab 的图片作为独立 Sprite 使用

## 严禁修改 `Common_Components` 引用和公共实例内部命名

Figma 中引用 `Common_Components` 画布的 component / instance 时，Unity 通常已有对应公共 Prefab 或节点映射。改名会导致导入、替换或绑定失败。

**规则**：

1. `Common_Components` 来源的 instance 名称和内部子节点名称必须保留。
2. 即使内部存在 `fg`、`BG`、`TITLE`、`Close` 等不够语义化的名称，也不要整理它们。
3. 如果需要表达业务语义，只能在外层父节点补充，例如 `Reward_Item / Common_Reward`、`Avatar_Column / Common_CharacterCard`。
4. `Common_Item` 必须视为整 Prefab 复用对象，不要拆内部图标、底图、数量样式或字段。

**严禁行为**：
- ❌ `Common_Btn_Pop_Close` 改成 `Popup_Close_Button`
- ❌ `Common_Item` 改成 `Reward_Item_Icon`
- ❌ 展开 `Common_Item` 内部并替换 Sprite

## 严禁跳过资源归档判断直接导出图片

重复导出公共图或把功能内通用图放错目录，会造成资源膨胀和后续替换困难。

**规则**：

1. `Common_` 图片先查 `Assets/_Art/Texture/GUI/_Common`。
2. 功能内复用图片先查或放入 `功能名_CommonUI`。
3. 单界面业务图片才放到业务模块目录。
4. Figma `Component` / `Variant` 内部只有一张图片时，按图片资源处理，不按结构组件创建子 Prefab。
5. 同一批导出图片名必须唯一，业务图片必须带 `FeatureName_` 前缀。

**严禁行为**：
- ❌ 把功能内通用图片误放入全局 `CommonFigma`
- ❌ 未查 Common 目录就重新导出公共按钮、弹窗底板、红点、道具框
- ❌ 同一界面导出两个同名 PNG

## 严禁把可滚动区域做成静态裁剪容器

只要内容会超出可视区域，且语义是列表、奖励区、卡片区、道具区等可滚动容器，就必须落地为 `ScrollRect` 结构。

**规则**：

1. Figma 开启 `Clip Content`、内容超出可视区域、语义是滚动容器时，使用 `ScrollView / Viewport / Content`。
2. 所有 row / item 必须放在 `Content` 下。
3. `Viewport` 使用裁剪组件，`Content` 承载 LayoutGroup 或动态生成节点。

**严禁行为**：
- ❌ 用 `RectMask2D/Mask + LayoutGroup` 替代实际需要滚动的 `ScrollRect`
- ❌ 只因当前截图没看到滚动条就省略 `ScrollRect`
- ❌ 把 row / item 直接挂在 `ScrollView` 或普通 frame 下

## 严禁把固定文案烘焙成图片或硬编码进 Prefab

固定文案需要支持多语言，不能因为 Figma 中看起来是静态文本就转成图片。

**规则**：

1. 标题、按钮、固定描述、页签、弹窗固定提示语使用 `CustomLanguageText`。
2. 数字、时间、玩家名、奖励数量、读表动态文本和运行时拼接文本使用 `CustomText`。
3. 新增多语言表、ID 段、Excel 路径等属于项目配置变更；必须先确认当前项目规则。
4. 英文等语种可能更长，计划中要说明布局预留、换行或自适应方案。

**严禁行为**：
- ❌ 把长文案切成图片
- ❌ 把固定中文写入 Prefab 文本字段并宣称完成多语言
- ❌ 只按中文长度验收按钮或页签

## 严禁拆碎 boolean-operation / flatten 节点

Figma 的 `boolean-operation` / `flatten` 表示合层后的视觉结果。拆回内部基础形状会增加资源数量并引入轮廓和对齐误差。

**规则**：

1. 决定导出时，按合层整体结果导出一张图。
2. 决定 Unity 还原时，也必须说明还原的是合层后的整体视觉，不是布尔运算前的内部结构。
3. 如果该节点同时属于 `Common_` 或功能通用资源，先走复用目录检查，再决定是否新增。

**严禁行为**：
- ❌ 把一个 `boolean-operation` 拆成多张图片
- ❌ 因视觉简单就跳过节点类型判断
- ❌ 为同一布尔图形重复导出业务图和 Common 图


## Prefab first generation has empty Sprite references: check TextureImporter refresh timing first

Case: while importing `UI_Attack (2649:32)`, Relay export, PNG writes, and the first `FigmaPrefabGenerator.Generate()` call all appeared successful. Static Prefab checks still found several `m_Sprite: {fileID: 0}` residues, and the new PNG `.meta` files still had `textureType: 0`, `spriteMode: 0`, and `alphaIsTransparency: 0`. In that state, `AssetDatabase.LoadAssetAtPath<Sprite>(path)` returns null, so Image components are saved without Sprite references.

Rules:

1. After writing PNG files into the Unity project, do not trust file existence alone; confirm Unity imported them as Sprite assets.
2. After generating the Prefab, check the target Prefab for `m_Sprite: {fileID: 0}`. Any count greater than 0 is a blocking failure, not a warning.
3. Check every new PNG `.meta`: `textureType: 8`, `spriteMode: 1`, `alphaIsTransparency: 1`; for sliced images also check `spriteBorder`.
4. If the first generation leaves default texture `.meta` values, let Unity finish Refresh/Importer setup and run `FigmaPrefabGenerator.Generate(".tmp/prefab_spec.json")` again.
5. The final report must include the SpriteNull check result, for example `m_Sprite: {fileID: 0} = 0`.

Code evidence: the current generator calls `ApplySpriteBorderAfterImport()` from `FigmaPrefabGenerator.DownloadImages()` to set `TextureImporter.textureType = TextureImporterType.Sprite`, `spriteImportMode = Single`, `alphaIsTransparency = true`, and `mipmapEnabled = false`. Later `CreateImageNode()` loads the Sprite through `AssetDatabase.LoadAssetAtPath<Sprite>()`. If the importer state has not taken effect yet, Sprite loading fails.

## Do not put complex validation logic into uLoop dynamic code

Case: after import, a long C# snippet was passed to `uloop execute-dynamic-code --code` to count TMP, Image, and SpriteNull residues. The code itself was correct but mixing concern-specific validation with Unity execution added unnecessary latency.

Rules:

1. Keep Unity dynamic code to a single focused call — `FigmaPrefabGenerator.Generate(path)`.
2. All verification (Prefab YAML, `.meta`, PNG size, MD5, `m_Sprite: {fileID: 0}`, `m_RaycastTarget`, `m_enableAutoSizing`) must be done via Python static file analysis, not Unity runtime code.
3. Keep CLI dynamic code to direct statements; place complex validation in the existing Python static checks.
4. Do not misdiagnose CLI compile errors as generator logic failures — check `.meta` state first.

## Attribute Console errors only after inspecting the stack trace

Case: after import, Console contained a `NullReferenceException`, but the stack trace was `UnityEditor.Graphs.Graph.OnEnable()`, not `FigmaPrefabGenerator`, the target Prefab, or the new image directory. After clearing Console and recompiling, Unity still reported 0 Error / 0 Warning, so the error could not be attributed to this import.

Rules:

1. When Console has Error logs, inspect the stack trace.
2. Attribute an error to the current import only if the stack points to the current import paths, generator, resource import, or target Prefab.
3. If the stack belongs to UnityEditor internals or historical residue, report the evidence and remaining risk; do not silently ignore it, and do not misattribute it.

## Efficiency: use uLoop CLI for all Unity-side execution

**Solution**: All Unity execution (Generate, compile, log check, screenshot) uses `uloop` CLI:
```bash
uloop execute-dynamic-code --code '<approved direct C# statements that invoke FigmaPrefabGenerator.Generate(".tmp/prefab_spec.json") by reflection>'
```
Use PowerShell single quotes around `--code`; keep the code to direct statements and let the static Python checks handle complex validation.

## Efficiency: pre-write `.meta` files before first Generate to avoid two-pass TextureImporter refresh

**Problem**: The first `FigmaPrefabGenerator.Generate()` runs before Unity finishes importing new PNG files as Sprites. All `.meta` files have `textureType: 0` (Default), so `AssetDatabase.LoadAssetAtPath<Sprite>()` returns null. The workaround — fix `.meta` → `AssetDatabase.Refresh()` → re-Generate — doubles the execution time.

**Solution**: Before calling `FigmaPrefabGenerator.Generate()`, pre-write every target PNG's `.meta` file with correct Sprite settings:
  - `textureType: 8` (Sprite)
  - `spriteMode: 1` (Single)
  - `alphaIsTransparency: 1`
  - `mipmaps.enableMipMap: 0`
  - For nine-slice: `spriteBorder: {x: left, y: bottom, z: right, w: top}`

Then call `FigmaPrefabGenerator.Generate()` once. The Sprite assets are already available on first import, eliminating the two-pass problem.

**Rule**: Pre-write `.meta` → call `AssetDatabase.Refresh()` via `uloop execute-dynamic-code` → single `Generate()` call. Verify `m_Sprite: {fileID: 0} == 0` after first generation; if > 0, check `.meta` correctness instead of blindly re-generating.

## Efficiency: batch confirmation windows to reduce round-trips

**Problem**: The figma-to-prefab skill requires user confirmation at every gate: inputs → Relay → Spec → phase-II → verify → post-analysis. Each round-trip adds 15-30s of context switching.

**Solution**: In the Spec review step, batch the following into a single confirmation request:
  - Relay result summary (status, blockingErrors, image count, nine-slice stats)
  - JSON Spec lint results (all validations)
  - Nine-slice PNG min-size verification table
  - PrefabInstance mapping table (exact + fuzzy matches)
  - Known issues (duplicateOf failures, Common_Prefab_Down fuzzy match)
  - Explicit "confirm phase-II execution" with all of the above visible

This collapses 3-4 separate confirmations into 1, saving 1-2 minutes per import.

---

## 2026-05-12 系统性经验：九宫、SKIP、去重（7日任务拆分 202 节点 20 九宫）

以下规则从 `7日任务拆分` Figma → Unity 导入的 4 轮迭代中提炼，属于硬规则而非建议。

### 九宫最小尺寸必须从源图四角+四边合成，严禁左上角单点 crop

**错误做法**：`png.crop((0, 0, min_w, min_h))` — 只取源图左上角
**后果**：右/下边的装饰元素全部丢失。Unity `spriteBorder` 定义的是图片两端的保护区：左端在像素 0-left，**右端在像素 (W-right)-W**，上端在 0-top，**下端在 (H-bottom)-H**。左上角单点 crop 拿不到右端和下端。

**正确做法**：从源图不同位置取边角合成最小图片：

```python
# 9-slice
new_w = left + right + 2; new_h = top + bottom + 2
result = Image.new('RGBA', (new_w, new_h))
result.paste(png.crop((0, 0, left, top)), (0, 0))                          # TL
result.paste(png.crop((W-right-2, 0, W, top)), (left+2, 0))                # TR
result.paste(png.crop((0, H-bottom-2, left, H)), (0, top+2))               # BL
result.paste(png.crop((W-right-2, H-bottom-2, W, H)), (left+2, top+2))     # BR
result.paste(png.crop((left, 0, left+2, top)).resize((2, top)), (left, 0)) # top edge
# h3-slice 同理：left+center+right 横向合成，保留完整高度
# v3-slice 同理：top+center+bottom 纵向合成，保留完整宽度
```

**门禁**: 生成后必须检查每张九宫 PNG 的实际内容 — 四角四边是否都保留。单点 crop 是阻塞失败。

### SKIP 逻辑必须用 startswith('__slice_')，禁止用 'in' 检查

**错误做法**: `if '__slice' in name.lower(): SKIP`
**后果**: 父容器 `29_jiugong_daily_bgbig1__slice` 名称中恰好含 `__slice`，被误加入 SKIP 集合，导致所有九宫容器被跳过。

**正确做法**: `if name.lower().startswith('__slice_'): SKIP` — 只跳过叶子切片节点。同时递归收集切片子节点的子节点加入 SKIP（切片子节点也有子节点要一起跳）。

### imageHash 去重必须覆盖无 base64 的节点

**场景**: 节点 A 有 base64 导出 → 注册到 `image_specs`。节点 B 共享相同 `imageHash` 但无 base64 → 必须探测 `hash_to_image_id` 复用已有 `imageId`，**严禁降级为 Panel**。

**正确流程**:
```python
# 先查去重映射
image_hash_for_node = None
for e in node_exports:
    h = e.get('imageHash', '')
    if h and h in hash_to_image_id:
        image_hash_for_node = h
        break

# 优先级: 九宫 > 自有base64 > 共享hash > Instance > Panel
if node_id in SIXED_DATA:
    spec_type = 'Image'
elif has_export_image:
    spec_type = 'Image'
elif image_hash_for_node:
    spec_type = 'Image'  # 共享 hash，复用已有 imageId
elif ntype == 'INSTANCE':
    spec_type = 'PrefabInstance'
```

### 九宫副本容器必须映射源图

**场景**: 多个九宫容器（如 78/79/80）与另一些容器（69/70/71）切片结构完全相同，`__slice_*` 子节点导出仅为首批容器所有，副本无独立 base64。

**正确做法**: 建立 `DUPE_SRC = {dup_id: src_id}` 映射：
1. 从源容器的 `__slice_*` 子节点找到 base64 导出
2. 把源导出注入到副本容器的第一个 `__slice_*` 子节点
3. 副本容器的 SIXED_DATA 通过 `deepcopy(SIXED_DATA[src_id])` 获取（复用相同的 source image 和 border）

### 九宫类型自动判断（参考 psd-layer-to-figma）

```python
has_corners = any(n in names for n in ['__slice_top_left', '__slice_bottom_left'])
has_h = any(n in names for n in ['__slice_left', '__slice_right'])
has_v = any(n in names for n in ['__slice_top', '__slice_bottom'])
ratio = w / h if h > 0 else 999

if has_corners or (w > 100 and h > 100 and 0.3 <= ratio <= 3.0):
    return '9slice'
elif has_h or ratio > 3.0 or (h < 80 and w > h * 3):
    return 'h3slice'
elif has_v or ratio < 0.33 or (w < 80 and h > w * 3):
    return 'v3slice'
```

**h3-slice 必须保留完整高度，v3-slice 必须保留完整宽度**（参考 psd-layer-to-figma hard rule）。

### Border 必须从 Figma __slice 子节点尺寸计算

不依赖 Relay 导出中的 border 字段（该字段可能缺失或为 0）。
Border 格式: `{left, bottom, right, top}` → Unity `.meta`: `{x: left, y: bottom, z: right, w: top}`。

```python
# 9-slice
border['left']   = __slice_top_left.width
border['right']  = __slice_top_right.width
border['top']    = __slice_top_left.height
border['bottom'] = __slice_bottom_left.height
# h3-slice
border['left']   = __slice_left.width
border['right']  = __slice_right.width
# v3-slice
border['top']    = __slice_top.height
border['bottom'] = __slice_bottom.height
```

### 父子相对坐标必须用直接父节点 bounds

**错误**: 所有子节点统一用根节点 `root_bounds` 计算 Unity 坐标。
**正确**: 用直接父节点 `node_map[child.parentId].bounds` 计算。
**抽查门禁**: 生成 Spec 前抽查至少一个有子节点的父节点，确认子节点坐标已从 `child.relativeBounds - parent.relativeBounds` 转换。

### Spec 文件名与实际 PNG 文件名必须一致

使用统一的 `sanitize_name()` 函数生成文件名，禁止在 `register_image()` 和图片写入代码中使用不同的命名逻辑。生成后检查 `ImageSpec.fileName` 对应的文件是否全部存在。

### 后处理验证清单

生成 `FigmaPrefabGenerator.Generate()` 后必须：
- [ ] 静态检查 `m_Sprite: {fileID: 0}` = 0
- [ ] 静态检查 `m_RaycastTarget: 1` = 0（所有图片组件）
- [ ] 静态检查 `m_enableAutoSizing: 0` = 0（所有 TMP）
- [ ] 绑定 CommonFont.mat: `m_fontMaterial: {fileID: 2100000, guid: fcba6b7bbf5920740a85f43f90020a1a}`
- [ ] 编译 0 Error 0 Warning
- [ ] 九宫 PNG 尺寸符合 `sliceKind`：9slice 用最小宽高，h3slice 保留完整高度，v3slice 保留完整宽度

### INSTANCE 内部子节点必须全部 SKIP，不得创建到 Prefab

**场景**: Figma 中 `type=INSTANCE` 的节点（如 `Common_Texture_Lock`）在 Figma 节点树中有内部子节点（如 `Common_Lock 2`）。这些子节点属于源 Prefab/Component 的内部结构。

**错误做法**: 把 INSTANCE 的子节点也作为普通节点处理，创建到目标 Prefab 中。
**后果**: 
1. 子节点的 relativeBounds 可能是绝对坐标（非相对 INSTANCE），位置完全错误
2. Prefab 中出现重复的内部结构（INSTANCE 自身 + 被拆碎的子节点）
3. 子节点的图片覆盖 INSTANCE 本身的图片引用

**正确做法**:
```python
# 1) 所有 INSTANCE 内部子节点加入 SKIP_IDS
for n in nodes_list:
    if n['type'] == 'INSTANCE':
        for cid in children_map[n['id']]:
            collect_skip_ids(cid)  # 递归跳过

# 2) process_node 中 INSTANCE 的子节点不处理
if ntype != 'INSTANCE':
    for cid in get_immediate_children(node_id):
        ...
```

**注意**: `FigmaPrefabGenerator.cs` 已支持 `PrefabInstance` 类型的 Spec 节点，通过 `prefabInstances[].sourcePrefabPath` 加载源 Prefab。feature-local ComponentSet 还可在节点上写 `activeVariant`，生成器会只启用源 Prefab 根下对应 `[Variant_*]` 子节点。同状态变体去重时，`activeVariant` 可以指向代表 Variant，例如 `Day4_Locked` 指向 `Variant_Day3_Locked`。

### Common_Texture_* 节点必须先用项目已有公共贴图

**场景**: Figma 中名为 `Common_Texture_Lock`、`Common_Texture_Toggle`、`Common_Texture_Timer` 的节点。

**错误做法**: 从 Figma 导出新 PNG 或用 INSTANCE 子节点图片。
**正确做法**:
1. 扫描 `Assets/_Art/Texture/GUI/_Common/` 递归所有 `.png`，建立 `{stem → {assetPath, guid}}` 索引
2. 节点名命中索引 → `register_image()` 用 `existing_asset_path` 直接指向已有资源
3. 跳过 PNG 导出和 `.meta` 写入
4. 未命中 → 结束时列出缺失的 `Common_Texture_*` 名称

```python
COMMON_TEXTURE_INDEX = {}
for png in _common_dir.rglob("*.png"):
    COMMON_TEXTURE_INDEX[png.stem] = {"assetPath": rel_path, "guid": meta_guid}
```

### INSTANCE 节点降级处理：从子节点取图，然后降级为 Image

**场景**: INSTANCE 节点自身无图片导出，图片在内部子节点上。公共贴图或未命中 ComponentSet 的视觉实例需要降级为 Image；命中 feature-local ComponentSet 的业务实例必须转为 PrefabInstance。

**错误做法**: 跳过 INSTANCE 子节点 → 子节点的图丢失。
**错误做法2**: 保留子节点 → 错位的重复节点。

**正确做法**（三步）:
1. 第一轮遍历：对每个 INSTANCE，如果有子节点带 base64 → 把子节点的 export 转到 INSTANCE 父节点上
2. 子节点全部加入 SKIP_IDS（递归）
3. process_node 中，INSTANCE 优先判断 ComponentSet / 公共 Prefab / Common_Texture；命中 ComponentSet 则保留为 PrefabInstance，未命中但有图片导出时才降级为 Image。

```python
for n in nodes_list:
    if n['type'] == 'INSTANCE':
        for cid in children_map[n['id']]:
            c_exps = export_by_node.get(cid, [])
            for e in c_exps:
                if e.get('base64'):
                    export_by_node[n['id']].append(e)  # 转移
                    break
        for cid in children_map[n['id']]:
            collect_skip_ids(cid)  # SKIP
```

### imageHash 去重需要同时查子节点的 exports

**场景**: INSTANCE 副本节点（如其他 6 个 Common_Texture_Lock）的子节点无 base64 但有 imageHash。如果只查节点自身的 exports，找不到共享 hash，节点仍然缺图。

**正确做法**: 节点自身 exports 中没有共享 hash 时，也查子节点的 exports：
```python
if not image_hash_for_node:
    for cid in get_immediate_children(node_id):
        for e in export_by_node.get(cid, []):
            h = e.get('imageHash', '')
            if h and h in hash_to_image_id:
                image_hash_for_node = h
                break
        if image_hash_for_node:
            break
```

### 九宫类型检测逻辑不得重复维护 —— 使用 `nine_slice_common.detect_type_and_border()`

踩坑案例：v3slice 容器（12_jiugongv3_rewards_db1，w=500/h=548）的 border 全为 0，因为宽高比 0.91 落在 [0.3, 3.0] 范围内，被 9slice 检测提前捕获。

**根因**：`gen_spec.py` 和 `process_images.py` 各自维护了一份完全相同的九宫类型检测代码。两处的优先级都错误地把宽高比检测放在切片名称检测之前。

**规则**：
1. **禁止在两个文件中重复实现九宫类型检测**。必须使用共享模块 `nine_slice_common.detect_type_and_border(slices, w, h)`。
2. 检测优先级：`has_tl → has_l+has_r → has_t+has_b → 宽高比 fallback`
3. h3slice/v3slice **必须**在宽高比 fallback 之前被显式切片名称捕获

**后果**：
- 改了 gen_spec.py 的检测逻辑但没改 process_images.py → 两边行为不一致
- 导致调试 3 轮才修好，浪费约 30 分钟

### h3slice/v3slice 导出必须保留完整显示尺寸

踩坑案例：Relay 为 v3slice 导出了 2×275 的预裁剪图（left=right=0），在 Unity 中被拉伸到 500px 宽后视觉不正确。

**规则**：
1. h3slice 合成后必须保留完整显示高度（不能因 `top+bottom+2=2` 而把高度切成 2）
2. v3slice 合成后必须保留完整显示宽度（不能因 `left+right+2=2` 而把宽度切成 2）
3. Relay Figma→Prefab 通道必须携带 `sliceKind` 和 `sourceVisibleSize`，父节点有 IMAGE fill 时优先使用父节点 `imageHash` 直接导出正确尺寸。
4. 只有旧 manifest 或父节点缺图时，`process_images.py` 才 fallback 到 synthesize；fallback 需要从父节点可用源图或 `__slice_*` 子节点共享 imageHash 获取完整源图，按 slice bounds 手动裁剪各区域。

### base64 传播方向禁止父→子，只能子→子

踩坑案例：把 FRAME 父节点的 base64（Relay 预裁剪的 2×275 结果图）复制给切片子节点，导致 synthesize_v3slice 用预裁剪图当"源图"，提取的 top/bottom/center 区域完全错位。

**规则**：
- 旧 Relay manifest 中 FRAME 父节点的 base64 可能是错误预裁剪结果图，不能盲目传播给切片子节点。
- 新 Relay manifest 中 FRAME 父节点若带 `sliceKind/sourceVisibleSize` 且尺寸门禁通过，可以作为最终 PNG 直接写入。
- 切片 fallback 的源图传播方向是**子→子**（`__slice_top → __slice_center → __slice_bottom`），因为它们共享同一个 imageHash。
- 禁止把父节点的 base64 传播给子节点```

---

## 2026-05-22 系统性经验：图片导出尺寸与颜色（明日方舟主界面 1920×1080）

### 严禁用 `image.getBytesAsync()` 作为非九宫 IMAGE fill 的导出源

**错误做法**：对 IMAGE fill 节点用 `image.getBytesAsync()` 获取源图字节
**后果**：返回源图文件原生分辨率（如 1672×941），而不是 Figma 帧显示尺寸（如 1920×1080）。Unity 中 PNG 像素数与 RectTransform 尺寸不匹配。

**正确做法**：新增 `exportImageAtFrameSize()` 函数，对非九宫 IMAGE fill 节点用 `node.exportAsync()` 按帧尺寸导出；失败时回退到 `image.getBytesAsync()`。

### 严禁 SOLID fill 节点导出时包含效果溢出

**错误做法**：`node.exportAsync({ format: "PNG" })` 不带约束
**后果**：节点有投影/描边效果时，导出 PNG 包含了效果外扩区域（如 380×116 → 400×136）。Unity RectTransform 按 Figma 帧尺寸（380×116），导致 PNG 被压缩变形。

**正确做法**：必须使用 `contentsOnly: true` + `constraint: { type: "SCALE", value: 1 }` 限制导出范围到节点帧边界。

```javascript
// ✅ 正确
const bytes = await node.exportAsync({ 
    format: "PNG", 
    constraint: { type: "SCALE", value: 1 }, 
    contentsOnly: true 
});
```

### 严禁给 Relay 已导出 PNG 的 Image 节点叠加 m_Color

**错误做法**：在 spec 中给 Image 节点设置 Figma 填充色，例如 `color: {r: 0.949, g: 0.957, b: 0.945, a: 0.9}`
**后果**：Relay 导出 PNG 时已将填充色+描边+效果烘焙到像素中。Unity 的 `Image.m_Color` 会与像素色值相乘，造成**双重染色**——颜色过深、透明度偏低。

**正确做法**：所有 Image 节点的 `m_Color` 必须保持 `(1, 1, 1, 1)`。PNG 自带颜色，`gen_spec.py` 的白色默认值是正确的。

**适用条件**：此规则适用于 Relay `exportAsync` 导出的节点（包括 IMAGE fill 帧尺寸导出和 SOLID fill 节点导出）。对于纯 1×1 白色像素 PNG（由 gen_spec 创建），m_Color 可以设置为 Figma 填充色。

### 新增文件

- `03_figma_to_prefab.js`：`exportImageAtFrameSize()` 函数 + `nodeExport` 路径均需 `contentsOnly` 约束
- 参考 `memory/figma-to-prefab-image-export-sizing.md`
