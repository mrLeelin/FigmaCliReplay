# Figma UGUI 导入约定

本文件用于 Figma → Unity Prefab 与 Figma 贴图批量导入。执行写入前先用它做结构、命名、复用、导出和验收判断。

## 1. 总体决策顺序

1. 先读取目标节点的 `name`、`type`、`source_bounds`、层级结构和截图。
2. 先做复用判断，再决定是否新建 Prefab 或 PNG。
3. 命中 `Common_`、`Common_Components`、`Common_Item` 或项目既有公共 Prefab 时，优先复用，不要拆开重建。
4. 再判断 Unity 组件还原还是导出切图：纯色、简单圆角、简单描边优先用 Unity 组件；复杂装饰、渐变、纹理、布尔合层优先切图。
5. 最后复核高风险项：文本描边颜色、复杂装饰视觉、公共资源是否同图、多语言文本是否撑破布局。

## 2. 公共组件与资源复用

- `Common_Components` 画布里的 component / instance 及其内部子节点禁止改名。
- `Common_` 开头的公共 Prefab 先查 `Assets/MagicWarrior/_Resources/Prefabs/UGUI/_Common` 或项目既有公共 Prefab 目录。
- `Common_` 开头的公共贴图先查 `Assets/_Art/Texture/GUI/_Common`，按 `Button`、`Bg`、`Element`、`ProgressBar` 等项目现有类别落位。
- `Common_Item` 先查 `Assets/MagicWarrior/_Resources/Prefabs/UGUI/_Common/Item` 下的项目既有 Item Prefab；不要进入内部替换图片、改字段或重建结构。
- 功能内多个界面复用、但不是全局通用的图片，放到对应功能目录下的 `功能名_CommonUI`，不要误放到全局 `CommonFigma`。
- Figma `Component` / `Variant` 如果内部只有图片内容，按图片资源处理；不带 `Common` 时默认归入功能内通用图片，不创建子 Prefab。

## 3. 命名规则

- UI 根节点使用 `UI_FeatureName`，子界面或弹窗可使用 `UI_FeatureName_Module`。
- 可复用组件使用 `C_FeatureName_ComponentName`。
- 文本节点使用 `*_Text`，名称表达字段用途，不要使用当前显示内容。
- 业务图片、图标、背景、按钮底图等导出资源必须以当前功能名为前缀，例如 `PhantomStarRecruit_BG`。
- 同一界面内所有导出图片名必须唯一，避免覆盖。
- 禁止保留 `Frame 1`、`Group 1`、`Rectangle 1`、`Vector`、`image 10` 等无语义名称。
- `Common_`、`UI_Common_`、`Common_Item` 等公共组件实例及其内部子节点不按业务功能名前缀改名。

## 4. 层级、Anchor 与 ScrollView

- 完整界面优先整理为：

```text
UI_FeatureName
  FeatureName_BG
  Anchor_Top
  Anchor_Middle
  Anchor_Bottom
```

- `Anchor_Top` 放顶部固定区域；`Anchor_Middle` 放列表、滚动区和主要自适应内容；`Anchor_Bottom` 放底部固定区域。
- 只改名不够，Figma 侧也要设置真实 constraints：`Anchor_Top = Scale / Top`、`Anchor_Middle = Scale / Scale`、`Anchor_Bottom = Scale / Bottom`。
- 弹窗不强制拆三段 Anchor，优先使用 `PopupRoot / ContentRoot`。
- 可滚动区域必须整理为：

```text
ScrollView / XxxList
  Viewport
    Content
```

- 所有 row / item 放在 `Content` 下。内容会超出可视范围且语义是列表、奖励区、卡片区或道具区时，必须创建 `ScrollRect`，不要偷懒做成静态裁剪容器。
- 若干业务元素需要成组时，使用无填充、不裁切的 `Frame`；不要用 `Group` 承担约束、适配或绑定职责。

## 5. Unity 组件映射

- 图片默认使用 `CustomImage`。
- 纯色矩形使用 `CustomImage + 颜色填充`，不额外导出切图。
- 纯色圆角底图优先复用 `Assets/_Art/Texture/GUI/_Common` 下已有圆角或九宫格资源，以 `Slice` 方式使用并叠加颜色。
- 文本描边使用 `CustomOutLine`，只改描边颜色，不擅自改默认粗细、偏移和透明度。
- 固定文案使用 `CustomLanguageText`；数字、读表动态文本、运行时拼接文本使用 `CustomText`。
- 按钮和可点击控件使用项目统一点击结构：点击父节点挂 `CustomButton`、`Animator`、`NonDrawingGraphic`，并创建 `fg` 承载前景层。
- 仅展示的子节点关闭 `raycastTarget`，避免遮挡点击。
- 非滚动矩形裁剪优先 `RectMask2D`；只有图片遮罩或非矩形遮罩才使用 `Mask`。

