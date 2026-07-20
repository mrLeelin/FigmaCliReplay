---
name: figma-hierarchy-cleanup-mcp
description: Use when整理 Figma 节点层级、给 Figma 节点打组、生产化 Figma hierarchy、cleanup Figma node hierarchy、group Figma nodes、把重复列表项或 Tab 抽象为 ComponentSet 变体，并且要求不使用官方/通用 Figma MCP 直写、只通过本地 figma-mcp-relay/figmaMcpRelay 操作当前 Figma 文件。
---

# Figma Hierarchy Cleanup MCP Relay

## 插件窗口“AI 整理对话”边界

当任务由 Figma 插件中的“开始 AI 整理对话”启动时，插件窗口就是与用户的多轮对话界面，必须保持同一个 Codex/Claude CLI 会话并完整使用本 Skill。由 Relay 接受任务本身完成服务预检，首轮只允许 `预检 → analyze → plan → 审阅完整目标树`，不得先用 `curl`、`Invoke-WebRequest` 或直接 `/health` 探测；不得写入 Figma；按钮点击不是写入授权。Relay 还会按会话阶段执行服务端写入闸门，提示词不得被当作唯一安全边界。必须在窗口中展示完整最终层级树并等待用户明确确认，才允许调用本 Skill 的 `run_cleanup_pipeline.py --apply-confirmed --no-auto-component-sets` 或等价脚本入口执行层级整理。

层级整理和即时验证完成后，必须在同一窗口询问用户是否满意。用户明确满意后，才进入本 Skill 的 AutoComponentSet/变体阶段；用户提出调整时，重新分析并修订计划，不得沿用旧快照或旧计划。所有 Figma 写入仍只允许通过本地 MCP Relay 脚本，禁止官方/通用 Figma MCP 直写。

旧的 `/cleanup/runs` V2 控制器仅为兼容已有 API 客户端保留；它不是窗口“开始 AI 整理对话”的入口，也不得阻止对话会话使用本 Skill 的分析、确认、写入和验证流程。

## Relay 生命周期边界

- `http://127.0.0.1:32130` 是外部管理的 MCP Relay。执行本 Skill 的 AI 只能作为客户端；插件窗口任务的 Relay 接收状态是权威服务预检，不得独立请求 `curl`、`Invoke-WebRequest` 或直接 `/health`，不得猜测 `localhost:3000` 或其它端口。
- 禁止启动、重启、停止、结束或重配 Relay；禁止绑定/监听 32130、32131；禁止运行 `start_mcp_companion`、`start_mcp_hidden`、`start_mcp_oneclick`、`npm run dev` 或任何等价服务管理命令。
- 遇到 WinError 10055、ENOBUFS、WinError 10048、EADDRINUSE、超时或连接错误时，必须回报原始错误为“本机 TCP 资源压力导致客户端无法建立连接”，并停止当前回合；不得声称 Relay 已停止或要求启动 Relay，也不得通过重启服务、抢占端口、杀进程或反复探测端口来恢复。

## Hypothesis-Action-Verification Loop

Use this loop for every write or cross-phase operation. Treat each step as a hypothesis that can be disproved by live evidence, not as a linear checklist.

1. State the current hypothesis before acting.
2. Check for counter-evidence before writing.
3. Take the smallest reversible action that can advance or test the hypothesis.
4. Immediately verify with live MCP/script evidence.
5. If verification contradicts the hypothesis, stop that path, preserve rollback artifacts, revise the plan, and continue from the revised hypothesis.
6. Do not treat `status=completed` or `allPass=true` as semantic correctness; they only prove operation-level checks passed.
7. When a failure pattern repeats, add or request a script/validator gate instead of relying on judgment alone.

For hierarchy cleanup, ComponentSet and grouping candidates must pass geometry, child-count, type, alignment, internal-structure, and unique-ownership checks. Names, indexes, and visual similarity are only reporting signals. If only part of a sibling set qualifies, use a partial node-group workflow instead of forcing every sibling into the same group or variant set.

## Fast MCP Execution Contract

- 【强制】Figma 层级整理的标准入口是 `scripts/run_cleanup_pipeline.py` 和 `scripts/figma_hierarchy_cleanup_mcp_client.py`（脚本内部调用 MCP Relay）。脚本会构建完整 job payload，避免 MCP tool 参数截断问题。
- 独立启动的 Skill 任务可用 `figmaMcpRelay.figma_health` 做一次轻量预检；由插件窗口启动的 AI 整理对话已经由 Relay 完成权威预检，禁止再次调用 `figma_health`、直接 `/health`、`curl` 或 `Invoke-WebRequest`。`figma_query_selection`、`figma_query_node_children` 等目标化只读查询仍可按需使用。
- Figma plugin/runtime traffic may still use local HTTP/WebSocket internally. That is companion-to-plugin transport, not the agent-facing API. Do not hand-write `/jobs`, `/figma/pending`, `/figma/result`, or `/assets/...` calls.
- Script stdout must be treated as compact status only. Read the `[SUMMARY_JSON]` block and the file paths it reports; full analysis/apply/pipeline JSON stays on disk.
- Never read full `analysis_result.json`, `apply_result.json`, or `pipeline_result.json` into LLM context for normal decisions. Use `figma_analyze_reader.py`, `cleanup_plan_diagnostic.md`, pipeline summary fields, and targeted child queries.
- Do not use MCP `fullResult` or wrapper `--verbose-result` for normal work. Full results require explicit bounded debugging (`fullResult=true` plus `debugFullResult=true`) and still strip inline base64 before returning to the model.
- When the auto plan is too coarse, first inspect `largeGroups`, `sparseGroups`, `nonContiguousGroups`, warning/error codes, and the diagnostic report. Do not expand the whole tree unless a targeted gate cannot explain the issue.
- Nested wrapper targets must use the real id returned by the previous apply result. Read `result.artifacts.createdGroups` / `result.createdGroups` with `extract_single_created_group_id`; never continue from stdout text, remembered ids, guessed ids, or id increments.
- If root grouping already succeeded and only a nested wrapper chain remains, use `run_cleanup_pipeline.py --skip-root-apply --wrapper-root-node-id <live-id> --wrapper-root-name "[ListRoot]" ...`（脚本内部调用 MCP Relay）。禁用 MCP tool 直连 `figma_submit_job` 提交 `FIGMA_HIERARCHY_WRAP_CHAIN`。不要重新执行根打组或复用根打组前的直接子节点 id。
- Every wrapper apply must pass a local stale-plan preflight first: `plan.target.nodeId` must match the current analysis root and `childNodeIds` must exactly equal the current direct children in order. A `planNodeSetMismatch` from the plugin means this local gate was skipped or the plan is stale.
- Fail fast on command failure. Do not treat `python ... | Tee-Object ...` as proof of success unless the child process exit code is explicitly checked; prefer `run_cleanup_pipeline.py` or Python `subprocess.run(check=True)` for timed multi-step runs.
- If a CLI wrapper reports a stale plugin `sessionId`, the wrapper may use its own bounded Relay session diagnostic and record `preflightSessionRefresh`; the AI must not add an independent health/port probing loop. When exactly one online session matches the requested `fileKey`, the wrapper may refresh to that session; otherwise fail with the full session diagnostic. Do not silently ignore the stale session and do not guess a target.
- When verifying a nested list cleanup whose current target is already `[Content]`, `[Viewport]`, `[ScrollView]`, or `[ListRoot]`, `[Item_*]` children satisfy the list-depth gate. Do not require another nested list container inside that target.
- For wrapper chains, do not re-run full `FIGMA_HIERARCHY_CLEANUP_ANALYZE` after every wrapper apply when the previous apply already returned the newly created wrapper id and `originalNodesAfter`. Synthesize the next before-analysis from that apply result, write it to disk, mark it with `syntheticBeforeAnalysis`, then immediately apply and verify the next layer.
- Final screenshots should use `FIGMA_EXPORT_NODE_SCREENSHOT` unless a fresh hierarchy tree is also needed for validation. Do not run a full hierarchy analyze just to get a PNG screenshot.
- When the cleanup plan is already explicit, prefer `FIGMA_HIERARCHY_BATCH_APPLY` to run `cleanupApply`, `wrapChain`, `reorderChildren`, and final `screenshot` steps in one MCP round-trip. This batch job is only an execution accelerator: it must not infer geometry groups, build screen-specific plans, or replace the agent's read-only planning review.
- Screen-specific semantic presets are not part of the default cleanup workflow. Do not encode a PSD family, page name, node id, fixed child count, fixed coordinate, or fixed layer-index range in `run_cleanup_pipeline.py` or the generic planner.
- Allowed reusable structure names are `[ListRoot]`, `[ScrollView]`, `[Viewport]`, `[Content]`, `[TabBar]`, and `[ProgressSection]`. Repeated children should use generic `[Item_*]` or `[TabItem_*]` names unless the user explicitly requests a business-specific rename after the generic grouping is correct.
- Repeated UI cleanup must start from geometry/type clustering, not names. Run `FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE` or `scripts/hierarchy_repeat_cluster_validator.js` before auto-grouping Day/List/Progress-like regions. The cluster score may use only `type`, `x/y/width/height`, `visible`, `opacity`, `childCount`, `isNineSliceLike`, main-axis spacing, marker spacing, and edge-slot geometry. `name`, `path`, and text `characters` are reporting-only signals and must not affect clustering score.
- PSD numeric prefixes such as `01_`, `29_`, or `60_` may be detected only as reporting-only semantic hints. Use `plan_figma_hierarchy_cleanup.py --detect-psd-prefix-hints` to write `psd_prefix_hints.json` and surface candidate prefix runs in `cleanup_plan_diagnostic.md`. These hints must not change repeat-cluster scoring, must not bypass unique-assignment or validator gates, and must not be treated as screen-specific fixed ranges.
- Auto apply is allowed only when repeat-cluster confidence is at least `0.85`, candidate ambiguity is absent, and every current node is assigned exactly once. Lower-confidence or ambiguous clusters must stop at dry-run/report; do not write Figma.
- `horizontal-list` is never auto-written from dry-run alone. Even when confidence is at least `0.85`, stop and ask the user whether to structure the horizontal repeat. If the user confirms it is a fixed horizontal strip, create direct child groups under the horizontal container and do not add `[ScrollView]`; add `[ScrollView] > [Viewport] > [Content]` only when the user explicitly wants a scrollable horizontal list. The decision must be based on geometry/type repeat clustering, not business names, node names, paths, or text characters.
- `vertical-list` list-like regions such as task/reward/mail/rank rows should use `[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]` when confidence and unique assignment pass. If the first dry-run rejects because nested slices or masks disturb anchors, retry with the expected visible row count and depth settings before giving up; do not stop after a single wrong-parameter reject.

