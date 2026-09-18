# T7 真实环境验收记录

## 2026-09-18 首轮预检

执行 `node dist/cli.js sessions --timeout 8`，通过默认本机 `/relay` WebSocket 查询真实 Figma 会话；未请求旧 HTTP health，未扫描端口，未重试。

- 返回：`CONNECTION_FAILED`。
- 原始网络错误：`ECONNRESET / socket hang up`。
- operationId：`0b8ddbc8-c098-48b4-8f2a-42ec93b092b4`。
- 尝试次数：1/1。
- 原始日志：`.tmp/t7-sessions.log`。

当前证据只能说明本次 WebSocket 连接被重置。不能据此认定服务停止、TCP 资源压力、旧版本运行或重启即可修复；这些原因均未证实。

未获得在线 Figma 会话，因此没有进行真实资源写入、截图、视觉比对或断线恢复验收。未启动、重启、停止或重配当前 Relay，未安装 Bridge 到用户项目。

已复核 6 项现存失败的测试要求：组件库查询失败时降级图片；增量 staging 解包及预览；文字自动尺寸修复和回滚。当前测试包含源代码契约断言，不能仅凭失败认定真实 Figma 视觉结果错误，也不能删除断言来宣称通过。本轮尚未修复这些业务行为。

T7 状态：真实环境连接预检阻塞，未完成。下一步需要确认当前 Relay 的运行版本和 `/relay` WebSocket 接入状态；若需要将服务切换到本次构建，必须先取得明确的生命周期操作授权。恢复连接后使用明确的测试文件、节点和 Unity 项目执行验收，不将自动化 fixture 结果冒充真实验收。

## 用户授权重启后的验证

用户明确授权“可以，重启吧”。确认端口 32130 的旧进程属于当前工作区 `dist/index.js` 后停止 PID 45252，使用独立启动脚本启动 PID 116348；保留原令牌，未操作其他服务。

- CLI `relay.status` 成功，transport 为 websocket，鉴权启用，运行目录为当前仓库。
- CLI 精确版本握手通过（发布版本 0.1.48）；Figma 插件自动重连，声明 job.result/job.reconcile/job.cancel 能力。
- 真实 `figma-status` 通过，插件返回 build 281、status completed。
- 真实 `selection` 通过：文件“推币机_资源库”，页面“周四演示”，选区为空。
- 证据：`.tmp/t7-restart-status.json`、`.tmp/t7-restart-sessions.json`、`.tmp/t7-plugin-status.json`、`.tmp/t7-selection.json` 及同名诊断日志。

连接阻塞已解除，真实 CLI → Relay → Figma → WebSocket 结果回传已验证。尚未修改 Figma 资源或 Unity 项目；空选区不能充当资源/视觉验收目标，T7 整体验收仍未完成。
