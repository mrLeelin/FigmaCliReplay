---
name: psd-layer-to-figma
description: Import Photoshop PSD files into Figma while preserving PSD layer names, bounds, opacity, visibility, stacking order, available group hierarchy metadata, editable text metadata, text fill/stroke/drop-shadow effects, common component markers, name-marked nine-slice layers, and Unity-friendly post-import Figma hierarchy/name cleanup. Use when the user asks to upload/import a .psd to Figma as editable Figma layer nodes rather than a single flattened PNG, especially with Figma URLs, node IDs, PSD layers/layer hierarchy, PSD text layers, Unity UGUI follow-up import, or PSD layer names such as common_, common-, common btn, jiugong_, nine_slice_, nine-slice_, nine slice, or 9slice_.
---

# PSD Layer To Figma

## Hypothesis-Action-Verification Loop

Use this loop for every write or cross-phase operation. Treat each step as a hypothesis that can be disproved by live evidence, not as a linear checklist.

1. State the current hypothesis before acting.
2. Check for counter-evidence before writing.
3. Take the smallest reversible action that can advance or test the hypothesis.
4. Immediately verify with live MCP/script evidence.
5. If verification contradicts the hypothesis, stop that path, preserve rollback artifacts, revise the plan, and continue from the revised hypothesis.
6. Do not treat `status=completed` or `allPass=true` as semantic correctness; they only prove operation-level checks passed.
7. When a failure pattern repeats, add or request a script/validator gate instead of relying on judgment alone.

For PSD imports, layer names, prefixes, `common` markers, and semantic hints are reporting signals only. The manifest gates, Figma MCP Relay validation, screenshot evidence, and live Figma structure decide whether a write is correct.

## 当前强制执行策略：figmaMcpRelay 批量导入 + 插件组件缓存

- PSD 导入 Figma 的标准流程必须使用 `figmaMcpRelay` 完成；`<relay-root>` 下的插件和 runtime relay 只是 MCP server 的执行后端。
- Figma MCP Relay 插件负责目标节点解析、组件库索引、common 匹配、PNG `figma.createImage`、节点创建、Text、九宫/三切片、metadata、PSD index Z 顺序、完整验证与截图导出。
- 每次运行本 skill 提交 Figma 导入前，必须优先通过 `figmaMcpRelay.figma_health` 检查本地 companion；如果未运行，先执行 `powershell -ExecutionPolicy Bypass -File "<relay-root>\start_mcp_companion.ps1" -Mode mcp`。
- **【强制】PSD 批量导入必须使用 `scripts/submit_psd_import_job.py` 脚本**，因为它会做 `build_payload`（将 manifest 的相对路径解析为绝对路径并构建完整 job payload），raw MCP `figma_submit_job` 的 `assetPaths.layersDir` 简写会被 MCP 框架截断导致超时或失败。`<relay-root>/client/figma_mcp_client.py` 作为脚本的后端 client 使用。`figmaMcpRelay.figma_submit_job` / `figmaMcpRelay.figma_wait_result` 只用于后处理（网格 Component 创建、层级整理等小型 job），**不得用于 PSD 批量导入**。
- MCP 默认 endpoint 是 `http://127.0.0.1:32130/mcp`，插件 URL 默认是 `http://localhost:32130`。这些是 MCP Streamable HTTP transport / runtime relay 地址，不是旧业务 HTTP 协议；AI 不得手写 POST `/jobs`、`/figma/pending`、`/figma/result` 或 `/assets/...`。如果必须走 CLI fallback，只能调用封装脚本，并显式传 `--file-key` 或 `--session-id`。
- 不要在正常流程使用 MCP `fullResult` 或 wrapper `--verbose-result`。完整结果只允许在有界 debug 时使用（`fullResult=true` 必须同时传 `debugFullResult=true`），并且 relay 会在返回给模型前剥离 inline base64。
- **【组件缓存刷新】使用 `figmaMcpRelay.figma_query_components` 查询组件库，通过 `refresh_component_cache.py --from-mcp` 写入新鲜缓存。禁止使用官方/通用 Figma MCP `use_figma` 查询组件库。** Figma MCP Relay 插件的 `code.js` 内置 `COLLECT_COMPONENTS` handler，直接在 Figma 插件内遍历 `62:115` 和 `2896:32` 并返回组件列表，不需要加载 `figma-use` skill。
- 导入后的网格 Component 创建、Variant 创建、层级整理等一次性分析操作，也应优先走 `figmaMcpRelay`/插件专用 job；只有用户明确批准 fallback 时才使用官方/通用 Figma MCP `use_figma`。
- 标准流程禁止使用官方/通用 Figma MCP `upload_assets`、`use_figma`、`get_screenshot` 承担**批量导入**、验证或截图。fallback 仅允许在 `figmaMcpRelay`/插件环境故障且用户明确允许时用于人工排查。
- 交付门禁以 MCP Relay result 为准：`status == "completed"`，缺图、空 fill、坏 transform、Text 裁切、Text 颜色/描边、切片结构、Z 顺序全部为 0。

## 边想边做执行契约

本技能默认按“小假设 → 最小动作 → 证据 → 继续/停止”的闭环执行。不要为了速度把导出、写入、结构化整理、Prefab 后续导入混成一个不可回退的大步骤。

| 检查点 | 当前假设 | 最小动作 | 证据 | 继续 / 停止条件 |
|---|---|---|---|---|
| 0. 目标锁定 | PSD 路径和 Figma 目标是本轮真实输入 | `figma_health`、`figma_query_selection`、确认 PSD 文件存在 | `fileKey/sessionId/page/targetNodeId`、PSD 路径和大小 | 目标 parent 不存在或会写到未知页面时停止；不要凭历史 nodeId 写入 |
| 1. 组件缓存 | 组件库可用，common 可复用 | `figma_query_components` 或 `refresh_component_cache.py --from-mcp` | 组件库/图片库 count、缓存路径 | 组件扫描失败按 5a 降级继续，但必须记录 warning；不要放弃基础导入 |
| 2. PSD 导出 | PSD 可以被当前脚本完整拆层 | `export_psd_layers.py --summary --match-cache` | stdout stats、`manifest_summary.json`、`semanticHints.psdPrefix`、warning count | `layerCount == 0`、导出异常或 summary 缺失时停止；warning 只按类型判断是否阻塞 |
| 3. 导入前确认 | 本轮将新增一个根 Frame，不改已有节点内容 | 读取 compact summary；必要时 `submit_psd_import_job.py --output` 做 payload dry-run | layer/common/text/nine-slice 数量、target、payload size | 目标、资源路径、manifest 来源不一致时停止；不要手抄坐标或颜色 |
| 4. Figma 写入 | Relay 能按 manifest 创建视觉一致节点 | `submit_psd_import_job.py --wait` | `[SUMMARY_JSON]`：`status`、gate counts、`createdCount`、截图、timeline | `stopAfterSummary=true` 时直接交付；任一 gate 非 0 只做针对性诊断 |
| 5. 后续结构化 | 用户确实需要 UGUI/Prefab 结构 | 先转交 `figma-hierarchy-cleanup-mcp` dry-run | repeat-cluster 置信度、唯一归属、validator | `semanticHints.psdPrefix` 只能辅助报告；不得绕过几何/validator/确认门禁 |

声明结论时必须只说证据已经证明的内容。例如：导入 gate 全 0 只能证明“PSD → Figma 导入链路成功”；如果 `semanticHints.psdPrefix.segmentCount == 0`，不得声称“数字前缀分段已在该 PSD 上验证通过”。

阶段证据脚本（只读）：

```powershell
python "<relay-root>\ai\skills\psd-layer-to-figma\scripts\psd_import_phase_evidence.py" `
  --artifact-dir ".tmp\psd-layer-to-figma\<run-dir>"
