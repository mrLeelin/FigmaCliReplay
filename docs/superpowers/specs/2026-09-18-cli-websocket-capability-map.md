# CLI + WebSocket 迁移能力映射

核查日期：2026-09-18。依据当前源码、[规格](2026-09-18-cli-websocket-migration.md)与[实施顺序](../plans/2026-09-18-cli-websocket-migration.md)。本文为 T1 静态能力盘点，不是实现或运行验收证明。

本轮范围为 T1/T2 的只读查询纵向切片；T3-T7 尚需后续实施。下列命令以 `<cli>` 表示项目 CLI，命令名和 WS action 为建议映射，实际 T2 合同以实现文档为准。现有 Figma job type 应继续复用，不能因换传输改变业务语义。

## 14 个 MCP 工具

来源：`src/mcpServer.ts` 的 `createRelayTools`。

| 旧工具 | 建议 CLI | 建议 WS action / 现有执行 job | 任务 |
| --- | --- | --- | --- |
| figma_health | `<cli> status` | `relay.status`；读取 Relay 与会话状态 | T2 |
| figma_query_selection | `<cli> figma selection` | `figma.query-selection` / QUERY_SELECTION | T2 |
| figma_query_plugin_status | `<cli> figma status` | `figma.query-plugin-status` / QUERY_PLUGIN_STATUS | T2/T4 |
| figma_query_node_children | `<cli> figma children --node-id ...` | `figma.query-node-children` / QUERY_NODE_CHILDREN | T4 |
| figma_query_components | `<cli> figma components` | `figma.query-components` / COLLECT_COMPONENTS | T4 |
| figma_analyze_repeat_clusters | `<cli> figma analyze-repeat-clusters` | `figma.analyze-repeat-clusters` / FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE | T4 |
| figma_query_pages | `<cli> figma pages` | `figma.query-pages` / QUERY_FIGMA_PAGES | T4 |
| figma_set_context | `<cli> figma context set` | `figma.set-context` / SET_CONTEXT | T4 |
| figma_resize_node | `<cli> figma node resize` | `figma.resize-node` / RESIZE_NODE | T4 |
| figma_delete_node | `<cli> figma node delete` | `figma.delete-node` / DELETE_NODE_BY_ID | T4 |
| figma_submit_job | `<cli> jobs submit --file ...` | `jobs.submit`；受同一写入闸门限制 | T3/T4 |
| figma_wait_result | `<cli> jobs wait <id>` | `jobs.get` + `jobs.subscribe`；移除结果 HTTP 轮询 | T3 |
| figma_prefab_import_start | `<cli> prefab-to-figma import` | `prefab-to-figma.import.start`；迁出 legacyJson | T5 |
| figma_prefab_import_status | `<cli> prefab-to-figma status <id>` | `prefab-to-figma.import.get` + 订阅 | T5 |

参数保全项：sessionId/fileKey 目标、nodeId/pageId、timeout、聚类 options、libraryNodeIds、job/assetPaths/requestId、wait、结果摘要与调试大结果策略，以及 Prefab 的 canvas、componentMode、嵌套 Prefab 参数。不能只迁移工具名。当前组件查询有默认 libraryNodeIds，迁移阶段先保持语义，再独立评估是否更改。

## Node HTTP 路由逐项映射

来源：`src/httpServer.ts` 的顶层 handler、handleLogGet、handleGet、handlePost。花括号是动态 ID；同一行的动作集合代表源码中的每个分支。

