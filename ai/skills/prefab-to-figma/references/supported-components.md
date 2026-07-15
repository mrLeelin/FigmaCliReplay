# 支持组件与降级策略

第一版目标是可重复、可验证地把静态 UGUI Prefab 结构导入 Figma。无法从静态文件准确还原的运行时行为必须降级并写入报告。

| Component | First version behavior |
| --- | --- |
| RectTransform | Supported |
| UnityEngine.UI.Image Simple | Supported |
| UnityEngine.UI.Image Sliced | Supported as dynamic 1 to 9 generated child layers based on Sprite border |
| UnityEngine.UI.Image Filled | Downgrade unless fill amount is 1 |
| UnityEngine.UI.Image Tiled | Unsupported warning |
| CustomImage | Supported when serialized fields match Image sprite fields |
| SlicedFilledImage | Supported only when fill amount is 1 |
| TextMeshProUGUI | Basic text, size, color, alignment only |
| TextMeshProUGUI with empty class identifier | Supported when `m_text` and `m_fontSize` are serialized |
| RawImage | Supported when texture GUID resolves to PNG |
| Mask / RectMask2D | Mark as clip metadata for Figma writer |
| Animator | Unsupported warning |
| MMFeedbacks / MMF_Player | Unsupported warning |
| Particle / UIParticle | Unsupported warning |
| HorizontalLayoutGroup / VerticalLayoutGroup | Supported by deterministic static layout for direct active children and nested PrefabInstance children |
| GridLayoutGroup | Supported by deterministic static layout for direct active children and nested PrefabInstance children |
| ContentSizeFitter | Supported when paired with a supported Horizontal/Vertical/Grid LayoutGroup |
| LayoutElement | Supported for ignoreLayout, min size, preferred size, and flexible size in static layout |

## 判定规则

- 能从 Prefab YAML 和 `.meta` 静态读出的数据才允许直接映射。
- 需要 Unity 运行时、脚本执行、材质计算或图集动态加载的数据必须降级。
- 降级不等于静默跳过；必须进入 `warnings` 和 `report.md`。
- Unity 原节点名称、层级、RectTransform 位置和尺寸优先级高于视觉效果拟合。
- 子节点视觉超出根 RectTransform 时，Figma 写入阶段应使用生成的 `__ImportBounds` 外层包围盒，避免按钮、阴影或特效边缘被截图裁切。

## 常见降级说明

- `Filled` 且 `m_FillAmount != 1`：导出 simple 图片，并提示填充效果未还原。
- `Tiled`：第一版不平铺，标记 unsupported。
- `Sliced` 但 Sprite border 全为 0：按 simple 图片或 1 个中心切片处理，并提示没有可用九宫边框。
- `Sliced` 的切片数量不能固定为 3 个；必须根据 left/right/top/bottom 自由组合，最大 9 个。
- `HorizontalLayoutGroup` / `VerticalLayoutGroup`：静态求解 padding、spacing、alignment、child control、force expand 和 reverse arrangement，输出 `layout.resolved` 元数据。
- `GridLayoutGroup`：静态求解 padding、spacing、start corner、start axis、constraint、constraint count 和 cell size，输出 `layout.resolved` 元数据。
- `ContentSizeFitter`：当同节点存在受支持 LayoutGroup 时，先按 preferred size 求父级尺寸，再排布子节点。
- `LayoutElement`：静态布局会读取 `ignoreLayout`、min/preferred/flexible 尺寸；仍不等同完整 Unity runtime layout pass。
- `Animator` / `MMFeedbacks`：只保留静态节点，动画或反馈效果不导入。
