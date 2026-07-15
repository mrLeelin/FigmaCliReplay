# Figma 图层命名与 Unity 导入整理规则

本文件用于 `psd-layer-to-figma`：PSD 分层导入 Figma 前先做名称语义预处理，导入后再把 Figma 节点整理成适合 Unity UGUI 导入和程序绑定的结构。

## 1. 导入前命名预处理

PSD 原始图层名可能由美术手工输入，允许空格、大小写、分隔符混用。导入前必须先派生一个规范化名称，只用于识别语义、生成候选名和后续 Figma 显示名建议，不得丢弃原始图层名。

必须在 manifest 或 Figma metadata 中保留：

- `rawPsdLayerName`：PSD 原始图层名。
- `normalizedLayerName`：规范化后的名称。
- `semanticMode`：`common-component`、`nine-slice`、`text` 或 `image`。
- `normalizationWarnings`：因空格、分隔符、大小写、缺少边框等产生的警告。

规范化规则：

- 去除首尾空白。
- 将连续空格、连字符、中文空格、斜杠等分隔符统一为 `_`。
- 将 `common _ btn`、`common- btn`、`common btn`、`common_btn` 统一识别为 `common_btn` 语义。
- 将 `jiugong_ panel`、`jiugong panel`、`nine slice panel`、`nine-slice_panel`、`9 slice panel` 统一识别为九宫语义。
- 保留业务含义，不为追求整洁删除 `common`、`jiugong`、`nine_slice`、`9slice` 等语义标记。

语义优先级固定为：

```text
common-component > nine-slice > text > image
```

例如 `common_ jiugong_panel` 必须先按通用组件查找；只有找不到通用组件时，才允许按九宫或普通图片降级，并记录 warning。

## 2. common 通用组件规则

`common_`、`common-` 或规范化后等价于 `common_` 的图层，都表示优先复用 Figma 通用组件。

执行顺序：

1. 用 `rawPsdLayerName` 和 `normalizedLayerName` 共同生成候选名。
2. 先在通用组件库节点 `62:115` 的本地 Component/ComponentSet 索引中查找，再在通用图片库节点 `2896:32` 的本地 `Common_` Component/ComponentSet 索引中按名称绑定规则查找，禁止使用 `search_design_system`。
3. 找到高置信命中时创建 Instance。
4. 找不到时记录候选、匹配方式、置信度和 warning，再按后续语义降级。

### 通用图片库名称绑定

通用图片库固定为：

```text
fileKey=ly2b1kkcvLtNBFPSQi4XO4
nodeId=2896:32
```

第一版通用图片采用名称绑定，不强制要求 Figma metadata 或本地 JSON 绑定表。组件命名必须使用：

```text
Common_<UnitySpriteName>
```

匹配时统一规范化：

- Figma 组件名去掉 `Common_` / `Common-` 前缀。
- PSD 图层名去掉可选 `common_` / `common-` / `image_` / `img_` 前缀。
- 名称转小写，并移除空格、连字符、下划线、方括号、圆括号和扩展名。
- 规范化后完全相等才自动替换为 Instance。

普通图片层 auto 查询时，必须先查 `2896:32` 通用图片库；未命中时再查 `62:115` 通用组件库。多个同名候选、相似但不完全相等的候选只能输出 warning，不能自动替换。

命中通用图片组件后，导入节点必须写入：

```text
matchedComponentName
matchStrategy = common-image-name-binding
matchConfidence = 1.0
commonImageLibraryNodeId = 2896:32
```

来自通用图片库的 Instance 和普通通用组件 Instance 一样，导入后禁止改名、禁止改内部结构。

改名限制：

- 可以把 Figma 显示名整理成 Unity 友好的业务名。
- 不能改变已匹配通用组件的实例来源。
- 不能修改来自 `Common_Components` 画布的 component / instance 内部子节点名称。
- 必须保留 `rawPsdLayerName`、`normalizedLayerName`、`matchedComponentName`、`matchStrategy`、`matchConfidence`。

## 3. 九宫层规则

`jiugong_`、`nine_slice_`、`nine-slice_`、`9slice_` 或规范化后等价标记的图层，都表示九宫切片语义。