```

该脚本只读取 `manifest_summary.json`、`figma_mcp_result.json` 和可选 `timeline.json`，输出 `[PHASE_EVIDENCE_JSON]`。`decision=stop` 时不得继续 cleanup 或 Unity 导入；`decision=go` 只表示 PSD 导出和 Figma 写入证据通过，不代表 `semanticHints.psdPrefix` 已被几何/validator 证明。


## 核心流程

1. 用户调用 `$psd-layer-to-figma` 即为明确定位为 **PSD 分层导入**，不再重复确认。
2. 如果任务发生在某个 Unity 工程内，先读取该项目要求的知识库入口和任务路由文档；项目规则仅作参考，导入流程不因项目规范中断确认。
3. 对 Figma 写入、验证和截图默认走 `figmaMcpRelay`；不要在标准流程中调用官方/通用 Figma MCP `use_figma` / `upload_assets` / `get_screenshot` 承担批量导入。
4. 在执行 PSD 导出、读取 manifest 或写入 Figma 前，读取 `references/figma-layer-naming-unity-import.md`。这份规则是强制规则，不是可选建议。
5. **【组件缓存刷新】使用 `figmaMcpRelay.figma_query_components` 查询组件库，禁止用官方/通用 Figma MCP `use_figma`。** 运行 `refresh_component_cache.py <cache_dir> --from-mcp`，由插件在 Figma 内直接遍历 `62:115` 和 `2896:32` 并返回最新组件清单，自动写入缓存。禁用过期磁盘缓存，避免组件 ID 错误导致 common 全部降级。
5a. **【组件库扫描失败容错】如果 `figma_query_components` 超时、组件库节点不存在或 Figma 连接暂时不可用，不得直接放弃 PSD 导入。** 先报告 warning，再使用离线 manifest/cache、空组件库配置或 common 降级图片继续导入；只要导入 validation、视觉截图和 Z 顺序门禁通过，组件扫描失败本身不阻塞交付。
6. 用 `scripts/export_psd_layers.py` 导出 PSD 图层 PNG 和 `manifest.json`（带 `--summary --match-cache <fresh_cache>` 参数）。导出产物会在 `manifest.json` / `manifest_summary.json` 中写入 reporting-only 的 `semanticHints.psdPrefix`：只用于提示 PSD 数字前缀候选段，例如 `01_` 连续 TabBar、`29_` 连续 Bg、`60_` 连续 ListRoot；不得把这些 hint 当成几何聚类分数、自动分组依据或 Figma 写入授权。
7. 在导入 Figma 前先做 PSD 图层命名预处理：从 `rawPsdLayerName` 派生 `normalizedLayerName`，识别 `semanticMode`，写入 `normalizationWarnings`。`common_ btn`、`common btn`、`common- btn` 必须识别为 common 语义；`jiugong_ panel`、`nine slice panel`、`9slice panel` 必须识别为九宫语义。
8. 读取 `manifest.json`，在 Figma 目标页面创建一个根 Frame，尺寸等于 PSD canvas。
8a. **【导入前验证目标 parent】写入 Figma 前必须通过 MCP Relay 只读分析目标 parent/page：确认 nodeId 存在、类型可承载新根 Frame、MCP Relay 可切换到所属 Page。** 如果目标 parent 不可访问，先停止并报告；不得在未知页面或凭历史 nodeId 盲写。
9. 按 manifest 图层顺序创建子节点，设置名称、位置、尺寸、透明度、可见性，并写入 `rawPsdLayerName`、`normalizedLayerName`、`semanticMode` metadata。**AI 必须自动推断并设置每个导入节点的 Figma `constraints`，不得因为 PSD 没有显式约束信息而询问用户；优先使用 manifest 中的 `layer.constraints`，缺失时按本 skill 的“图层 Constraints 推断规则”用 PSD canvas 与 layer bounds 现场推断。** Figma MCP Relay 插件会自动在插件内实时建组件索引，不依赖 Python 侧缓存。
10. 如果 layer 的 `mode` 是 `common-component` 或规范化后等价 common 语义，必须先查通用组件；找到后创建 Instance；找不到时记录 warning，并按 `common-component > nine-slice > text > image` 降级。
11. 对普通图片层，如果 manifest 有 `componentSearch.strategy === "auto"`，先在通用图片库 `2896:32` 按名称绑定规则查询 `Common_` 图片组件，再走通用组件库 `62:115` auto 模糊查询；只有高置信命中才创建 Instance，中低置信只记录候选 warning 并保留图片层。
12. 如果 layer 的 `mode` 是 `nine-slice` 或规范化后等价九宫语义，按九宫父 Frame + `__slice_*` 子层创建，不要当普通单图导入；父层可以整理显示名，`__slice_*` 子层和 border metadata 不得改坏。
13. 如果 layer 的 `mode` 是 `text`，优先创建 Figma Text，并把导出的 PNG 只作为隐藏对照引用保留。
13a. **【强制】文字层的 fillColor 和 strokeColor 必须从 manifest 的 `text.fillColor` 和 `text.effects.stroke.color` 程序化读取，禁止手动硬编码任何颜色值。** 如果 manifest 过长无法一次读取，必须用脚本提取文字颜色数据。违反此规则会导致所有文字颜色错误。
14. 用 `figmaMcpRelay`/插件 runtime relay 直接读取 PNG 字节，在 Figma 插件内调用 `figma.createImage` 生成 `imageHash`。
15. 由 Figma MCP Relay 插件批量创建普通图层 image fill；九宫/三切片图层用同一 `imageHash` 为每个 `__slice_*` 设置 CROP fill。
16. 完成基础导入后，只整理本次导入根 Frame / Component 的名称、metadata 和必要的节点类型标记，默认不打组、不重组业务层级；以 PSD 原始 layer index 和视觉一致性优先。只有用户明确要求 UI 语义分组、UGUI 结构化或后续 prefab 导入结构时，才允许按 `references/figma-layer-naming-unity-import.md` 做 Group 转 Frame、Layout、ScrollView / Viewport / Content 等结构化整理，并且必须先说明影响并取得确认。
16a. 如果用户要求 PSD 导入后继续做 UI 语义分组、UGUI 结构化或后续 prefab 导入结构，禁止只整理导入根 Frame 的顶层。必须对 TaskList/list-like、RewardSlot、Milestone、Progress 等区域继续使用 `figma-hierarchy-cleanup-mcp` 的生产层级规则：列表显式 `[ListRoot]` → `[ScrollView]` → `[Viewport]` → `[Content]` → `[Item_*]`；RewardSlot/Milestone 保留自己的 marker（如 `jdtbig3`、marker、tick）；ProgressTrack 只放轨道、填充和 slice。
16b. 每次结构化 wrap/apply 后，必须重新 query 当前 Figma 真实结构，再判断下一步整理或验证；不得复用 PSD 导入初始 manifest、旧 analyze summary 或 apply 前的 children 顺序作为当前层级事实。
16c. PSD 导入后的重复 UI 结构整理不得按名称硬编码识别 Day/List/ProgressSection。必须先按 `figma-hierarchy-cleanup-mcp` 的 repeat-cluster 规则 dry-run：只用节点 `type`、几何 bounds、visible/opacity、childCount、isNineSliceLike、主轴间距、marker/edge-slot 几何打分；`name`、`path`、`characters` 只能用于报告。`confidence >= 0.85` 且节点全部唯一归属时才允许进入整理决策，否则只报告 dry-run 或拒绝。
16c-1. 如果导入 manifest 带有 `semanticHints.psdPrefix`，后续 cleanup 可把它作为 `figma-hierarchy-cleanup-mcp` 的 `--semantic-hints` 输入或诊断报告来源，帮助人工/Agent 发现“前缀连续但几何规划过粗”的区域。该 hint 仍必须保持 `hintOnly=true`，只能生成 dry-run 候选或报告，不得绕过 repeat-cluster、唯一归属、stale-plan preflight、validator 和用户确认门禁。
16d. `horizontal-list` 即使高置信也不得直接自动写入；必须先询问用户是否需要整理横向重复项。用户确认固定横向结构后，整理为直接 item：例如 `[DayList] > [Item_Day01..07]`，不得默认套 `[ScrollView]`。只有用户明确要求横向滚动时，才允许 `[ScrollView] > [Viewport] > [Content]`。
16e. Task/List 这类纵向重复内容项在高置信且唯一归属时必须继续整理到 `[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]`。若首次 dry-run 因九宫切片、遮罩或锁定层导致拒绝，必须审查 `expectedYCount`、`maxDepth` 和可见行数后重跑；不得因为一次错误参数拒绝就跳过 Task 整理。
17. **【强制】所有分批创建完成后，必须按 PSD 原始 layer index 对本次导入根 Frame 的直接子节点统一重排 Z 顺序。** 禁止保留“普通图片批次 > common 批次 > 九宫批次 > Text 批次”的创建顺序作为最终层级；否则九宫/大背景很容易覆盖图标、奖励、装饰图，造成“缺很多图”的假象。重排必须只移动本次导入根节点下的直接子节点，不得重建节点、不得重传图片、不得破坏 Text、common Instance 或九宫切片内部结构。
18. **【强制】缺图验证不能只看子节点数量。** 即使 root.children 数量等于 PSD 图层数，也必须继续验证 `imageHash`、空 fill 叶子节点、visible/opacity、越界、PSD index 顺序和大面积遮挡；“节点都在但被后创建的大九宫 Frame 遮挡”视为导入失败，必须先修正 Z 顺序再交付。
19. 由 Figma MCP Relay 插件验证：子节点数量、位置、尺寸、opacity、`imageFillCount`、Text 数量、common/auto Instance 数量、九宫结构、命名预处理 metadata、导入后整理结果、导入节点 constraints 都符合 manifest 和命名整理规则；额外要求 `missingNodeCount == 0`、`emptyImageFillCount == 0`、`badTransformCount == 0`、`textClipRiskCount == 0`、`textColorMismatchCount == 0`、`textStrokeMismatchCount == 0`、`sliceProblemCount == 0`、`indexOrderBad == 0`，且 constraints 不得缺失或与推断结果冲突，疑似大面积遮挡数量无异常。
20. 由 Figma MCP Relay 插件 `exportAsync` 导出根 Frame 截图（插件内部验证留存，不交付用户）。
21. **【可选-需用户确认】网格布局检测与 Component 属性推断**：导入完成后，对当前根 Frame 内的子节点做空间网格分析。如果检测到规律排列的网格布局，先向用户报告分析结果，**等待用户确认后再执行 Component 创建**。Component 创建必须通过 `figmaMcpRelay.figma_submit_job` 提交插件专用 job，不走官方/通用 MCP `use_figma`。

## 导出 PSD 图层

运行：

```powershell
python .agents\skills\psd-layer-to-figma\scripts\export_psd_layers.py `
  Doc\Psd\generated-1778059337516.psd `
  --out .tmp\psd-layer-to-figma\psd_layers_generated_1778059337516 `
  --composite-check
```

输出：

- `manifest.json`：canvas、图层名、bounds、opacity、visible、blend、sectionType、PNG 路径、通用组件搜索元数据、可编辑文字元数据、reporting-only 的 `semanticHints.psdPrefix`。
- `NN_<layer-name>.png`：每个 PSD 图层的透明 PNG。
- `composite_from_layers.png`：可选合成校验图。
- `composite_check.json`：可选合成校验数据。

脚本不依赖 `psd_tools`，但需要 Pillow。脚本支持 PSD v1、RGB/8-bit、Raw 和 PackBits RLE 通道数据。

## 命名预处理与 Unity 友好整理

执行 PSD → Figma 导入前，必须读取 `references/figma-layer-naming-unity-import.md` 并应用其中规则。

命名预处理发生在 PSD 导出后、Figma 写入前：

- 原始 PSD layer 名保留为 `rawPsdLayerName`。
- 规范化识别名写入 `normalizedLayerName`。
- 语义模式写入 `semanticMode`。
- 因美术命名不规范产生的修正写入 `normalizationWarnings`。

必须容错识别以下美术命名：

- `common_ btn`、`common btn`、`common- btn`、`common _ btn` 都视为 common 组件语义。
- `jiugong_ panel`、`jiugong panel`、`nine slice panel`、`nine-slice_panel`、`9 slice panel` 都视为九宫语义。

整理限制：

- 可以改 Figma 显示名，但不得动摇原本导入语义。
- common 图层必须先正确查找通用组件，再允许整理显示名。
- 九宫图层必须先正确创建九宫父 Frame 和 `__slice_*`，再允许整理父层显示名。
- `Common_Components` 来源的实例和内部子节点不要改名、不要改结构。
- 导入后只整理本次导入的目标根 Frame / Component，不要影响其它无关节点。

## PSD 通用组件层命名规则

当 PSD layer 名称以前缀 `common_` 或 `common-` 开头时，视为通用组件层，优先复用 Figma 文件内通用资源库：

- 固定库：`https://www.figma.com/design/ly2b1kkcvLtNBFPSQi4XO4/推币机_资源库?node-id=62-115`
- 固定搜索根：`fileKey=ly2b1kkcvLtNBFPSQi4XO4`，`nodeId=62:115`
- 固定通用图片库：`https://www.figma.com/design/ly2b1kkcvLtNBFPSQi4XO4/推币机_资源库?node-id=2896-32`
- 固定通用图片搜索根：`fileKey=ly2b1kkcvLtNBFPSQi4XO4`，`nodeId=2896:32`
- 示例：`common_RedBtn` → 候选 `RedBtn__ImportBounds`、`RedBtn`
- 示例：`common_RedBtn__ImportBounds` → 候选 `RedBtn__ImportBounds`
- 示例：`common_KaTongGreenBtn_1` → 候选 `KaTongGreenBtn_1__ImportBounds`、`KaTongGreenBtn_1`

如果美术命名写成 `common_ btn`、`common btn`、`common- btn`、`common _ btn` 这类变体，必须先规范化为 common 语义再做候选生成，不能因为空格或分隔符错误降级为普通图片。

优先级固定为：`common-component` > `nine-slice` > 普通图片。也就是说，`common_jiugong_xxx` 仍应先按通用组件复用处理。搜索必须使用 `figmaMcpRelay.figma_query_components` 或插件 job 生成的组件索引，禁止用官方/通用 Figma MCP `use_figma` 或 `search_design_system`；找不到匹配 Component/ComponentSet 时，记录 warning 并降级为普通图片层。

### PSD 通用图片库名称绑定规则

通用图片库固定为：

- `fileKey=ly2b1kkcvLtNBFPSQi4XO4`
- `nodeId=2896:32`