## 路径约定

> 本文档中所有脚本命令都使用 `scripts/xxx.py` 形式，指向 skill 安装目录下的 `scripts/` 子目录。
>
> 例如 SKILL.md 位于 `<skill-dir>/SKILL.md`，则 `scripts/analyze.py` 对应 `<skill-dir>/scripts/analyze.py`。
>
> **在你的环境中**，根据 skill 实际安装路径替换 `<skill-dir>`：
> - Relay built-in: `<relay-root>/ai/skills/figma-hierarchy-cleanup-mcp`
> - Claude Code: `.claude/skills/figma-hierarchy-cleanup-mcp`
> - Codex CLI: `.codex/skills/figma-hierarchy-cleanup-mcp`
> - Gemini CLI: `.gemini/skills/figma-hierarchy-cleanup-mcp`
> - 自定义: 指向你的实际 skill 路径

## 核心原则

本技能只用于 **Figma 目标节点内部层级整理**：把大量散乱直接子节点整理成少量语义分组，保持视觉完全不变。全流程必须使用 `<relay-root>` 下的本地 MCP Relay / `figmaMcpRelay`，禁止使用官方/通用 Figma MCP 直写。

## MCP 接入优先级

- 【强制】标准入口是 `scripts/run_cleanup_pipeline.py` 和 `scripts/figma_hierarchy_cleanup_mcp_client.py`（内部调用 MCP Relay）。
- 独立 Skill 任务可用 `figmaMcpRelay.figma_health` 做一次轻量预检；插件窗口 AI 整理对话不得重复探测 health。`figma_query_selection`、`figma_query_node_children` 等目标化只读查询可直接用 MCP tools。**所有写入操作（apply/wrap/reorder）必须走脚本，禁止直用 `figma_submit_job` 提交写入 job。**
- `figma_hierarchy_cleanup_mcp_client.py` 和 `run_cleanup_pipeline.py` 是标准入口（内部通过 MCP Relay 做 JSON-RPC `tools/call`），不是旧业务 HTTP 协议。
- `/figma/pending`、`/figma/result`、`/assets/...` 是 MCP server 与 Figma 插件之间的 runtime relay；AI 不应直接 POST 或轮询这些 endpoint。
- MCP 默认 endpoint 是 `http://127.0.0.1:32130/mcp`，插件 URL 默认是 `http://localhost:32130`。如果当前 relay 使用其它端口，必须读取当前 MCP 配置或显式传入 `--relay-url`，不要硬猜端口。
- Figma 插件通信优先 WebSocket `/figma`，polling 只作为 runtime fallback；这不改变 AI 侧 MCP tool 的调用方式。

## 适用场景

- 用户要求”整理 Figma 节点””打组””生产化层级””cleanup hierarchy””group nodes”。
- Figma Frame/Section 下直接子节点过多，需要整理成 `[Bg]`、`[Header]`、`[ListRoot]`、`[TabBar]`、`[ProgressSection]` 等生产语义组。
- 只整理 Figma 文件，不生成 Unity Prefab，不导出图片资源。

## 简洁触发语

技能加载后，以下简洁语句直接对应到具体流程：

| 你说 | 我理解成 |
|------|---------|
| **选中做成组件变体然后替换** | 选中节点为模板 → `rebuild-component-set-from-siblings` → 找同级同类 → 生成 ComponentSet 变体 → 替换原节点为 Instance → 原备份 |
| **做成组件变体然后替换** | 同上 |
| **打组变体** | 同上 |
| **组件变体替换** | 同上 |
| **选中合并成组件** | 选中节点 → `component-from-selection` → 克隆生成普通 Component → 原节点不动 |
| **合并成组件** | 同上 |

不适用：Figma → Unity Prefab 导入、Prefab → Figma、纹理导出、PSD 导入。

## Agent 行为准则

- **失败先查文档，不要凭记忆试另一个命令。** 遇到 MCP tool 调用失败、超时、参数错误或任何非预期结果时，第一件事是回去读本文件（SKILL.md）确认标准流程和正确入口，不是凭经验猜另一个命令再试。本 skill 的标准入口是 `scripts/run_cleanup_pipeline.py` 和 `scripts/figma_hierarchy_cleanup_mcp_client.py`，不是裸 `figma_submit_job`。
- **不确定就说不确定，禁止把猜测包装成结论。** 超时就是超时、失败就是失败，原因未明就是未明。禁止在没有验证的情况下断言"正确应该是 X"或"问题出在 Y"。如果需要给用户解释，只陈述已知事实和未排除的可能性，不编造听起来合理的"权威"解释。
- **动手前先确认入口和职责边界。** 轻量只读查询（health、query-selection、query-node-children、export-screenshot）可以直接用 MCP tool；analyze、plan、apply、wrap、reorder 等写入/分析操作必须走脚本。这条规则写在 SKILL.md 里，执行前必须读到。
- **超时先分层定位，禁止空等或重复提交。** Figma 长任务的 AI-facing HTTP MCP 外层请求超时必须与写入任务等待时间保持一致，统一按 `300s` 配置；`figma_submit_job(timeout=300)` 不能被外层 `/mcp` HTTP 客户端 `30s` 超时截断。apply/write job 超时后，禁止重复提交同一个写入 job，也禁止盲目等待；必须立即检查 live health/result 状态，随后用 fresh analyze 验证是否已落地，或切换到 stdio MCP client 路径继续。向用户汇报时必须标明超时层级：`outer-http-timeout`、`plugin-result-timeout` 或 `figma-execution-error`。
- **显式目标优先，禁止默认依赖选区。** 当用户提供明确 `figma-url`、`fileKey + nodeId`、目标节点路径或目标节点清单时，必须以这些显式目标作为唯一整理目标；禁止要求用户当前选中该节点，禁止用当前 Figma selection 覆盖或推断目标。此时如需校验文件、页面或 root 节点，应使用 `figma_health`、目标 `analyze` 返回的 `fileKey/pageName/rootName/rootBounds`，或 `query-node-children` 等目标化只读查询；不要把 `query-selection` 作为前置门禁。只有用户明确说“整理当前选择/选中的界面/我选择的节点/把我选择的节点打组变体/选中合并成组件”等 selection 驱动语义时，才允许使用当前 selection 作为目标来源。

## 强制安全规则

- 禁止调用官方/通用 Figma MCP 直写：`use_figma`、`get_design_context`、`get_screenshot`、`upload_assets` 都不得用于本技能写入。
- 所有 Figma 写入操作必须通过 `scripts/run_cleanup_pipeline.py` 或 `scripts/figma_hierarchy_cleanup_mcp_client.py` 脚本执行（脚本内部调用 MCP Relay）。`figmaMcpRelay.figma_health`、`figma_query_selection`、`figma_query_node_children` 等轻量只读查询可直接用 MCP tools。
- 禁止在用户确认前提交 `FIGMA_HIERARCHY_CLEANUP_APPLY`。
- 禁止修改视觉属性：坐标、尺寸、透明度、填充、描边、字体、特效、图片、文本内容均不得改。
- 禁止删除原始节点，禁止 flatten/vectorize，禁止 detach instance。
- 禁止拆散 `__slice_`、`jiugong`、`nine-slice` 相关节点。
- 只允许新增/命名外层分组容器，并把原始节点移动到计划中的分组。
- 只修正同一父节点下的视觉栈顺序时，优先使用 `FIGMA_HIERARCHY_REORDER_CHILDREN`；禁止为了调整 sibling 顺序重新导入 PSD 或重建整棵树。

## 标准流程