执行顺序：

1. 先识别九宫语义，再解析 `left,bottom,right,top` 边框。
2. 缺少边框时按当前 skill 的推断规则生成 border，并记录 `inferredBorder=true`。
3. 在 Figma 中创建九宫父 Frame 和动态 `__slice_*` 子层。
4. 子层名必须保留为 `__slice_*`，不得为了整洁改名。
5. 父层可以整理成业务显示名，但必须保留 border、source rect、imageHash、CROP transform 等 metadata。

禁止把九宫层作为普通单图导入，除非九宫识别失败且已输出 warning。

## 4. 导入后 Figma 层级整理

导入后只整理本次导入的目标根 Frame / Component，不要移动其它无关页面或节点。

整理目标：

- 层级按程序绑定和 Unity UGUI 导入友好组织。
- 删除或合并无视觉、无语义、无绑定、无复用价值的空包层。
- 保留 Common 实例、需要绑定的 Text/Icon/Button/RedDot/Progress/Toggle、九宫父层和 `__slice_*`。
- 保持整理前后的视觉截图一致。

### 根节点与组件命名

页面或弹窗根节点使用：

```text
UI_FeatureName
UI_FeatureName_Popup
UI_FeatureName_List
UI_FeatureName_Detail
```

可复用组件使用：

```text
C_FeatureName_ComponentName
```

### 容器命名

推荐容器名：

```text
Root
PopupRoot
ContentRoot
Header
Body
Footer
List
Row
Item
ButtonGroup
TabGroup
Avatar_Column
Player_Info
Reward_Item
```

如果容器主要负责布局、排版、适配或占位，名称必须包含 `Layout`：

```text
Header_Layout
Reward_Item_List_Layout
Bottom_ButtonGroup_Layout
SafeArea_Layout
Content_Adaptive_Layout
```

### Group 与 Frame

需要作为真实 Unity 节点、需要约束、需要整体移动或承载多个子元素的语义分组，必须使用无填充、不裁切的 Frame，不要保留为 Group。

把 Group 改成 Frame 时必须：

- 保持原始位置、尺寸、层级顺序和子节点视觉位置。
- 清空 Frame 默认 fill，避免白底遮挡。
- 不改 `Common_Components` 公共组件实例内部结构。

### ScrollView

列表必须整理为 Unity ScrollRect 友好结构：

```text
ScrollView / XxxList
  Viewport
    Content
      Xxx_Row_Template
```

所有 row/item 必须放在 `Content` 下。动态列表模板建议命名为 `Xxx_Row_Template`，示意行使用 `Xxx_Row_Preview_01`。

### 文本与图片

- 动态文本保留为 Text 节点，命名使用 `*_Text`。
- 不要把多语言、数字、时间、玩家名、奖励数量烘焙成图片。
- 业务图片、图标、背景、按钮底图等导出资源必须使用当前功能名前缀，例如 `PhantomStarRecruit_Chest_Image`。
- 同一界面内会导出的业务图片名必须唯一，避免覆盖。
- `Common_`、`UI_Common_`、`Common_Item` 等公共组件及其内部子节点不按业务功能名前缀改名。

## 5. 验证清单

完成后必须检查：

- 所有疑似 `common` 标记层都已正确归类，或有明确 warning。
- 所有疑似九宫标记层都有九宫结构和 border metadata，或有明确 warning。
- `rawPsdLayerName` 与 `normalizedLayerName` 已写入 manifest 或 Figma metadata。
- 根节点使用 `UI_FeatureName` 类命名。
- 组件使用 `C_FeatureName_xxx` 类命名。
- 负责布局的容器名包含 `Layout`。
- 需要语义分组的 Group 已改成无填充、不裁切 Frame。
- 不存在无意义的 `Group 1`、`Frame 1`、`Rectangle 1`、`Vector`。
- ScrollView 是 `ScrollView / Viewport / Content`。
- 动态文本保留 Text 节点。
- `Common_Components` 实例及其内部子节点保持原命名。
- 业务导出图片名有功能名前缀且无重复。
- 整理前后截图没有视觉偏移。