通用图片组件第一版采用名称绑定，不强制要求 Figma metadata 或本地 JSON 绑定表。组件命名必须使用：

```text
Common_<UnitySpriteName>
```

匹配时按以下方式规范化：

1. Figma Component/ComponentSet 名去掉 `Common_`、`Common-`、`common_`、`common-` 前缀。
2. PSD 图层名去掉可选的 `common_`、`common-`、`image_`、`img_` 前缀。
3. Unity/PSD/Figma 名称统一转小写，移除空格、连字符、下划线、方括号、圆括号和扩展名。
4. 规范化后完全相等才视为名称绑定命中。

示例：

```text
Figma: Common_UI_Attack_bg02
PSD:   UI_Attack_bg02
规范化后：uiattackbg02 == uiattackbg02
```

普通图片层 auto 查询时，必须先查通用图片库 `2896:32`：

1. 命中 `Common_` 图片组件且规范化名称完全相等时，创建该组件 Instance，保留组件原名，不再上传散图。
2. 未命中时，再进入通用组件库 `62:115` 的原有 auto 模糊查询流程。
3. 如果通用图片库中出现多个规范化名称相同的 `Common_` 组件，禁止自动选择，必须记录冲突 warning 并保留普通图片层。
4. 如果只是名称相似但不完全相等，只记录候选 warning，不自动替换。

`common_` 强制层查询顺序固定为：

```text
通用组件库 62:115 精确/标准化/模糊匹配
→ 通用图片库 2896:32 名称绑定匹配
→ common_ 视觉 pHash fallback
→ 仍失败才降级为普通图片层
```

创建通用图片 Instance 后，必须写入本次导入节点 metadata：

```text
rawPsdLayerName
normalizedLayerName
semanticMode
matchedComponentName
matchStrategy = common-image-name-binding
matchConfidence = 1.0
commonImageLibraryNodeId = 2896:32
```

共有图片 Instance 和普通共有组件 Instance 一样，导入后命名整理时禁止改名、禁止改内部结构。

### Common_Texture / Common_Prefab 尺寸规则

- `Common_Texture_*` 属于通用纹理复用，必须使用 PSD 图层尺寸、位置和 constraints；即使匹配策略不是 `image-library`，只要最终组件名、PSD 图层名或匹配名包含 `Common_Texture`，也必须按 PSD `x/y/w/h` 调整 Instance。
- `Common_Prefab_*` 属于通用模板复用，必须保留模板原生尺寸，并将模板中心对齐到 PSD 图层中心；禁止为了匹配 PSD 框而 resize 模板。
- 尺寸策略优先级固定为：`Common_Texture` 名称语义 > `Common_Prefab` 名称语义 > 明确的 image-library/component-library 匹配来源 > fallback。禁止只看 `matchStrategy`，因为离线匹配或精确命中可能返回 `exact-name`，会丢失 Texture/Prefab 尺寸语义。
- 验证时必须抽查 `Common_Texture_*` 的 Figma 节点宽高等于 manifest 图层 `w/h`；`Common_Prefab_*` 可以与 PSD 图层 `w/h` 不同，但中心点必须与 PSD 图层中心一致。

### 视觉匹配 Fallback

当 `common_` 强制层的名称匹配（精确/标准化/模糊）全部失败时，启用视觉匹配 fallback：

1. **组件截图缓存**：导入开始时，通过 `figmaMcpRelay` 组件索引 / 截图专用 job 对 `62:115` 子树内所有 Component/ComponentSet 生成截图缓存，并用 Pillow 计算 pHash（感知哈希，8x8 DCT）。如果当前 relay 没有该专用 job，记录 warning 并跳过视觉 fallback；不要改用官方/通用 `get_screenshot`。
2. **PSD 图层 pHash**：对名称匹配失败的 `common_` 图层，读取其导出的 PNG 计算 pHash。
3. **对比**：计算 PSD 图层 pHash 与所有组件 pHash 的 hamming distance。
4. **阈值**：
   - hamming distance ≤ 10 → 高置信命中，创建 Instance
   - 10 < distance ≤ 18 → 中置信，记录候选 warning，仍降级图片
   - distance > 18 → 不匹配
5. **尺寸预过滤**：只对宽高比差异 < 50% 的组件做 pHash 对比，避免无意义计算。
6. **仅 `common_` 强制层触发**：普通 auto 层不走视觉匹配（避免误命中），只有 `common_` 前缀的强制层在名称匹配失败后才 fallback。

视觉匹配的 Python 辅助脚本在 `scripts/export_psd_layers.py` 同目录下可扩展 `--phash` 参数，或在导入阶段由 Agent 直接用 Pillow 计算。

## PSD 普通层 auto 通用组件模糊查询规则

没有 `common_` / `common-` 前缀，且不是 `nine-slice` / `text` 的普通图片层，默认写入 `componentSearch.strategy = "auto"`。导入 Figma 时先尝试在 `2896:32` 通用图片库索引内做名称绑定查询，未命中时再尝试在 `62:115` 通用资源库索引内模糊查询，规则如下：

- 只在 `2896:32` 和 `62:115` 子树内查询，禁止使用 `search_design_system`。
- 通用图片库 `2896:32` 仅允许规范化名称完全相等时自动替换为 Instance；多个同名候选或相似名称候选只记录 warning。
- 先按候选名做精确匹配和标准化匹配；再用名称相似度、尺寸相似度、UI 关键词相似度做轻量评分。
- 普通 auto 层只有 `score >= 0.92` 且第一名领先第二名至少 `0.08` 时才自动创建 Instance。
- `0.80 <= score < 0.92` 或候选分差不足时，只记录候选 warning，继续保留普通图片层。
- `common_` 强制层可使用更低的高置信阈值 `0.88`，但仍需候选分差保护；找不到时必须 warning 并降级图片。
- auto 第一版不默认批量截图组件或计算 pHash；如果后续需要视觉匹配，再按“每次刷新轻量元数据、仅变更组件重算视觉特征”的索引策略扩展。

## PSD 九宫层命名规则

当 PSD layer 名称包含以下任一标记时，视为九宫层：

- `jiugong_`
- `nine_slice_`
- `nine-slice_`
- `9slice_`

如果美术命名写成 `jiugong panel`、`jiugong_ panel`、`nine slice panel`、`9 slice panel` 这类变体，必须先规范化为九宫语义再解析 border，不能因为空格或分隔符错误当普通图片处理。

推荐在名称中同时写明边框：

```text
jiugong_l88_b88_r88_t87_panel
nine_slice_left88_bottom88_right88_top87_panel
```

边框语义使用 Unity `spriteBorder` 顺序：`left,bottom,right,top`。如果只有九宫标记但没有边框数值，脚本必须自动推测 border，不能阻塞导入：

- 四边都缺失时，按图层宽高的 25% 推测：`left/right = width * 0.25`，`top/bottom = height * 0.25`。
- 只缺部分边时，优先用对边镜像补齐，例如缺 `left` 但有 `right`，则 `left = right`；仍缺的边再按 25% 推测。
- 推测值必须限制在对应轴向尺寸的一半以内，避免切片重叠。
- manifest 必须写入 `inferredBorder: true`、`inferMethod`、`confidence: "low"`、`inferredFields` 和 warning。
- 最终说明必须列出所有 `inferredBorder=true` 的图层，提醒在 Figma 中人工复核九宫拉伸效果。

### Agent 手动视觉审核九宫推算

当九宫层缺少显式 border，或脚本推算结果为 `inferredBorder=true`、`confidence!="explicit"` 时，优先使用半自动审核流程，让 Agent/人工看源 PNG 判断视觉边界，再由脚本校验并回填 manifest。

生成审核包：

```powershell
python "<relay-root>\ai\skills\psd-layer-to-figma\scripts\prepare_nine_slice_ai_review.py" `
  .tmp\psd-layer-to-figma\psd_layers\manifest.json `
  --out .tmp\psd-layer-to-figma\nine_slice_review
```

审核目录会生成：

- `review_index.json`：所有待审核九宫层索引。
- `*_candidates.json`：当前脚本推算、25% fallback 等候选。
- `*_review.json`：Agent/人工填写的审核结果。
- 对应源 PNG：用于观察圆角、描边、阴影等不可拉伸区域。

`*_review.json` 必须只写结构化结果：

```json
{
  "layerIndex": 12,
  "selectedBorder": { "left": 24, "bottom": 24, "right": 24, "top": 24 },
  "confidence": "high",
  "reason": "圆角和描边约 24px，中间区域适合拉伸",
  "needsHumanReview": false,
  "apply": true
}
```

回填审核结果：

```powershell
python "<relay-root>\ai\skills\psd-layer-to-figma\scripts\apply_nine_slice_ai_review.py" `
  .tmp\psd-layer-to-figma\psd_layers\manifest.json `
  .tmp\psd-layer-to-figma\nine_slice_review `
  --out .tmp\psd-layer-to-figma\psd_layers\manifest.ai_nine_slice.json
