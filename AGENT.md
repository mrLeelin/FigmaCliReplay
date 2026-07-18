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
