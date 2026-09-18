使用 Relay 内置整理技能：$figma-hierarchy-cleanup。

不要使用 `Skill()` 或 `ToolSearch` 查找该技能。直接读取项目中的 `ai/skills/figma-hierarchy-cleanup/SKILL.md`，并按技能的 `analyze → plan → apply` 标准流程执行；通过项目 CLI 提交任务并使用 task-wait 等待结果。

整理当前选中的 Figma 节点。

目标选区：

- {{selectionBlock}}

Relay 会在启动 AI 前生成唯一的执行规则和权威快照；此模板只表达用户的初始整理意图，不能再包含执行规则、JSON 示例或确认流程。所有 Figma 业务调用通过项目 CLI + WebSocket 完成。