```

强制规则：

- Agent/人工只负责视觉判断 border，不能直接手改 Figma 九宫结构。
- 回填脚本必须校验 `left/right/top/bottom >= 0`、`left+right < width`、`top+bottom < height`，且单边不超过对应轴 50%。
- 回填脚本必须复用九宫 slice 生成逻辑，重新写入 `nineSlice.slices`、`inferMethod="ai-visual-review"`、`aiReview.reason`。
- 原始 manifest 不得被覆盖；默认输出 `manifest.ai_nine_slice.json`。
- `needsHumanReview=true` 或 `confidence!="high"` 的图层必须在最终说明中列出，并在 Figma 截图后人工复核。

## PSD 文字层导入规则

当 PSD layer 附加信息包含 `TySh` 时，脚本会把该层标记为 `mode: "text"`，并在 manifest 的 `text` 字段写入：

- `characters`：PSD EngineData 的 `/Text`，把 Photoshop 回车换算为 Figma 换行。
- `fontFamily`、`fontSize`、`leading`：从 `/FontSet` 和 `/StyleSheetData` 读取。
- `fillColor`：从 `/FillColor/Values [A R G B]` 读取；Figma 使用 `R,G,B` 的 0 到 1 通道。
- `effects.stroke`：只在 `lfx2/FrFX` 同时满足 `enabled=true` 且未隐藏时读取；`Sz` 映射 `strokeWeight`，`Opct` 映射描边 opacity，`OutF` 映射 `strokeAlign: "OUTSIDE"`。文字层隐藏/禁用描边不得写入 manifest，也不得导入 Figma。
- `effects.dropShadow`：只在 `lfx2/DrSh` 同时满足 `enabled=true` 且未隐藏时读取；隐藏/禁用阴影不得写入 manifest，也不得创建 Figma `DROP_SHADOW`。

Figma 导入文字层时：

1. 先 `await figma.loadFontAsync(fontName)`，原字体缺失时按 manifest 的 `figma.fontFallbackCandidates` 依次查找。
2. **【强制】替换字体后必须检查 Figma 中同类文字的 fontFamily + fontStyle，保持完全一致。** 例如 PSD 用 GROBOLD 不存在，Fig 中已有文字用的是 `Inter Bold`，则必须用 `Inter Bold` 而非 `Inter Regular`。不同 fontStyle 会导致视觉"大小不一致"。
3. 字号先按 PSD `fontSize` 1:1 写入，然后以原文字 PNG 的 `layer.width` 作为目标宽度迭代拟合 1 到 3 次；单行文字以**宽度为唯一约束**（高度差异由字体替换导致可接受），多行文字固定原宽度后按高度拟合。
4. 拟合后的比例必须写入 `setSharedPluginData("psd_layer_to_figma", "fontFallbackScale", ...)`；如果比例 `<0.5` 或 `>2`，必须输出 warning 并提示对照 `__png_reference_hidden` 人工复核。
5. **【强制】Text 必须使用 `textAutoResize="WIDTH_AND_HEIGHT"` 与 `lineHeight={unit:"AUTO"}`，创建后立即设置，然后按原中心点回摆。** 禁止固定小框导致文字折断。只有明确需要固定多行文本框且通过裁切验证时，才允许把 PSD `leading` 写入 `lineHeight: {unit:"PIXELS", value: leading}`。
6. 文本节点命名为 `NN_layerName__text`；原文字 PNG 节点改名为 `__png_reference_hidden` 并 `visible=false`，方便对照但不参与最终视觉。
7. 颜色必须直接从 manifest 的 `text.fillColor` 精确写入 Figma fills，使用 `{r, g, b}` 的 0 到 1 通道值，不做任何转换或近似。
8. 描边颜色从 `text.effects.stroke.color` 的 `{r, g, b}` 精确写入 Figma strokes，同样使用 0 到 1 通道值。

## 图层 Constraints 推断规则

导入的每个图层节点（包括图片层、九宫父 Frame、通用组件 Instance、文字层）必须根据其在根 Frame（PSD canvas）中的位置自动设置 Figma `constraints`。这是 AI/导入器的自动职责，不需要用户标注，也不得在导入计划里把 constraints 作为待确认问题抛给用户。

推断数据来源固定为：

1. **优先使用 manifest**：如果 `layer.constraints.horizontal` 和 `layer.constraints.vertical` 已存在且值合法，直接使用。
2. **manifest 缺失时 AI 自动推断**：使用 `canvas.width`、`canvas.height`、`layer.x/y/width/height` 推断。
3. **写入范围**：普通图片 Rectangle、Text、common/auto Instance、九宫/三切片父 Frame 都要写入；九宫/三切片的 `__slice_*` 子层继续使用切片固定 constraints。
4. **记录来源**：如果是现场推断，必须在 warning 或 metadata 中标记 `constraintsInferred=true` / `constraintSource=inferred-from-bounds`，便于复核。
5. **禁止默认全 MIN**：除非规则推断结果确实是 `MIN/MIN`，不得为了省事把所有节点统一设置为 `{horizontal:"MIN", vertical:"MIN"}`。

- **水平方向**：
  - 图层宽度 > canvas 宽度 80% → `horizontal: "STRETCH"`（拉伸）
  - 图层左边距 < canvas 宽度 20% 且右边距 > canvas 宽度 20% → `horizontal: "MIN"`（靠左）
  - 图层右边距 < canvas 宽度 20% 且左边距 > canvas 宽度 20% → `horizontal: "MAX"`（靠右）
  - 图层中心 X 在 canvas 宽度的 25%~75% 之间 → `horizontal: "CENTER"`
  - 其他情况 → `horizontal: "MIN"`（默认靠左）
- **垂直方向**：
  - 图层高度 > canvas 高度 80% → `vertical: "STRETCH"`（拉伸）
  - 图层顶部距离 < canvas 高度 20% → `vertical: "MIN"`（靠上）
  - 图层底部距离 < canvas 高度 20% → `vertical: "MAX"`（靠下）
  - 图层中心 Y 在 canvas 高度的 25%~75% 之间 → `vertical: "CENTER"`
  - 其他情况 → `vertical: "MIN"`（默认靠上）

注意：判断顺序必须先判 `STRETCH`，再判边缘锚点，最后才判 `CENTER`。例如接近全宽的背景应为 `STRETCH/MIN` 或 `STRETCH/STRETCH`，不能因为中心点在画布中间被误判为 `CENTER`。

九宫层的 `__slice_*` 子层 constraints 仍按固定规则（见九宫切片部分），不受此规则影响。

## 文字 Alignment 推断规则

文字的 `textAlignHorizontal` 不能只依赖 PSD 的 Justification 值，必须结合文字在根 Frame 中的实际位置推断：

- 文字中心 X 在 canvas 宽度的 40%~60% 之间 → `"CENTER"`
- 文字左边距 < 文字右边距的 50% → `"LEFT"`
- 文字右边距 < 文字左边距的 50% → `"RIGHT"`
- 其他情况以 PSD Justification 为准

如果推断结果与 PSD Justification 一致，直接使用；如果不一致，以位置推断为准（因为 PSD 的 Justification 可能是段落对齐而非视觉对齐）。

## Figma 导入规则

- 目标 URL 的 `node-id=62-2087` 要转换为 `62:2087`。
- 如果目标 node 是 Page，直接在该 Page 上创建根 Frame。
- 如果目标 node 是 Frame/Section，优先在该容器内创建；否则创建到目标 node 所在 Page。
- 不能使用 `figma.currentPage = page`；必须 `await figma.setCurrentPageAsync(page)`。
- 每个 `figmaMcpRelay` 插件 job 创建或修改节点时必须返回所有 created/mutated node IDs。
- 写入 Figma 前必须完成命名预处理，并把 `rawPsdLayerName`、`normalizedLayerName`、`semanticMode`、`normalizationWarnings` 写入 manifest 或 Figma metadata。
- `common-component` 层必须先在通用组件库节点 `62:115` 子树内按 `candidateNames` 精确/标准化/高置信模糊匹配 Component/ComponentSet；然后在通用图片库节点 `2896:32` 子树内按名称绑定规则匹配 `Common_` 图片组件；不要全文件乱匹配，也不要使用 `search_design_system`。
- 普通图片层如果带 `componentSearch.strategy === "auto"`，只允许在 `2896:32` 通用图片库和 `62:115` 通用组件库索引内查询；高置信才替换为 Instance，中低置信必须保留图片并输出候选 warning。
- 标准流程不得使用官方/通用 `upload_assets`。PNG 必须由 `figmaMcpRelay` 插件读取 asset path，在插件内 `figma.createImage` 并设置 image fill。
- `text` 层必须优先创建 Figma Text；只有无法解析 `characters` 或无法加载任何候选字体时，才降级为 PNG 图片并输出 warning。
- PSD 文件里没有 `lsct/lsdk` 分组标记时，不要伪造 group；默认按平铺图层导入，并在最终说明写明“PSD 未检测到分组标记”。
- 九宫层必须参考 `prefab-to-figma` 规则：父节点保存隐藏源图 fill，子节点使用动态 1 到 9 个 `__slice_*`，并按 source rect 计算 CROP `imageTransform`。
- 基础导入完成后，默认只整理本次导入根节点内部的命名和 metadata，不做业务打组，不重组层级；不得修改其它无关节点，也不得修改 `Common_Components` 实例内部节点。
- 只有用户明确要求打组/结构化时，才允许按 `references/figma-layer-naming-unity-import.md` 整理层级；整理必须保证视觉不变（通过位置和尺寸参数验证），如果无法保证视觉一致，需要回滚整理结果。

## 历史错误防范

### 禁止手动硬编码文字颜色（2026-05-09）

**错误现象**：文字层颜色全部错误，例如 `change player` 应为黄色 #FFF8B9 却被设为白色 #FFFFFF，`Attack different player` 应为浅蓝 #7CF3FF 却被设为灰色 #808080。

**根本原因**：创建文字层时，Agent 手动构建了文字数据数组并凭记忆填写颜色值，没有从 `manifest.json` 的 `text.fillColor` 字段程序化读取。

**强制规则**：

- 创建文字层时，`fillColor`、`strokeColor` 必须直接从 manifest 的 `text.fillColor` 和 `text.effects.stroke.color` 字段精确读取，禁止手动估算、硬编码或简化为白色/灰色/黑色。
- 如果 manifest 内容过长无法一次性读取，必须用脚本提取文字层的完整颜色数据，不能省略或近似。
- 验证阶段必须对比每个文字层的 Figma fill color 与 manifest `text.fillColor.hex`，不一致时必须修正。

### common_ 层必须穷尽匹配手段（2026-05-09）

**错误现象**：`common_ closedb` 因精确名和标准化名都不匹配就直接降级为普通图片，没有尝试模糊匹配或视觉匹配。

**强制规则**：

- `common_` 前缀层必须依次尝试：精确匹配 → 标准化匹配 → 模糊评分匹配 → 视觉 pHash 匹配。只有所有手段都失败后才允许降级为图片。
- 模糊匹配时 `common_` 层使用更低阈值 `0.88`（而非 auto 的 `0.92`），并且要考虑名称中的语义关键词（如 `close`→`CloseBtn`、`db`→`Down`）。
- 降级为图片时，必须在输出中列出所有候选组件及其分数，让用户可以手动指定。

### 导入后必须输出匹配报告和整理结构（2026-05-09）

**错误现象**：导入完成后没有输出通用组件匹配详情和九宫信息，也跳过了必要的命名整理和结构报告。

**强制规则**：

- 导入完成后，必须直接输出以下报告（不等待确认）：
  - **通用组件匹配报告**：每个 `common_` 层的候选名、匹配方式、置信度、最终匹配的组件名，或降级原因和候选列表。
  - **九宫层报告**：每个九宫层的 border 值、推断方式、confidence、是否需要人工复核。
- 命名整理、metadata 校验和结构报告是**必须执行的步骤**，不可跳过。默认不打组、不重组层级；只有用户明确要求结构化时，才按 `references/figma-layer-naming-unity-import.md` 整理根 Frame 内的层级结构。

### 共有组件 Instance 禁止改名 + 默认禁止打组破坏视觉（2026-05-09）

**错误现象**：
1. 共有组件 Instance 被重命名为业务名（如 `KaToneGreenBtn_3` → `Attack_GoBtn_1`），丢失了组件来源信息。
2. 曾要求导入后强制打组，但后续发现默认打组/重组层级容易改变 z-order，导致视觉效果与 PSD 不一致。

**强制规则**：

- 共有组件 Instance（来自 `62:115` 通用组件库或 `2896:32` 通用图片库的 Instance）**禁止修改名称**，必须保留原组件名（如 `KaToneGreenBtn_3`、`Common_Down_1`、`Common_UI_Attack_bg02`）。
- 导入后的命名整理步骤中，只能重命名普通图片层、九宫层、文字层，不能动 Instance 名。
- 默认保持 PSD 平铺层级和原始 layer index 顺序，**禁止为了语义结构主动打组**，以保证视觉效果和 PSD 一致。
- 只有用户明确要求 UI 语义结构化/UGUI 分组时才允许打组；打组前必须说明可能影响 z-order 和视觉一致性，并等待用户确认。
- 确认打组时必须保持子节点的绝对位置不变（移入 Frame 后用 `node.x = absX - group.x` 换算相对坐标），并在打组后按 PSD layer index 校验视觉层级。
- **【强制】 当理解有歧义的时候除非我指定你推断否则你要主动问我.

### 组件库扫描失败不能阻断 PSD 导入（2026-05-14）

**错误现象**：PSD 导入前实时扫描 Figma 组件库超时或节点不可访问，Agent 因为拿不到最新组件索引而中断整次导入。

**强制规则**：

- 组件库扫描失败只影响 common/auto 复用质量，不等于 PSD 图层无法导入；必须优先保证 PSD 分层节点、图片 fill、文字、九宫/三切片和 Z 顺序正确写入。
- 允许使用离线 manifest/cache、空组件库配置或禁用实时组件扫描继续导入；common 未命中时降级为图片不是失败，但必须写入 warnings，并在最终说明列出降级图层、原因和候选信息。
- 导入前必须先验证目标 parent/page 可访问；目标不可访问才阻塞导入，组件库扫描超时不得作为阻塞条件。

### 最终交付必须包含导入 validation（2026-05-14）

**强制规则**：

- 最终说明必须列出 MCP Relay result 的关键门禁：`status`、`createdCount`、`directChildCount`、`missingNodeCount`、`emptyImageFillCount`、`badTransformCount`、`textClipRiskCount`、`textColorMismatchCount`、`textStrokeMismatchCount`、`sliceProblemCount`、`indexOrderBad`。
- 所有 warnings 都必须汇总；common 降级图片属于 warning，不属于失败，除非用户明确要求该层必须复用组件。
- 如果后续还执行了 Figma 层级整理，最终说明必须同时包含导入 validation、整理 apply 的 `allPass` 汇总、最终结构存在性和 UTF-8 检查结果。

### Common_Texture 被当成 Common_Prefab 导致尺寸错误（2026-05-14）

**错误现象**：`Common_Texture_Lock`、`Common_Texture_Toggle`、`Common_Texture_Timer` 等通用纹理复用成功创建 Instance，但节点宽高保留了模板原生尺寸，没有按 PSD 图层尺寸缩放，导致 MCP Relay validation 出现 `sizeMismatchCount`。

**根本原因**：尺寸策略只判断 `matchStrategy.includes("image-library")`。当离线 manifest 或精确匹配返回 `exact-name`、`exact-normalized-*` 时，即使组件名是 `Common_Texture_*`，也会错误走 `Common_Prefab` 的模板尺寸分支。

**强制规则**：

- 尺寸策略必须优先解析名称语义：`Common_Texture_*` 一律使用 PSD 图层尺寸；`Common_Prefab_*` 一律使用模板原生尺寸。
- validation 中若 `sizeMismatchCount` 来自 `Common_Texture_*`，视为阻塞问题；若来自 `Common_Prefab_*`，必须继续检查中心点是否对齐，不能直接当成错误。

## 验证门槛

完成前必须确认：

- **【强制】每个文字层的 Figma fill color 必须与 manifest `text.fillColor` 的 hex 值一致，不一致必须修正后才能交付。**

- MCP Relay result `status == "completed"`，并且 `missingNodeCount`、`emptyImageFillCount`、`badTransformCount`、`textClipRiskCount`、`textColorMismatchCount`、`textStrokeMismatchCount`、`sliceProblemCount`、`indexOrderBad` 全部为 0；这些数值必须在最终交付中明示。
- `manifest.json` 或 Figma metadata 包含 `rawPsdLayerName`、`normalizedLayerName`、`semanticMode`、`normalizationWarnings`。
- 原始名称中疑似 common 的图层都已匹配通用组件，或有明确降级 warning。
- 原始名称中疑似九宫的图层都已创建九宫父层和 `__slice_*`，或有明确降级 warning。
- 所有 common 匹配记录包含候选名、匹配方式、置信度和最终 Component/ComponentSet 名。
- `Common_Texture_*` 节点尺寸必须等于 manifest 的 PSD 图层 `w/h`；`Common_Prefab_*` 节点可保留模板原生尺寸，但中心点必须与 PSD 图层中心一致。
- 所有九宫层保留 border、source rect、imageHash、CROP transform metadata。
- 导入后节点层级符合 `references/figma-layer-naming-unity-import.md` 的检查清单。

## 需要更详细步骤时

读取 `references/figma-import-workflow.md`，里面包含 Figma 检查、建节点、上传、设置 image hash 和验证的代码模板。


### 描边必须检查 enabled 字段（2026-05-09）

**错误现象**：PSD 中描边为 `enabled: false`（存在但禁用）的文字层，在 Figma 中被错误地添加了描边。例如进度条数字（8、15、22、30）本不应有描边，却被加上了 `#260E0E` 描边。

