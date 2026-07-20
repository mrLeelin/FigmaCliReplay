# 根据当前 AI 在 PowerShell 继续任务 - 设计

## 目标

让使用者在 Figma Relay 面板中把已经生成的 AI 提示词交给本机已选择的 AI CLI，并打开一个可见、可继续对话的 Windows PowerShell 窗口。此模式是人工接管入口，不改变现有的 Relay 托管执行、整理审批或变体流程。

## 使用体验

1. 用户在面板选择任务类型与 AI（Codex 或 Claude Code），并先生成提示词。
2. 面板在提示词操作区提供“在终端继续”按钮；没有可用提示词时按钮禁用，并说明需先生成提示词。
3. 用户点击后，面板根据当前任务类型取得对应选择：整理任务使用 `cleanupProviderSelect`，其他任务使用 `aiRunnerSelect`。
4. Relay 写入本次任务文件，启动新的可见 PowerShell 窗口，并将任务全文作为 Codex 或 Claude Code 的首条交互消息。
5. 面板显示 CLI 类型、终端已打开和任务文件路径；之后的对话与执行由用户在该终端内完成。

不会复制到剪贴板，也不会自动执行 Relay 托管整理交易，更不会把终端内后续输出误报为 Relay 已执行成功。

## 服务端接口

新增仅供本机面板调用的接口：

`POST /ai-runner/open-terminal`

请求字段：

- `template`：当前提示词模板标识。
- `prompt`：面板预览中的完整提示词。
- `runner`：`codex` 或 `claude`。
- `sessionId`、`unityProject`：用于诊断关联，不作为终端执行结果依据。

成功响应包含 `ok`、`runner`、`taskFile`、`pid`。响应只表示 PowerShell 进程已成功启动，不表示 AI 已完成任务。

## Windows 启动方式

服务端在 Relay 的运行目录创建每次独立的 `terminal-task.md`，再以 `powershell.exe -NoExit -EncodedCommand` 启动可见窗口。编码命令只包含固定脚本、CLI 路径、工作目录与任务文件路径；提示词始终从任务文件以 UTF-8 读取，避免中文内容和 Shell 转义损坏。

- Codex：交互模式执行 `codex <首条提示词>`。
- Claude Code：交互模式执行 `claude <首条提示词>`，不使用 `-p`。
- 窗口保持打开，使用户能阅读错误、继续多轮对话或自行退出。

CLI 命令仍通过已有的本机命令解析与可用性检查确定。未找到所选 CLI 时，服务端不打开终端，并返回明确中文错误。

## 日志与错误处理

所有服务端步骤使用现有 `local-ai-runner` 集中日志器和同一操作 ID，记录 `started -> task-persisted -> command-prepared -> powershell-started -> succeeded/failed` 生命周期。日志字段包括模板、runner、任务文件、进程 PID、会话关联和提示词字符数；不得记录完整提示词或散落的 `console` 日志。

面板使用现有 `uiLogger` 为点击操作记录开始、请求、成功或失败，并将可操作的中文状态写入日志区。异常按以下类别显示：提示词缺失、CLI 未安装或无法解析、任务文件写入失败、PowerShell 启动失败、接口响应无效。

## 边界与安全

- 仅启动用户已在面板选择的本机 CLI；不启动、重启或占用 MCP Relay 的 32130 端口。
- 终端是显式用户点击触发的可见进程；不后台自动接管 AI 对话。
- 使用 Base64 编码的 PowerShell 命令与任务文件传递，避免把提示词拼进命令行造成注入、长度和中文编码问题。
- Relay 只记录启动事实，不能声称终端中 AI 操作已成功或已应用到 Figma。

## 验收与测试

1. UI 静态测试验证按钮存在、使用当前 AI 选择且提示词为空时不可点击。
2. 服务端测试验证路由、runner 映射、任务文件生成、日志生命周期和失败响应。
3. 单元测试替换 PowerShell 启动器，断言会创建可见 PowerShell 启动参数且不把提示词正文写入命令行日志。
4. 执行现有 Node 测试、TypeScript 检查和插件构建；人工烟测使用已安装的 Codex 与 Claude Code 分别打开交互终端。

## 非目标

- 不在本次改动中解析终端中的 AI 输出或反向同步终端会话状态。
- 不替换现有 Relay 托管的 AI 执行、审批与变体工作流。
- 不新增第三方依赖或新的本地常驻服务。