| 方法与旧路径 | 目标入口 / 处理方式 | 任务 |
| --- | --- | --- |
| GET/POST/DELETE 配置的 mcpPath（默认 /mcp） | 删除 MCP 协议处理；只允许明确升级诊断，不执行旧工具 | T6 |
| GET /health | `<cli> status` / `relay.status`，移除业务 HTTP 健康探测 | T2/T6 |
| GET /mcp/config/status | 删除 MCP 配置状态能力；CLI 诊断展示 WS 配置 | T6 |
| GET /mcp/clients | 删除 MCP host 配置枚举；AI runner 信息由 ai.status 承接 | T6 |
| POST /mcp/config/write | 删除 MCP 配置写入，CLI 不修改用户全局 AI 配置 | T6 |
| POST /mcp/config/delete | 删除在线 MCP 配置删除入口；迁移工具须独立授权修改外部配置 | T6 |
| POST /mcp/config/open | 删除 MCP 配置打开入口 | T6 |
| GET /ai-runner/providers | `<cli> ai providers` / `ai.providers.list` | T4 |
| GET /ai-runner/status | `<cli> ai status` / `ai.status` | T4 |
| POST /ai-runner/config | `<cli> ai configure` / `ai.configure` | T4 |
| POST /ai-runner/open-terminal | `<cli> ai open-terminal` / `ai.terminal.open` | T4 |
| POST /ai-runner/run-cleanup | 已弃用别名，删除；收敛到正式 cleanup 启动入口 | T4/T6 |
| POST /ai-runner/run-prompt | `<cli> ai start` / `ai.run.start` | T4 |
| GET /ai-runner/runs/{runId} | `<cli> ai get <id>` / `ai.run.get`，进度改订阅 | T3/T4 |
| POST /ai-runner/runs/{runId}/followup | `<cli> ai followup` / `ai.run.followup` | T4 |
| POST /ai-runner/runs/{runId}/stop | `<cli> ai stop` / `ai.run.stop` | T3/T4 |
| POST /cleanup/runs | `<cli> cleanup start` / `cleanup.run.start` | T4 |
| GET /cleanup/runs/{runId} | `<cli> cleanup get <id>` / `cleanup.run.get`，进度改订阅 | T3/T4 |
| POST /cleanup/runs/{runId}/approve | `<cli> cleanup approve` / `cleanup.run.approve` | T4 |
| POST /cleanup/runs/{runId}/cancel | `<cli> cleanup cancel` / `cleanup.run.cancel` | T3/T4 |
| POST /cleanup/runs/{runId}/confirm-component-sets | `<cli> cleanup confirm-component-sets` / `cleanup.run.confirm-component-sets` | T4 |
| GET /unity-projects | `<cli> unity projects list` / `unity.projects.list` | T5 |
| GET /unity-projects/{projectId}/gateway | `<cli> unity status --project ...` / `unity.gateway.get` | T5 |
| POST /unity-projects/add | `<cli> unity projects add` / `unity.projects.add` | T5 |
| POST /unity-projects/select | `<cli> unity projects select` / `unity.projects.select` | T5 |
| POST /unity-projects/remove | `<cli> unity projects remove` / `unity.projects.remove` | T5 |
| POST /unity-projects/install-bridge | `<cli> unity install-bridge` / `unity.bridge.install` | T5 |
| POST /jobs | `<cli> jobs submit` / `jobs.submit` | T3/T4 |
| GET /jobs/{requestId}/result | `<cli> jobs get/wait` / `jobs.get` + `jobs.subscribe` | T3 |
| GET /figma/pending | 删除轮询；执行端 WS 任务推送与接收确认 | T4 |
| POST /figma/result | 执行端 WS result 帧，校验实际执行会话 | T4 |
| POST /figma/query-selection | figma selection / `figma.query-selection` | T2/T4 |
| POST /figma/query-plugin-status | figma status / `figma.query-plugin-status` | T2/T4 |
| POST /figma/query-node-children | figma children / `figma.query-node-children` | T4 |
| POST /figma/query-components | figma components / `figma.query-components` | T4 |
| POST /figma/resize-node | figma node resize / `figma.resize-node` | T4 |
| POST /figma/delete-node | figma node delete / `figma.delete-node` | T4 |
| POST /open-plugin-folder | `<cli> plugin open-folder` / `plugin.folder.open` | T5 |
| POST /crop-jiugong | `<cli> images crop-jiugong` / `images.crop-jiugong` | T5 |
| POST /prefab-to-figma/import | prefab-to-figma import / `prefab-to-figma.import.start` | T5 |
| GET /prefab-to-figma/import/{taskId}/status | prefab-to-figma status / `prefab-to-figma.import.get` | T5 |
| POST /prefab-to-figma/resolve-dropped | `<cli> prefab-to-figma resolve-dropped` / `prefab-to-figma.resolve-dropped` | T5 |
| POST /figma-to-prefab/import | `<cli> figma-to-prefab import` / `figma-to-prefab.import.start` | T5 |
| GET /figma-to-prefab/import/{taskId}/status | figma-to-prefab status / `figma-to-prefab.import.get` | T5 |
| POST /psd-to-figma/import | `<cli> psd import` / `psd.import.start` | T5 |
| GET /psd-to-figma/import/{taskId}/status | `<cli> psd status <id>` / `psd.import.get` | T5 |
| POST /psd-to-figma/import/{taskId}/adopt-baseline | `<cli> psd adopt-baseline` / `psd.import.adopt-baseline` | T5 |
| POST /psd-to-figma/import/{taskId}/apply | `<cli> psd apply` / `psd.import.apply` | T5 |
| GET /logs | `<cli> logs query` / `logs.query` | T4/T5 |
| GET /log | 删除旧别名；同 logs.query | T6 |
| GET /logs/operations/{operationId} | `<cli> logs operation <id>` / `logs.query` 带 operationId | T4/T5 |
| POST /logs/events | 受角色授权的 WS 日志批次 / `logs.ingest` | T4/T5 |
| GET /logs/download | 日志收集和过滤先走 `logs.export`，只将生成文件的受控下载保留为 HTTP | T5 |
| GET /assets/{requestId}/{assetId} | 保留受控文件下载；资源登记、凭据和元数据通过 WS | T5 |
| OPTIONS 与 WebSocket upgrade | 按最终保留的下载/升级入口最小化；不是业务命令 | T6 |

