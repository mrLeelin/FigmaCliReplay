# 项目 CLI（迁移阶段）

Unity 项目管理控制支持 `unity.projects.list/add/select/remove`、`unity.bridge.install`、`unity.gateway.get`。添加传 `path`，选择、移除、安装和发现必须传显式 `id`，不自动使用最近选择的项目。CLI 和插件使用同一注册表与安装逻辑；旧 `/unity-projects` HTTP 入口返回 410。示例：

```powershell
node dist/cli.js control --job-type unity.projects.list --payload '{}'
node dist/cli.js control --job-type unity.projects.add --payload-file project.json
node dist/cli.js control --job-type unity.gateway.get --payload '{"id":"<projectId>"}'
```

Unity 业务入口新增 `unity.command` 与 `unity.command-status`。payload 必须指定注册项目 `id` 和稳定的 `requestId`；提交时还需 `action`、可选对象 `body`、可选查询字符串 `query` 和 `timeoutMs`（100 至 120000）。例如：

```powershell
node dist/cli.js control --job-type unity.command --payload '{"id":"<projectId>","requestId":"health-001","action":"unity.health"}'
node dist/cli.js control --job-type unity.command-status --payload '{"id":"<projectId>","requestId":"health-001"}'
```

Relay 从所选项目的本地发现文件读取 Bridge 地址与私有令牌，连接 `/bridge` WebSocket，并校验协议版本、精确产品版本及项目路径；公开 `unity.gateway.get` 不返回令牌。UI 的健康、选择、Canvas、图片导入、层级和字体同步以及 Node 日志采集已切换 WS，业务在 Unity 主线程执行；UI 不再扫描端口。`run_full_import.py` 经项目 CLI 执行 Unity 导入，`--unity-project-id` 与 `--unity-project` 共同校验目标，旧 `--unity-gateway-url` 已删除。导入编排与拖放已使用共享 WS 控制，运行时真值通过 Unity CLI，旧 Bridge 业务 HTTP 已拒绝执行。

命令状态为 queued/running/completed/failed；断线或超时只查询原 requestId，不自动重放。保留记录中的相同请求 ID 与参数只执行一次，不同参数被拒绝；最多保留 1000 项。满时回收已完成的 health/ping/selected-folder/logs 只读结果，不能回收写入记录；无可回收项则拒绝新请求。已回收的只读请求可重新查询。Editor 域重载或 Bridge 重启会丢失内存状态，旧 ID 查询返回 unknown，此时不能据此重新写入。单帧请求上限 16 MiB。UI/Python 错误保留项目和请求 ID，便于用 `unity.command-status` 核对；安装 Bridge 不等于实际 Editor 编译或运行验收。

传输回归可独立于 Unity 运行：`dotnet build tests/fixtures/unity-bridge-host/BridgeHost.csproj --output .tmp/bridge-host`，设置 `UNITY_BRIDGE_TEST_HOST` 为生成的 `BridgeHost.dll` 绝对路径，再运行 `node --test tests/unity-bridge-csharp.test.mjs`。此测试链接实际 C# 传输源码，仅替换 Unity API 和业务队列，不证明真实资源操作正确。

PSD 控制已接入 `control --job-type psd.import.start|get|apply|adopt-baseline`（竖线表示选择一个 action）。启动 payload 包含稳定的 `clientRequestId`、`fileName`、`fileBase64`、`mode` 和 `target`；查询包含 `taskId`；应用与采用基线还必须包含预览返回的 `baselineFingerprint`。使用 `--session-id` 固定会话，Relay 校验目标文件与任务归属。示例：

```powershell
node dist/cli.js control --job-type psd.import.start --session-id <sessionId> --payload-file psd-request.json
node dist/cli.js control --job-type psd.import.get --session-id <sessionId> --payload '{"taskId":"<clientRequestId>"}'
node dist/cli.js psd-status --session-id <sessionId> --task-id <clientRequestId>
node dist/cli.js psd-wait --session-id <sessionId> --task-id <clientRequestId> --timeout 120
node dist/cli.js psd-cancel --session-id <sessionId> --task-id <clientRequestId>
```

插件进度使用 `psd.import.subscribe/unsubscribe`，与 AI、Prefab 订阅互不替换。旧 PSD HTTP 业务入口返回 410。PSD 状态保留在当前 Relay 进程内，最多 100 项；重启后旧任务 ID 若已有产物则拒绝重新执行，不代表支持重启恢复。请求失败或结果不明时先查询原 taskId，不自动重复写入。

