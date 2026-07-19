# FigmaMcpRelay Agent Guide

## 项目目标

本仓库用于连接 AI/MCP、Node.js Relay、Figma 插件以及 Unity Editor Bridge。
修改前先确认真实调用链，避免只修复某一端而破坏协议兼容性。

## 主要目录

- `src/`：Node.js / TypeScript Relay 与 MCP 服务。
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
