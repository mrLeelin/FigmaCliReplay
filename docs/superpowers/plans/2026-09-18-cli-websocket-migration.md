# CLI + WebSocket 迁移实施顺序

依据：[迁移规格](../specs/2026-09-18-cli-websocket-migration.md)。状态：T1 完成，T2/T3/T4/T5/T6 代码及自动化验证完成；T7 真实 Figma/Unity 验收待完成。全量测试仍有 6 项既有 PSD 失败，不能宣称整体验收通过。开发过程可分阶段，正式交付统一切换，不保留旧协议兼容执行。

### T6 收口

MCP SDK、服务、配置界面、Python 常驻服务器和旧启动链已删除。CLI 与插件状态/日志/打开目录使用共享 WS 控制；HTTP 仅服务登记资源，其余业务请求返回 410。已清除轮询 API，技能入口及导出证据文件使用 CLI/Relay 命名。独立启动、doctor、smoke、发布脚本已更新；构建清理旧 MCP JS，打包排除 Python 缓存。版本仍为 0.1.48，未重启服务、安装 Bridge 或发布。验证细节见 [T6 记录](../../t6-cleanup.md)。

### T5 Python 与导入进度阶段记录

- Node 已通过固定 `server/algorithm_cli.py` 入口运行一次性 Python 子进程，stdin JSON / stdout NDJSON；裁图和 Prefab 导入不再启动 Python HTTP 后台。算法流水线独立于旧服务器模块，保留导出、计划、读回审核以及 Unity 真值失败时的非阻塞告警。
- Prefab 导入固定 sessionId/fileKey，使用 clientRequestId 去重，拒绝同 ID 不同参数和跨会话读取；进度采用独立 WebSocket 订阅，可与 AI 订阅并存。连接结果不明时查询原任务，不自动重放写入。任务状态目前仅存于 Relay 内存，重启后不恢复。
- 验证：完整 `npm run build` 通过（构建 269，发布版本 0.1.48）；Python 6 项通过，包含真实裁图 PNG/meta 产物、关联成功/失败日志、审核拒绝、目标透传。Node 首轮 60 项通过；随后增加订阅并存测试，控制测试 2 项通过；增加 Prefab UI 事件过滤测试后 UI 测试 6 项通过。本轮未重跑全量测试。
- PSD 后续进展：启动、查询、应用、采用基线已接入共享 CLI/WS 控制；插件进度改为独立订阅，去掉 HTTP 轮询。旧 PSD HTTP 分发删除并返回 410。固定目标、请求去重、跨会话拒绝、旧产物 ID 防重放、UI 立即终态和过期事件过滤、AI/Prefab/PSD 订阅并存已覆盖测试。预览指纹及应用门禁保留。
- PSD 验证：完整构建 270 通过，最终 TypeScript 编译通过；25 项定向测试通过。全量 Node 421 项中 414 通过、7 项既有失败（组件库降级 1、staging 3、文本修复 2、隐藏启动 1），日志 `.tmp/t5-psd-full-tests.log`。两条检查旧 HTTP/轮询函数的 UI 断言已更新为 WS 行为。未进行真实 PSD 导入视觉验收。
- PSD 等待/取消：新增 `psd-status`、`psd-wait`、`psd-cancel`；等待使用 WS 推送，超时不取消任务。导出阶段取消在子进程返回后阻止 Figma 提交，预览可立即取消；已进入 Figma 提交的任务明确返回 accepted=false，继续核对实际结果。真实 CLI 子进程与隔离 Relay、真实 Python 导出取消在内的 59 项定向测试通过，完整构建 271 通过；本轮未重复全量测试。
- Unity 项目管理进展：项目增删、选择、Bridge 安装和网关发现接入共享 CLI/WS 控制；Node 入口显式共享注册表，UI 注册完成后刷新项目。选择/移除/安装/发现要求显式项目 ID。旧项目管理 HTTP 分发和辅助授权入口删除，改为 410。网关记录校验保留，编辑器内部业务仍待迁移。
- Unity 项目管理验证：完整构建 272 通过；项目/发现/安装/HTTP 拒绝/UI 定向 19 项通过，真实 CLI 子进程经隔离 WS Relay 访问注册表及 UI/CLI 回归共 44 项通过。安装仅在临时项目验证，未安装到用户项目、未启动 Unity 或操作常驻 Relay；本轮未重跑全量测试。
- Unity WS 传输进展：新增本地令牌鉴权、精确版本/项目握手的 `/bridge`，业务通过独立命令对象排入 Editor 主线程；CLI 共享控制提供 `unity.command`、`unity.command-status`。Node 日志采集改用 WS。请求按 ID 去重，跨连接可查询排队/运行/终态，同 ID 异参拒绝，断线不重放；实例内最多 1000 项，重载后状态未知。关闭及启动失败释放连接，迟到的旧实例命令在入队时拒绝。旧业务 HTTP 入口暂存，等待调用方迁移后删除。
- Unity WS 验证：完整构建 273 通过，发布版本仍为 0.1.48；Unity/CLI/日志定向回归 90 项通过（`.tmp/t5-unity-ws-regression.log`），包含 Node 与实际 C# 传输源码跨进程互通、重复提交、异参冲突、断线取回和 Origin/令牌拒绝。全部 Bridge C# 引用本机 Unity 6 程序集编译 0 错误、118 警告；测试宿主只替换 Unity API/业务队列，未安装到实际项目、未获得 Editor 运行验收。本轮未重跑全量 Node 测试。
- Unity 调用方进展：UI 健康/选择/Canvas/图片/层级/字体同步改用共享 WS 控制，删除端口扫描；请求固定项目 ID，丢弃切换项目后的旧结果，失败保留原请求 ID。Node 导入预检采用 WS，Python 导入经 CLI 按注册项目 ID/路径匹配，移除直连 HTTP 和 `--unity-gateway-url`。只读缓存满时可回收完成项，写入记录不回收；版本拒绝向 UI 返回明确错误。
- Unity 调用方验证：完整构建 274、95 项定向 Node、19 项 Python 通过；定向测试包含实际 C# 传输接收 1100 次查询后仍保留写入去重记录、项目切换与未知结果不重放。全量 Node 441 项中 434 通过、7 项既有失败（组件库降级 1、staging 3、文本修复 2、隐藏启动 1），无跳过，日志 `.tmp/t5-unity-callers-full-final.log`。发现文件的旧无令牌发布断言已更新。全部 Bridge C# 引用本机 Unity 6 程序集编译 0 错误、118 警告。实际 Editor 与真实跨端资源操作仍未验收。
- T5 收尾完成：Figma 到 Prefab 编排改用 `figma.prefab.start/get/subscribe/unsubscribe`，稳定请求 ID 去重、会话归属校验、旧产物阻止未知写入重放；拖放解析改用 `prefab.resolve-dropped`，只接受显式注册项目并丢弃项目切换后的迟到结果。Unity 真值采集改用显式项目的 `unity command eval_file`，校验 CLI 成功状态、项目与 Prefab 身份，超时不重试。Bridge 只在 `/bridge` 接收 WS，旧业务 HTTP 返回 410；`unity.resolve-image` 返回路径/MIME，二进制继续由 Relay 受控下载。Relay 旧导入、裁图、打开目录 HTTP 转发已删除。
- 收尾验证：完整构建 276 通过，发布版本仍为 0.1.48；首轮定向 Node 23 项、Python 21 项通过。全量 Node 442 项中 435 通过、7 项上述既有失败、无跳过（`.tmp/t5-final-node.log`），包含实际 C# WS 宿主。之后增加 UI 迟到事件/未知结果保护与显式拖放项目验证，相关定向 21 项及最终任务/拖放 9 项通过（`.tmp/t5-final-focused.log`、`.tmp/t5-final-drop.log`）。全部 Bridge C# 引用本机 Unity 6 程序集编译 0 错误、118 警告。真实 Unity CLI 常量 `eval_file` 探针通过，仅证明执行入口可用，不代表 Prefab 资源或视觉验收。
- 边界：PSD 与直接导入任务最多保留 100 项，终态保留 30 分钟，重启后仅阻止已有产物 ID 重放，不提供状态恢复；执行端写入期间的 PSD 取消明确拒绝。T6 负责旧服务器源码、MCP SDK、配置/启动链、旧命名和文档清理。T7 负责真实 Figma/Unity 运行及资源视觉验收。未安装新 Bridge 到用户项目，未操作常驻 Relay 生命周期，未提交或发布。

