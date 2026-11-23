请在保持画面表现的前提下，整理以下 Figma 节点的内部层级。

目标选区：

{{selectionBlock}}

- 读取 `{{cleanupSkillPath}}`，按独立 CLI 任务的 `analyze → plan → apply` 流程执行。路径为相对路径时，从 Relay 安装目录查找。
- 用 `figma-relay sessions` 和选区查询核对文件、页面与目标。定位不一致时先确认目标。
- 首轮只分析并展示完整拟议层级树。等我明确确认后再通过项目 CLI 提交写入，用 `task-wait` 等待同一任务，并验证层级和画面。组件变体需另行确认。
