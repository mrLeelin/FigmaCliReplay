---
name: prefab-to-figma
description: Static Unity UGUI Prefab to Figma import. Use when the user asks to convert, push, or import a Unity UGUI Prefab into Figma while preserving hierarchy, GameObject names, RectTransform size/position, TextMeshProUGUI text, Image/CustomImage sprites, TMP material metadata, clipping, nested Prefab instances, or nine-slice data. Do not use for Figma-to-Unity Prefab creation or Figma texture batch export.
---

# Prefab To Figma

Use this skill only for **Unity UGUI Prefab → Figma**.

## 参考文档分层加载策略

AI 第一次加载时只读快速检查清单，后续按确定性触发条件加载完整文档：

### 每次必加载（第一次）

- `references/workflow-unity-to-figma.md`
- `references/pitfalls-unity-to-figma.md`
- `references/supported-components.md`

### 按触发条件加载

| 条件 | 加载文档 |
|------|---------|
| 准备写入 Figma | `references/figma-layer-mapping.md` |
| `prefab_export_audit_report.json` 中 `blockingErrors` 非空 | `references/pitfalls-unity-to-figma.md` 对应规则 |
| `figma_write_plan_audit_report.json` 中 `prefabInstancePolicy` 失败 | `references/figma-layer-mapping.md#嵌套 PrefabInstance 组件复用规则` |
| 导出包中 `prefabInstances.length > 0` | `references/figma-layer-mapping.md#嵌套 PrefabInstance 组件复用规则` |
| Relay 错误 `Cannot call with documentAccess: dynamic-page` | `references/pitfalls-dynamic-page-findall.md` |
| `figma_write_verify_report.json` 中 `prefabInstanceNodeType` 失败，reason=`parser_did_not_provide_instance_node_mapping` | `references/pitfalls-parent-mapping-write-plan.md` |
| 非 PrefabInstance 节点但名称含 `Common_Prefab_` 前缀 | `references/pitfalls-static-image-vs-component-instance.md` |
| 导出包中九宫数量 > 0 | `references/figma-layer-mapping.md#九宫动态切片规则` |
| 导出包中任意节点 `rect.rotationZ != 0` | `references/pitfalls-unity-to-figma.md#旋转节点必须使用 relativeTransform` |
| 调试 YAML 或 parser 输出异常 | `references/unity-prefab-yaml.md` |

### AI 职责

Prefab → Figma 默认走“无大模型确定性流水线”：AI CLI / Figma 插件 UI → `figmaRelay` CLI + WebSocket (`/relay`) → runtime relay → 固化脚本 → Figma 插件写入 → 插件读回验证。AI 不参与几何、资源、warning 阻塞性或截图验收的判定。

- Relay 生命周期由外部管理。AI 不得启动、重启、停止或重配服务；插件任务以 Relay 接受为预检，独立任务使用 `node dist/cli.js sessions`。连接失败记录原始错误并停止，不探测替代端口。
- 业务命令与结果只走 WebSocket；HTTP 仅保留受控资源下载。
- Relay 生命周期由外部管理。AI 不得启动、重启、停止或重配服务；插件任务以 Relay 接受为预检，独立任务使用 `node dist/cli.js sessions`。连接失败记录原始错误并停止，不探测替代端口。
- 使用 `prefab_to_figma_cli.py` 提交固定写入计划，或通过共享 `prefab.import.start/get` 控制编排任务。
- 插件命令与结果只走 `/figma` WebSocket；CLI 通过 `/relay` 查询和订阅原任务，不回退 HTTP，不重放结果未知的写入。
- ✅ AI 只负责启动任务、读取任务状态、转述 `allPass/blockingErrors/warnings/summary/checks/artifacts`、定位失败发生在哪个固化步骤。
- ✅ 失败时修脚本、插件或验证规则，让流水线下次自动判断；不要把判断外包给 AI 经验。
- ❌ 不要手算坐标、九宫 CROP、旋转/翻转矩阵、图片 hash、节点数量。
- ❌ 不要手写 Markdown 确认报告来替代脚本报告。
- ❌ 不要逐节点人工审查 200+ 节点 JSON 来决定是否通过。
- ❌ 不要把终端输出中的坐标、颜色、文本、图片 hash 手动复制进 Figma JS 或报告。
- ❌ 不要让 LLM 直接手写官方/通用 Figma MCP `use_figma` 大段创建脚本作为标准写入路径。

