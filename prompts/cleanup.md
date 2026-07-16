请使用 $figma-hierarchy-cleanup-mcp 整理 Figma 节点。

目标 Figma：
- {{selectionBlock}}

目标：
- 整理一下命名 Image 叫 _Image  按钮 叫 _Btn  之类的
- 清理无意义的层级和命名，提升导入 Unity 前的结构可读性。
- 保持视觉效果、尺寸、位置和图片内容不变。
- 分组和 Z 顺序必须以当前真实 Figma 节点为依据，不要根据名称或经验猜测。

读取与计划要求：
- 禁止使用 Figma MCP 写入，只能通过 `<relay-root>` 下的本地 MCP Relay 操作当前 Figma 文件。
- 先检查 MCP Relay health，再 query-selection 回显当前选中节点。
- 对目标节点执行 analyze，必须 includeHidden，避免漏掉隐藏占位、遮罩或备份节点。
- 计划前必须输出 before directChildren 顺序表，包含 index、name、type、visible、bounds，说明 Figma sibling 越靠后视觉越在上层。
- 给出完整最终目标树和整理计划，列出会影响的节点名称、原父级、新父级、原 index、新 index。

分组规则：
- 只允许新增外层语义分组容器，并把原始节点移动进去；禁止删除、flatten、vectorize、detach instance 或重建原节点。
- 保序分组优先：进入同一新分组的原始节点必须保持原 sibling 相对顺序。
- 保视觉栈优先：新增顶层分组的 sibling 顺序必须按视觉遮挡关系排列，背景类组在下层，按钮/Tab/弹窗/前景装饰在上层。
- 不允许把视觉上不相邻、功能不明确、bounds 区域跨度异常的节点硬塞进同一组。
- 如果单个分组吞掉 70% 以上直接子节点，或 [ListRoot] / [TabBar] / [ProgressSection] 这类语义组仍可继续拆分却未展开，视为异常计划，必须停下报告，不要 apply。
- 遇到不确定的分组归属、遮罩归属、九宫归属、隐藏节点用途时，先报错问我，不要猜。

Z 顺序规则：
- Figma sibling 越靠后视觉越在上层；整理计划必须同时表达语义树和最终视觉栈顺序。
- 分组后必须保持每个原始节点的相对视觉堆叠关系，不能因为新建 wrapper 导致 [Bg]、[TabBar]、[ListRoot]、[ProgressSection] 等顶层组遮挡错误。
- 只有同一父节点下 sibling 顺序错误时，才使用 FIGMA_HIERARCHY_REORDER_CHILDREN 修复。
- reorder 计划必须覆盖该父节点当前全部直接子节点，不要只给局部节点，避免漏节点、重复节点或集合变化。
- 禁止为了修 Z 顺序重新导入 PSD、重建整棵树、复制节点或移动到错误父级。

执行规则：
- 等我确认后再执行 apply。
- 如果需要备份节点，优先通过当前 MCP Relay 选区或 apply 计划设置 `createBackup: true` 自动备份，不要在提示词里暴露节点 id。
- apply 后必须立即重新 analyze，不要把验证推到最后。
- apply 后必须输出 after directChildren 顺序表，并和 before/plan 对比。
- 如果发现只是 sibling 顺序错误，优先生成全量 reorder 计划修复，不要重新整理或重新导入。

验收要求：
- verify 必须确认节点集合守恒：原始节点全部且仅一次进入计划分组，没有遗漏、重复或新增替代节点。
- absolute bounds 漂移必须为 0 或不超过工具允许容差；root 尺寸不变。
- hidden 节点、mask、Instance、__slice_ / jiugong / nine-slice 结构不能丢失或被拆散。
- root 顶层 directChildren 顺序必须符合计划中的视觉栈顺序。
- 使用 FIGMA_HIERARCHY_REORDER_CHILDREN 时，必须验证 childSetPreserved、orderMatchesPlan、boundsPreserved、rootSizeUnchanged 全部通过。
- 如果验证发现遮挡关系异常，必须报告具体节点和 index 差异，先问我确认修复方案。
- 遇到无法判断的节点请报错说明，不要猜测修改。