## 6. 切图导出规则

- `boolean-operation` 或 `flatten` 节点决定切图时，按合层后的整体结果导出一张图，不要拆回内部基础形状。
- 同一圆角规格、仅颜色不同的纯色圆角底图不要重复导出。
- 公共关闭按钮、返回按钮、弹窗底板、道具框、红点、头像框、已有公共时钟图标等优先复用，不重复导出。
- 贴图批量导入遇到同名 PNG 时，未获明确覆盖授权必须停止并报告冲突。

## 7. 多语言与文本

- 标题、按钮、固定描述、页签、弹窗固定提示语等固定文案必须走多语言。
- 固定中文文案不要硬编码到 Prefab，也不要烘焙进图片。
- 动态数字、时间、玩家名、奖励数量等必须保留独立文本节点。
- 新增多语言表、ID 段、Excel 路径等属于项目配置变更；执行前必须确认项目当前规则，不能凭历史路径直接写表。
- 英文和其他语种通常更长，按钮、页签、单行标题要预留宽度或支持布局伸缩；描述文本要允许换行或高度自适应。

## 8. 可清理与必须保留的层

可以清理：

- 隐藏层，且不是素材备份。
- 0 宽或 0 高的层。
- 没有 fill、stroke、effect、text、children 的空 frame。
- 只有一个子节点、自己没有视觉效果也没有业务语义的 frame。
- 无意义默认命名的包层和重复导出的图片层。

必须保留：

- `Common_` 开头的公共组件实例。
- 来自 `Common_Components` 的 component / instance 及其内部子节点。
- `Common_Item` 内部节点。
- 公共按钮内部的 `fg`。
- 需要程序绑定的 Text、Button、Icon、RedDot、Progress、Toggle。
- 命名为 `HiddenAsset / xxx` 的素材备份层，除非用户确认不需要。

## 9. 写入计划检查清单

Figma → Unity 写入前，计划中必须说明：

- 是否命中 Common 复用，命中的 Prefab / PNG 路径是什么。
- 新建或覆盖的 Prefab、PNG、`.meta` 路径。
- 业务图片是否统一功能名前缀，是否有重名风险。
- 完整界面是否有 Anchor 结构，列表是否为 `ScrollView / Viewport / Content`。
- 文本是 `CustomLanguageText` 还是 `CustomText`，是否存在多语言撑破风险。
- 按钮是否复用公共 Prefab 或符合项目点击父节点结构。
- boolean / flatten / 纯色圆角节点如何处理。

## 10. TMP 描边材质生成与复用规则

### 材质位置

所有 Figma → Unity 自动生成的 TMP 描边材质统一放在：
```
Assets/MagicWarrior/_Resources/Font/Package/
```
和项目已有的 `CommonFont.mat`、`CommonFont_Btn_GreenBtn.mat` 等同目录。

### 材质命名

格式：`CommonFont_figma_{signature}.mat`

signature 编码：
```
o_{outlineColor}_w_{outlineWidth×100}
u_{underlayColor}_x_{offsetX}_y_{offsetY}_s_{softness}_d_{dilate}
```

示例：`CommonFont_figma_o_471a03ff_w_017_u_none_x_100_y_100_s_000_d_000.mat`

### 描边参数公式

| 参数 | 公式 | 示例 (28pt/3px) |
|------|------|:--------------:|
| `_OutlineWidth` | `7/3 × strokeWeight / fontSize` | 0.25 |
| `_FaceDilate` | `OutlineWidth × 0.5` | 0.12 |
| `_OutlineColor` | Figma stroke 颜色 | #000000 |

比例关系：`FaceDilate : OutlineWidth = 1 : 2`。

### 复用逻辑

`FigmaPrefabGenerator.Generate()` 每次运行时的材质查找顺序：

1. **按 signature 查**：遍历 `Font/Package/` 下所有 `CommonFont*` 材质
2. **参数近似匹配**：比较 `_OutlineWidth`、`_OutlineColor`、`_FaceDilate`
3. **匹配 → 复用**：直接返回已有材质，不新建
4. **不匹配 → 新建**：以 `CommonFont.mat` 为模板，调用 `AssetDatabase.CreateAsset`

重复跑 `Generate()` 不会产生重复材质，已经有同 signature 的材质就直接复用。

### 手工修正

如果自动生成的材质参数（描边宽度、FaceDilate）不满足视觉要求，可以直接修改 `.mat` 文件中的 `_OutlineWidth` 和 `_FaceDilate` 值。参数修改后需要重新跑一次 `FigmaPrefabGenerator.Generate()` 刷新 Prefab 中的引用。
