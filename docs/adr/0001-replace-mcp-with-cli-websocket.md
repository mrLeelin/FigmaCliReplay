---
status: accepted
---

# 用 CLI + WebSocket 替代 MCP

用户于 2026-09-18 明确指定：移除本项目的 MCP 方案，全部替换为 CLI + WebSocket。该约束排除继续以 MCP 作为正式入口或通过 CLI 包装旧 MCP 调用的方案；迁移涉及入口、调用端、部署配置与文档，需要统一设计。

用户已确认以下架构边界：

- 新增本项目自己的 CLI，供人、Codex 和 Claude 调用；现有 AI CLI 继续负责模型执行。
- 保留常驻 Relay，项目 CLI 通过 WebSocket 接入 Relay，Relay 通过 WebSocket 连接 Figma 与 Unity。
- 业务命令、结果和进度统一走 WebSocket，删除 HTTP 轮询；图片等大文件保留 HTTP 下载。

用户进一步确认以下运行与切换规则：

- Relay 由独立入口启动；业务 CLI 连接失败时明确报错，不自动启停服务。
- CLI 退出不取消已经提交的任务；调用方可凭任务 ID 查询进度或明确请求取消。
- Figma 或 Unity 断线后等待重连；已发送但结果不明的修改操作必须先核对状态，不得直接重放。
- CLI、Relay、Figma 插件和 Unity Bridge 同步切换；移除 MCP 入口与配置脚本，旧客户端明确提示升级，不保留兼容执行通道。

架构方向与上述行为已确认；尚未实施代码迁移。迁移规格见 ../superpowers/specs/2026-09-18-cli-websocket-migration.md。