1. 读取仓库规则、AI入口、任务路由和 `Doc/ReportError/` 中 Figma/MCP Relay 相关错误。
2. 检查 MCP Relay：独立启动本 Skill 时只调用一次 `figmaMcpRelay.figma_health`；插件窗口 AI 整理对话跳过此步，以 Relay 已接受任务和随任务提供的 authoritative cleanup snapshot 为预检证据，禁止额外 health/端口探测。
3. 只读分析目标节点：
   ```powershell
   python scripts/figma_hierarchy_cleanup_mcp_client.py analyze --figma-url "https://www.figma.com/design/FILE/NAME?node-id=1-2" --include-hidden
   ```
   **分析结果通常 >500KB，无法直接 Read。必须使用 `figma_analyze_reader.py` 一次性提取摘要**：
   ```powershell
   python scripts/figma_analyze_reader.py --input .tmp/figma-hierarchy-cleanup/analysis_result.json --output .tmp/figma-hierarchy-cleanup/analysis_summary.txt
   ```
   默认 `brief` 只输出行动摘要和节点类型统计；需要直接子节点列表时用 `--mode children --max-children 80`；只有明确需要审查完整嵌套结构时才用 `--mode all` 或 `--mode tree`。
   **禁止：** Read 大 JSON、多次 cp/grep/cat 探查结构、写多版迭代脚本提取不同字段。
   **允许：** 如果 analyze 结果<50KB，可直接 Read；否则必须用 `figma_analyze_reader.py`。
   ⚡ ⚡ ⚡ **如果 directChildCount==1**，立即用 `figma_query_node_children` 或再分析内层节点，不要等看完摘要才发现。

4. 追加整理、嵌套分步 apply 或子层级整理前，必须对当前目标节点重新 analyze，不得复用旧 root 的分析结果。
5. 生成整理计划：
   ```powershell
   python scripts/plan_figma_hierarchy_cleanup.py --analysis .tmp/figma-hierarchy-cleanup/analysis_result.json --plan .tmp/figma-hierarchy-cleanup/cleanup_plan.json --report .tmp/figma-hierarchy-cleanup/cleanup_plan.md --diagnostic-report .tmp/figma-hierarchy-cleanup/cleanup_plan_diagnostic.md
   ```
6. 每个 plan 生成后必须立即检查 UTF-8，而不是等最终交付；确认 plan/report 中没有连续问号占位符或 Unicode U+FFFD。通过 PowerShell 管道写入含中文 `reason` 的 JSON 属于高风险路径，优先使用 UTF-8 脚本文件，或让 plan 元数据保持 ASCII。
7. 审阅计划质量：如果单个分组吞掉 70% 以上直接子节点，或 `[ListRoot]` / `[TabBar]` / `[ProgressSection]` 等语义组仍可继续拆分却未展开，视为异常计划，必须人工重建，不得 apply。
7a. 对 Day/List/ProgressSection/TaskList/RewardSlot/Milestone 这类重复 UI 区域，先执行 repeat-cluster dry-run：使用 `scripts/figma_hierarchy_cleanup_mcp_client.py` 提交 `FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE`（脚本内部调用 MCP Relay），或在本地回归/离线分析时运行 `node "<relay-root>/scripts/hierarchy_repeat_cluster_validator.js" --input <analysis.json> --json`。输出必须包含 `confidence`、`clusterType`、`groups`、`nodeAssignments`、`rejectReasons`、`usedSignals` 和 `ignoredSignals`。`ignoredSignals` 必须包含 `name`、`path`、`characters`。
7b. repeat-cluster 只生成候选，不直接代替整理计划。`confidence >= 0.85` 且无候选冲突时，才允许把候选转成 cleanup/wrap/reorder 计划；`0.65 <= confidence < 0.85` 或候选分差不足时只输出 dry-run；`confidence < 0.65`、锚点不足、marker 不足、节点重复归属或节点遗漏时必须拒绝自动整理。
7c. `horizontal-list` 通过高置信 dry-run 后仍不得自动写入；必须先询问用户是否需要整理横向重复项。用户确认是固定横向结构后，目标树应是横向容器直接挂载重复子项组，不得默认套 `[ScrollView]`。只有用户明确要求横向滚动时，才允许使用 `[ScrollView] > [Viewport] > [Content]`。判断必须基于几何/类型重复聚类，不得依赖业务名称、节点名称、路径或文本内容。
7d. `vertical-list` 被拒绝时必须先审查参数和层级深度：例如 Task 行可能被九宫切片、遮罩或锁定层干扰，首次默认 `expectedYCount` 失败不代表不可整理。应根据可见行/卡片几何数量重跑 dry-run；只有多轮参数审查仍无法证明唯一归属时才停止。
8. **一次规划完整最终树，一次确认，分步执行。** 向用户展示的必须是完整的最终目标树（含所有层级子组），而不是只展示顶层粗分组。用户确认后视为对完整结构的认可，后续子组整理不再二次询问确认，直接自动迭代 apply 到最终状态。不得只展示粗分大组，不得在用户确认后又因子组拆分再次打断用户。
9. 用户确认后执行：
   ```powershell
   python scripts/figma_hierarchy_cleanup_mcp_client.py apply --plan .tmp/figma-hierarchy-cleanup/cleanup_plan.json
   ```
10. 每次 apply 后立即验证，不得攒到最后；执行后验证：
   ```powershell
   python scripts/verify_figma_hierarchy_cleanup.py --before .tmp/figma-hierarchy-cleanup/analysis_result.json --after .tmp/figma-hierarchy-cleanup/apply_result.json --plan .tmp/figma-hierarchy-cleanup/cleanup_plan.json
   ```
   每次 `wrap`、`apply`、`batchApply` 或 `reorderChildren` 后，必须用 `figma_query_node_children` 或 fresh analyze 读取当前真实结构，再生成下一步计划；不得继续使用 apply 前的 `directChildren`、旧 wrapper id、旧 summary 或记忆中的层级。
11. 复查计划、apply、verify JSON 的 UTF-8 文本，确认没有连续问号占位符或 Unicode U+FFFD 替换字符。
12. 如果 MCP Relay 只支持当前目标下一层分组，嵌套结构必须按“完整目标树一次规划、工具分层 apply”执行：`apply parent wrapper → analyze new wrapper → apply child wrapper → verify`；工具分步不等于需求二次整理。
13. 当前 analyze 不存在的节点不得根据旧结果、记忆或历史 apply 记录补建；只能记录为“当前目标内未发现”，如需恢复必须单独征得用户确认。
14. 如果 apply 后用户指出 `[Bg]`、`[TabBar]`、`[ListRoot]`、`[ProgressSection]` 等顶层组遮挡关系错误，先重新 analyze 当前 root 的 `directChildren` 顺序；只要节点集合正确且仅 sibling 顺序错误，就使用重排计划修复，不要重新整理或重新导入。

## 阶段推进规则

一次完整整理任务按固定阶段推进，禁止在第一轮规划或层级写入后直接结束：

1. `PlanReview`：只读 analyze，给出完整最终层级树、节点移动计划和预计自动创建的 ComponentSet 变体候选，不写入 Figma。必须询问用户是否确认执行层级计划；“确认”“确认执行”“可以执行了”“按此执行”“执行计划”“可以”“同意”及明确同义表达只授权下一阶段。用户不满意时根据反馈重新 analyze 和修订计划。
2. `HierarchyCleanup`：收到 `PlanReview` 的一次授权后，只执行层级整理、打组、必要的重排和逐步验证；此阶段禁止创建 Component、ComponentSet、Variant 或替换 Instance。
3. `SatisfactionReview`：层级验证通过后立即停止写入，在同一窗口询问用户是否满意。只有“满意”“满意了”“确认满意”“效果满意”“可以了”及明确同义表达才授权 AutoComponentSet；调整反馈会回到新的只读 `PlanReview`，不得复用旧计划。
4. `AutoComponentSet`：收到 `SatisfactionReview` 的明确满意后，对当前最新结构中可明确识别的重复节点创建 `ComponentSet` 变体并把原节点替换为对应 Instance，原节点备份。若重复节点范围、变体属性、替换数量或父级结构存在歧义，必须阻塞并说明缺少的信息。
5. `ComponentSetReview`：自动 ComponentSet 完成后展示验证结果；用户提出问题时按最新结构重新分析，不得回退到层级计划授权。
6. `CustomGroupingLoop`：询问用户是否还有自定义成组需求。若用户说“把我选择的节点打组变体”“把我选中的节点打组变体”或同义表达，立即按当前 Figma 选择执行手动选择或跨父级节点组 ComponentSet 流程；每次完成后继续询问。
7. `Done`：只有用户明确结束，才输出最终通知；最终通知必须包含层级整理验证、自动 ComponentSet 结果、自定义成组结果和剩余 warnings。

## 确认前全量节点映射门禁

`PlanReview` 询问用户确认以前，必须完成以下机器可校验门禁；仅写“全部节点都会处理”不算通过：