## Execution Contract

- Follow repository `AGENTS.md` first.
- Before any Figma write, parser output under `.tmp/`, Unity automation, or file modification, list plan, affected files, validation method, risks, and wait for explicit user confirmation.
- Load required workflow and pitfalls before acting, then include these audit lines in the plan:
  - `已加载 workflow: references/workflow-unity-to-figma.md`
  - `已加载 pitfalls: references/pitfalls-unity-to-figma.md`
- Ask when required inputs are missing or intent is ambiguous.
- Do not create or modify Unity C# scripts, Prefabs, Scenes, Addressables, generated data, Hotfix DLL bytes, or existing art assets.

## Required Inputs

- Prefab input under the repository. Supported forms:
  - Single Prefab asset path, for example `Assets/MagicWarrior/_Resources/Prefabs/UGUI/.../Panel.prefab`.
  - Unity Project window multi-selection of `.prefab` assets when the Unity gateway exposes selected Prefab paths.
  - UTF-8 prefab list text file with one `.prefab` path per line. Blank lines and lines starting with `#` are ignored.
- Figma design file URL or file key.
- Canvas size, for example `1080x1920`; for small components, use `auto` only after user confirmation.
- Component mode is enabled by default. If the user says `不要组件`, `no component`, or `frame only`, skip component conversion.

## Required Reads

- Always read `references/workflow-unity-to-figma.md`.
- Always read `references/pitfalls-unity-to-figma.md`.
- Read `references/figma-layer-mapping.md` before any Figma write.
- Read `references/unity-prefab-yaml.md` when debugging parser output or unsupported YAML.
- Read `references/supported-components.md` when reporting downgrades.

## Environment Checks

- Run `python --version`; require Python 3.10+.
- Relay 生命周期由外部管理。AI 不得启动、重启、停止或重配服务；插件任务以 Relay 接受为预检，独立任务使用 `node dist/cli.js sessions`。连接失败记录原始错误并停止，不探测替代端口。
- Confirm the Figma plugin UI panel is open; the plugin connects to the local runtime relay by WebSocket when available and falls back to polling because Figma plugins cannot listen as a server.
- Confirm `<unity-project>/Assets/` and `<unity-project>/ProjectSettings/` exist.
- Do not auto-install dependencies.

## Parser Commands

Run only after the user approves the `.tmp` output path. 解析阶段会同时输出：

- `prefab-to-figma.json`
- `report.md`
- `prefab_export_audit_report.json`

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/prefab_to_figma.py" --project-root "<unity-project>" --prefab "Assets/MagicWarrior/_Resources/Prefabs/UGUI/Home/HomeMainView/MainView/TuiBiJiComboView.prefab" --canvas "1080x1920" --out ".tmp/prefab-to-figma/TuiBiJiComboView"
```

Batch mode:

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/prefab_to_figma.py" --project-root "<unity-project>" --batch-dir "Assets/MagicWarrior/_Resources/Prefabs/UGUI/_Common/Buttons" --canvas "auto" --out ".tmp/prefab-to-figma/batch-buttons"
```

Multiple specific Prefabs:

```powershell
# prefab-list.txt uses UTF-8, one prefab path per line; blank lines and # comments are ignored.
python "<relay-root>/ai/skills/prefab-to-figma/scripts/prefab_to_figma.py" --project-root "<unity-project>" --prefab-list ".tmp/prefab-to-figma/prefab-list.txt" --canvas "auto" --out ".tmp/prefab-to-figma/list-export"
```

Unity Project multi-selection:

- If the Unity gateway returns multiple selected Prefab paths, write them to `.tmp/prefab-to-figma/prefab-list.txt` as UTF-8, one path per line, then run the `--prefab-list` command above.
- If the gateway only returns a single `currentPrefabPath`, use normal `--prefab` mode unless the user explicitly provides additional Prefab paths.
- Before writing the list file, validate every selected item is an existing `.prefab` under the repository. If non-Prefab assets are selected, stop and ask the user to reselect or confirm excluding them.
- Deduplicate repeated paths while preserving the Unity selection order, and report the final count and paths in the plan.

Batch outputs are written under the output directory by Prefab name. If multiple Prefabs share the same file name, the exporter appends a sanitized relative-path suffix to avoid overwriting earlier outputs.

Expected outputs include `prefab-to-figma.json` and `report.md`.

## 固化脚本（确定性流水线模式）