注意 `/logs/download` 当前会触发 Unity 日志采集和查询，不能仅凭下载文件名就原样保留为 HTTP 业务入口。资源端必须保留路径、requestId/assetId 与授权边界，不能替换成任意本机路径下载。

## Figma、Unity 和 Python 调用链

| 源码范围 | 当前链路与迁移要求 | 任务 |
| --- | --- | --- |
| src/index.ts、src/websocketGateway.ts、src/runtimeRelay.ts | 已有 Figma WS 与 ai.run/cleanup.run 控制 action；统一新客户端角色与执行端身份，去掉 polling 及 legacy 回落。CLI 断开不取消任务，结果未知写操作不重放 | T2/T3/T4 |
| ui.html、code/ 源片段 | UI 混合使用 WS 和 HTTP，包括健康、项目、AI、导入和配置入口；逐项改 WS，插件任务结果不再 HTTP 兜底。code.js 必须由 scripts/build.py 生成 | T4/T5 |
| unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs | HttpListener 分发 /health、/ping、/selected-folder、/export-selected、/pull-latest、/resolve-image、/import-selected-images、/sync-selected-text-style、/sync-prefab-hierarchy、/prefab-import-canvas、/figma-to-prefab-import、/logs；全部业务迁移到 unity.* WS action，实际执行继续在 Editor 主线程 | T5 |
| src/pythonWorker.ts、server/figma_mcp_relay_server.py | LegacyRelay 经本机 32131 HTTP 代理 Python；重复 /health、/ping、/status、MCP 配置、任务轮询、Figma 查询/写入、Prefab 导入、crop/open-folder 等。算法保留，业务调用改 WS 或受控进程协议，不能只删外层 Node HTTP | T5/T6 |
| server/figma_mcp_companion.py | 同时支持 HTTP MCP 与 stdio MCP，并转发 /jobs 与轮询结果；移除两类 MCP 执行路径 | T6 |
| client/figma_mcp_client.py | HTTP JSON-RPC 与 stdio 子进程客户端，skill 共用入口；调用项目 CLI，保持 JSON stdout 和 stderr 日志 | T4/T5 |
| server/crop_jiugong.py | 图像算法保留，入口通过 images.crop-jiugong 任务；产物走受控下载 | T5 |