1. 从当前 authoritative snapshot / includeHidden analyze 中提取 root 的全部原始直接子节点，按原始 sibling 顺序建立 before 清单。每项必须包含原始 `ID + name`，并显式记录唯一目标父级和目标 sibling 顺序。
2. 每个原始直接子节点必须恰好出现一次。若原始直接子节点本身是九宫、Frame 或其它容器，只分配这个直接子容器并整体保留其后代；不得把后代误列为 root 直接子节点，也不得拆散 `__slice_` / `jiugong` / `nine-slice`。
3. 禁止用省略号、区间、`其余节点随对应图片移动`、`同类节点一起移动`、`剩余节点同上` 或任何叙述替代显式映射。计划正文较长也不能省略节点。
4. 插件窗口对话中，AI 只允许写 Relay 为当前任务指定的机器可读精简语义决策 `cleanup-plan-decision.json` 绝对路径，禁止 AI 手写 `cleanup-plan-for-confirmation.json`，也不得写到仓库根目录或用其它草稿替代。精简决策只包含 `schemaVersion: 1`、`rootNodeId`、`groups`、`componentCandidates`、`warnings`；每个 `groups[]` 只包含 `name`、`count`、`startNodeId`、`endNodeId` 和可选 `subgroups`。count 表示从当前权威 sibling 游标开始的连续节点数量，首尾锚点必须精确等于该连续区间在 authoritative snapshot 中的首尾节点，顶层 count 总和必须等于 root 直接子节点总数。
5. 每个精简决策组至少包含 2 个节点。含 12 个及以上节点的组必须提供至少两个 `subgroups`，每个子组仍只写 `name`、`count`、`startNodeId`、`endNodeId` 和可选嵌套子组；子组 count 总和必须精确等于父组 count，每个子组锚点必须等于父区间内对应连续切片的首尾节点，仍有 12 个及以上节点的子组必须继续展开。禁止提交按语义交错抽取 ID 的子组，因为这会破坏原 sibling / Z 轴顺序。
6. AI 回合结束后，Relay 必须根据 authoritative snapshot 确定性生成唯一允许进入确认阶段的 `cleanup-plan-for-confirmation.json`：自动填入每组的权威 `parentNodeId`、连续 `sourceNodeIds`、`preserveSiblingOrder: true`，以及每个直接子节点完全一致的 `nodeId`、`nodeName`、`targetParent`、`targetSiblingIndex`。AI 自己的计数、手抄完整 ID 方案、报告或“校验通过”陈述只作参考，不能推进阶段。
7. Relay 独立校验摘要必须明确输出 `beforeCount`、`assignedCount`、`missing = []`、`duplicate = []`、`extra = []`、`groupCount`；只有数量相等且三个集合均为空，才证明 before 直接子节点 ID 集合与计划分配 ID 集合完全相等。顺序不一致时日志必须包含首个错位 index、expected ID、actual ID 和两侧长度。
8. 每个待创建分组必须至少包含 2 个有效直接子节点；出现单子节点分组、目标父级不是当前直接父级、父子层级混用、节点名称与快照不一致、无效目标 sibling 顺序时，计划必须阻塞。
9. 若 Relay 校验失败，它会把具体错误自动回传到同一个 CLI 会话。此时必须保持只读，重新读取 authoritative snapshot，只重写 `cleanup-plan-decision.json` 并等待 Relay 再次确定性展开和独立校验；不得手写完整确认产物，不得把任务提示、按钮点击或 AI 自己的话误认成用户确认。
10. 若校验失败或计划仍有 `largeGroups`、`sparseGroups`、`nonContiguousGroups`、未展开的大语义组，必须留在只读分析阶段修复并重新校验；不得询问确认，不得把未验证计划交给用户，更不得 apply。

用户可读计划允许在全量映射之外增加摘要，但不得省略映射本身，也不得用自然语言承诺替代机器可读计划和本地校验结果。

## 快速流水线

批量整理或包含 ScrollView / Viewport / Content 等嵌套包装时，优先使用一键流水线脚本减少人工往返和重复截图：

AI-facing rule: 标准入口是 `run_cleanup_pipeline.py` 脚本（内部调用 MCP Relay）。所有 APPLY/WRAP_CHAIN/REORDER 等写入操作必须通过脚本提交，禁止直用 `figma_submit_job`。`figma_submit_job` 只允许用于轻量只读查询（EXPORT_NODE_SCREENSHOT 等）。

```powershell
python scripts/run_cleanup_pipeline.py --figma-url "https://www.figma.com/design/FILE/NAME?node-id=1-2"
```

默认行为：

- 只执行 `health → analyze → plan`，不写入 Figma，输出 `.tmp/figma-hierarchy-cleanup/pipeline/pipeline_result.json`。
- 分析阶段默认包含隐藏节点，避免漏掉占位、遮罩、ImportBounds 等节点。
- 中间步骤默认不截图，降低 Figma PNG 导出耗时。
- 命令行只输出摘要和耗时，完整结果仍写入 JSON 文件。

用户确认计划后，才允许追加 `--apply-confirmed` 写入 Figma：

```powershell
python scripts/run_cleanup_pipeline.py --figma-url "https://www.figma.com/design/FILE/NAME?node-id=1-2" --apply-confirmed
```

如果需要一步完成列表生产结构，可传入包装链：

```powershell
python scripts/run_cleanup_pipeline.py --figma-url "https://www.figma.com/design/FILE/NAME?node-id=1-2" --apply-confirmed --wrapper-chain "[ListRoot]>[ScrollView]>[Viewport]>[Content]"
```

流水线门禁：

- `--apply-confirmed` 只能在用户明确确认后使用。
- 每次 apply 后流水线必须立即 verify，任一步失败立即停止。
- Wrapper 链必须从当前 apply 结果读取新建分组 id，不得凭旧 id 或记忆继续执行。
- 最后一次 apply 默认截图；只有用户明确允许跳过最终截图时才使用 `--no-final-screenshot`。
- `pipeline_result.json` 必须包含每步耗时、产物路径、验证结果和最终截图预期。
- 自动生成的根计划仍需人工审阅；流水线只减少执行往返，不替代计划质量判断。
- 插件对话的 `HierarchyCleanup` 阶段调用 `run_cleanup_pipeline.py --apply-confirmed --no-auto-component-sets`，确保层级验证后先进入 `SatisfactionReview`。用户明确满意后，才调用 `run_cleanup_pipeline.py --apply-confirmed --auto-component-sets-only` 创建 ComponentSet 变体。
- AutoComponentSet 只能基于通用规则：同父级、直接子节点、`FRAME`、数量不少于 2、名称符合 `[Name_数字_State]` / `[Name_数字]` 这类 indexed sibling 模式；不得使用 PSD 名、页面名、nodeId、固定 child count 或具体界面坐标。
- 目标直接子节点已经是 `INSTANCE` 时必须记录 `skippedAlreadyInstance`，不得再次生成 ComponentSet、组件库或备份帧。

## ComponentSet 变体固化流程

当 `[Content]` 下的列表项、`[TabBar]` 下的 Tab，或其它重复交互项已经整理成单个成员分组后，可以进一步把单个成员抽象为 Component，并通过 ComponentSet 变体选择展示状态。该流程仍然属于 MCP Relay / `figmaMcpRelay` 写入流程，禁止使用官方/通用 Figma MCP 直写。

适用场景：

- `[Content]` 下存在同构任务项、奖励项、邮件项、排行项等，成员差异主要是状态，如 `InProgress`、`Claimable`、`Completed`、`Locked`。
- `[TabBar]` 下存在同构 Tab，成员差异可由单属性或多属性表达，如 `State=Selected`、`Index=2|State=Selected`。
- 目标节点已经经过当前最新 analyze 证明直接子节点就是要组件化的重复成员；不得复用旧 analyze 或旧 Figma 结构记忆。

执行门禁：

1. 先对当前目标节点重新 analyze，并确认目标直接子节点仍是原始 `FRAME` 成员，而不是已经替换过的 `INSTANCE`。
2. 手工编写 `component_set_plan.json`，明确 `target.nodeId`、`componentSetName`、`replaceOriginalsWithInstances`、`createBackup` 和每个变体来源节点。
3. 如果是用户直接要求 ComponentSet、手动选择 ComponentSet 或跨父级节点组 ComponentSet，必须向用户展示计划摘要并获得明确确认后才允许执行；如果来自插件整理对话，只有 `SatisfactionReview` 阶段的明确满意才授权 `AutoComponentSet`，`PlanReview` 确认不得复用为变体授权。
4. 默认 `createBackup=true`，原始成员会移动到隐藏备份 Frame，禁止删除原节点。
5. 禁止 flatten、detach instance、拆散 `__slice_` / `jiugong` / `nine-slice` 节点。
6. 同一目标不要重复执行 `component-set`；如果目标直接子节点已经是 `INSTANCE`，应停止并报告“已组件化”。

确认后执行：

```powershell
python scripts/figma_hierarchy_cleanup_mcp_client.py component-set --plan .tmp/figma-hierarchy-cleanup/component_set_plan.json --output .tmp/figma-hierarchy-cleanup/component_set_result.json
```

单属性变体计划示例：

```json
{
  "target": { "nodeId": "CONTENT_NODE_ID" },
  "componentSetName": "Item",
  "variantProperty": "State",
  "replaceOriginalsWithInstances": true,
  "createBackup": true,
  "variants": [
    { "nodeId": "ITEM_1_NODE_ID", "value": "InProgress" },
    { "nodeId": "ITEM_2_NODE_ID", "value": "Claimable" },
    { "nodeId": "ITEM_3_NODE_ID", "value": "Completed" },
    { "nodeId": "ITEM_4_NODE_ID", "value": "Locked" }
  ]
}
```

多属性变体计划示例：

```json
{
  "target": { "nodeId": "TAB_BAR_NODE_ID" },
  "componentSetName": "TabItem",
  "variantProperty": "State",
  "replaceOriginalsWithInstances": true,
  "createBackup": true,
  "variants": [
    { "nodeId": "TAB_1_NODE_ID", "properties": { "Index": "1", "State": "Normal" } },
    { "nodeId": "TAB_2_NODE_ID", "properties": { "Index": "2", "State": "Selected" } },
    { "nodeId": "TAB_3_NODE_ID", "properties": { "Index": "3", "State": "Locked" } }
  ]
}
```