| 任务 | 前置 | 工作与完成条件 |
| --- | --- | --- |
| T1 能力与回归基线 | 无 | 枚举旧 MCP 工具、HTTP 路由及脚本调用方；标注对应新入口；记录已有测试失败与用户改动，补必要行为回归测试 |
| T2 CLI 与协议纵向切片 | T1 | 明确握手、授权、请求/响应/事件、目标与错误；实现 CLI 查询真实 Figma 选择的完整链路，验证 JSON、退出码与拒绝日志 |
| T3 任务可靠性 | T2 | 统一提交、查询、订阅、取消、去重与断线核对；明确保留期限、Relay 重启恢复边界，覆盖结果未知场景 |
| T4 Figma 与 AI 迁移 | T3 | 迁移所有工具、整理和 AI 控制；更新提示词与 skills；移除相关轮询和 HTTP 兜底，验证确认与回滚行为 |
| T5 Unity 与资源迁移 | T3 | 迁移 Unity、Python 与导入脚本调用链；受控文件下载继续保留；覆盖双向导入、PSD 和图像处理 |
| T6 统一切换与清理 | T4、T5 | 移除 MCP SDK、配置与启动调用链；更新部署、版本同步、AGENT.md 和使用文档；验证旧端升级提示和残留符号 |
| T7 整体验收 | T6 | 完整构建、定向回归、Unity 编译、真实跨端操作及断线测试；独立审查差异并报告未验证项 |