Unity 建议 CLI 子命令分别为 `unity status`、`unity selected-folder`、`unity export-selected`、`unity pull-latest`、`unity resolve-image`、`unity import-selected-images`、`unity sync-selected-text-style`、`unity sync-prefab-hierarchy`、`unity prefab-import-canvas`、`unity figma-to-prefab-import`、`logs query --source unity`。下载图像可以 HTTP，查找、导入、同步命令不可以。

## Skills、提示词和脚本调用方

| 调用方 | 必须保留或替换的能力 | 任务 |
| --- | --- | --- |
| src/localAiRunner.ts；prompts/cleanup.md、component-variants.md | AI provider/runner 执行继续保留；工具提示与注入配置改项目 CLI，整理阶段、满意确认、ComponentSet 写闸门照常执行 | T4 |
| ai/skills/figma-hierarchy-cleanup-mcp/ | 客户端依赖 client/figma_mcp_client.py；覆盖 analyze/apply、wrap、screenshot、reorder、move、positions、union、selection、clone、组件与变体命令。保留计划/验证算法，替换传输、目录引用和执行指令 | T4/T6 |
| ai/skills/prefab-to-figma/；prompts/prefab-to-figma.md | prefab_to_figma_mcp_client.py 调共用 MCP 客户端；保留 YAML、RectTransform、资源处理、write-plan、readback 与 golden tests | T5 |
| ai/skills/figma-to-prefab/；prompts/sync-to-unity.md、unity.md | figma_to_prefab_mcp_client.py、run_full_import.py、run_import_benchmark.py、phase_evidence 等；传输和 Unity HTTP 调用都迁移，保留图像处理、spec、导入和校验规则 | T5 |
| ai/skills/psd-layer-to-figma/；prompts/psd-import.md | submit_psd_import_job.py、upload_parallel.py、refresh_component_cache.py、grid_component_creator.py、psd_import_phase_evidence.py；保留 PSD 导出、九宫格审查、manifest 和增量状态语义，提交与状态改 CLI/WS | T5 |
| 各 ai/skills/*/SKILL.md、references/、agents/openai.yaml | 删除实际使用 MCP/HTTP 的指令与旧路径依赖；不让 AI 客户端管理 Relay 生命周期 | T4/T5/T6 |

## 启动、配置和发布

当前链路：根目录 MCP 命名 bat → `scripts/start_mcp_oneclick.ps1` → `start_mcp_hidden.ps1` 或 `start_mcp_companion.ps1` → Node `dist/index.js` 或旧 Python 模式。`package.json` 的 dev/start/oneclick、doctor/smoke、setup:codex/setup:claude 也指向旧入口。迁移时保留独立 Relay 启停工具，业务 CLI 不能自动启动服务。

T6 覆盖 `scripts/setup_mcp_config.ps1`、`install_mcp_autostart.ps1`、`doctor_mcp.ps1`、`smoke_mcp.ps1`、全部 start_mcp 包装、根目录中文启动/停止/自动启动 bat，以及仓库 `.codex/config.toml` 的实际配置内容检查。不要因目录名推断该配置一定包含 MCP；修改外部全局配置不属于本次默认权限。

`scripts/package_release.ps1` 当前包含版本提升、同步、完整构建、Python 脚本进程识别、/health 验证与打包后旧启动脚本调用；T6 必须改为新握手/CLI smoke 和新入口。此次盘点没有执行该脚本、版本提升、服务启停或发布。`scripts/build.py` 的发布版本同步顺序、Unity 精确版本匹配、AGENT.md、README.md、依赖锁文件及 MCP SDK 移除一起在 T6 收口。

## 完成证据边界

- T1：此表证明已查阅源码并建立映射；不是新接口全部可用的证明。
- T2：只读查询需要握手、目标歧义、拒绝日志、JSON/退出码和 WS 执行端结果的定向测试；真实 Figma 查询应单独记录。
- T3-T5：去重、取消、断线恢复、未知结果、写入门禁、导入与文件权限仍需实现和回归。
- T6-T7：清除旧执行链后再做完整构建、Python 测试、Unity 编译与真实跨端验收；不能以静态符号消失代替实际运行证据。