`psd-wait` 经 WebSocket 接收进度，在完成、失败、取消或需要用户处理的预览状态返回；超时或退出 CLI 不取消任务。`psd-cancel` 在导出阶段返回 `accepted: true` 和 `cancel_requested`，导出进程结束且未提交 Figma 后才返回 `cancelled`；空闲预览可立即取消。一旦开始提交 Figma，取消返回 `accepted: false` 并保留实际状态，不终止提交进程或伪造取消成功。CLI 退出码 0 表示请求已成功处理，须检查 `result.accepted` 及 `result.task.status` 判断取消或任务结果。

当前实现会话查询、Figma 通用命令、AI/整理控制，以及任务查询、等待和取消。需要使用本次构建的 Relay，以及重新加载后的 Figma 插件；旧 Relay 或缺少 WebSocket 结果能力的插件会被拒绝。本次代码验证没有重启正在运行的服务。

在项目目录中运行：

```powershell
node dist/cli.js --help
node dist/cli.js sessions
node dist/cli.js selection --session-id <sessionId>
node dist/cli.js figma-command --session-id <sessionId> --job-type QUERY_PLUGIN_STATUS --payload '{"includeSelection":true}'
node dist/cli.js selection --file-key <fileKey> --timeout 15
node dist/cli.js selection --session-id <sessionId> --detach
node dist/cli.js task-status --task-id <taskId>
node dist/cli.js task-cancel --task-id <taskId>
node dist/cli.js task-wait --task-id <taskId> --timeout 120
```

只有一个在线 Figma 会话时可省略目标；存在多个匹配会话时必须明确选择。sessionId 与 fileKey 同时指定时必须匹配同一会话。

默认地址为 ws://127.0.0.1:32130/relay，可用 --url 指定其它本机端口。CLI 只连接服务，不负责服务启动、重启或停止。安装包声明的命令名是 figma-relay；开发目录可以通过 node dist/cli.js 直接使用，无需全局安装。

## 输出与身份

- 结果为 stdout 上单行 JSON；诊断日志输出到 stderr，并通过现有日志系统记录。
- 退出码：0 成功、1 连接或业务失败、2 命令行参数错误。
- 认证令牌优先读取 FIGMA_RELAY_TOKEN，其次读取本项目 .local/admin-token.txt；FIGMA_RELAY_TOKEN_FILE 可覆盖令牌文件位置。
- 服务端复用当前 adminToken 配置校验令牌；/relay 不接受带浏览器 Origin 的连接。
- CLI 产品版本须与 Relay 一致，消息协议版本独立为 1。

## T2 协议

| 消息 | 用途 |
| --- | --- |
| relay.hello | role=cli、protocolVersion=1、clientVersion 握手 |
| relay.ready / relay.error | 接受或拒绝握手，返回服务版本 |
| relay.request | requestId、operationId、action、payload |
| relay.response | 同一 requestId/operationId，ok 与 result 或 error |
| command.request | Relay 下发 Figma 命令；新任务携带 resultTransport=websocket |
| command.received | 插件接收确认，不表示执行完成 |
| relay.request，action=job.result | 插件通过已有 WS 请求机制提交最终结果 |

CLI action 支持 relay.sessions、figma.selection、figma.command、relay.control、task.status、task.wait 和 task.cancel。使用 --detach 时只提交任务并返回任务标识 requestId；Relay 进程存活期间可从另一 CLI 进程查询。Figma 插件须声明 job.result、job.reconcile、job.cancel 能力。结果只允许通过任务令牌和目标会话校验的插件提交；重复提交确认首次存储的结果，不再次覆盖。

## T3 任务可靠性

`task-wait` 使用 Relay WebSocket 事件订阅，不轮询 HTTP；CLI 进程退出不会取消任务。使用 `--request-id` 可安全重试，相同任务和目标只会复用原任务，不会重复下发。任务状态包括 `queued`、`running`、`cancel_requested`、`waiting_reconnect`、`succeeded`、`failed`、`cancelled` 和 `result_unknown`。WebSocket 任务断线后进入 `waiting_reconnect`，30 秒内只接受插件重连核对或真实结果，不自动重放；期限过后变为 `result_unknown`。取消中的运行任务明确返回 `running`，不伪造中断。recovery token 只用于插件与 Relay 鉴权，不输出到 CLI JSON 或日志。

`figma-command` 是 T4 的通用 Figma job 入口。`--job-type` 必须是插件已实现的 job type，`--payload` 是该 job 的 JSON 字段；任务仍经过目标会话校验、幂等 request ID、WebSocket 结果鉴权和写入闸门。