**根本原因**：创建文字层时，只检查了 manifest 中是否存在 `text.effects.stroke` 数据（`hasStroke`），没有检查 `stroke.enabled` 字段。PSD 中"描边存在但禁用"和"描边不存在"是两种不同状态。

**强制规则**：

- 导出文字层效果时，必须先检查 PSD 效果的 `enab`/`present` 状态；隐藏或禁用的文字描边、阴影等效果不得写入 manifest。
- 创建文字层描边时，必须同时检查 `text.effects.stroke.enabled === true`，只有 manifest 中明确存在且启用时才在 Figma 中添加描边。
- 隐藏/禁用的描边数据不得保留到 metadata，也不得写入 Figma strokes；隐藏/禁用的 `dropShadow` 同理不得创建 Figma `DROP_SHADOW`。
- 验证阶段必须对比每个文字层的 Figma strokes/effects 数量与 manifest 中实际导出的文字效果状态，不一致时必须修正。

### 九宫 CROP imageTransform 禁止取倒数（2026-05-10）

**错误现象**：九宫层的 9 个 `__slice_*` 子节点视觉完全错误——每个 slice 只显示了极小的一块像素区域，拼起来不是完整的源图。例如 `__slice_top_left`（23×23）的 `imageTransform[0][0]` 值为 `8.47` 而不是正确的 `0.118`。

**根本原因**：计算 CROP `imageTransform` 时，错误地对归一化比例取了倒数（`1/scaleX`），并对偏移做了负号除法（`-translateX/scaleX`）。这是把"从节点空间到图片空间的逆变换"当成了"Figma 需要的正变换"。

**Figma CROP imageTransform 正确语义**：

矩阵 `[[a, 0, tx], [0, d, ty]]` 直接描述源图中被裁切显示的归一化区域：

```javascript
// 正确公式（强制使用）
imageTransform: [
  [sliceWidth / imageWidth,  0, sourceX / imageWidth],
  [0, sliceHeight / imageHeight, sourceY / imageHeight]
]
```

示例：源图 195×88，裁切 top_left 区域 (0,0,23,23)：
```javascript
// 正确 ✅
imageTransform: [[23/195, 0, 0/195], [0, 23/88, 0/88]]
// = [[0.118, 0, 0], [0, 0.261, 0]]

// 错误 ❌ 禁止取倒数
imageTransform: [[195/23, 0, 0], [0, 88/23, 0]]
// = [[8.478, 0, 0], [0, 3.826, 0]]
```

**强制规则**：

- 九宫 CROP fill 的 `imageTransform` 必须使用 `[sw/imgW, 0, sx/imgW], [0, sh/imgH, sy/imgH]`，其中 `sw/sh` 是 slice 在源图中的像素宽高，`sx/sy` 是 slice 在源图中的像素起点，`imgW/imgH` 是源图总像素尺寸。
- 所有矩阵值必须在 0~1 范围内（因为是归一化坐标），如果出现 >1 的值说明计算有误。
- 禁止对归一化比例取倒数（`1/(sw/imgW)`）或对偏移做负号除法。
- 验证阶段必须检查每个 `__slice_*` 的 `imageTransform` 所有值都在 [0, 1] 范围内，超出范围必须修正。

## 经验总结（2026-05-12）

### 标准执行时间预算（2026-05-12 更新）

| 步骤 | 操作 | 耗时 | 工具 |
|------|------|------|------|
| 1 | 插件查询 62:115 + 2896:32 组件库 | ~2s | `figmaMcpRelay.figma_query_components` |
| 2 | PSD 图层导出 + 摘要生成 | **3s** | export_psd_layers.py |
| 3 | MCP Relay 批量导入 100 层（含文字/九宫/验证/截图） | **~48s** | MCP Relay 批量通道 |
| 4 | 网格 Component 创建（7 slot） | ~8s | figmaMcpRelay 专用 job |
| 5 | 任务行 Component（5 行） | ~8s | figmaMcpRelay 专用 job |
| **总计** | | **~69s（有效操作）** | |

MCP Relay 导入 100 层约 48s（含字体加载、九宫切片、common 匹配、验证和截图），是硬等待时间。全流程有效操作约 80s，加上排查/阅读参考文档约 120s。

### 组件匹配（2026-05-12，2026-05-13 更新）

**必须使用 `figmaMcpRelay.figma_query_components` 查询组件库，禁止使用官方/通用 Figma MCP `use_figma`。**

- 每次 PSD 导入前，运行 `refresh_component_cache.py <cache_dir> --from-mcp`，由 Figma MCP Relay 插件在 Figma 内直接遍历 `62:115` 和 `2896:32` 并返回最新组件清单，自动写入缓存。
- 缓存供 `export_psd_layers.py --match-cache` 做离线匹配，但 Figma MCP Relay 插件的 `buildComponentIndexes` 会再次在插件内实时建索引，所以最终匹配以 MCP Relay 的组件索引为准。
- `figmaMcpRelay.figma_query_components` + `code.js` 的 `COLLECT_COMPONENTS` handler 负责查询，无需加载 `figma-use` skill。
- 已知问题：Figma 中的组件名可能含 `_Prefab_`、`_Texture_` 等中间前缀（如 `Common_Texture_Lock`），而 PSD 层名是 `Common_Lock`。Figma MCP Relay 插件的 `findBestComponentMatch` 使用名称相似度评分匹配，阈值 0.88，名称不匹配时可能降级。这种情况下需要在 manifest 中设置 `match.matched = true, match.matchedComponentId = "实际ID"` 强制匹配。

### 打组件原则（2026-05-12）

**figmaMcpRelay 负责批量导入，也负责后处理专用 job。**

| 操作 | 工具 | 原因 |
|------|------|------|
| PSD 批量导入（图片/text/九宫/common） | figmaMcpRelay → 插件 job | 批量高效，无 50k 限制 |
| 网格 Component、行列分组、层级整理 | figmaMcpRelay 专用 job | 保持同一插件执行和验证通道 |

后处理的标准方法：
1. 用 Python 从 manifest 中分析图层空间分布（坐标、尺寸、名称模式）。
2. 用 `figmaMcpRelay` 查询根帧子节点获取真实节点 ID。
3. Python 生成结构化 plan/job，不生成官方/通用 `use_figma` 脚本。
4. 提交 `figmaMcpRelay.figma_submit_job` 执行，并读取插件返回的验证报告。

注意：
- JS 变量名不能含 `/`、`+` 等特殊字符（`n_102_1999/2000` 非法）
- `createText()` 默认使用 Inter Regular 字体，必须先 `loadFontAsync` 再设 characters
- 用 `var` 代替 `let` 避免重复声明错误
- 一次 Node 被 `appendChild` 移入新父节点后，其原坐标变为相对新父节点的偏移