验收门禁：

- `result.status == "completed"`，`result.allPass == true`，`blockingErrors` 为空。
- `summary.variantCount` 等于计划变体数量，`summary.replacedInstanceCount` 等于替换实例数量。
- `checks.componentSetCreated`、`checks.contentChildCountPreserved`、`checks.contentChildrenAreInstances`、`checks.contentOrderPreserved`、`checks.boundsPreserved`、`checks.sourceNodesBackedUp` 全部通过。
- 若源节点含九宫切片，`checks.nineSlicePreservedInVariants` 必须通过。
- `boundsPreserved.driftCount == 0` 或不超过任务约定容差，并保留最终截图或说明无法截图。
- 执行后重新 analyze 当前目标节点，确认直接子节点均为 `INSTANCE`，数量与计划一致。
- 复查 `component_set_plan.json`、`component_set_result.json` 和相关报告无连续问号占位符或 Unicode U+FFFD 乱码。

### 手动选择 ComponentSet 流程

当用户明确表示“根据我当前选择的几个节点打 ComponentSet”时，优先使用手动选择模式，而不是 `[Content]` / `[TabBar]` 自动完整覆盖规则。

只读查询当前选择：

```powershell
python scripts/figma_hierarchy_cleanup_mcp_client.py query-selection --output .tmp/figma-hierarchy-cleanup/selection_result.json
```

创建新 ComponentSet：

```powershell
python scripts/figma_hierarchy_cleanup_mcp_client.py component-set --from-selection --component-set-name ManualSelectionSet --variant-property State --variant-values Variant1,Variant2,Variant3 --output .tmp/figma-hierarchy-cleanup/component_set_result.json
```

把后续手动选择的其它节点追加到已有 ComponentSet：

```powershell
python scripts/figma_hierarchy_cleanup_mcp_client.py component-set-add-variants --component-set-id COMPONENT_SET_ID --variant-property State --variant-values Variant4,Variant5 --output .tmp/figma-hierarchy-cleanup/component_set_add_variants_result.json
```

手动选择模式门禁：

- 必须先 `query-selection`，向用户回显当前选择的节点 id/name/type/count；用户确认后才执行创建或追加。
- 创建 ComponentSet 至少需要选中 2 个节点；追加变体至少需要选中 1 个节点。
- 默认只创建 ComponentSet 或追加变体，不删除、不移动、不替换用户选中的源节点。
- `--variant-values` 按当前选择顺序匹配；如果用户未指定，MCP Relay 会按顺序生成 `Variant1`、`Variant2` 等临时值，最终交付必须提醒用户可在 Figma 中重命名。
- 追加变体必须提供 `--component-set-id`，并且目标节点必须是 `COMPONENT_SET`。
- 如果追加的变体属性组合已存在，任务必须阻塞，禁止覆盖旧变体。

### 手动选择合成普通 Component

当用户要求“先把选中的几个节点合并一个组件”且明确选择“克隆生成，原节点不动”时，使用 `component-from-selection`，不要误用 ComponentSet。

先只读查询当前选择：

```powershell
python scripts/figma_hierarchy_cleanup_mcp_client.py query-selection --output .tmp/figma-hierarchy-cleanup/selection_result.json
```

确认后克隆当前选择并生成普通 Component：

```powershell
python scripts/figma_hierarchy_cleanup_mcp_client.py component-from-selection --component-name ManualSelectionComponent --output .tmp/figma-hierarchy-cleanup/component_from_selection_result.json
```

门禁：

- 必须先 `query-selection` 回显节点列表，确认选中的是用户指定节点。
- 该命令会克隆源节点到新 Frame，再把新 Frame 转 Component；原选择节点不删除、不移动。
- 如果用户要求“移动原节点合并”，不能使用此命令，必须另行设计并确认。
- 验证 `componentCreated`、`sourceSelectionCountPreserved`、`sourceNodesPreserved`、`componentBoundsValid` 和 `screenshotExported`。

### 基于选中同级重建 ComponentSet 并替换实例

当用户选中一个已经整理好的列表项或 Tab 项，并要求“把节点中其他的也换成这个 Component，并生成变体，类似 `[Item_1_InProgress]`”时，使用 `rebuild-component-set-from-siblings`。该流程以当前选中节点为锚点，读取其同父级、同尺寸的直接子节点，克隆这些同级节点生成新的 ComponentSet，然后把原同级节点移动到隐藏备份 Frame，并在原位置创建对应变体 Instance。

只读门禁：

```powershell
python scripts/figma_hierarchy_cleanup_mcp_client.py query-selection --output .tmp/figma-hierarchy-cleanup/selection_result.json
```

确认选区后执行：

```powershell
python scripts/figma_hierarchy_cleanup_mcp_client.py rebuild-component-set-from-siblings --component-set-name Item --variant-property State --output .tmp/figma-hierarchy-cleanup/rebuild_component_set_from_siblings_result.json
```

门禁：

- 必须且只能选中 1 个模板节点；脚本会使用该节点的父级直接子节点作为候选来源。
- 默认只处理同父级且与选中节点宽高一致的直接子节点，避免跨区域误替换。
- 节点名形如 `[Item_1_InProgress]` 时，会推断 `Index=1` 与 `State=InProgress`；无法推断时使用 `VariantN`。
- 默认 `createBackup=true` 且 `replaceOriginalsWithInstances=true`，原节点移动到隐藏备份 Frame，不直接删除。
- 父级 Auto Layout 会阻塞，避免替换实例改变布局。
- 执行后必须重新 analyze 父级，确认直接子节点数量不变、均为 `INSTANCE`、顺序不变、bounds 无漂移、`sourceNodesBackedUp` 通过。
- 禁止用该命令重复处理已经正确组件化的目标，除非用户明确要求重新生成一套新的 ComponentSet。

### 跨父级节点组 ComponentSet 流程

当一个可复用成员由多个分散在不同父级下的节点组成时，例如进度条刻度在 `[ProgressBar]`、数值文本在 `[MilestoneTexts]`、奖励图标在 `[ProgressSection]` 直接子节点，不能使用同级重建命令。应显式编写节点组计划，并使用 `component-set-from-node-groups`。

快捷触发语：

- 用户说“把选中的合并成组件变体，并替换原有同类节点”时，优先理解为本流程。
- 用户说“把选中的合并组件变体，替换原有”时，也按本流程处理，但必须先 `query-selection` 和 analyze，回显当前选中节点以及准备替换的同类节点组，再等待确认。
- 这里的“合并组件变体”表示：一组散节点作为一个组件成员，多组散节点组成 ComponentSet 变体，最后用变体实例替换原散节点，并把原节点备份。

计划示例：

```json
{
  "target": { "nodeId": "PROGRESS_SECTION_ID" },
  "componentSetName": "ManualSelectionComponentSet",
  "variantProperty": "Value",
  "replaceOriginalsWithInstances": true,
  "createBackup": true,
  "groups": [
    {
      "name": "[Milestone_1_100]",
      "value": "100",
      "properties": { "Index": "1", "Value": "100" },
      "nodeIds": ["TICK_ID", "TEXT_ID", "REWARD_ID"]
    }
  ]
}
```

确认后执行：

```powershell
python scripts/figma_hierarchy_cleanup_mcp_client.py component-set-from-node-groups --plan .tmp/figma-hierarchy-cleanup/component_set_node_groups_plan.json --output .tmp/figma-hierarchy-cleanup/component_set_from_node_groups_result.json
```

门禁：

- 每组必须显式列出所有源节点 id，不允许靠旧分析结果自动补节点。
- 默认 `createBackup=true`，源散节点移动到隐藏备份 Frame，不直接删除。
- 替换实例会挂到 `target.nodeId` 容器下，并保持每组节点 union bounds 的绝对位置和尺寸。
- 适合固定里程碑、奖励点、跨层组合件；不适合 Auto Layout 容器。
- 验证必须检查 `componentSetCreated`、`groupsReplacedWithInstances`、`sourceNodesBackedUp`、`boundsPreserved`、`nineSlicePreservedInVariants` 和最终截图。

## 大JSON处理规范（效率门禁）

**问题：** FIGMA_HIERARCHY_CLEANUP_ANALYZE 返回的 JSON 通常 >500KB/500K tokens，Read 工具无法直接读取。传统做法（反复 Read/探查/写多版迭代脚本）能浪费 3-5 分钟。

**铁律：**

1. **analyze 结束后，立即用 `figma_analyze_reader.py` 提取摘要，禁止多步探查。**
   ```powershell
   python scripts/figma_analyze_reader.py --input .tmp/figma-hierarchy-cleanup/analysis_result.json --output .tmp/figma-hierarchy-cleanup/analysis_summary.txt
   ```
   一句命令，得到直接子节点表、Y 坐标空间布局、完整嵌套树、节点类型统计、内层冗余检测。

2. **发现 directChildCount==1 时，立即 query 内层节点。**
   如果根节点只有一个 FRAME 子节点且同尺寸，这就是冗余包装层。不要重新 submit_job，直接用 `figma_query_node_children` 查看内层实际内容：
   - `figma_query_node_children(nodeId="内层ID", depth=1)` — 查看内层子节点数量
   - 然后对内层节点重新 submit `FIGMA_HIERARCHY_CLEANUP_ANALYZE` 获取完整分析