每个任务开始前读取涉及的当前源码与未提交差异。纯传输改动不得改变业务语义；确需改变时补充决策依据。修改 Figma 源片段后通过构建生成 code.js。最终报告分别列出源码验证、运行验证和发布状态。

## 2026-09-18 实施记录

- T1：[能力映射](../specs/2026-09-18-cli-websocket-capability-map.md) 已覆盖 14 个 MCP 工具、HTTP 业务、Unity、Python、skills 及发布调用链。现有用户修改保留。
- T2：新增项目 CLI、版本与角色握手、sessions/selection 只读动作；复用 RuntimeRelay 下发 QUERY_SELECTION。新任务使用 WebSocket 回传结果，禁止进入 HTTP 轮询队列。通过 job.result 能力声明识别旧插件并提示升级。
- T3：新增 selection --detach、task-status、task-wait 和 task-cancel，并支持 --request-id 幂等重试；任务在 Relay 存活期间按 taskId 查询或订阅，取消先进入 cancel_requested，运行中取消明确回报 running，插件确认后才成为 cancelled。WS 任务使用 recovery token，重连后核对状态并补发已完成结果，禁止自动重放；断线任务进入 waiting_reconnect，超时后为 result_unknown。跨 CLI 查询、订阅、重连鉴权、取消和去重测试已覆盖。
- 插件最终结果按原 socket 的任务归属检查；派发确认不算执行完成。重复结果只确认、不覆盖首次结果；面板保留轻量运输标记，防止晚到结果进入旧 HTTP 分支。
- 日志覆盖 CLI 连接、握手、参数与目标校验、任务下发、结果、拒绝和原始网络错误；输出 JSON 与诊断 stderr 分离。
- 两份新增行为测试共 21 项通过，包括真实 CLI 子进程、隔离端口的 Relay/模拟插件、UI 函数执行、鉴权、跨会话伪造、版本不匹配、断线、超时、取消结果及重复回传。
- 完整 npm run build 通过；发布版本保持 0.1.48，构建生成器更新开发构建号到 261。
- 全量 Node 测试 378 项中 370 通过、8 失败。失败涉及 provider 重连、PSD 组件降级、staging 清理、文本布局与后台启动脚本断言；用内存读取 HEAD 版本 ui.html、code.js、start_mcp_hidden.ps1 复跑同一批测试，复现完全相同的 8 项失败，未改动当前工作区文件。
- 本机验证日志：.tmp/cli-migration-node-tests.log、.tmp/cli-migration-baseline-failures.log；基线重现加载器为 .tmp/cli-migration-baseline-loader.mjs。
- 已完成规格与代码规范两路审查，修复失败状态判定、原始网络错误保留和拒绝日志关联问题。
- T3 验证：`npm run build` 通过；CLI、插件任务/结果、日志关联和 cleanup UI 定向测试 73 项通过。全量 Node 测试 398 项中 390 通过、8 项失败，仍为已记录的 provider 重连、PSD 组件/staging/文本布局和后台启动脚本基线失败。