### 网格 Component 创建

详见末尾「网格布局检测与 Component 属性推断（后处理）」章节。

### refresh_component_cache.py 数据格式（2026-05-12）

**错误现象**：`refresh_component_cache.py --inline-comp` 传了 JSON 数组（`[{...}, {...}]`），报 `AttributeError: 'list' object has no attribute 'get'`。

**根本原因**：`save_cache()` 用 `comp_data.get("components")` 读取，期望 JSON **对象**（`{"components": [...]}`），但 `--inline-comp` 直接把传入的 JSON 字符串写入文件，传数组时文件内容就是数组而非对象。

**强制规则**：
- `--inline-comp` / `--inline-img` 必须传 JSON 对象：`{"components": [...], "libraryNodeId": "62:115"}`
- 更稳妥的方式：在 `figma_query_components` 查询结果 JSON 中直接保存对象格式，用 `--components file.json` / `--images file.json` 传文件路径

### manifest_summary.json 扁平格式无需额外验证（2026-05-12）

**经验**：`export_psd_layers.py --summary` 导出的 `manifest_summary.json` 使用扁平格式（`chars`、`fillColor`、`border`、`slices` 直接挂在 layer 顶层），Figma MCP Relay 插件的 `normalizeManifest` 同时兼容扁平格式和嵌套格式（`text.characters`、`nineSlice.slices`）。

**强制规则**：
- 直接提交 `manifest_summary.json` 给 MCP Relay，**不需要**读 `manifest.json` 全量确认九宫/文字格式
- 如需确认文字颜色、九宫切片等细节，直接从 summary 中读取，不要多花时间验证格式兼容性
- 节省约 30s 的 manifest 结构分析时间

## 性能优化工作流

### Figma MCP Relay 插件快速路径（推荐）

当 Figma Desktop 可运行开发插件时，优先使用 `figmaMcpRelay` 驱动本地插件，替代官方/通用 Figma MCP 的大量往返：

- 插件目录：`<relay-root>/`
- AI-facing MCP gateway：`<relay-root>/dist/index.js`，由 `powershell -ExecutionPolicy Bypass -File "<relay-root>\start_mcp_companion.ps1" -Mode mcp` 启动
- MCP CLI wrapper：`<relay-root>/client/figma_mcp_client.py`
- MCP endpoint：默认 `http://127.0.0.1:32130/mcp`（AI 连接 MCP tool；如果当前 MCP 配置使用其它端口，以配置为准）
- runtime relay：同一 Node gateway 内的 `/figma` WebSocket、polling fallback 和 asset/result endpoint（MCP server 与插件之间的内部通道）
- 详细流程：`references/figma-http-plugin-workflow.md`

工作流：

1. 用 `export_psd_layers.py --summary` 导出 `manifest_summary.json` 和 PNG。
2. 在 Figma Desktop 运行 `<relay-root>/manifest.json` 对应插件，并保持 UI 面板打开。
3. **【强制】PSD 批量导入必须使用 `submit_psd_import_job.py` 脚本**（脚本内部调用 `figma_mcp_client.py` 与 MCP Relay 通信，但会做 `build_payload` 解析相对路径为绝对路径）。`figmaMcpRelay.figma_submit_job` 只用于后处理（网格 Component、层级整理等小型 job），**不得用于批量导入**。
4. 插件优先通过 WebSocket `/figma` 接收任务，polling `/figma/pending` 仅作 fallback；插件直接 `fetch` PNG 字节并用 `figma.createImage` 生成 imageHash。
5. 插件在 Figma 内创建根 Frame、普通图片层、Text、common Instance、九宫/三切片和 metadata。
6. 插件把验证结果交回 runtime relay，提交脚本默认把完整结果写入 `figma_mcp_result.json`，并把截图 base64 另存为 PNG；stdout 只打印轻量摘要。只有需要排查具体 warning/error 时才读完整结果文件或使用 `--verbose-result`。

该路径用于替代：

- 多次 `upload_assets(count=5)` 获取上传 URL；
- 大段 `use_figma` JS 注入；
- 因 `use_figma` 50000 字符限制导致的分批执行。

若插件不可用、目标 Figma 文件未打开、common 组件 nodeId 不可访问，先修复 `figmaMcpRelay`/插件环境。只有用户明确批准 fallback 时，才允许使用官方/通用 Figma MCP，并且必须说明额外耗时和风险。

### 组件库索引缓存

避免每次导入都遍历 Figma 组件库。标准刷新入口是：

```powershell
python "<relay-root>\ai\skills\psd-layer-to-figma\scripts\refresh_component_cache.py" .tmp\psd-layer-to-figma\figma_cache --from-mcp
```

脚本内部调用 `figmaMcpRelay.figma_query_components`；后续导入直接读取 `component_library_cache.json` 和 `image_library_cache.json`。

### 预计算 constraints

在 `export_psd_layers.py` 导出阶段就根据图层位置和 canvas 尺寸计算好 constraints，写入 manifest 的每个 layer：

```json
{ "constraints": { "horizontal": "CENTER", "vertical": "CENTER" } }
```

这样创建节点时直接设置，不需要额外一次 Figma 调用。

### 跳过无意义的 auto 匹配

对于 `图层 1`、`图层 2` 等明显通用名（中文"图层"开头 + 数字），在 manifest 中标记 `componentSearch.skipReason: "generic-layer-name"`，导入时直接跳过组件库查询。

### manifest 精简摘要（必须使用）

manifest.json 可能超过 2000 行，分多次读取浪费时间。导出阶段必须同时生成 `manifest_summary.json`，只包含导入所需的精简字段：

```json
{
  "canvas": { "width": 1146, "height": 2162 },
  "layers": [
    {
      "idx": 17, "name": "20", "mode": "text", "x": 373, "y": 1380, "w": 101, "h": 63,
      "opacity": 255, "visible": true,
      "fillColor": { "r": 1.0, "g": 0.91763, "b": 0.50195, "hex": "#FFEA80" },
      "stroke": { "enabled": true, "r": 0.4, "g": 0.204, "b": 0.024, "size": 4 },
      "chars": "20", "fontSize": 78,
      "constraints": { "horizontal": "CENTER", "vertical": "CENTER" }
    }
  ],
  "commonLayers": [...],
  "nineSliceLayers": [...],
  "imageLayers": [...]
}
```

Agent 只需一次读取 `manifest_summary.json` 即可获得全部导入数据，禁止分多次读取完整 manifest。导入后也不要把 `figma_mcp_result.json` 整体读入 LLM；先看 `submit_psd_import_job.py --wait` 的 `[SUMMARY_JSON]`，再按需针对 warning/error 样例或验证字段做小范围读取。

`manifest_summary.json` 顶层包含 `semanticHints.psdPrefix`，`submit_psd_import_job.py --wait` 的 `[SUMMARY_JSON]` 会输出 prefix hint 的段数、覆盖率和候选段摘要。结构化整理时先用这些摘要决定是否进入 cleanup dry-run，不要为了找前缀段读取完整 manifest 或 Figma result。

### 导入结果摘要（必须使用）

**【强制】PSD 批量导入必须使用 `submit_psd_import_job.py` 脚本**（`assetPaths.layersDir` 简写在 raw MCP tool 中会被截断导致超时，脚本的 `build_payload` 会正确解析为绝对路径）。标准命令：

```powershell
python .claude\skills\psd-layer-to-figma\scripts\submit_psd_import_job.py `
  .tmp\psd-layer-to-figma\psd_layers_xxx\manifest_summary.json `
  --root-name "source.psd_xxx" `
  --file-key "ly2b1kkcvLtNBFPSQi4XO4" `
  --wait
```

禁止手写 POST `/jobs`、`/figma/pending`、`/assets` 等裸 HTTP 流程。

重复导入测试快速路径：

- 先用 MCP tools 完成本轮 `figma_health`、`figma_query_selection`、`figma_query_plugin_status`，确认 `fileKey`、页面和选区。
- **【性能防退化】先刷新组件缓存，再执行 PSD 导出；禁止先导出一次、刷新缓存后再导出一次。** 只有组件缓存刷新失败且按本 skill 规则决定降级继续时，才允许直接导出一次并带 warning。不要为了“先看摘要”做探测性导出；导出结果本身就是导入输入。
- 提交时可加 `--fast-repeat` 跳过脚本内部重复 preflight；必须同时传 `--file-key` 或 `--session-id`。
- `--fast-repeat` 只跳过重复 target preflight，不跳过 MCP result gate、截图保存、截图 PNG 校验和 timeline 输出。
- 若 `status != completed`、任一门禁非 0、截图不存在或 warning/error 异常，立即退出快速路径，读取 `figma_mcp_result.json` 和 timeline 做慢速诊断；不要重新导入覆盖问题现场。
- 时间复盘必须区分真实总时间、机器执行时间、agent 决策/空窗时间；不要只报插件内部 `durationMs`。

重复导入命令示例：

```powershell
python .claude\skills\psd-layer-to-figma\scripts\submit_psd_import_job.py `
  .tmp\psd-layer-to-figma\psd_layers_xxx\manifest_summary.json `
  --root-name "source.psd_xxx" `
  --file-key "ly2b1kkcvLtNBFPSQi4XO4" `
  --wait `
  --fast-repeat
