# Figma 与 Unity 协作

本项目连接设计工具、Unity 编辑器和 AI，支持设计整理与资源导入。

## 术语

**项目 CLI**：供用户和 AI 调用本项目能力的命令行入口。
_避免_：AI CLI、MCP 客户端。

**AI CLI**：负责运行模型任务的外部命令行工具，例如 Codex 或 Claude Code。
_避免_：项目 CLI。

**Relay**：协调项目调用方、Figma 插件与 Unity 编辑器之间任务的本地常驻服务。
_避免_：MCP 服务。