3. **一次性脚本，禁止迭代重写。**
   一个 `.py` 文件输出所有你需要的数据格式。不要为每个输出格式写新脚本。

4. **禁用路径：**
   - ❌ Read 大 JSON（必定超 token 限制）
   - ❌ cp → cat → grep 反复探查文件内容
   - ❌ cp → python 又被权限拦截（跨工具拷贝）
   - ❌ 为不同输出格式写多个迭代脚本

5. **正确路径：**
   - ✅ `python figma_analyze_reader.py --input X --output Y` → Read Y（~18KB，一行 Read）
   - ✅ 一步 dump 到文件，用 Read 读取

6. **粗计划诊断路径：**
   计划生成后如果出现 `largeGroups`、`sparseGroups`、`nonContiguousGroups`，或用户反馈“自动计划太粗”，先读 `cleanup_plan_diagnostic.md`：
   ```powershell
   python scripts/plan_figma_hierarchy_cleanup.py --analysis .tmp/figma-hierarchy-cleanup/analysis_result.json --plan .tmp/figma-hierarchy-cleanup/cleanup_plan.json --report .tmp/figma-hierarchy-cleanup/cleanup_plan.md --diagnostic-report .tmp/figma-hierarchy-cleanup/cleanup_plan_diagnostic.md
   ```
   诊断报告只列目标、关键质量指标、warning code、问题组和有限示例节点；每组会截断 source indices / sample names，避免 LLM 重新吞入大 JSON。

7. **命令行输出只看摘要。**
   `plan_figma_hierarchy_cleanup.py`、`run_cleanup_pipeline.py`、`verify_figma_hierarchy_cleanup.py` 默认 stdout 只打印轻量摘要和产物路径。完整 JSON 已写入对应 output 文件；只有深排查且确认体积可控时才加 `--verbose-result`。

## 时间优化规则

- 中间 analyze/apply 统一使用无截图模式；最终 apply 保留截图作为视觉验收依据。
- MCP wrapper 默认只打印轻量摘要；需要排查完整节点树时再使用 `--verbose-result`。
- 多层嵌套结构优先用 `run_cleanup_pipeline.py --wrapper-chain`，不要手工重复执行多组 analyze/apply 命令。
- 不要为了省时跳过 includeHidden、节点守恒、bounds 漂移、UTF-8 和最终截图门禁。
- 如果单次运行慢，先查看命令行摘要中的 `output` 路径，再用 `pipeline_result.json.timings` 定位耗时在 health、analyze、apply、截图还是 verify；如果是计划质量问题，优先 Read `diagnosticReport`。

## 视觉栈顺序规则

- Figma sibling 越靠后，视觉越在上层；root 顶层计划必须同时表达“语义树”和“视觉栈顺序”。
- 语义名称不能单独决定层级；`[Bg]`、`[TabBar]`、`[ListRoot]`、`[Header]`、`[ProgressSection]` 等名称只辅助理解，最终前后顺序必须以实际视觉遮挡关系为准。
- 背景、遮罩、光效、前景装饰可能同时存在；背景类节点通常更靠底层，但不能硬性要求固定 index，必须按截图或设计画面判断谁遮挡谁。
- **`[Bg]` 不自动最低。** 组名只表达语义分类，不决定 Z 序。`[Bg]` 中的 PSD index 可能比 `[TabBar]` 或 `[Header]` 高（即 TabBar 的 PSD 图层可能在 Bg 之下），此时 `[TabBar]` 必须排在更底层。每组在 sibling 顺序中的位置由该组元素的 PSD layer index 范围决定，不是由组名决定。
- Tab、列表、进度、标题、底部导航等功能组不能套固定模板；如果某组在设计中应该覆盖另一组，就必须放在更上层，反之应放在更下层。
- 发现视觉栈错误时，优先生成 `childNodeIds` 全量顺序计划并调用 `reorder`，不得只提交局部 id，避免漏节点或重复节点。

## 生产级结构深度门禁

- 结构深度判断必须通用化：先用 bounds、重复方向、近似尺寸、原 sibling 连续性和可交互/可复用意图判断类型，再决定命名。禁止把某个页面的业务名、坐标、node id、图层 index 范围写成规则。
- 纵向重复的多行/多卡片结构默认是列表候选；最终结构必须是 `[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]`，或在计划摘要中明确说明固定静态原因后使用 `[ListRoot] > [List] > [Item_*]`。
- 列表外层默认使用 `[ListRoot]`，内部必须保留 `[ScrollView] / [Viewport] / [Content]` 或 `[List]` 承载项。禁止把 `[Item_*]` 直接挂在列表根下。
- 横向重复的 Tab、日期、状态、步骤结构必须拆到可复用项层：`[TabBar] > [TabItem_*]`。检测逻辑不得依赖具体业务名称。
- 进度、里程碑、奖励进度等区域必须继续拆成功能层，例如 `[ProgressBar]`、`[MilestoneBase]`、`[MilestoneTexts]`、`[MilestoneRewards]`；如果任一功能层仍包含大量重复奖励或刻度，继续拆到可复用子项。
- 任一语义组 `directChildCount >= 12` 且没有子结构、静态豁免说明或工具分层 apply 计划，视为过粗计划；必须阻塞 apply，并要求展开到可复用 child units。
- 工具可以按层 apply，但计划和验收必须描述完整最终树。只生成顶层粗分组、apply 后再临时发现需要 `[ScrollView]` / `[Item_*]` / `[TabItem_*]`，属于不合格流程。

## MCP Relay Job 协议

只读分析：

```json
{
  "type": "FIGMA_HIERARCHY_CLEANUP_ANALYZE",
  "target": { "nodeId": "4765:408", "fileKey": "...", "url": "..." },
  "options": { "includeHidden": true, "includeScreenshot": true, "maxDepth": 8 }
}
```

确认后应用：

```json
{
  "type": "FIGMA_HIERARCHY_CLEANUP_APPLY",
  "target": { "nodeId": "4765:408" },
  "plan": { "groups": [] }
}
```

确认后只重排直接子节点：

```json
{
  "type": "FIGMA_HIERARCHY_REORDER_CHILDREN",
  "target": { "nodeId": "4765:408" },
  "plan": {
    "childNodeIds": ["bg-id", "tabs-id", "list-id", "header-id"],
    "expectedOrder": ["[Bg]", "[TabBar]", "[ListRoot]", "[Header]"]
  }
}
```

重排计划必须覆盖当前 root 的全部直接子节点，并验证节点集合不变、顺序符合计划、bounds 不漂移。

确认后创建 ComponentSet 变体并替换原成员为实例：

```json
{
  "type": "FIGMA_CREATE_COMPONENT_SET_VARIANTS",
  "target": { "nodeId": "4878:1207" },
  "plan": {
    "target": { "nodeId": "4878:1207" },
    "componentSetName": "Item",
    "variantProperty": "State",
    "replaceOriginalsWithInstances": true,
    "createBackup": true,
    "variants": [
      { "nodeId": "4878:1212", "value": "InProgress" },
      { "nodeId": "4878:1211", "value": "Claimable" }
    ]
  },
  "options": { "includeScreenshot": true },
  "assets": []
}
```

统一结果必须包含：

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

### 节点克隆备份

apply 计划支持 `createBackup: true`，在整理前自动复制整个根节点并隐藏。也可独立使用 `clone-node` 命令：

```powershell
python scripts/figma_hierarchy_cleanup_mcp_client.py clone-node --node-id "5088:2159" --output .tmp/figma-hierarchy-cleanup/clone_node_result.json
```

常用参数：
- `--no-hide-clone`：克隆后不隐藏（默认隐藏）
- `--no-backup-prefix`：不添加 `[Backup]` 前缀（默认添加）
- `--offset-x 200`：自定义横向偏移（px，默认原节点宽度+100）
- `--offset-y 50`：自定义纵向偏移（px，默认 0）

```json
{
  "type": "FIGMA_CLONE_NODE",
  "target": { "nodeId": "5088:2159" },
  "plan": {
    "nodeId": "5088:2159",
    "hideClone": true,
    "backupPrefix": true,
    "offsetX": null,
    "offsetY": null
  }
}
```

### 重命名支持

apply 的每个 group 可指定 `renameChildren`，在移动节点后自动重命名：

```json
{
  "name": "[Banner]",
  "childNodeIds": ["5088:2275", "5088:2277"],
  "renameChildren": {
    "5088:2275": "Common_Prefab_TipBtn_1_Btn",
    "5088:2277": "48_ui_kace_diban_1_Image"
  }
}
```

## 分组策略

