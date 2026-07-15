请使用 $figma-hierarchy-cleanup-mcp，根据我当前选中的多个 Figma 节点，规划 ComponentSet 变体。

{{selectionBlock}}

重要前提：
- 当前选中的节点可以是多个模板节点。
- 这些节点不一定是根节点，也不一定同父级。
- 不要假设它们都是同级列表项或同级 Tab 项。

目标：
- 先 query-selection，回显当前选中节点的 name/type/count/nodePath。
- 再分析相关父级结构，判断这些选中节点应该作为手动 ComponentSet 的多个变体来源，还是跨父级节点组 ComponentSet 的一组或多组来源。
- 如果适合手动选择 ComponentSet 流程，请规划 component-set --from-selection；该流程默认只创建 ComponentSet，不删除、不移动、不替换源节点。
- 如果目标是替换原有重复项，必须先 analyze 相关父级或目标容器，明确哪些同类节点要被替换，再规划 component-set-from-node-groups 或其它合适流程。
- 如果适合跨父级节点组流程，请规划 component-set-from-node-groups，并显式列出每组节点的名称、类型和 nodePath；实际写入以 MCP Relay 当前选区和分析结果为准。
- 如果变体值、分组关系或替换范围无法从节点名和结构可靠推断，必须先问我，不要猜。

执行规则：
- 只先给计划，不要直接执行。
- 等我确认后再调用 MCP Relay 写入。
- 只有计划明确要替换原有重复项时，才设置 replaceOriginalsWithInstances=true。
- 发生替换时默认 createBackup=true，源节点必须备份到隐藏备份 Frame。
- 禁止删除原节点。
- 禁止 flatten、detach instance、拆散 __slice_ / jiugong / nine-slice 节点。

验收要求：
- 执行后验证 ComponentSet 创建成功。
- 如果计划包含替换，验证原节点已备份、实例替换成功、bounds 不漂移。
- 如果计划只是 component-set --from-selection，验证源选中节点仍保留且未被移动。
- 验证九宫切片在变体内被保留。
- 重新 analyze 目标结构，确认替换后的节点数量、顺序和 Instance 状态符合计划。
