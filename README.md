# Figma Relay

项目 CLI + WebSocket 连接 AI、Figma 插件与 Unity Editor。MCP 服务、SDK 和配置写入已移除，旧业务 HTTP 返回升级提示；HTTP 仅提供登记资源下载。

## 分发给其他人

Windows ZIP 分发包的首次安装和使用步骤见 [分发说明](docs/distribution.md)，下载入口为 [GitHub 最新发布](https://github.com/mrLeelin/FigmaCliReplay/releases/latest)。执行 `npm run package:release -- -NoLaunch` 会提升 patch 版本、同步各端版本、完整构建，并生成 ZIP、哈希和签名 `latest.json`。默认更新源为公开仓库 `mrLeelin/FigmaCliReplay`，ZIP 下载地址绑定发布 tag。打包不提交、推送 Git 或上传文件。

接收者先安装 Node.js 18+ 和 Python 3.10+，再运行包内 `首次安装.bat`，安装到固定目录 `%LOCALAPPDATA%\FigmaRelay`。从固定目录的 `start_relay.bat` 启动 Relay，在 Figma 导入固定的 `plugin\manifest.json`。以后在“设置 → 版本与更新”检查和安装新版本，完成后重新打开插件，无需换目录重新导入。首次安装和更新需要联网准备依赖；个人配置保存在固定目录的 `data`，与各版本独立的 `.venv`、程序文件分开。连接异常时运行固定目录的 `更新修复.bat`。

发布私钥位于源码仓库 `.local/release-signing/private.pem`，必须备份并跨版本复用，永不随 ZIP 分发。没有配置发布地址的包只支持本地安装验收，界面会明确显示更新源未配置，不会把离线状态当作“已是最新版”。

测试通过并将对应代码提交推送后，执行 `npm run publish:github -- -Version "实际版本" -TargetCommit "实际的40位提交SHA"` 发布已打好的包。脚本先校验本地文件，再创建 GitHub 草稿、上传全部资产并检查，最后发布为 Latest；失败保留草稿，不覆盖既有 Release。可加 `-DryRun` 仅查看计划。发布命令不替你提交或推送代码。

## 从源码安装与启动

需要 Node.js 18+、Python；Unity 真值采集还需要 Unity CLI。

```powershell
npm ci
python -m pip install -r server/requirements.txt
npm run build
npm link --ignore-scripts --offline
.\启动Relay.bat
npm run doctor
figma-relay sessions
figma-relay --help
```

启动是独立操作，业务 CLI 不自动管理服务。后台日志位于 `.logs`。Figma 开发插件导入 `manifest.json`；Unity Bridge 与其 `.meta` 一起安装到目标项目 `Assets/Editor`，工程里已存在的 `.meta` 原样保留，模板 GUID 与工程内其它资产冲突时自动改用新 GUID。

CLI 默认连接 `ws://127.0.0.1:32130/relay`，插件连接 `/figma`；Unity Bridge **主动出站**连中继的 `/unity`（一条长连接，断线退避重连）。Bridge 不再监听本地端口、不写发现文件、也不做端口级联——因此**运行中的 Relay 必须是支持 `/unity` 的版本**（升级后需重启 Relay），否则 Unity 侧只会记录"未连接"而不会回退到旧路径。Unity 出站端口由 EditorPrefs `FigmaBridge_RelayPort` 决定（默认 32130）。CLI 读取 `FIGMA_RELAY_TOKEN` 或 `.local/admin-token.txt`；需要多轮请求时可使用长驻模式 `node dist/cli.js serve`（一个进程 + 一条连接）。各端发布版本必须一致。

## 控制与验证

```powershell
node dist/cli.js control --job-type relay.status --payload '{}'
node dist/cli.js control --job-type logs.query --payload '{"query":{"source":"relay","limit":100}}'
```

AI 和新调用者可以直接从 CLI 查找操作和参数，无需读取源码：

```powershell
figma-relay commands --search unity
figma-relay commands --kind figma --json
figma-relay describe FIGMA_INSPECT_NODES --json
figma-relay describe unity.projects.list
figma-relay figma-children --help
```

帮助和操作目录可离线查询。`describe` 返回输入 JSON Schema、调用示例、约束和实现来源；业务操作按实际运行状态执行。详见 [CLI 文档](docs/cli.md)。结果在 stdout，诊断在 stderr。写入结果未知时核对原任务，不重复提交；重启不恢复内存任务。资源登记必须符合允许目录规则。

让其他项目中的 AI 发现该工具，打开插件「设置 → AI Skill」，检查状态后点击对应客户端的「写入 Skill」或「更新 Skill」；写入后会再次核对本机文件。也可执行 `npm run ai:install-skill`。它为当前电脑用户的 Codex 和 Claude Code 安装 [figma-relay Skill](ai/skills/figma-relay/SKILL.md)，保留全局配置及本地改过的 Skill 文件。Skill 的描述供 AI 按任务选择；也可在 Codex 显式使用 `$figma-relay`，在 Claude Code 使用 `/figma-relay`。项目内另有 `AGENTS.md` / `CLAUDE.md` 入口。安装不证明 AI 已自动选中；未在技能列表出现时重新打开会话。

出站客户端的真实 C# 端到端测试默认跳过，需要用已编译宿主显式开启：

```powershell
dotnet build tests/fixtures/unity-bridge-client-host\BridgeClientHost.csproj
$env:UNITY_BRIDGE_CLIENT_HOST = "$PWD\tests\fixtures\unity-bridge-client-host\bin\Debug\net8.0\BridgeClientHost.dll"
node --test tests/unity-outbound-client.test.mjs
```

同一份出站测试也能跑在 **Unity 自带的 Mono** 上（对应用 Unity 的真实运行时）：把 `BridgeWebSocketTransport.cs`/`BridgeCommand.cs` 用 Unity 的 Roslyn 针对 `MonoBleedingEdge\lib\mono\4.5` 编译成宿主 exe，然后设 `UNITY_BRIDGE_CLIENT_RUNNER=mono`、`UNITY_BRIDGE_CLIENT_HOST=<宿主 exe>`、`UNITY_MONO_EXE=<mono.exe>` 再跑 `tests/unity-outbound-client.test.mjs`。

AI 整理保留只读分析、确认整理、验证、满意确认、ComponentSet 的分阶段写入闸门。失败保留回滚及恢复产物。关闭插件后会话有短暂重连宽限期。

`npm run build` 同步版本并生成插件；构建号不参与兼容性判断。打包是显式操作，不停止现有服务、不覆盖已有发布目录，也不修改全局 AI 配置。

## 截图拆成 Figma 资源

PNG / 截图拆层与已有结果的过细拆分修正使用 [Image Layer To Figma Skill](ai/skills/image-layer-to-figma/SKILL.md)。默认以可独立使用的资源为单位：完整礼盒、完整卡牌插画、按钮底图和独立价格等。该 Skill 负责资源规划与验收，外部拆层服务按需调用；离线合成脚本可复用已有图层生成完整透明资源，无需重新拆图。

默认交付还包含业务嵌套层级：区域 → 功能组 → 独立资源。导入成功不是拆图任务的最终完成状态；使用 [资源层级流程](ai/skills/image-layer-to-figma/references/resource-hierarchy.md) 和 `ai/skills/image-layer-to-figma/scripts/structure_resources.py` 校验完整节点归属，再执行原生整理事务，验证节点守恒、位置和 RGBA 截图一致。明确要求原始平铺图层时才跳过；该阶段不会自动修改已有 Unity Prefab。

[DXX Skill 与 Python 客户端](ai/skills/dxx-image/SKILL.md) 已随项目提供。在插件「设置 → DXX 图片拆层」输入 API Key，点击「保存」；关闭再打开插件会从本机配置读取并明文显示。若此前仅使用环境变量，点击保存也会将当前 Key 写入本机配置。「测试连接」仅进行鉴权与拆层服务可用性检查，不上传图片或创建任务，也不保存尚未提交的输入。设置页和 Python 共用 `.local/dxx-config.json`，项目保存值优先于兼容的 `GORILLA_API_KEY` / `GORILLA_API_BASE` 环境变量。`.local` 已被 Git 忽略，普通状态查询与日志不返回 Key。

也可在项目根目录验证同一配置：

```powershell
python -X utf8 ai/skills/dxx-image/scripts/dxx_image.py Test
```

## 导出 Unity Prefab

在 Figma 选择一个根节点，在 Unity Project 中选中输出文件夹，然后打开插件「导出 → 导出 Prefab」，点击「读取 Unity 选中目录」后导出。输出目录可以已有其他内容，也可以是 `Assets` 根目录。

```text
选中的目录/
└─ 节点名/
   ├─ Prefab/节点名.prefab
   └─ Texture/
```

名称使用 `｜` 或 `|` 前的标识，例如 `[cat_header｜顶部白猫｜原图插画]` 导出为 `cat_header`；只有实际有子节点的 Unity 层级节点才保留 `[cat_header]` 形式。目录、Prefab 和 PNG 文件名不带方括号，文字正文保持原样。文件名中的非法字符会替换。已有同名目录或 `.meta` 时直接报冲突，不覆盖。此入口不生成 UiAtlas；文字、九宫图和已有公共资源引用沿用现有 Prefab 生成器规则。结果会报告实际 Prefab、Texture 和验证路径，进度经 Relay 推送。

Unity Bridge 需要支持 `supportsPrefabExportWithoutAtlas`；旧 Bridge 会在写入前收到更新提示，可在插件设置里更新。「同步 Unity」仅保留「图片导出」和「字体同步」；Prefab 导出统一从「导出 → 导出 Prefab」进入。

打开插件时会读取本机保存的上次 Unity 工程并自动连接。恢复和检查期间显示「连接中」，通过工程路径与 Bridge 版本校验后显示「已连接」；恢复失败才显示「未连接」及原因。手动断开后不会自行重连，重新打开插件或点击「自动连接」可再次尝试。

## 导出分层 PSD

在 Figma 选择节点，打开插件「导出 → 导出 PSD」。默认 1x 保持原始像素尺寸；2x、3x 同步放大画布、图层位置和位图一次，用于更高分辨率输出。阴影、描边超出节点边界时，画布会扩展以保留完整内容。

文件写入本项目 `.tmp/exports/`，同时生成图层索引。保留中文名称、层序、分组、隐藏图层和透明度；文字当前输出为像素层。蒙版、容器裁切、布尔运算及复杂组效果保留完整合成图，原始子层放在对应组内隐藏的「源图层」中，避免重复叠加。需要分别编辑源子层时，先隐藏合成图，再显示「源图层」；这些效果不会转换成 Photoshop 原生效果。

任何必需图片缺失、分片不完整或 PSD 回读验证失败都会报错，不交付部分成功文件。结果会显示实际图片数、缺失数及合成说明。当前边界为 5000 个清单节点（含虚拟根）、128 层嵌套、PSD 单边最多 30000 像素；超限需拆分选区或降低倍率。重新构建后须重新运行 Figma 开发插件以加载新版本。

迁移记录见 [实施计划](docs/superpowers/plans/2026-09-18-cli-websocket-migration.md)。真实 Figma/Unity 资源与视觉验收属于 T7，构建通过不代表运行验收完成。