所有生产脚本和插件读回验证都必须优先输出统一审核结构，供 Relay Server 和 UI 自动判断任务状态；AI 只转述，不重新裁决：

```json
{
  "allPass": true,
  "blockingErrors": [],
  "warnings": [],
  "summary": {},
  "checks": {},
  "artifacts": {}
}
```

流水线规则：

- `blockingErrors` 非空：必须由脚本/服务端视为阻塞，停止写入或停止交付。
- `warnings` 非空：由脚本/插件明确分类和记录；如果需要用户决策，必须产出结构化 decision 项，而不是让 AI 经验判断。
- `summary/checks/artifacts`：只用于 UI 展示和 AI 转述证据，不用于重新计算。

### `prefab_to_figma.py` — Prefab 静态导出器

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/prefab_to_figma.py" `
  --project-root "<unity-project>" `
  --prefab "Assets/MagicWarrior/_Resources/Prefabs/UGUI/Panel.prefab" `
  --canvas "1080x1920" `
  --out ".tmp/prefab-to-figma/Panel"
```

功能：静态解析 Prefab YAML → 输出 Figma 中间包、Markdown 摘要和 `prefab_export_audit_report.json`。

### `verify_export_package.py` — 导出包复核器

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/verify_export_package.py" `
  --package ".tmp/prefab-to-figma/Panel/prefab-to-figma.json" `
  --output-report ".tmp/prefab-to-figma/Panel/prefab_export_audit_report.json"
```

功能：复核 `prefab-to-figma.json` 是否包含必需字段、统计一致性、Sprite 资源解析、可计划处理的 PrefabInstance 信息。

### `build_figma_write_plan.py` — Figma 写入计划生成器

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/build_figma_write_plan.py" `
  --package ".tmp/prefab-to-figma/Panel/prefab-to-figma.json" `
  --figma-url "https://www.figma.com/design/FILE/NAME?node-id=1-2" `
  --target-node-id "1:2" `
  --component-mode component `
  --out ".tmp/prefab-to-figma/Panel"
```

功能：只生成 `figma_write_plan.json` 和 `figma_write_plan_audit_report.json`，不写 Figma。计划中列出图片上传、占位节点清理、文本描边、TMP 材质元数据、九宫源图、PrefabInstance、旋转/翻转 relativeTransform 和写入后验证项。

### `figmaRelay` — AI 标准写入控制面

将导入参数保存为 JSON（包含 clientRequestId、sessionId、fileKey 和 prefabPaths），执行：

```powershell
node dist/cli.js control --job-type prefab.import.start --session-id <sessionId> --payload-file import-request.json
node dist/cli.js control --job-type prefab.import.get --session-id <sessionId> --payload-file import-status.json
```

状态参数包含 taskId 和原 sessionId；只转述结构化结果，不重复提交未知写入。

### `prefab_to_figma_cli.py` — CLI 命令行入口

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/prefab_to_figma_cli.py" `
  --package ".tmp/prefab-to-figma/Panel/prefab-to-figma.json" `
  --write-plan ".tmp/prefab-to-figma/Panel/figma_write_plan.json" `
  --result ".tmp/prefab-to-figma/Panel/prefab_to_figma_relay_result.json"
```

- CLI 连接 `ws://127.0.0.1:32130/relay`，插件连接 `/figma` WebSocket。地址覆盖使用 CLI `--url` 或 Python `--relay-url`；HTTP 仅保留受控资源下载。

- `prefab_to_figma_relay_result.json`
- `figma_write_result.json`
- `figma_write_verify_report.json`
- `relay_screenshots/*.png`（如插件返回截图）

可先运行健康检查或 job 预览：

```powershell
python "<relay-root>/ai/skills/prefab-to-figma/scripts/prefab_to_figma_cli.py" --health
python "<relay-root>/ai/skills/prefab-to-figma/scripts/prefab_to_figma_cli.py" --dry-run `
  --package ".tmp/prefab-to-figma/Panel/prefab-to-figma.json" `
  --write-plan ".tmp/prefab-to-figma/Panel/figma_write_plan.json" `
  --job-output ".tmp/prefab-to-figma/Panel/prefab_to_figma_write_job.json"
