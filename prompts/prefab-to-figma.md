请使用 $prefab-to-figma 将Prefab 导入到 Figma。

目标 Figma：
- {{selectionBlock}}

Unity Prefab 路径：
{{unitySelectedPrefabBlock}}
- 路径来自 Unity Project 窗口当前选中的 Prefab 资源；允许单选或多选。
- 如果没有任何 .prefab 路径，停止执行并让我重新选择。

重要前提：
- 目标允许两种模式：不选择 Figma 节点时使用当前 Figma 页面；选择 1 个 FRAME 时使用当前选区里的 FRAME 作为目标容器。
- 如果目标是当前页面，请在当前页面下新建 Prefab 根 Frame；如果目标是当前选区 FRAME，请在该 FRAME 内新建 Prefab 根 Frame。
- 如果选中了多个节点或非 FRAME 节点，先报错让我确认。

目标：
- 将 Unity UGUI Prefab 转换为 Figma 节点；如果 Unity 多选了多个 Prefab，则逐个导入到当前 Figma 目标下。
- 保持层级语义、GameObject 命名、RectTransform 尺寸/位置、TextMeshProUGUI 文本、Image/CustomImage sprite 引用、九宫信息。
- 遵守目标 Unity 项目规范和 prefab-to-figma skill 执行合约。

要求：
- 先检查 Unity 网关 health，确认当前选中的 Prefab 路径列表有效。
- 如果存在多个 Prefab 路径，按 prefab-to-figma skill 要求先生成 UTF-8 `.tmp/prefab-to-figma/prefab-list.txt`，每行一个路径，再使用 `--prefab-list` 批量导出；不要要求我手工创建列表文件。
- 多选列表中如果混入非 `.prefab`、不存在路径或重复路径，先报告并让我确认重选或去重策略。
- 执行前必须通过 MCP Relay 确认当前 Figma 文件 key、页面名和选区上下文。
- 如果缺少 Figma 目标 key 或用户未指定组件模式，先向我确认；Canvas 使用选中 Prefab 根 RectTransform 自动推导，不再要求手动输入。
- 先给出导入计划、影响范围和验证方式。
- 等我确认后再执行 Prefab 解析器和 Figma 写入。
- 不要直接修改 Unity Prefab、资源或 .meta，除非我确认。
- 完成后必须做 MCP Relay 验证和截图。
