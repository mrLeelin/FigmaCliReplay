# FigmaMcpRelay Agent Guide

## 版本与发布

- `package.json` 的 `version` 是唯一发布版本源，必须符合 SemVer；不得手工让 UI、Relay 或 Unity Bridge 使用不同的发布版本。
- 发布版本与开发构建号严格分离：`.build_version` 只用于生成 `code.js` 的递增构建标识和 Figma 开发缓存诊断，不能用于兼容性判断、Bridge 校验或发布命名。
- `python scripts/build.py --sync-release-version` 必须把 `package.json.version` 同步到以下带标记的目标：
  - `ui.html` 的发布版本徽标；
  - `unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs` 的 Bridge 版本；
  - `src/config.ts` 的 `SERVER_VERSION`，供 WebSocket 握手响应使用。
- 同步命令必须通过独立日志类记录同一 `operationId` 的 `started`、逐目标 `progress`、`succeeded` 或 `failed`；失败日志需包含错误类型和经长度限制的错误摘要。
- 发布打包必须先运行版本同步，再编译 TypeScript；否则 `dist/` 会保留旧 `SERVER_VERSION`。禁止在编译后才修改 TypeScript 源版本。
- 发布打包默认只提升 patch 版本；minor 用于保持兼容的新能力，major 仅用于不兼容的协议、请求/响应或数据语义变化。是否发布、打 tag、推送由用户明确指示。
- 每次版本同步或发布前后至少验证：
  - `ui.html`、Unity Bridge、`src/config.ts` 与 `package.json.version` 完全相同；
  - 编译后的 `dist/config.js` 与发布版本相同；
  - WebSocket `relay.ready` 响应中 `serverVersion` 与发布版本相同；
  - Unity Bridge 连接继续采用精确版本匹配，不接受仅主版本或前缀匹配。
- 如果完整发布流程受缺失构建脚本、环境或外部服务阻断，必须明确记录为发布阻塞项；不得宣称已经完成可分发发布。
- `code.js` 是由 `code/` 源片段生成的构建产物。修改插件逻辑必须先改源片段、再运行 `python scripts/build.py`；禁止直接修改 `code.js` 作为最终实现。
- 修改发布版本后，必须运行 `npx tsc -p tsconfig.json` 重新编译 `dist/` 并重启当前 Relay，再通过 WebSocket `relay.ready` 响应核对运行中 `serverVersion`；只改源码或只通过静态测试不视为版本已生效。
- `npm run build` 是发布门禁，`build:ui` 引用的脚本必须存在且构建成功。脚本缺失、构建失败或被跳过时必须阻断发布，禁止以手工复制 `dist/`、跳过 UI 构建或仅运行类型检查替代完整构建。
- 未经用户明确指示，不得执行 `npm version`、创建 tag、Git 提交或推送；版本同步与本地编译不等于发布。
- 产品发布版本、WebSocket 消息协议版本以及 PSD/清理计划等数据 schema 版本必须分别管理。仅在不兼容的请求、响应或数据语义变化时升级 schema，并提供迁移、明确拒绝或可查询的兼容性日志。

## 项目目标

本仓库用于连接 AI CLI、Node.js Relay、Figma 插件以及 Unity Editor Bridge。
修改前先确认真实调用链，避免只修复某一端而破坏协议兼容性。

## Relay 生命周期归属

- `127.0.0.1:32130` 是外部管理的 Figma Relay 端点；AI 整理、提示词和本地 AI CLI 只能作为客户端调用它，不拥有该服务的生命周期。
- Figma 插件窗口启动的 AI 任务以 Relay 已接受任务作为服务可用性的权威预检；不得额外运行 `curl`、`Invoke-WebRequest` 或直接 `/health` 探测，也不得臆测或探测 `localhost:3000` 等替代端口。
- AI 任务不得启动、重启、停止、终止或重配 Relay，不得绑定或监听 `32130`、`32131`，也不得运行 `start_relay.ps1`、`启动Relay.bat`、`npm run dev` 或等价的服务管理命令。
- 出现 `WinError 10055`、`ENOBUFS`、`WinError 10048`、`EADDRINUSE`、超时或连接错误时，AI 必须通过统一日志记录原始错误、当前 `operationId` 和已尝试次数，并标明“本机 TCP 资源压力导致客户端无法建立连接”；不得据此声称 Relay 已停止或要求启动 Relay。然后结束当前轮次交由用户处理；不得重启服务、循环探测端口或增加连接压力。

## AI 整理阶段安全

- Figma 插件“开始 AI 整理对话”必须由 Relay 的会话级写入闸门约束，提示词不是唯一安全边界。
- 固定阶段为：首轮只读分析 → 明确确认后仅层级整理 → 层级验证后等待满意 → 明确满意后仅 ComponentSet/变体。任何跨阶段写入必须由 Relay 拒绝并记录 `runId`、`sessionId`、阶段和被拒绝的 `jobType`。
- 计划确认不得授权 ComponentSet/变体；满意确认不得重新授权任意层级或删除操作。调整反馈必须回到只读分析并生成新计划。
- AI 会话启动必须携带本次 Figma 层级快照、所选 provider/runner 和幂等 `clientRequestId`；同一插件会话不得并发启动两个整理对话。

## 主要目录

- `src/`：Node.js / TypeScript Relay 与 WebSocket 服务。
- `code/`：Figma 插件代码片段；修改后需要重新生成根目录 `code.js`。
- `ui.html`：Figma 插件 UI。
- `server/`、`client/`：Python 服务与客户端。
- `unity/Assets/Editor/FigmaBridge/`：Unity Editor Bridge，命名空间为 `MagicWarrior.Editor.FigmaBridge`。
- `tests/`：Node.js 与 Python 测试。

## 工作约束