```

输出规则：

- stdout 只展示 `rootNodeId`、`createdCount`、耗时、统计、验证 gate、warning/error 数量和少量样例。
- `[SUMMARY_JSON]` 中的 `timeline.machineTimeMs` 和 `timeline.events[]` 是标准时间证据；回答耗时问题时优先引用这些字段，不要再额外打开 `timeline.json`，除非摘要缺失或字段异常。
- `[SUMMARY_JSON].stopAfterSummary == true` 表示标准交付证据已经足够：`status=completed`、关键 gate 为 0、无 warning/error、截图存在。此时禁止再做全量 `figma_query_node_children`、全量 result 解析、截图路径反复探测或其它重验证；直接用摘要交付。只有用户明确要求结构/children 明细、某个 gate 失败、warning/error 非 0、截图不存在、或摘要字段缺失时，才进入慢速诊断。
- 完整插件结果写入 manifest 同目录 `figma_mcp_result.json`。
- 截图 base64 必须另存为 PNG，并从 JSON 中移除，避免结果文件和 LLM 上下文暴涨。
- 只有定位具体失败时才打开完整结果；正常交付依据轻量摘要中的 validation gate 和文件路径。

### 性能防退化复盘规则（2026-06-07）

**错误现象**：一次 97 层 PSD 导入在 Figma Relay 已经完成后，Agent 继续做全量 children 查询、重复解析 result、中文截图路径二次探测和冗长报告整理，导致用户看到额外约 7 分钟等待。另一次流程还先导出 PSD，再刷新组件缓存，然后二次导出，浪费约 7 秒。

**根本原因**：

- 缓存刷新顺序放在 PSD 导出之后，导致第一次导出成为无效探测。
- Agent 没有把 `submit_psd_import_job.py` 的 `[SUMMARY_JSON]` 当成交付证据，而是在成功后继续做重验证。
- 中文文件名截图路径用手写字符串复核，触发编码显示问题后又额外绕了一次目录枚举。

**强制规则**：

- 标准顺序固定为：`figma_health/query_selection/plugin_status` → `refresh_component_cache.py --from-mcp` → `export_psd_layers.py --summary --match-cache` → `submit_psd_import_job.py --wait` → 读取 `[SUMMARY_JSON]` 交付。
- 每个 PSD 源默认只导出一次。禁止为了看 manifest 摘要先导出一遍；需要摘要就使用最终导出的 `manifest_summary.json`。
- 正常完成后以 `[SUMMARY_JSON]` 为准交付；如果 `stopAfterSummary=true`，不得再 query 根节点 children 或打开完整 result 做二次证明。
- 如果用户问“为什么慢/每步时间”，优先引用 `[SUMMARY_JSON].timeline.events[]` 的北京时间和 `machineTimeMs`；明确区分机器执行时间与 Agent 决策/空窗时间。
- 截图验证由脚本负责，Agent 只引用摘要中的 `screenshot` 和 validation 的 `screenshotFileValid`。不要用手写中文路径字符串再校验截图，避免编码问题造成假阴性和额外等待。

### 单次插件 job 创建全部节点（强制）

禁止按图层类型分多次官方/通用 `use_figma` 创建节点。必须在一次 `figmaMcpRelay` 插件 job 中完成：

1. 创建根 Frame
2. 创建所有图片层（设置 image fill）
3. 创建所有 common Instance
4. 创建所有九宫层（父 Frame + 9 个 __slice_*，设置 CROP fill）
5. 创建所有文字层（加载字体、设置颜色/描边）
6. 设置所有 constraints

这要求在调用前把所有数据（assetPaths、组件匹配结果、文字颜色、constraints）全部准备好，一次性传入 MCP job。

### 组件匹配离线化（强制）

组件匹配必须在 Python 侧完成，不需要 use_figma 实时查询：

1. 读取 `component_library_cache.json`（24h 有效）
2. 在 Python 中按名称精确/标准化/模糊匹配，输出匹配结果
3. 匹配结果写入 `manifest_summary.json` 的 `matchedComponentId` 字段
4. 插件 job 直接用 `figma.getNodeByIdAsync(id).createInstance()` 创建

禁止在官方/通用 `use_figma` 中做组件名搜索或遍历子树。

### 目标时间预算

| 步骤 | 目标耗时 |
|------|----------|
| 读取 manifest_summary.json | <5s（一次读取） |
| figmaMcpRelay 提交 assetPaths | <5s |
| 插件 fetch PNG + createImage | ~10s |
| 单次插件 job 创建全部节点 | ~30s |
| 验证 + 截图 | ~20s |
| **总计** | **~2 分钟**（不含用户交互） |

如果超过 5 分钟（不含等待用户确认），必须分析瓶颈并优化。

### 禁止手动转录坐标到 Figma 写入代码（2026-06-07）

**错误现象**：`jiugong_di_002` 在 Figma 中位置偏左。manifest_summary 中坐标正确（x=604），但 Agent 在构建 Figma 写入代码时手动抄坐标，把另一个九宫层 `jiugong_di`（x=453）的坐标错误地写到了 `jiugong_di_002` 上。

**根本原因**：Agent 从 manifest_summary 的终端输出中手动复制坐标到 JavaScript 数组，在多个同名前缀的图层之间抄串了行。

**强制规则**：

- 创建节点时，禁止手动将坐标从 manifest 转录到任何 Figma 写入代码中。必须由 `figmaMcpRelay` 插件 job 直接消费 manifest 数据，或使用 Python 脚本生成完整的 job 数据数组。
- 如果必须硬编码数据数组，必须用脚本自动生成该数组（如 `python -c "..."` 输出 JSON），禁止人工逐行抄写。
- 验证阶段必须对比每个节点的 Figma 绝对坐标与 manifest 中的 x/y 值，不一致时必须修正。

### 历史错误：use_figma 代码超 50k（2026-05-11）

**错误现象**：一次性生成 99 个节点的 JS 代码（56k chars），超出 `use_figma` 的 `code` 参数 50000 字符限制，导致执行失败。

**根本原因**：每个图层的创建代码约 400-600 chars，99 个图层加上九宫层的子节点和文字层的字体加载，总代码远超限制。

**当前规则**：

- 标准流程不再生成官方/通用 `use_figma` 创建脚本，也不再按 50k 限制拆批。
- 必须将 manifest、assetPaths、组件匹配和验证要求通过 `submit_psd_import_job.py` 脚本提交给 `figmaMcpRelay`，由插件专用 handler 一次性消费结构化数据。
- 如果用户书面同意 fallback 到官方/通用 Figma MCP，才允许参考此历史限制，并且必须在最终报告中标记 fallback 风险。

**错误现象**：`jiugong_di_002` 在 Figma 中位置偏左。manifest_summary 中坐标正确（x=604），但 Agent 在构建 Figma 写入代码时手动抄坐标，把另一个九宫层 `jiugong_di`（x=453）的坐标错误地写到了 `jiugong_di_002` 上。

**根本原因**：Agent 从 manifest_summary 的终端输出中手动复制坐标到 JavaScript 数组，在多个同名前缀的图层之间抄串了行。

**强制规则**：

- 创建节点时，禁止手动将坐标从 manifest 转录到 Figma 写入代码中。必须由 `figmaMcpRelay` 插件 job 直接消费 manifest 数据，或使用 Python 脚本生成完整的 job 数据数组。
- 如果必须硬编码数据数组，必须用脚本自动生成该数组（如 `python -c "..."` 输出 JSON），禁止人工逐行抄写。
- 验证阶段必须对比每个节点的 Figma 绝对坐标与 manifest 中的 x/y 值，不一致时必须修正。

### 关闭按钮等全局控件禁止因结构化整理而被遮挡（2026-06-07）

**错误现象**：`Common_CloseBtn_1` 被放入 `Header_Layout` 分组，但 `Header_Layout` 在 z-order 中被 `Character_Layout`（包含大面积角色图）覆盖，导致关闭按钮不可见。

**根本原因**：结构化整理时按 Y 坐标范围把 CloseBtn 归入了 Header 区域，没有考虑它作为全局控件需要始终在最顶层。

**强制规则**：

- 默认不打组；如果用户明确要求结构化整理，关闭按钮（`CloseBtn`、`Close`）、返回按钮（`BackBtn`）、遮罩层（`Mask`、`Overlay`）等全局 UI 控件，必须保留在根 Frame 的最顶层（children 数组末尾），不得放入任何内容分组。
- 结构化整理时必须先识别全局控件列表，将其排除在分组逻辑之外，最后统一 append 到根 Frame。
- 全局控件的判断依据：名称包含 `Close`、`Back`、`Mask`、`Overlay`，或 constraints 为 `MAX`+`MIN`（右上角定位）的小尺寸按钮。

### 九宫前缀图层必须先判断形状适配性（2026-05-11）

**错误现象**：所有带 `jiugong_` 前缀的图层都被无条件做成 9-slice 结构（9 个 `__slice_*` 子节点），即使图层尺寸明显不适合九宫拉伸。例如 `jiugong_rewares_jdt1`（806×50 的扁平进度条）被做成 9-slice，纵向 top=4 + bottom=4 只有 8px，中间 42px 完全没有拉伸意义；`jiugong_rewares_jdt3`（68×70 的小圆点）也被做成 9-slice。

**根本原因**：只检查了图层名是否包含 `jiugong_` 前缀就一律创建 9-slice，没有根据图层实际尺寸和形状判断适合哪种切片方式。

**强制规则**：

创建九宫结构前，必须按以下流程判断图层的切片类型：

```text
jiugong_ 前缀图层
  → 宽高都 < 100px 且宽高比在 0.5~2.0 之间？ → 降级为普通图片（不做九宫）
  → 宽高比 > 3:1，或高度 < 80px 且宽度 > 高度×3？ → 横向 3-slice（left/center/right，纵向不切）
  → 宽高比 < 1:3，或宽度 < 80px 且高度 > 宽度×3？ → 纵向 3-slice（top/center/bottom，横向不切）
  → 其他（宽高都 > 100px，比例在 0.3~3.0 之间） → 标准 9-slice
```

各类型的 Figma 结构：

- **普通图片**：单个 Rectangle + FILL image，无 `__slice_*` 子节点。
- **横向 3-slice**：父 Frame + 3 个子节点 `__slice_left`、`__slice_center`、`__slice_right`，每个子节点高度 = 图层完整高度。
- **纵向 3-slice**：父 Frame + 3 个子节点 `__slice_top`、`__slice_center`、`__slice_bottom`，每个子节点宽度 = 图层完整宽度。
- **标准 9-slice**：父 Frame + 9 个子节点（现有逻辑）。

验证：

- 创建后检查每个 slice 尺寸是否合理，不应出现 4px 高的 top/bottom slice。
- 对扁平图层确认只有 3 个 slice。
- 对小图层确认是普通图片。

### 禁止使用 MCP use_figma 直接写入 Figma（2026-05-12）

**错误现象**：MCP Relay 完成批量导入后，Agent 直接使用 MCP `use_figma` 对已导入的节点进行修改（修复九宫切片、补充文字描边），绕过了 MCP Relay 的统一写入通道。

**根本原因**：认为"修改已存在节点"不属于导入流程，没有触发 skill 规则检查。未先向用户说明情况并获取 fallback 许可。

**强制规则**：

- 任何时候禁止使用 MCP `use_figma` / `upload_assets` / `get_screenshot` 对 Figma 文件做任何写入操作，包括创建/修改/删除节点、设置属性、替换 Instance、修复导入后问题。
- 修复导入后的问题应通过以下方式之一：
  1. Figma MCP Relay 插件的增量 job/manifest
  2. Figma MCP Relay 插件新增专用消息处理器（如 `FIX_SLICES`）
  3. **用户明确要求且书面同意**使用 MCP fallback
- 唯一例外：MCP Relay 环境故障且用户明确书面同意 fallback 时，才允许使用 MCP 排查，并在完成后回退到 MCP Relay。

**相关错误报告**：`Doc/ReportError/PSD导入_禁止MCP直接写入Figma.md`

## 网格布局检测与 Component 属性推断（后处理）

导入完成后，如果根 Frame 内存在大量`平铺的、重复的子元素`（如每日签到、奖励列表、任务列表等），Agent**必须先探测并报告**给用户，**用户确认后才执行 Component 化**。

### 触发条件

在层级整理后（核心流程第 16 步完成），对根 Frame 内的平铺子节点做空间分析。**同时满足以下条件才触发**：

1. **X 轴规律重复**：至少 3 个图层/组的 X 坐标呈等差数列（公差 ±5px 以内）
2. **Y 轴一致**：这些图层的 Y 坐标在同一行范围内（上下浮动 < 20px）
3. **结构相似**：每个 X 位置有相似数量的子元素（数量差 ≤ 2）

满足时 → 检测为网格布局，进入分析报告流程。
不满足时 → 跳过，不询问。

### 分析流程

#### Step 1 — 空间网格检测

从根 Frame 的直接子节点中，按以下算法检测网格：

```python
def detect_grid(nodes):
    # 1. 按 Y 分组：相同 Y 行的节点
    rows = group_by_y(nodes, tolerance=20)

    # 2. 对每行检测 X 等差数列
    for row in rows:
        xs = sorted([n.x for n in row])
        gaps = [xs[i+1] - xs[i] for i in range(len(xs)-1)]
        if len(set(gaps)) <= 2:  # 最多两种间距（容差 5px）
            # 检测为网格行
            return row, median(gaps)

    return None  # 未检测到网格
