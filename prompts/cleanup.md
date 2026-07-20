使用 Relay 内置整理技能：$figma-hierarchy-cleanup-mcp。

不要使用 `Skill()` 或 `ToolSearch` 查找该技能。直接读取项目中的 `ai/skills/figma-hierarchy-cleanup-mcp/SKILL.md`，并按技能的 `analyze → plan → apply` 标准流程执行；标准入口脚本为 `ai/skills/figma-hierarchy-cleanup-mcp/scripts/figma_hierarchy_cleanup_mcp_client.py`。此技能为项目自定义技能，不在 `.claude/skills/` 中。

整理当前选中的 Figma 节点。

目标选区：

- {{selectionBlock}}

Relay 会在启动 AI 前生成唯一的执行规则和权威快照；此模板只表达用户的初始整理意图，不能再包含执行规则、JSON 示例或确认流程。