- 保序分组优先：原直接子节点在新分组内保持原 sibling 顺序。
- 保视觉栈优先：新增分组的 root sibling 顺序必须按目标视觉遮挡关系排列；因为 MCP Relay apply 使用追加创建分组，计划中越靠后的 group 越在上层。
- 语义命名优先：`bg/background/背景` → `[Bg]`，`header/title/top/标题` → `[Header]`，`list/task/reward/mail/rank/card/item/列表/任务/奖励/邮件/排行` → `[ListRoot]`，`tab/day/state/lock/selected/页签/天/状态` → `[TabBar]`，`progress/milestone/reward/进度/里程碑/奖励` → `[ProgressSection]`。
- 坐标只做辅助，禁止纯空间聚类直接应用。
- **同名模式出现在不同空间区域时，必须先验证空间归属再分组。** 具体：如果两组节点名称结构相同（如都是 StickerPack + mask + text + stars），但 Y 坐标范围分别落在屏幕不同区域（如一组 y~862，另一组 y~1519），不能仅凭名称相似归为一组。必须先检查各自的绝对坐标是否落在更高层语义组的边界内，再按空间归属分配。名称匹配只用于发现候选关系，不替代空间归属判断。
- 任何语义组如果 `directChildCount >= 12`，且内部存在可识别的重复项、状态项或功能层，必须继续子整理；只保留一个大组通常不合格。
- 子整理先识别结构类型，再决定通用命名：横向重复状态项 → `[TabBar]` + `[TabItem_*]`；纵向重复内容项 → `[ListRoot]` + `[ScrollView]` / `[Viewport]` / `[Content]` + `[Item_*]`；进度条与里程碑 → `[ProgressSection]` + `[ProgressBar]` + `[Milestone*]`。
- 重复列表结构必须按行或卡片分组，例如 `[Item_1_Normal]`、`[Item_2_Selected]`、`[Item_3_Disabled]`；命名优先表达序号和状态，不把某个界面的业务词写进默认规则。
- 列表类 UI（任务列表、奖励列表、邮件列表、排行列表、商店列表、活动条目等）若存在滚动、动态增删、复用或后续转 Unity UGUI `ScrollRect` 的可能，优先整理为 `[ListRoot]` → `[ScrollView]` → `[Viewport]` → `[Content]` → `[Item_*]` 格式。
- 如果用户明确要求保留业务外层名，可以在最终命名阶段保留，但检测和默认计划仍必须按 `[ListRoot]` / `[TabBar]` / `[ProgressSection]` 的通用结构生成。
- 如果存在多行列表、卡片列表、可领取/已完成/锁定/禁用等重复状态行，禁止只生成一个粗粒度 `[ListRoot]` 大组；必须继续在列表根内生成 ScrollView 格式或至少生成二级 `[Item_*]` 分组。
- 列表项命名优先表达序号和状态，例如 `[Item_1_Normal]`、`[Item_2_Selected]`、`[Item_3_Completed]`、`[Item_4_Locked]`。
- 列表项内部仍保持原 sibling 顺序；九宫背景、奖励图标、按钮、进度条、文本等只移动到同一项，不修改视觉属性。
- **ScrollView 硬性判定规则**：当目标节点下存在 ≥2 个纵向排列的重复内容项时（可通过 Y 坐标判定——近似间距、类似内部结构、相同/近似宽度），**必须**使用 `[ListRoot] → [ScrollView] → [Viewport] → [Content] → [Item_*]` 结构。不允许跳过 ScrollView/Viewport/Content 直接把列表项挂在 [ListRoot] 或列表名下。只有以下情况允许豁免：目标节点是组件库内已确定高度且不可能滚动的片段、一次性静态展示且用户明确指定不要 ScrollView、或 MCP Relay 单次分组深度限制无法到达该层级（此时必须分批 apply）。豁免必须在计划摘要中写明原因。
- 固定少量静态展示项且明确无滚动需求时，可以不使用 ScrollView，但计划中必须说明原因。
- 横向 Tab、日期、步骤、状态切换结构必须按单个可交互项分组；业务明确是天数时可使用 `[Day1]`、`[Day2_Selected]`、`[DayN_Locked]`，通用页签使用 `[TabItem_1_Normal]`、`[TabItem_2_Selected]`、`[TabItem_N_Locked]`。
- 进度、里程碑、奖励进度区域必须按功能层分组，例如 `[ProgressBar]`、`[MilestoneBase]`、`[MilestoneTexts]`、`[MilestoneRewards]`；奖励图标和数量文本较多时，可继续拆成 `[Reward_1_*]` 等更细分组。
- 九宫切片节点必须作为原容器内部成员整体保留。
- PSD 导入后的层级清理不得只做顶层整理；凡是 `[ListRoot]`、`[ProgressSection]`、TaskList、RewardSlot、Milestone 等区域内部仍有可识别业务单元、重复项或功能 marker，都必须继续整理到可生产层级。
- TaskList 或其它 list-like 区域必须显式形成 `[ListRoot]` → `[ScrollView]` → `[Viewport]` → `[Content]` → `[Item_*]`。`[Item_*]` 不得直挂在 `[ListRoot]`、业务列表名或 `[Viewport]` 下。
- RewardSlot / Milestone 等业务单元应拥有对应的进度 marker、奖励图标、数量文本等业务成员，例如 `jdtbig3`、marker、tick 应归入对应 Milestone/RewardSlot；`[ProgressTrack]` 只保留轨道、填充和 slice 节点，不吞业务 marker。

## Repeat Cluster 回归门禁

当修改重复结构识别、自动整理计划、Progress/List/Day 归类逻辑，或用户要求证明“按重复度自动归类”时，必须运行 7 日任务 fixture 回归：

```powershell
node "<relay-root>\scripts\hierarchy_repeat_cluster_validator.js" --fixture 7day-task --rounds 100 --json
```

通过标准：

- Day、List、Progress 各 100 轮。
- 每轮打乱输入顺序、轻微扰动坐标、随机移除 optional 节点。
- `wrongAuto` 必须为 0。
- 自动通过轮次必须报告；若出现 rejected，必须说明是低置信保护还是算法退化。
- 不得把名称、路径或文本内容加入聚类评分来让 fixture 通过。

## 通用一步到位目标树

首次整理计划必须尽量展开到可生产使用的最终层级，而不是先粗分大组再二次整理。通用目标形态示例：

```text
[Bg]
[Header]
[CloseArea]
[ProgressSection]
├─ [ProgressBar]
├─ [MilestoneBase]
├─ [MilestoneTexts]
└─ [MilestoneRewards]
[ListRoot]
└─ [ScrollView]
   └─ [Viewport]
      └─ [Content]
         ├─ [Item_1_Normal]
         ├─ [Item_2_Selected]
         ├─ [Item_3_Completed]
         └─ [Item_N_Locked]
[TabBar]
├─ [TabItem_1_Normal]
├─ [TabItem_2_Selected]
├─ [TabItem_3_Locked]
└─ [TabItem_N_Disabled]
```

默认保留通用名 `[ListRoot]`、`[TabBar]`、`[ProgressSection]`。只有用户明确要求保留业务名时，才在分组正确后做命名替换；检测、计划和验收门禁仍按通用结构执行。

## 一步到位门禁

- 第一次提交给用户确认的计划必须包含完整最终树：列表要展开到 `[Item_*]`，Tab 要展开到 `[TabItem_*]`，进度/里程碑要展开到功能层。**只展示顶层粗分组 → 用户确认 → 再因子组拆分二次询问 = 不合格流程。** 必须一次展示完整树，用户确认后自动迭代到最终状态。
- 工具执行可以分层 apply，但设计计划和验收必须按一步到位结构组织；禁止把“工具分步”变成“需求二次整理”。
- 自动计划如果只生成 `[ListRoot]`、`[TabBar]`、`[ProgressSection]` 等大组，而内部仍有明显重复项或功能层，必须在 apply 前拦截并人工重建。
- 只有固定小组件、直接子节点很少且无可识别重复/功能层、用户明确要求只做一层、或分析信息不足时，才允许不继续展开；原因必须写入计划摘要。
- 当前 analyze 不存在的节点不得凭旧结果补建；缺失项只能报告并等待用户确认是否恢复。

## 完成后提示

每次整理、打组或 ComponentSet 变体替换执行完毕后，必须按阶段询问用户，而不是只发送一次泛泛提示：

1. 完整计划生成后询问：`完整层级整理计划是否确认执行？需要调整请指出位置；确认可回复“确认执行”或“按此执行”。本次确认只授权层级整理，不授权 ComponentSet/变体。`
2. 收到计划确认后只执行层级整理、必要重排和即时验证；此阶段禁止创建 Component、ComponentSet、Variant 或替换 Instance。
3. 层级验证通过后必须停止写入并询问：`层级整理已完成并通过验证，效果是否满意？需要调整请指出节点；只有回复“满意”或明确同义表达后，才会开始自动 ComponentSet/变体。`
4. 收到明确满意后执行 AutoComponentSet/变体和验证，完成后询问：`ComponentSet 变体替换是否满意？不满意请指出节点或变体；满意后我会继续询问是否还有自定义成组。`
5. ComponentSet 满意后询问：`是否还有自定义成组？如果有，请在 Figma 中选择节点并说明“把我选择的节点打组变体”；如果没有，请回复“整理完毕了”。`
6. 用户提出自定义成组后，执行 `query-selection`，回显选中节点并按对应手动选择或跨父级节点组 ComponentSet 流程处理；每轮完成后继续询问第 5 步，直到用户明确结束。
7. 用户在 `CustomGroupingLoop` 阶段回复“整理完毕了”“结束”“没有了”或同义表达后，停止循环并输出最终通知。

最终通知前仍必须提醒用户：

> 可以在 Figma 中手动选择其他节点，使用「选中做成组件变体然后替换」继续打组变体。

## 交付门禁

