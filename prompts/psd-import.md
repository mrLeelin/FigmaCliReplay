请使用 $psd-layer-to-figma 将 PSD 分层导入到当前 Figma 文件。

PSD 文件：
- 当前拖入文件：{{psdFileName}}
- 如果这里显示“未拖入”，仍然继续生成导入计划；PSD 来源由我稍后补充路径，或我会直接把源 PSD 文件发给 AI。
- 如果执行导入时需要 PSD 绝对路径，请先读取我补充的路径；没有路径时再向我确认，不要猜路径。

目标 Figma：
{{selectionBlock}}



重要前提：
- 目标允许两种模式：不选择节点时使用当前 Figma 页面；选择 1 个 FRAME 时使用当前选区里的 FRAME 作为目标容器。
- 如果目标是当前页面，请在当前页面下新建 PSD 根 Frame；如果目标是当前选区 FRAME，请在该 FRAME 下新建 PSD 根 Frame 或按计划导入到该 FRAME 内。
- 这是 PSD 分层导入，不是把 PSD 合成为一张 PNG。
- 不要直接覆盖或删除我选中的 Frame；请先确认导入方式。如果需要在该 Frame 下新建 PSD 根 Frame，先说明计划和影响。

执行要求：
- 必须使用 `figmaRelay` 驱动 `<relay-root>` 下的插件执行批量导入、验证和截图，不要用官方/通用 Figma MCP upload_assets/use_figma/get_screenshot 承担标准导入流程。
- 先调用 `figma_health`，再 `figma_query_selection` 回显当前 Figma 文件 key、页面名、选区数量、节点名称、类型和 nodePath，确认与上方信息一致。
- 如果目标是当前页面，导入前必须只读确认当前 Figma 文件 key、页面名与上方信息一致，且 Relay 可访问当前页面。
- 如果目标是当前选区 FRAME，导入前必须只读验证当前选区只有 1 个 FRAME，且目标可承载新导入根 Frame。
- Text 层优先创建可编辑 Figma Text；fillColor、strokeColor、描边和阴影必须从 manifest 程序化读取。
- AI 必须自动推断并设置每个导入节点的 Figma Constraints。优先使用 manifest 的 `layer.constraints`；如果缺失，必须根据 PSD canvas 和 layer bounds 自动推断，不要向我询问。普通图片、Text、common/auto Instance、九宫/三切片父 Frame 都要设置；`__slice_*` 子层使用切片固定 Constraints。
- 所有分批创建完成后，必须按 PSD 原始 layer index 统一重排本次导入根 Frame 的直接子节点 Z 顺序。

交付门禁：
- MCP/插件 result 必须 status == completed。
- missingNodeCount、emptyImageFillCount、badTransformCount、textClipRiskCount、textColorMismatchCount、textStrokeMismatchCount、sliceProblemCount、indexOrderBad 必须全部为 0。
- Constraints 不得缺失；如果 manifest 缺失导致现场推断，必须说明推断规则和影响节点范围。
- 必须导出 Relay 截图并说明截图路径。
- 如果 PSD 路径、目标 Figma key、目标页面/选区、组件库查询或九宫参数无法确认，直接报错提示我，不要猜测执行。
