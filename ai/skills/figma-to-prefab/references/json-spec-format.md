# JSON Spec 格式规范

本文件定义脚本生成的 JSON Spec 与 `FigmaPrefabGenerator.cs` 之间的契约。阶段一由 `gen_spec.py` 从 MCP Relay manifest 生成此 JSON，阶段二中 C# 脚本读取并创建 Prefab。LLM 只审核脚本输出的结构化报告，不手写或手改 Spec。

## 整体结构

Spec 文件必须写入 Unity 工程根目录下的 `<unity-project>/.tmp/prefab_spec.json`。调用生成器时从 Unity 工程根目录传入相对路径：

```csharp
FigmaPrefabGenerator.Generate(".tmp/prefab_spec.json")
```

不要把 Spec 写到仓库根目录的 `.tmp/`，否则生成器会在 Unity 工程根目录下找不到文件。

```json
{
  "prefabName": "UI_AttackView",
  "prefabPath": "Assets/MagicWarrior/_Resources/Prefabs/UGUI/Attack/UI_AttackView.prefab",
  "rootSize": {"x": 1080, "y": 2340},
  "images": [...],
  "prefabInstances": [...],
  "nodes": [...]
}
```

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prefabName` | string | 是 | Prefab 根节点名称，如 `UI_FeatureName` |
| `prefabPath` | string | 是 | 完整资源路径，以 `Assets/` 开头，以 `.prefab` 结尾 |
| `rootSize` | Vector2Spec | 是 | 根节点设计尺寸（通常是 Figma 画布尺寸） |
| `images` | ImageSpec[] | 否 | 需要下载/导入的图片资源列表 |
| `prefabInstances` | PrefabInstanceRef[] | 否 | 引用的现有 Prefab 列表 |
| `nodes` | NodeSpec[] | 是 | 扁平节点列表，**第一个节点必须是 type="Root"** |

---

## Vector2Spec

```json
{"x": 1080, "y": 2340}
```

用于尺寸和 pivot，所有字段为 float。

## Vector4Spec

```json
{"l": 88, "b": 88, "r": 88, "t": 87}
```

用于 spriteBorder。`l`=left, `b`=bottom, `r`=right, `t`=top。

---

## ImageSpec — 图片资源

```json
{
  "id": "img_0",
  "fileName": "Attack_BG.png",
  "targetDir": "Assets/_Art/Texture/GUI/Attack/",
  "spriteSettingJson": "{\"pivot\":{\"x\":0.5,\"y\":0.5},\"border\":{\"l\":88,\"b\":88,\"r\":88,\"t\":87}}"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 唯一标识，NodeSpec 中 `imageId` 引用此 id |
| `fileName` | 是 | 图片文件名（含扩展名 .png） |
| `targetDir` | 是 | 目标目录，以 `Assets/` 开头 |
| `spriteSettingJson` | 否 | JSON 字符串，反序列化为 SpriteSettingSpec |

### 图片下载清单（AI 侧契约）

`ImageSpec` 不包含下载 URL。`gen_spec.py` 必须在阶段一额外生成 `<unity-project>/.tmp/image_download_plan.json` 和 `<unity-project>/.tmp/spec_audit_report.json`。阶段二由 `process_images.py` 按 MCP Relay manifest/base64 和下载计划写入图片，确认文件存在后再调用 `FigmaPrefabGenerator.Generate()`。

推荐结构：

```json
{
  "images": [
    {
      "imageId": "img_0",
      "figmaNodeId": "123:456",
      "imageHash": "abc123",
      "downloadUrl": "https://...",
      "targetAssetPath": "Assets/_Art/Texture/GUI/Attack/Attack_BG.png",
      "expectedSize": {"x": 128, "y": 64},
      "expectedMD5": "0123456789abcdef0123456789abcdef",
      "border": {"l": 16, "b": 16, "r": 16, "t": 16}
    }
  ]
}
```

执行前必须由脚本报告确认：

- `targetAssetPath == images[].targetDir + images[].fileName`
- 图片文件已由 `process_images.py` 写入到 `targetAssetPath`
- 实际宽高与 `expectedSize` 一致
- 实际 MD5 与 `expectedMD5` 一致
- 九宫格 `border` 与 `spriteSettingJson.border` 一致

### SpriteSettingSpec（spriteSettingJson 的内容）

```json
{
  "pivot": {"x": 0.5, "y": 0.5},
  "border": {"l": 88, "b": 88, "r": 88, "t": 87}
}
```

- `pivot`：Sprite pivot 点
- `border`：九宫格边框。非九宫格图片全部为 0，即 `{"l":0,"b":0,"r":0,"t":0}`
- **关键格式规则**：Vector 类型的 JSON 必须写成 `{"x": 0.5, "y": 0.5}`，**严禁**缺少 key（如 `{0.5, 0.5}`）

---

## PrefabInstanceRef — 嵌套 Prefab 引用

```json
{
  "id": "prefab_0",
  "figmaName": "KaTongGreenBtn_1",
  "sourcePrefabPath": "Assets/MagicWarrior/_Resources/Prefabs/UGUI/_Common/Buttons/KaTongGreenBtn_1.prefab"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 唯一标识，NodeSpec 中 `prefabId` 引用此 id |
| `figmaName` | 否 | Figma 中的组件名，用于日志和对照 |
| `sourcePrefabPath` | 是 | 项目中的 Prefab 路径，以 `Assets/` 开头 |

---

## NodeSpec — 层级节点（核心）

```json
{
  "name": "[AttackPanelBg]",
  "type": "Image",
  "rect": {"x": -482, "y": -594, "w": 964, "h": 1656},
  "imageId": "img_0",
  "imageType": "Sliced",
  "color": {"r": 1, "g": 1, "b": 1, "a": 1},
  "childIndices": []
}
```

### 通用字段（所有节点类型）

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | GameObject 名称。AI 创建的非根节点使用方括号命名，如 `[Bg]` |
| `type` | 是 | 节点类型：`Root` / `Panel` / `Image` / `Text` / `PrefabInstance` |
| `rect` | 是 | 位置和尺寸（见下方 RectSpec） |
| `childIndices` | 是 | 子节点在 `nodes` 数组中的索引，无子节点时为空数组 `[]` |

### 各类型专属字段

**Root / Panel**：无额外字段。

**Image**：

| 字段 | 必填 | 说明 |
|------|------|------|
| `imageId` | 是 | 引用 `images[].id` |
| `imageType` | 否 | `"Simple"`（默认）或 `"Sliced"`（九宫格） |
| `color` | 否 | RGBA 颜色，默认白色（1,1,1,1） |

**Text**：

| 字段 | 必填 | 说明 |
|------|------|------|
| `text` | 是 | 显示的文本内容 |
| `fontSize` | 否 | 字号，默认 24 |
| `color` | 否 | RGBA 颜色 |
| `alignment` | 否 | `"Left"` / `"Center"` / `"Right"` / `"TopLeft"` / `"Top"` / `"TopRight"` / `"BottomLeft"` / `"Bottom"` / `"BottomRight"`，默认 `"Center"` |
| `autoSize` | 否 | 默认不生成（AutoSize 关闭）。gen_spec.py 不再输出此字段，FigmaPrefabGenerator 在 ApplyPostProcessing 中强制关闭 enableAutoSizing |
| `textMaterial` | 否 | TMP 材质需求。仅当 Figma 文本存在描边或 DropShadow 时生成，用于复用或新建近似 TMP 材质 |

当前生成器的 Text 节点负责静态 `TextMeshProUGUI` 视觉还原；文本字体统一绑定 `CommonFont.asset`。当 `textMaterial` 存在时，生成器会优先扫描现有 `CommonFont*.mat` 是否近似匹配描边/投影参数，匹配则复用；找不到时才基于 `CommonFont.mat` 在 `Assets/MagicWarrior/_Resources/Font/Package/FigmaGenerated/` 下创建新材质。它仍不表达 `CustomLanguageText`、`CustomText` 或多语言 Key；涉及业务绑定时，必须复用现有 Prefab 或列为生成后处理计划。

Text 节点的 `rect.w/h` 必须来自 MCP Relay manifest 中该 Figma 文本节点自身的 `bounds.width/height`。生成后对应 `TextMeshProUGUI` 所在 `RectTransform.sizeDelta.x/y` 必须与 Spec 宽高一致，容差 0.5px；任何宽高不一致都视为阻塞失败。

### TextMaterialSpec — TMP 描边/投影材质需求

```json
{
  "enabled": true,
  "signature": "o_833411ff_w_010_u_833411ff_x_100_y_080_s_004_d_000",
  "materialName": "CommonFont_figma_o_833411ff_w_010_u_833411ff_x_100_y_080_s_004_d_000",
  "outlineColor": {"r": 0.514, "g": 0.204, "b": 0.067, "a": 1},
  "outlineWidth": 0.1,
  "underlayColor": {"r": 0.514, "g": 0.204, "b": 0.067, "a": 1},
  "underlayOffsetX": 0,
  "underlayOffsetY": -0.2,
  "underlaySoftness": 0.04,
  "underlayDilate": 0,
  "hasOutline": true,
  "hasUnderlay": true,
  "sourceStrokeWeight": 1
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `enabled` | 是 | 是否启用专用 TMP 材质 |
| `signature` | 是 | 归一化后的效果签名；相同签名只应复用或生成一个材质 |
| `materialName` | 是 | 期望材质名，生成器会用 `AssetDatabase.GenerateUniqueAssetPath` 防止覆盖 |
| `outlineColor` / `outlineWidth` | 否 | Figma 字体描边近似映射到 TMP `_OutlineColor` / `_OutlineWidth` |
| `underlayColor` / `underlayOffsetX` / `underlayOffsetY` / `underlaySoftness` / `underlayDilate` | 否 | Figma DropShadow 近似映射到 TMP Underlay 参数 |
| `hasOutline` / `hasUnderlay` | 是 | 控制 `OUTLINE_ON` / `UNDERLAY_ON` keyword |
| `sourceStrokeWeight` | 否 | 原始 Figma strokeWeight，仅用于审核追踪 |

### 强制后处理字段

当前 JSON Spec 可以不显式表达以下 Unity 组件字段，但执行阶段必须统一后处理并验证：

- 所有 `TextMeshProUGUI`：`enableAutoSizing = false`（由 FigmaPrefabGenerator.ApplyPostProcessing 强制关闭，防止 TMP 字体绑定后 AutoSize 意外开启）。
- 所有 `Image` / `CustomImage` / Simple Image / Sliced Image：`raycastTarget = false`。

任何 `AutoSize=true` 或未获用户明确批准的 `RaycastTarget=true` 残留都视为阻塞失败，不能作为 warning 交付。

**PrefabInstance**：

| 字段 | 必填 | 说明 |
|------|------|------|
| `prefabId` | 是 | 引用 `prefabInstances[].id` |
| `activeVariant` | 否 | feature-local ComponentSet 使用。值如 `Variant_Milestone_1_100`，生成器会只启用源 Prefab 根下同名 `[Variant_*]` 子节点。同状态去重时可指向代表 Variant，例如 `Day4_Locked` 指向 `Variant_Day3_Locked` |

公共 `PrefabInstance` 节点默认使用源 Prefab 根对象名称，避免破坏公共组件身份。feature-local ComponentSet 允许使用业务实例名（例如 `[Milestone_1_100]` 指向 `Milestone.prefab`），但必须在审核报告中显式列出 `name -> prefabId -> sourcePrefabPath`，并通过 `verify_spec_contract.py --expect-prefab-instance` 验证该节点没有被降级为 `Image` 或 `Panel`。

---

## RectSpec — 位置和尺寸

```json
{"x": -482, "y": -594, "w": 964, "h": 1656}
```

| 字段 | 说明 |
|------|------|
| `x` | **已转换的** Unity anchoredPosition.x |
| `y` | **已转换的** Unity anchoredPosition.y |
| `w` | sizeDelta.x（宽度） |
| `h` | sizeDelta.y（高度） |

## RectTransformSpec — Constraints 转换后的 Unity anchors

```json
{
  "anchorMin": {"x": 0, "y": 1},
  "anchorMax": {"x": 0, "y": 1},
  "pivot": {"x": 0.5, "y": 0.5},
  "constraints": {"horizontal": "MIN", "vertical": "MIN"}
}
```

| 字段 | 说明 |
|------|------|
| `anchorMin` | 由 Figma `constraints` 转换出的 Unity `RectTransform.anchorMin` |
| `anchorMax` | 由 Figma `constraints` 转换出的 Unity `RectTransform.anchorMax` |
| `pivot` | 默认 `{x:0.5,y:0.5}`，除非后续 manifest 明确提供 pivot |
| `constraints` | 原始 Figma Constraints 标准化结果，用于审计和双向同步 |

映射规则：

| Figma Constraints | Unity anchors |
|------|------|
| horizontal `MIN` | x: `0 → 0` |
| horizontal `CENTER` | x: `0.5 → 0.5` |
| horizontal `MAX` | x: `1 → 1` |
| horizontal `STRETCH` | x: `0 → 1` |
| vertical `MIN` | y: `1 → 1` |
| vertical `CENTER` | y: `0.5 → 0.5` |
| vertical `MAX` | y: `0 → 0` |
| vertical `STRETCH` | y: `0 → 1` |

### 坐标转换公式

`gen_spec.py` 必须在生成 JSON 前完成坐标转换：

```
spanW = (anchorMax.x - anchorMin.x) * parentW
spanH = (anchorMax.y - anchorMin.y) * parentH

sizeDelta.x = width - spanW
sizeDelta.y = height - spanH

pivotX = figmaLocalX + width * pivot.x
pivotY = parentH - figmaLocalY - height * (1 - pivot.y)

rect.x = pivotX - anchorMin.x * parentW - spanW * pivot.x
rect.y = pivotY - anchorMin.y * parentH - spanH * pivot.y
rect.w = sizeDelta.x
rect.h = sizeDelta.y
```

**注意**：
- 必须使用 MCP Relay manifest 中目标节点自身的 bounds/relativeBounds，不能使用父节点 metadata 的子节点 bounds。
- 必须使用 MCP Relay manifest 中目标节点自身的 `constraints`；缺失时才回退中心锚点，并在审核报告中记录。
- INSTANCE 子节点的内部子坐标不可用于计算父节点头寸。
- Figma 远程工具返回的非直接子节点坐标不可用；标准流程禁止使用它们生成 Spec。

---

## ColorSpec — 颜色

```json
{"r": 1, "g": 1, "b": 1, "a": 1}
```

所有分量为 0-1 范围的 float。`a` 默认 1.0。

---

## 完整示例

```json
{
  "prefabName": "UI_AttackView",
  "prefabPath": "Assets/MagicWarrior/_Resources/Prefabs/UGUI/Attack/UI_AttackView.prefab",
  "rootSize": {"x": 1080, "y": 2340},
  "images": [
    {
      "id": "img_0",
      "fileName": "Attack_BG.png",
      "targetDir": "Assets/_Art/Texture/GUI/Attack/",
      "spriteSettingJson": "{\"pivot\":{\"x\":0.5,\"y\":0.5},\"border\":{\"l\":88,\"b\":88,\"r\":88,\"t\":87}}"
    }
  ],
  "prefabInstances": [
    {
      "id": "prefab_0",
      "figmaName": "KaTongGreenBtn_1",
      "sourcePrefabPath": "Assets/MagicWarrior/_Resources/Prefabs/UGUI/_Common/Buttons/KaTongGreenBtn_1.prefab"
    }
  ],
  "nodes": [
    {
      "name": "UI_AttackView",
      "type": "Root",
      "rect": {"x": 0, "y": 0, "w": 1080, "h": 2340},
      "childIndices": [1, 2, 3]
    },
    {
      "name": "[AttackPanelBg]",
      "type": "Image",
      "rect": {"x": -482, "y": -594, "w": 964, "h": 1656},
      "imageId": "img_0",
      "imageType": "Sliced",
      "color": {"r": 1, "g": 1, "b": 1, "a": 1},
      "childIndices": []
    },
    {
      "name": "[TitleText]",
      "type": "Text",
      "rect": {"x": 0, "y": 800, "w": 400, "h": 60},
      "text": "攻击",
      "fontSize": 36,
      "color": {"r": 1, "g": 1, "b": 1, "a": 1},
      "alignment": "Center",
      "autoSize": {"min": 12, "max": 36},
      "childIndices": []
    },
    {
      "name": "KaTongGreenBtn_1",
      "type": "PrefabInstance",
      "rect": {"x": 100, "y": -200, "w": 248, "h": 106},
      "prefabId": "prefab_0",
      "childIndices": []
    }
  ]
}
```

---

## 生成注意事项

1. **nodes 是扁平数组**，通过 `childIndices` 建立父子关系。第一个节点必须是 `Root`。
2. **坐标必须预转换**，`FigmaPrefabGenerator` 不进行 Figma→Unity 坐标转换。`rect.x/y` 直接作为 `anchoredPosition`。
3. **图片处理**：阶段二中 `process_images.py` 从 MCP Relay manifest/base64 写入图片到 `targetDir`，然后 `uloop execute-dynamic-code` 调用 `AssetDatabase.Refresh`。
4. **没有对应类型的 Figma 节点**：跳过该节点，或降级为 `Panel`。
5. **spriteSettingJson 必须是合法 JSON 字符串**（注意转义引号）。
6. **九宫格图片必须设置 spriteBorder**，非九宫格 border 全部为 0。

## 执行前 JSON Spec Lint

调用 `FigmaPrefabGenerator.Generate()` 前必须完成只读 lint：

1. `prefabPath` 以 `Assets/` 开头并以 `.prefab` 结尾。
2. `nodes` 非空，且 `nodes[0].type == "Root"`。
3. 所有 `childIndices` 在数组范围内，无重复父子引用和循环引用。
4. `images[].id` 唯一，所有 Image 节点引用的 `imageId` 都存在。
5. `prefabInstances[].id` 唯一，所有 PrefabInstance 节点引用的 `prefabId` 都存在。
6. `images[].targetDir` 以 `Assets/` 开头，`fileName` 不为空且以 `.png` 结尾。
7. `targetDir + fileName` 不得已存在；如果存在，必须有用户明确覆盖授权。
8. 每个 `prefabInstances[].sourcePrefabPath` 都能在项目中找到真实 Prefab。
9. 每个图片文件都已按 `image_download_plan.json` 和 `image_process_report.json` 写入完成，并通过尺寸与 MD5 校验。
10. 非根节点名遵守项目方括号规则；Unity 显示名会去掉 Figma 层级开头的数字排序前缀（如 `75--ui--main--view` → `ui--main--view`），但不删除业务名中间的数字；公共 PrefabInstance 默认保留源 Prefab 根名；feature-local ComponentSet 的业务实例名必须有显式映射和验证。

## 统一审核报告

`gen_spec.py`、`process_images.py`、`verify_prefab.py` 都必须输出机器可读报告，供 LLM 审核：

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

- `allPass=false` 或 `blockingErrors` 非空时，禁止进入下一阶段或宣称交付完成。
- `warnings` 需要 LLM 判断是否需要用户确认，但不得由 LLM 直接修改确定性产物。
- `summary/checks/artifacts` 是证据来源，LLM 只转述，不重新计算。