- T4 当前进展：通用 Figma job 与 AI/cleanup 控制入口接入 CLI；整理、PSD、双向 Prefab 的 Figma Python 客户端，以及组件缓存/九宫格创建改用 CLI + WebSocket。资源路径通过 assets-file 登记并复用目录校验；请求上限为 16 MB；保留 Python 消费方依赖的 requestId/result 结构。
- T4 UI/控制收口：AI 设置、启动、续聊、停止和满意确认已采用 WebSocket；进度改为订阅推送、按输出序号恢复，删除 AI HTTP 兜底。CLI 与插件共用 relayControl 处理。Figma 执行轮询及 HTTP 结果回传已删除，RuntimeRelay 所有新任务固定 WebSocket，缺少任务身份的旧命令在执行前拒绝，旧 HTTP 结果入口返回 410。整理 Skill 已更新旧超时重试和 JSON 解包说明。Unity/PSD/Prefab 编排与相关 UI HTTP 属于 T5；旧 MCP 服务、配置界面、启动/发布脚本及全量文档残留属于 T6，尚未移除。
- T4 本轮后续验证：完整构建通过（开发构建号 268，发布版本未改）；94 项定向测试通过，随后 provider/控制/CLI/UI 74 项通过；Python 16 项通过。全量 Node 413 项中 405 通过、8 项基线失败（`.tmp/t4-ws-full.log`）；随后将 provider 重连测试改为“注册完成后查询”的新协议断言并单独通过，其余 7 项既有失败未修改。最后新增的统一 WS 下发测试和订阅并发保护已通过定向验证，未重跑全量计数。
- T4 本轮验证：TypeScript 编译通过；Python 16 项、CLI/资源/PSD/Prefab 定向 36 项、路径可移植性 16 项通过。另补真实 Python → CLI 子进程 → 隔离 Relay → 模拟插件的结果产物回归并通过。全量 Node 405 项中 397 通过、8 项失败，名称与前述基线一致；日志为 `.tmp/t4-full-node-tests.log`。该全量计数不包含随后新增并单独通过的 Python 跨进程测试。

真实 Figma 与 Unity 的跨端验收尚未执行；未启动或重启当前 Relay，未提交或发布。T2/T3 自动化证据不等于真实 Figma 验收，MCP 尚未从整个产品移除。T3 支持 Relay 存活期间跨 CLI 进程订阅；Relay 重启后旧任务返回 TASK_UNKNOWN，不重放写入；不承诺真正中断插件主线程中的同步执行。
