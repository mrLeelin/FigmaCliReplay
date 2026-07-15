# Unity 组件复用注意事项

本参考用于 Figma 到 Unity 导入时选择组件结构。目标是让新 Prefab 像项目原生资源，而不是只做视觉占位。

## 总原则

- 优先复用项目已有 Prefab 和组件，不从零发明新 UI 体系。
- 保留参考 Prefab 的交互能力，只替换视觉和必要文本。
- 不新增 C# 脚本，除非用户明确要求。
- 不使用 Unity 原生 `Button` 或 `Text` 替代项目约定组件。
- 新节点命名应保持 Figma/Unity 语义清晰；如果是 AI 新建的非根物体，遵守项目方括号命名规则，除非复用的参考 Prefab 已有稳定命名。

## 组件选择

| Figma 内容 | Unity 优先组件 | 注意事项 |
| --- | --- | --- |
| 按钮 | `CustomTouchButton` | 优先克隆现有按钮 Prefab，保留 `selectImage`、`PressedSprite`、`DisabledSprite`、`pressedMoveRectTransform` 等字段。 |
| 普通图片 | `CustomImage` 或项目已有 Image 结构 | 若参考 Prefab 使用 `CustomImage`，不要降级成陌生组件。 |
| 九宫图片 | 支持 Sliced 的 Image/CustomImage | Sprite `.meta` 必须设置 `spriteBorder`，Prefab 中 `m_Type` 应为 Sliced。 |
| 文本 | `TextMeshProUGUI` | 保留字体资产、材质、自动缩放和本地化组件；只按 Figma 必要修改文本、颜色、字号。 |
| 纯视觉装饰 | 参考 Prefab 的图片节点 | 优先替换 Sprite，不新增运行时逻辑。 |

## Feature-local ComponentSet 默认拆分

Figma → Unity 导入时默认检测目标节点内部的同源业务 ComponentSet。命中后必须把这些实例拆为 feature-local Prefab，而不是压成主 Prefab 内的普通 `Image`。用户不需要每次额外声明“内部自己的 ComponentSet 单独导出”。

常见信号：

- MCP Relay manifest 中 `component.componentSetId` / `component.mainComponentSetId` 相同。
- 同一功能区内有命名前缀一致的多个 `INSTANCE`，例如 `Day1_Normal` / `Day2_Selected` 或 `Milestone_1_100` / `Milestone_2_250`。
- 多个实例共享结构，只是文本、图标、锁定态、进度态或奖励数量不同。
- MCP Relay 组件元数据缺失时，才用保守命名规则兜底。

排除信号：

- `Common_Texture_`、`Common_Prefab_`、`Common_`、`UI_Common_` 开头的公共实例。
- 嵌套在另一个 `INSTANCE` 内部的实例。
- 只有 1 个成员的候选组。
- 仅靠命名规则命中但分散在多个父节点下的候选组。

执行要求：

- 为每个 ComponentSet 生成一个旁边 Prefab，例如 `TabItem.prefab`、`Item.prefab`、`Milestone.prefab`。
- 主 Prefab 中对应节点必须是 `PrefabInstance`，不能降级为 `Image` / `Panel`。
- Component Prefab 内按状态后缀去重：例如 `Day3_Locked` / `Day4_Locked` / `Day5_Locked` / `Day6_Locked` / `Day7_Locked` 都属于 `Locked` 状态时，只保留排序最前的代表 Variant。
- 主 spec 中每个业务实例仍必须保留为 `PrefabInstance`；重复状态实例的 `PrefabInstance.activeVariant` 指向代表 Variant，例如 `[Day4_Locked]` 指向 `Variant_Day3_Locked`。
- 状态后缀必须完全相同才合并；`Locked` 和 `LockedProgress` 视为不同状态，不能自动合并。
- 允许 feature-local PrefabInstance 使用业务实例名，例如 `[Milestone_1_100]` 指向 `Milestone.prefab`；公共 PrefabInstance 仍默认保留源 Prefab 根名。
- 交付前必须用 spec contract 显式验证 `name -> prefabId -> sourcePrefabPath`，再用 Unity AssetDatabase 验证 `sourcePrefabPath` 可加载。

## 参考 Prefab 选择

优先使用以下顺序：

1. 与 Figma 节点同名或视觉近似的 Prefab。
2. 同目录下尺寸和用途最接近的 Prefab。
3. 项目 `_Common` 下通用按钮、关闭按钮、图标、面板 Prefab。
4. 业务模块内风格相同的 Prefab。

## 导入后同目录/相似 Prefab 分析

Figma → Prefab 导入成功并完成基础验证后，必须做一次只读参考分析，用于推算新 Prefab 是否需要挂载项目组件或复用项目通用结构。

### 搜索范围

按以下优先级查找参考 Prefab：

1. 目标 Prefab 同目录下的 `*.prefab`。
2. 同功能目录下名称相似的 Prefab，例如同样包含 `MainView`、`Item`、`Cell`、`Popup`、`Tips`、`Panel` 等后缀。
3. 同系统/同 View 类型目录下的 Prefab。
4. 用户明确指定的 reference Prefab。