- root 尺寸不变。
- root 顶层直接子节点顺序必须符合计划中的视觉栈顺序；验证输出要包含实际 `directChildren` 顺序。
- 不得用固定组件名或固定 index 判定层级失败；只有实际顺序不符合计划中声明的视觉遮挡顺序时，才视为层级门禁失败。
- 原始直接子节点全部且仅一次进入计划分组。
- 隐藏节点也必须全部且仅一次进入计划分组；整理前必须使用 includeHidden 分析，禁止因为不可见而遗漏。
- 原始节点无删除。
- 分组前后原始节点 absolute bounds 误差小于等于 `0.01`。
- 顶层分组数量与计划一致。
- 使用 `FIGMA_HIERARCHY_REORDER_CHILDREN` 时，必须验证 `childSetPreserved`、`orderMatchesPlan`、`boundsPreserved`、`rootSizeUnchanged` 全部通过。
- 若任一语义组 `directChildCount >= 12` 且未继续子整理，必须在计划摘要中说明“固定静态小组件/无可识别子结构”等原因；否则视为计划过粗，不得 apply。
- 若计划包含 `[ListRoot]` 或任意列表语义，必须检查是否存在多行/多卡片重复项；存在时必须生成并验证 `[Item_*]` 或具体业务项分组，否则计划不合格，不得 apply。
- **禁用 `[ListRoot]` 直挂列表项**。`[ListRoot]` 必须是仅包含 `[ScrollView]` 一个子节点的包装容器；发现重复项时，禁止把列表项直接挂在 `[ListRoot]` 下，必须走 ScrollView → Viewport → Content 链。如果不使用，必须在计划摘要中写明”固定静态列表/无滚动需求”等原因。
- 若识别为可滚动或动态列表，必须优先使用 `[ScrollView]` / `[Viewport]` / `[Content]` 结构；如果不使用，必须在计划摘要中写明”固定静态列表/无滚动需求”等原因。
- `[ListRoot]` 整理完成后，验证结果必须包含列表项分组数量、每个列表项 childCount、原列表节点集合无遗漏无重复、bounds 漂移为 0 或不超过容差。
- 使用 ScrollView 格式时，验证结果必须额外确认 `[ScrollView]`、`[Viewport]`、`[Content]` 三层存在，且所有 `[Item_*]` 都归入 `[Content]`。
- `[TabBar]` 整理完成后，验证结果必须包含每个 `[TabItem_*]` 分组和 childCount，并确认普通态、选中态、锁定态、禁用态、文本、角标没有被遗漏。
- `[ProgressSection]` 整理完成后，验证结果必须包含 `[ProgressBar]`、`[MilestoneBase]`、`[MilestoneTexts]`、`[MilestoneRewards]` 等功能组和 childCount，并确认进度条切片、刻度、奖励图标、数量文本没有被遗漏。
- 计划、apply 结果、verify 结果中的中文元数据必须复查，禁止出现连续问号占位符或 Unicode U+FFFD 替换字符乱码。
- 每个 plan/report 生成后都必须立即做 UTF-8 检查；发现乱码时必须先修复 plan 文件再 apply，禁止把乱码 reason 或中文元数据带入 Figma。
- 最终交付如果来自 PSD→Figma→整理链路，必须汇总：PSD 导入 validation 关键计数、每次整理 apply 的 `allPass`、最终结构存在性、顶层视觉栈顺序、UTF-8 检查结果和 warnings。
- 自动生成计划必须经过人工审阅；若单个分组覆盖超过 70% 直接子节点，或语义组明显吞掉无关区域，必须重做计划。
- `blockingErrors` 为空。
- 截图存在或明确说明无法截图。

## 常见错误

- MCP Relay / `figmaMcpRelay` 连接失败：独立 Skill 任务只允许一次 `figma_health` 预检；插件窗口 AI 整理对话不得追加 health/端口探测，必须保留并报告脚本返回的原始连接错误。不要 fallback 到官方/通用 Figma MCP 直写。
- Figma 当前页面不一致：插件执行前必须通过节点切换到所属 Page。
- 忘记 includeHidden：隐藏 ImportBounds、占位、遮罩等节点仍属于原始结构，遗漏会导致节点集合校验不完整。
- 复用旧分析结果：二级整理必须重新 analyze 当前子节点，否则会按过期层级生成错误计划。
- 自动计划过粗：某一组吞掉 70% 以上直接子节点通常说明语义分类失败，必须人工重建计划。
- 分步确认子组：只展示顶层粗分组就等用户确认，确认后又因子组拆分再次打断用户。正确做法是一次展示完整最终树，用户一次确认后自动迭代完成。
- 大语义组未子整理：`[TabBar]`、`[ProgressSection]`、`[ListRoot]` 等组超过 12 个直接子节点却没有二级结构，通常说明计划仍然过粗。
- 用语义名称替代视觉判断：例如把某类组件固定放 index 0、最上层或最下层，而没有根据截图/设计画面确认实际视觉遮挡关系，属于不合格整理。
- 为了修 sibling 顺序重新导入 PSD：会产生新 root、浪费时间并可能引入新差异；应使用 `FIGMA_HIERARCHY_REORDER_CHILDREN` 全量重排当前 root 直接子节点。
- 重排只给局部节点：会导致节点集合校验不完整；重排计划必须包含当前父节点的全部直接子节点。
- 重复执行 ComponentSet：目标直接子节点已经是 `INSTANCE` 时再次执行会创建重复组件库和备份。必须先重新 analyze 当前目标，确认不是已组件化状态。
- 越过满意确认创建 ComponentSet：`PlanReview` 的确认只授权层级整理。即使 `[TabBar]`、`[Content]` 或其它 indexed sibling FRAME 已经成组，也必须先完成层级验证并进入 `SatisfactionReview`；只有用户明确满意后才允许进入 `AutoComponentSet`。
- 自动组件化写死界面：允许保留 `[ScrollView]` / `[Viewport]` / `[Content]`、`[ListRoot]`、`[TabBar]`、`[ProgressSection]` 等通用容器名，但 ComponentSet 检测必须靠同父级重复结构和 indexed sibling 命名，不得写死 `7日任务`、固定数量、坐标范围或 PSD 文件名。
- ComponentSet 未备份原节点：默认必须设置 `createBackup=true`，除非用户明确要求不保留原始成员。
- ComponentSet 计划变体缺漏：`variants` 必须覆盖目标中所有要替换的重复成员，执行后核对 `variantCount`、`replacedInstanceCount` 和 `contentChildCountPreserved`。
- 计划中漏节点：apply 必须阻塞，不得部分整理。
- 计划中重复节点：apply 必须阻塞，避免一个节点被移动两次。
- 列表粗暴归组：检测到多行/多卡片重复项时，只生成 `[ListRoot]` 或具体列表名而不生成 `[Item_*]` 是不合格计划，必须退回重新规划。
- 列表结构缺少 ScrollView：检测到可滚动、复用或动态列表时，直接把列表项挂在列表根下而不说明原因，属于不完整计划，必须补 `[ScrollView]` / `[Viewport]` / `[Content]` 或明确静态原因。
- 视觉漂移：必须用 absolute bounds 快照验证，失败则报告人工处理。
- 同名模式跨区域错误归组：两组节点名称结构相同（如都是 StickerPack + mask + text + stars），但 Y 坐标在不同区域，错误地归为同一语义组。必须先用坐标验证空间归属（落在哪个父容器边界内），再决定分配到哪一组，不能仅凭名称相似聚类。
- JSON 元数据乱码：计划或结果文件出现连续问号占位符或 Unicode U+FFFD 替换字符时，必须先修复 UTF-8 再交付。
- 通过 PowerShell 管道生成含中文 JSON：容易把中文元数据写成连续问号占位符；优先使用 UTF-8 文件脚本，或让计划元数据保持 ASCII，写入后必须做字节级校验。
- 跨备份帧移动节点导致坐标污染：ComponentSet 的 `createBackup=true` 会把原始节点移入备份 Frame 并重排坐标。**禁止**用 `move-nodes` 把备份帧中的节点移回原父级——备份帧坐标已被重排，移回后子节点坐标全部偏差。如需重新创建 ComponentSet，应 `clone-node` 整个目标父级并在 clone 上操作。
- **大JSON反复读取：** analyze 返回 >500KB 时，禁止 Read/重定向/cp 反复探查结构。必须立即用 `figma_analyze_reader.py` 一句提取摘要。否则会浪费 3-5 分钟写多版迭代脚本。这是当前最常见的效率杀手。
- **粗计划回读大报告：** 自动计划太粗、`largeGroups`、`sparseGroups` 或 `nonContiguousGroups` 时，禁止回读完整 `analysis_result.json` 或完整 detail tree。必须先读 `cleanup_plan_diagnostic.md`，只对具体问题组做定向重规划。
- **stdout 大段 JSON：** 默认不要打开 `--verbose-result`。完整 report 已写文件；stdout 只用于看状态、路径、warning code 和关键计数。
- **分析 JSON 未解包：** MCP tool `figma_submit_job` 返回的结果是 `{submitted:{...}, result:{requestId, result:{...}}}` 两层包装。`directChildren`、`nodes` 等实际数据在内层 `result.result`。直接传给 `plan_figma_hierarchy_cleanup.py` 或 `verify_figma_hierarchy_cleanup.py` 会因为找不到字段而报错 `"缺少 directChildren"`。写入 `.tmp/` 前必须用 Python 提取 `data["result"]["result"]` 再串行化。
- **内层包装未检测：** `directChildCount==1` 且唯一子节点是同尺寸 FRAME 时未意识到是冗余包装，重新 submit_job 或把外层当操作目标。第一步就应通过 `figma_query_node_children` 确认内层实际内容。