大清单使用 `--payload-file manifest.json`，资源登记使用 `--assets-file assets.json`（资源 ID 到本机路径的 JSON 对象）。请求上限为 16 MB，资源仍受 Relay 允许目录限制；二进制资源继续通过受控下载读取。Python 入口 `client/figma_relay_cli.py` 用临时 JSON 文件调用本项目 CLI，保留脚本依赖的 requestId/result 结构，等待超时只重新订阅同一任务，不重复提交。

`control --job-type ai.run.get --payload-file control.json` 等控制命令使用原有 runId/capabilityToken 校验。已接入 ai.providers/status/config/open-terminal、ai.run.start/get/followup/stop，以及 cleanup.run.start/get/approve/cancel/confirm-component-sets。CLI 与插件共用控制处理；需要执行会话的动作必须唯一匹配在线目标，CLI 目标参数不能与 payload 冲突。

AI UI 通过 ai.run.subscribe 或 cleanup.run.subscribe 订阅进度。Relay 在本机读取运行状态，仅在状态或输出变化时发送 relay.event；UI 不再定时查询状态。断线释放订阅，重连后从 lastSequence 恢复输出。终态分页输出读完后退订。AI 控制不再回落 HTTP；普通启动与打开终端遇到结果不明时不会自动重试。

Figma 任务全部通过 WebSocket 下发及回传，旧 polling 配置不能开启任务轮询。UI 拒绝缺少 WebSocket 任务身份的旧命令；旧 POST /figma/result 返回 410 升级提示，不能绕过令牌提交结果。

## 当前边界

单次查询/订阅超时范围为 0.1 至 120 秒，默认 15 秒。已完成任务约保留 10 分钟；Relay 重启不会恢复内存任务，旧 taskId 返回 TASK_UNKNOWN。断线任务按上述 waiting_reconnect/result_unknown 流程处理，不自动重放，也不进入 HTTP 轮询。未下发任务可直接取消；已经下发的任务须由插件确认取消终态。

新 CLI 路径没有 MCP 调用；T5 业务调用迁移完成，旧 MCP 服务、SDK、配置与启动链已在 T6 移除。尚无真实 Figma/Unity 全链路与视觉验收结果。

## T5 Unity 与导入

共享 `control --job-type` 入口支持 `unity.command`、`unity.command-status` 和项目管理动作。Unity 命令携带注册项目 `id`、稳定 `requestId`、`action` 与 `body`，通过本地令牌、精确版本和项目身份校验的 Bridge WebSocket 执行；未知写入不自动重放。`unity.resolve-image` 返回 `assetPath` 与 `mimeType`，需按现有允许目录规则登记为 Relay 资源后受控下载。

Figma 到 Prefab 使用 `figma.prefab.start`，payload 包含 `clientRequestId`、`projectId`、`gatewayProjectPath`、`targetFolder`、`sessionId`、`fileKey`、`nodeId`、`nodeName`、`nodeWidth` 和 `nodeHeight`。相同 ID/参数复用原任务，同 ID 异参拒绝。`figma.prefab.get` 使用 `taskId` 和原会话身份核对状态；插件通过 `figma.prefab.subscribe/unsubscribe` 接收独立进度事件。任务最多 100 项，终态保留 30 分钟；重启后不恢复内存状态，已有产物 ID 拒绝重放。

`prefab.resolve-dropped` 使用显式 `projectId` 与 `files`（每项 `fileName`、可选 `text`）；路径由注册表决定，不接受调用方替换工程路径。冲突结果列出候选，不能自行选择同名 Prefab。

`dump_unity_prefab_truth.py` 通过 `unity command eval_file --project-path ... --format json` 采集真值，要求 Unity CLI 可用（`FIGMA_UNITY_CLI` 可指定可执行文件）。执行结果必须匹配项目、Prefab 路径和 truth schema；超时只报告失败，不重试。旧 Unity 业务 HTTP 及 Relay 导入/裁图 HTTP 入口均返回 410 升级提示。

## T6 状态、日志与独立启动

`control --job-type relay.status --payload {}` 查询状态和运行目录；`control --job-type logs.query --payload-file query.json` 查询日志，参数形如 `{"query":{"source":"relay","limit":200}}`。支持时间、来源、级别、操作 ID、模块与关键字筛选，limit 为 1–1000，非法参数明确拒绝。UI 日志导出使用相同查询结果。

外部操作者可使用 `启动Relay.bat` 或 `scripts/start_relay.ps1` 启动独立 Relay，`npm run doctor` 和 `npm run smoke` 通过 CLI/WS 验证；AI 任务不得管理该服务生命周期。旧 MCP 配置、启动文件与服务入口已删除。全新安装执行 `npm ci`、`npm run build`，增量构建会清除已退役的 MCP 编译入口。