```

#### Step 2 — Slot 对齐

把检测到的网格行按 X 位置分组，同一 X 位置的所有子节点归入一个 Slot：

```python
slots = {}
for node in row_nodes:
    x_key = round(node.x / step) * step  # 对齐到网格步长
    if x_key not in slots:
        slots[x_key] = []
    slots[x_key].append(node)

# slots 示例：
# slot 0: [bg_yq2, day_label, number_1, icon, qty]
# slot 1: [bg_yq1, day_label, number_2]
# slot 2: [bg_yq2, day_label, number_3, lock]
```

#### Step 3 — 差分分析

比较所有 Slot，区分**恒定元素**和**可变元素**：

| 分析维度 | 方法 | 产出 |
|---------|------|------|
| **名称匹配** | 按 node.name 分层命名关联 | 识别同名节点跨 slot 出现 |
| **类型匹配** | 相同 type(IMAGE/TEXT/INSTANCE) | 识别同类型节点 |
| **位置匹配** | 同一 slot 内相对 Y 相同 | 识别同位置的功能节点 |
| **值对比** | TEXT 的 characters / IMAGE 的 imageHash | 识别"值不同但角色相同"的节点 |

```python
def variance_analysis(slots):
    for each layer_name across slots:
        values = set()
        for slot in slots:
            node = find_node_by_name(slot, layer_name)
            if node:
                values.add(get_value(node))
        if len(values) == 1:
            mark_as_constant(layer_name)  # 所有 slot 值相同
        else:
            mark_as_variable(layer_name, values)  # 值不同 → 需要属性
```

#### Step 4 — Component Property 推断

根据差分结果，自动推断 Component Properties：

| 差分结果 | 属性类型 | 示例 |
|---------|---------|------|
| TEXT 类型，各 slot 值不同 | **TEXT** | number: "1","2","3"... → `dayNumber` |
| IMAGE 类型，部分 slot 有、部分无 | **BOOLEAN** | Lock 出现在 5/7 slot → `isLocked` |
| IMAGE 类型，大多数相同、少数不同 | **BOOLEAN** | 1/7 用 yq1, 6/7 用 yq2 → `isActive` |
| 同一位置出现不同图片 | **BOOLEAN (显隐)** | RewardIcon 只出现在 1/7 → `hasReward` |

推断规则：

```text
对每个可变元素 e:
  if e.type == TEXT and e 在各 slot 的值不同:
     推荐 → TEXT property (绑定 characters)
  elif e 只出现在部分 slot:
     推荐 → BOOLEAN property (绑定 visible)
  elif e.type == IMAGE and e 在部分 slot 使用不同的 imageHash:
     推荐 → BOOLEAN property (高亮图层覆盖)
  elif e 在各 slot 使用不同的 Instance:
     推荐 → INSTANCE_SWAP property
  else:
     标记为常量，不创建属性
```

#### Step 5 — 生成报告并等待确认

完成分析后，Agent**必须先输出报告**，**不能直接执行 Component 创建**。

报告格式：

```text
📐 检测到网格布局: 7 列 × 1 行
   步长: 133px, 每列尺寸: ~128×226

📊 差分分析结果:
   ┌──────────────┬─────────┬──────────┬──────────┐
   │ 元素          │ 类型    │ 差异      │ 推荐属性  │
   ├──────────────┼─────────┼──────────┼──────────┤
   │ bg          │ IMAGE   │ yq1(1x)  │ isActive │
   │             │         │ yq2(6x)  │ (BOOLEAN)│
   │ day_Label   │ TEXT    │ 全相同    │ 常量     │
   │ dayNumber   │ TEXT    │ 1,2,3... │ dayNumber│
   │             │         │          │ (TEXT)   │
   │ Lock        │ IMAGE   │ 5/7 有   │ isLocked │
   │             │         │          │ (BOOLEAN)│
   │ RewardGroup │ FRAME   │ 1/7 有   │ hasReward│
   │             │         │          │ (BOOLEAN)│
   └──────────────┴─────────┴──────────┴──────────┘

❓ 是否要将此网格转换为可复用 Component？
   Component名: C_{Feature}_{ItemType}
   属性: dayNumber(TEXT), isLocked(BOOL), hasReward(BOOL), isActive(BOOL)
   此操作会替换网格内所有散落节点为 Component Instance。
   
   确认执行？(y/N)  [等待用户输入]
```

用户确认后才创建 Component 并替换。用户拒绝则跳过。

#### Step 6 — 执行 Component 创建

用户确认后，按以下流程执行：

1. **提取每个 Slot 的首个完整实例作为参考 Frame**，包含所有恒定和可变元素
2. 用 `figma.createComponentFromNode()` 将其转换为 Component
3. 用 `addComponentProperty(name, type, defaultValue)` 逐一添加属性
4. 用 `componentPropertyReferences` 将属性绑定到对应子节点
5. **必须为每个使用默认值的实例调用 `setProperties()` 设置正确值**（因为默认值可能只对第一个 slot 正确）
6. 清除网格内的旧节点，替换为 Component Instance
7. 每个 Instance 调用 `setProperties()` 设置差异化值

代码模板：

```javascript
// 创建 Component
const frame = figma.createFrame();
// ... 设置子节点 ...
const comp = figma.createComponentFromNode(frame);

// 添加属性
const numKey = comp.addComponentProperty("dayNumber", "TEXT", "1");
const lockKey = comp.addComponentProperty("isLocked", "BOOLEAN", false);
const rewardKey = comp.addComponentProperty("hasReward", "BOOLEAN", false);

// 绑定属性到子节点
const numNode = comp.findChild(n => n.name === "dayNumber");
if (numNode?.type === "TEXT") numNode.componentPropertyReferences = { characters: numKey };

const lockNode = comp.findChild(n => n.name === "Lock");
if (lockNode) lockNode.componentPropertyReferences = { visible: lockKey };

// 创建 Instance 并设置属性值
for (const slot of slots) {
  const inst = comp.createInstance();
  parent.appendChild(inst);
  inst.setProperties({
    [numKey]: slot.number,
    [lockKey]: slot.hasLock,
    // ...
  });
}
```

### 最终交付

执行 Component 化后，最终交付必须包含：

- 报告网格检测参数（列数、步长、每列尺寸）
- 列出所有 Component Properties 及其推断依据
- 说明替换了多少个 Instance
- 如有无法映射的元素（异常值），单独列出

---

## 【强制硬规则】PSD 导入血泪教训：三切片与文字裁切，绝对禁止再犯

执行 `$psd-layer-to-figma` 时，以下规则优先级高于普通导入流程。不要把这些规则当建议，它们是必须通过验证的交付门禁。

详细规则文件：`references/psd-import-hard-lessons.md`。执行 PSD 导入、生成 Figma 图层、修复九宫/三切片或处理 Text 前，必须先阅读该文件。

### 1. h3-slice / v3-slice 禁止复用九宫中间行或中间列

错误做法：

- `h3-slice` 从九宫 9 个 slice 中筛选 `__slice_left / __slice_center / __slice_right` 的中间行。
- 这会让横向三切片只保留 `y=top, height=middleHeight`，直接丢失上边缘、下边缘、圆角和阴影。

正确做法：

- `h3-slice` 只切 X 方向，必须保留完整高度：
  - left：`x=0, y=0, w=left, h=fullHeight`
  - center：`x=left, y=0, w=center, h=fullHeight`
  - right：`x=left+center, y=0, w=right, h=fullHeight`
  - 每个子切片的 `imageTransform` 第二行必须是 `[0, 1, 0]`
- `v3-slice` 只切 Y 方向，必须保留完整宽度：
  - top/center/bottom：`x=0, w=fullWidth`
  - 每个子切片的 `imageTransform` 第一行必须是 `[1, 0, 0]`

强制验证：

- `h3-slice` 子切片数量必须为 3，且每片 `y=0`、`height=parent.height`。
- `v3-slice` 子切片数量必须为 3，且每片 `x=0`、`width=parent.width`。
- 所有 `imageTransform` 数值必须在 `[0,1]`。
- 发现不满足时，禁止交付，必须先修正。

### 2. Figma Text 禁止固定小框 + PSD leading 直接照搬 + 字体样式必须核对

错误做法：

- 把 PSD 文本框高度原样设置为 Figma Text 固定高度。
- 同时把 PSD 导出的 `leading` 直接写成 Figma `lineHeight`。
- 保持 `textAutoResize=NONE` 或只设为 `HEIGHT`（文字仍可能在宽度方向折断）。
- 替换字体时直接选 `Regular` 系列，没有检查 Figma 中同类文字实际用的是 `Bold` 还是其他样式。

这会导致：
- Figma 文字折断、裁切，尤其是描边数字和小高度文本。
- 字体样式不同导致视觉"大小不一致"（Regular 显瘦，Bold 显粗）。

正确做法：

- **【强制】替换字体前，先通过 `figmaMcpRelay` 只读文本/字体检查 job 或本次 MCP Relay 导出的 text metadata 检查 Figma 中已有同类文字的 `fontName.family` 和 `fontName.style`，确保替换字体与现有 UI 保持一致。禁止为此调用官方/通用 `use_figma`。**
- 可编辑 Text 默认使用：
  - `textAutoResize = "WIDTH_AND_HEIGHT"`（NOT 仅 `HEIGHT`，宽度也可能不够）
  - `lineHeight = { unit: "AUTO" }`（NOT `{ unit: "PIXELS", value: 0 }`）
  - 设置字符、字体、字号、描边后，按原中心点回摆，避免整体跑位。
- `WIDTH_AND_HEIGHT` 必须在同一个 `figmaMcpRelay` 插件 job 中设置（需要先 `loadFontAsync`）。
- 只有明确需要固定文本框排版时，才允许 `textAutoResize=NONE`，并且必须证明框高足以容纳字体和描边。

强制验证：

- 所有直接导入 Text 必须检查 `textAutoResize` 与 `lineHeight`。
- 如果 `lineHeight` 明显大于文本框高度，或者描边 Text 的框高小于 `fontSize + strokeWeight * 2`，必须自动修正或明确报告。
- 出现文字折断、裁切时，优先检查 `textAutoResize` 和 `lineHeight`，不要先猜字体问题。

### 3. 导入后必须做视觉关键规则验证

交付前不能只看节点数量。必须验证：

- h3/v3/9-slice 子切片数量和尺寸规则。
- `imageTransform` 是否全部在 `[0,1]`。
- Text 是否存在固定小框裁切风险。
- common 组件替换是否造成视觉偏差；如果用户要求像素还原，common 可以降级为 PSD PNG 原层。

验证必须基于具体节点数据（位置、尺寸、fill、opacity、子节点结构），不能仅依赖统计指标（如"count=12, all pass"）通过就交付。