相似度推算必须有证据，不能只凭经验。可引用：

- Prefab 文件路径和节点名。
- 根节点脚本类型或组件类型。
- 层级路径，如 `ScrollView/Viewport/Content`。
- `[SerializeField]` 字段名和绑定对象路径。
- 公共组件实例名和资源路径。

### 分析内容

只读分析以下模式：

- 层级模式：`Root`、`Header`、`Body`、`Footer`、`Layout`、`ScrollView/Viewport/Content`、`Item`、`ButtonGroup`。
- 组件模式：`Window` / View 脚本、`Animator` / `AnimatorPlayer`、`CanvasGroup`、`Button` / `CustomTouchButton`、`Image` / `CustomImage`、`TextMeshProUGUI` / `CustomText` / `CustomLanguageText`、`ScrollRect`、`Mask` / `RectMask2D`、LayoutGroup。
- 绑定模式：`[SerializeField]` 字段名、字段引用对象路径、按钮点击区域、动态文本节点、列表模板节点。
- 公共复用模式：是否复用 `_Common` Prefab、通用图片、通用按钮、关闭按钮、页签、列表项模板。

### 输出建议报告

最终说明必须包含“参考 Prefab 分析报告”，并以等待用户确认作为结束状态：

```text
参考 Prefab：
- Assets/.../Xxx.prefab

发现的项目习惯：
- 根节点通常挂 XxxView
- ScrollView 使用 ScrollView/Viewport/Content
- 动态文本使用 CustomLanguageText

建议调整：
1. 给 xxx 节点挂 CustomTouchButton
2. 将 xxx_Text 后处理为 CustomLanguageText

风险与确认项：
- 需要绑定脚本字段，不能自动执行
- 需要用户确认后才能挂组件或绑定字段

等待用户确认：
- 是否执行建议 1/2/3
- 未确认前本轮到此停止
```

### 硬边界

- 该分析默认只读，只能输出建议。
- 禁止凭相似 Prefab 自动挂业务脚本。
- 禁止自动绑定 `[SerializeField]` 字段。
- 禁止自动替换组件或修改现有 Prefab。
- 任何挂载组件、字段绑定、ScrollRect/Button 交互结构变化，都必须另行输出修改计划并等待用户二次确认。
- 推断建议不是执行授权；输出建议报告后必须停止，不能在同一轮里继续执行建议。
- 用户确认导入 Prefab 不等于确认执行导入后的推断建议；必须让用户再次确认具体建议项。

选择参考 Prefab 后，在计划中写明：

- 参考 Prefab 路径。
- 复用哪些组件和字段。
- 替换哪些图片、文本、尺寸或颜色。
- 是否会保留旧 Pressed/Disabled 状态图。

## 图片和九宫复用

- Figma 单张按钮图导入 Unity 时，应保存为一张新 PNG，再通过 Sprite border 实现九宫，而不是把 Figma 的 `__slice_*` 切片分别做成 Unity 运行时子节点。
- Figma 的 `__slice_*` 数量是动态的，可能是 1 到 9 个；不要只按 `__slice_left`、`__slice_center`、`__slice_right` 三段处理。
- 如果 Figma 来源本身是从 Unity 九宫导出的，优先复用其 `sourceRect` 或参考图片 `.meta` 中的 `spriteBorder`。
- 若无法确定九宫边框，必须在计划里说明并询问用户，不能随意猜。

## 文本复用

- 如果参考 Prefab 已有 `TextMeshProUGUI` 和本地化组件，默认保留本地化组件。
- Figma 文本可写入当前可见文案，但必须说明这可能只是静态默认值。
- 若用户要求多语言或业务动态文本，只留绑定入口或保留参考 Prefab 的本地化 key，不强行写死。

## 交互字段保护

克隆按钮 Prefab 时，避免破坏：

- `interactable`
- `buttonSoundType`
- `customFirstPressedSoundKey`
- `customClickSoundKey`
- `ButtonPressedFirstTime`
- `onClick`
- `ButtonPressed`
- `ButtonReseted`
- `selectImage`
- `DisabledSprite`
- `DisabledChangeColor`
- `DisableColorTarget`
- `PressedSprite`
- `PressedChangeColor`
- `pressedMoveRectTransform`
- `yOffset`
- `HighlightedSprite`
- `PressedOpacity`
- `IdleOpacity`
- `DisabledOpacity`
- `returnToInitialSpriteAutomatically`

只在用户明确要求交互变化时修改这些字段。

## 禁止项

- 不为了视觉导入而删除参考 Prefab 的脚本组件。
- 不把 Figma 生成层名 `__slice_*` 原样做成 Unity 运行时层级，除非用户明确要求拆片；即使拆片也必须支持 1 到 9 个切片。
- 不修改现有 Prefab 或现有图片 `.meta` 来适配新设计。
- 不把临时下载图片放进 `_Resources` 以外的随意目录；必须遵守项目资源组织。