```

## 默认执行流程（无大模型）

1. 用户在 Unity Project 选择一个或多个 `.prefab`，Figma 插件读取 Unity 网关选区。
2. AI 侧使用 `node dist/cli.js control --job-type prefab.import.start`，或 Figma 插件 UI 用当前文件 key、页面/选区上下文、组件模式调用本地后台导入。
3. 本地 Relay 后台依次执行：
   - `prefab_to_figma.py`
   - `verify_export_package.py`
   - `build_figma_write_plan.py`
   - `prefab_to_figma_cli.py`
4. 每一步只接受统一审核结构；`allPass=false` 或 `blockingErrors` 非空立即停止任务。
5. Figma 插件读回验证生成 `figma_write_verify_report.json`，Relay 汇总状态并返回 UI。
6. AI 只读取任务状态和报告路径，说明成功、失败或待用户决策项；不得补算或替代验证。

## 调试执行流程（AI 辅助）

仅当无大模型入口失败、需要定位脚本/插件 Bug，或用户明确要求命令行排查时，才使用下面分步流程。

### 阶段一：分析（脚本主导导出与计划）

1. 加载 workflow、pitfalls、supported-components。
2. 检查 Required Inputs：Prefab 输入（单 Prefab、目录批量、Unity 多选 Prefab 或 prefab-list）、Figma file URL/key、Canvas、component mode、`.tmp` 输出目录。
3. 环境检查：`python --version`、`node dist/cli.js sessions`、Figma 插件 UI 面板、`<unity-project>/Assets/` 与 `<unity-project>/ProjectSettings/`、脚本存在。
4. 用户确认 `.tmp` 输出后，调用 `prefab_to_figma.py`；Unity 多选 Prefab 时先生成 `.tmp/prefab-to-figma/prefab-list.txt`，再用 `--prefab-list`。
5. 读取 `prefab_export_audit_report.json`，只基于 `allPass/blockingErrors/warnings/summary/checks/artifacts` 审核。
6. 调用 `build_figma_write_plan.py` 生成写入计划。
7. **调试确认**：仅在 AI/命令行调试模式下输出以下摘要并等待用户一次确认：
   - 导出包审核结果（节点 / 图片 / 文本 / 九宫 / PrefabInstance / unsupported）
   - 写入计划审核结果（图片上传、TMP 元数据、描边、九宫、PrefabInstance、旋转/翻转）
   - 影响 Figma 文件与 `.tmp` 文件列表
   - 风险与需要用户决策的 warning

### 阶段二：执行（Figma 写入与读回验证）

1. 写入前必须读取 `references/figma-layer-mapping.md`。
2. 标准 AI 写入路径是 项目 CLI → WebSocket Relay → `figma-relay` Figma 插件。命令行调试也必须使用 CLI wrapper `prefab_to_figma_cli.py`；不得直接 POST `/jobs`、`/figma/pending`、`/figma/result` 或让 LLM 手写官方/通用 Figma MCP `use_figma` 大段创建脚本。
3. 正式写入时必须按 `figma_write_plan.json` 构建 Relay job，不从终端输出手抄坐标或 hash。
4. 写入完成后只读取 `figma_write_verify_report.json` 转述流水线结果：
   - `imageHash` 必须为 40 位。
   - TMP Material Preset plugin data 必须完整。
   - outline.width > 0 的文本必须有 stroke。
   - `prefabInstances` 必须是 Figma `INSTANCE`，禁止 FRAME 占位。
   - 九宫父节点必须保留隐藏源图 fill 与 slice metadata。
   - component mode 结果必须确认。
5. 截图验收必须由 Figma Relay 插件或服务端产出截图/跳过原因；AI 不能凭肉眼或 JSON 数量宣称完成。若截图缺失，流水线报告必须明确 `screenshotExported=false` 和原因。

## Validation

- Validate this skill after edits:
  `node --test "<relay-root>/tests/path-portability.test.mjs"`
- Run `python "<relay-root>\ai\skills\prefab-to-figma\scripts\run_golden_tests.py"` after script or workflow edits.
- Run `python "<relay-root>\ai\skills\prefab-to-figma\scripts\prefab_to_figma.py" --self-test` after parser edits.
- Confirm JSON includes `root`, `nodes`, `warnings`, `stats`, and `visualBounds`.
- Confirm `prefab_export_audit_report.json` and `figma_write_plan_audit_report.json` use the unified `allPass/blockingErrors/warnings/summary/checks/artifacts` shape.
- Confirm `figma_write_verify_report.json` uses the unified `allPass/blockingErrors/warnings/summary/checks/artifacts` shape after Relay execution.
- Confirm `report.md` lists warnings instead of silently ignoring unsupported data.
- If Figma import is performed, inspect the target file and summarize visual or structural downgrades.

## Project Steering

When executing Unity Prefab → Figma, also follow:

#[[file:.kiro/steering/unity-to-figma.md]]

## 历史错误防范

### 字体必须参考目标 Figma 文件已有风格（2026-05-09）

**错误现象**：文本使用了 Noto Sans SC Medium（按 TMP Font Asset 名称选择），但目标 Figma 文件中同类文本实际使用 Lilita One Regular，导致视觉不一致。

**根本原因**：导入时按 Unity TMP 字体名在 Figma 中查找同名字体并直接使用，没有先检查目标文件中已有的同类文本节点使用的字体。

**强制规则**：

- 写入文本前，必须先在目标 Figma 文件中查找已有的同类文本节点（同页面或相邻页面的 `__text` 层），读取其 `fontName.family` 和 `fontName.style`。
- 如果文件中已有统一的文本字体风格，以文件内已有风格为准，而非 Unity TMP 字体名。
- 如果文件中没有已有文本参考，再按 TMP Font Asset 名称查找 Figma 可用字体。
- 使用非 Unity 原始字体时，必须写入 `fontFallback=true`、`unityFontFamily`、`figmaFontFamily` 元数据。

### 描边（Stroke）不得遗漏写入（2026-05-09）

**错误现象**：所有文本节点没有描边，与设计稿差异明显。JSON 中 `text.effects.outline` 数据完整（`width > 0`），但 Figma 文本节点的 `strokes` 为空。

**根本原因**：委托 sub-agent 执行 Figma 写入时，指令中包含了描边步骤，但 sub-agent 在实际创建文本节点时跳过了 `strokes`、`strokeWeight`、`strokeAlign` 的设置。

**强制规则**：

- 创建 `__text` 节点后，必须立即检查 JSON `text.effects.outline`：若 `width > 0`，必须设置 `strokes`、`strokeWeight`、`strokeAlign`。
- 描边颜色从 `text.effects.outline.color` 的 `{r, g, b}` 精确读取，禁止硬编码。
- `strokeWeight` 参考目标文件已有同类文本的描边粗细（通常 2-4px）；如果没有参考，使用公式 `outline.width × fontSize × 0.2` 作为初始值，再 clamp 到 2-4px 区间。
- `strokeAlign` 固定为 `"OUTSIDE"`。
- 验证阶段必须检查每个 `__text` 节点的 `strokes` 数组不为空（当 JSON outline.width > 0 时），否则视为导入未完成。
- 委托 sub-agent 时，指令中必须明确写出"描边是必须步骤，不可跳过"，并在验证清单中列出描边检查项。

### 嵌套 PrefabInstance 必须在主层级创建后立即处理（2026-05-09）

**错误现象**：导入完成后用户反馈"丢失公共组件"。`Common_Down_1`、`Common_HeadIconRoot`、`KaTongGreenBtn_3` 等嵌套的公共组件完全缺失。

**根本原因**：静态解析器 `prefab_to_figma.py` 不会递归合并嵌套 PrefabInstance 的内容到 JSON `root.children` 树中，只在 `prefabInstances` 数组中报告 GUID 列表。导入流程只按 `root.children` 递归创建了节点，完全跳过了 `prefabInstances` 数组的处理。

**强制规则**：

- 创建主层级后，必须**立即**遍历 JSON `prefabInstances` 数组，不能延后、不能跳过、不能用占位 Frame 替代。
- 对每个 prefabInstance entry：用 GUID 找到子 Prefab 路径 → 读取父 Prefab 的 `m_Modification` override → 在 Figma 全文件搜索已有 Component → 创建 Instance 并定位。
- 如果 Figma 中没有已有组件，必须先解析子 Prefab、创建 Component，再创建 Instance。
- 委托 sub-agent 时，指令中必须明确包含"处理 prefabInstances 数组中的所有嵌套组件"步骤，并列出每个 GUID 和对应的子 Prefab 名称。
- 验证阶段必须检查每个 prefabInstance 在 Figma 中是否为 INSTANCE 类型节点（不是 FRAME）。
- 识别信号：report.md 中 `PrefabInstance documents detected: N`、JSON `prefabInstances.length > 0`、warnings 中 `Missing child RectTransform`。