- 直接在当前检出目录中修改；除非用户明确要求，否则不要创建 worktree。
- 工作区可能包含用户未提交的修改。保留所有无关改动，只编辑和暂存当前任务涉及的文件。
- 不执行破坏性 Git 操作，不擅自提交、推送、清理或覆盖文件。
- 新增或修改中文、非 ASCII 文本后，必须重新读取文件并检查乱码、`???`、替换字符和编码漂移。
- 修改协议、端口、消息结构或跨语言接口时，必须同步检查 Node.js、Figma、Python 和 Unity 的对应实现。

## 日志规范

- 所有可执行操作都必须产生日志，包括开始、关键步骤、成功、失败和取消。
- 日志输出必须封装在独立日志类中；业务代码统一引用日志类，不得散落新增 `console.*`、`Debug.*` 或直接写标准输出的日志语句。
- 一次完整操作应复用同一个 `operationId`，便于跨 Node.js、Figma、Python 和 Unity 查询调用链。
- 日志至少包含时间、级别、模块、操作、阶段、结果和错误信息；异常日志保留可定位的上下文。
- 密钥、令牌、用户隐私、完整二进制内容和超大消息体不得写入日志。
- Python 协议进程必须保持标准输出干净；诊断日志写入标准错误并使用统一格式。
- Unity Bridge 使用项目统一日志入口，不直接新增零散的 `UnityEngine.Debug` 调用。

### 详细日志门禁

- **功能开发即日志开发**：新增或改造任一功能时，必须在实现前列出可追踪的日志点，并随功能代码一并实现；没有覆盖主流程、关键决策、外部依赖、数据校验和失败分支的详细日志，不得视为功能完成。
- 新功能的日志必须让排障人员仅凭同一个 `operationId` 还原“谁触发、处理了什么目标、走到哪一步、输入/输出摘要、耗时、为何成功或失败”；必要时记录安全的计数、ID、哈希、路径摘要和配置选择，禁止记录敏感原文或大载荷。
- 功能验收与回归测试必须至少验证一条成功链路和一条失败/拒绝链路的日志可查询性；若无法自动验证，最终说明必须明确列出缺失的日志验证及原因。
- 每个操作必须按状态机记录：`started` → 一个或多个 `progress` → `succeeded`、`failed` 或 `cancelled`。禁止只有最终结果日志，也禁止静默提前返回。
- 所有跳过、降级、预检拦截、幂等命中、超时、回滚和取消分支都必须记录原因、影响范围和下一步；例如“组件库不可用，已降级为 PNG 图层”。
- 跨进程、跨服务或跨端调用必须携带并记录关联字段：`operationId`、`requestId`、`jobId/runId`、`sessionId`、目标文件/节点标识（可公开部分）以及来源模块。不得只依赖自然语言描述定位调用链。
- 外部调用、网络请求、Figma 插件任务、Unity Bridge 请求和文件转换必须记录：目标类型、开始时间、结束状态、耗时、HTTP/协议状态、重试次数、最大重试次数和退避原因。失败时记录规范化错误码（例如 `winerror`）与可读错误摘要。
- 循环或批处理任务至少记录总数、当前项、已成功数、失败数、跳过数；不得为每个大二进制载荷写入日志。资源日志只记录安全的 ID、大小、哈希或文件名摘要。
- 校验和提交门禁必须记录每个关键计数及判定，例如缺失节点、冲突、文字裁切风险、切片问题、验证截图/产物路径，以及最终是否允许 apply。不能只记录“校验通过”。
- 重试必须逐次记录 `attempt`、`maxAttempts`、可重试判定、等待时长和原始错误类别；最终失败日志必须汇总已尝试次数，便于判断是瞬态故障还是逻辑错误。
- 回滚/补偿操作必须使用原操作的 `operationId` 或显式 `parentOperationId`，并记录回滚目标、已恢复数量、失败数量与残留风险。
- 日志字段保持结构化和可查询。新增日志时优先传递对象数据给统一日志类；错误对象至少保留 `name`、`message`、受限长度的 `stack` 和已脱敏上下文。
- 日志本身写入失败不得掩盖业务异常：使用统一日志类的安全降级入口，并继续返回原始业务失败。

## 编码规范

- TypeScript 保持现有 ESM 风格，内部导入路径使用编译后可解析的 `.js` 后缀。
- 优先复用现有类型、协议模型和工具类，不重复创建同义实现。
- Unity 代码只放在合适的 `Editor/` 范围内，并保留现有命名空间与 `.meta` 文件配对关系。
- Figma 插件代码修改应保持 `code/` 源片段与生成的 `code.js` 一致。

## 构建与验证

按改动范围执行最小但足以证明结果的验证：

```powershell
# 重新生成 Figma 插件 code.js
python scripts/build.py

# TypeScript 编译检查
npx tsc -p tsconfig.json

# Node.js 定向测试
node --test tests/<target>.test.mjs

# Python 定向测试
python -m unittest <test_module>
```

- 修改 `code/` 后必须执行 `python scripts/build.py`，并检查生成差异。
- 修改 TypeScript 后必须执行编译检查和相关定向测试。
- 修改 Python 后必须执行对应单元测试，并确认协议标准输出未被日志污染。
- 修改 Unity C# 后必须进行 Unity 编译检查；编译通过不等于运行时功能已验证，两者应分别报告。
- 如果全量测试存在与本次修改无关的既有失败，应明确列出，不得把它描述为本次回归。

## 完成标准

- 需求涉及的调用路径已经覆盖，关键步骤均可通过统一日志查询。
- 相关代码已完成最小范围验证，且没有新增已知错误。
- 已检查实际差异与 Git 状态，没有混入无关文件。
- 最终说明列出修改文件、验证结果以及尚未验证的运行时风险。
