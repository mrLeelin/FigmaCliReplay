# Figma Relay

项目 CLI + WebSocket 连接 AI、Figma 插件与 Unity Editor。MCP 服务、SDK 和配置写入已移除，旧业务 HTTP 返回升级提示；HTTP 仅提供登记资源下载。

## 安装与启动

需要 Node.js 18+、Python；Unity 真值采集还需要 Unity CLI。

```powershell
npm ci
npm run build
.\启动Relay.bat
npm run doctor
node dist/cli.js sessions
node dist/cli.js --help
```

启动是独立操作，业务 CLI 不自动管理服务。后台日志位于 `.logs`。Figma 开发插件导入 `manifest.json`；Unity Bridge 与其 `.meta` 一起安装到目标项目 `Assets/Editor`，工程里已存在的 `.meta` 原样保留，模板 GUID 与工程内其它资产冲突时自动改用新 GUID。

CLI 默认连接 `ws://127.0.0.1:32130/relay`，插件连接 `/figma`；Unity Bridge **主动出站**连中继的 `/unity`（一条长连接，断线退避重连）。Bridge 不再监听本地端口、不写发现文件、也不做端口级联——因此**运行中的 Relay 必须是支持 `/unity` 的版本**（升级后需重启 Relay），否则 Unity 侧只会记录"未连接"而不会回退到旧路径。Unity 出站端口由 EditorPrefs `FigmaBridge_RelayPort` 决定（默认 32130）。CLI 读取 `FIGMA_RELAY_TOKEN` 或 `.local/admin-token.txt`；需要多轮请求时可使用长驻模式 `node dist/cli.js serve`（一个进程 + 一条连接）。各端发布版本必须一致。

## 控制与验证

```powershell
node dist/cli.js control --job-type relay.status --payload '{}'
node dist/cli.js control --job-type logs.query --payload '{"query":{"source":"relay","limit":100}}'
```

详见 [CLI 文档](docs/cli.md)。结果在 stdout，诊断在 stderr。写入结果未知时核对原任务，不重复提交；重启不恢复内存任务。资源登记必须符合允许目录规则。

出站客户端的真实 C# 端到端测试默认跳过，需要用已编译宿主显式开启：

```powershell
dotnet build tests/fixtures/unity-bridge-client-host\BridgeClientHost.csproj
$env:UNITY_BRIDGE_CLIENT_HOST = "$PWD\tests\fixtures\unity-bridge-client-host\bin\Debug\net8.0\BridgeClientHost.dll"
node --test tests/unity-outbound-client.test.mjs
```

同一份出站测试也能跑在 **Unity 自带的 Mono** 上（对应用 Unity 的真实运行时）：把 `BridgeWebSocketTransport.cs`/`BridgeCommand.cs` 用 Unity 的 Roslyn 针对 `MonoBleedingEdge\lib\mono\4.5` 编译成宿主 exe，然后设 `UNITY_BRIDGE_CLIENT_RUNNER=mono`、`UNITY_BRIDGE_CLIENT_HOST=<宿主 exe>`、`UNITY_MONO_EXE=<mono.exe>` 再跑 `tests/unity-outbound-client.test.mjs`。

AI 整理保留只读分析、确认整理、验证、满意确认、ComponentSet 的分阶段写入闸门。失败保留回滚及恢复产物。关闭插件后会话有短暂重连宽限期。

`npm run build` 同步版本并生成插件；构建号不参与兼容性判断。打包是显式操作，不停止现有服务、不覆盖已有发布目录，也不修改全局 AI 配置。

迁移记录见 [实施计划](docs/superpowers/plans/2026-09-18-cli-websocket-migration.md)。真实 Figma/Unity 资源与视觉验收属于 T7，构建通过不代表运行验收完成。
