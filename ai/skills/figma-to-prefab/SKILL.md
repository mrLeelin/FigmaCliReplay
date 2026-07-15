---
name: figma-to-prefab
description: Figma node or component to Unity UGUI Prefab import or sync. Use when a Figma URL is paired with updating UnityPrefab, updating Unity Prefab, 导入 Unity, 同步回 Unity, sync to Unity, or creating a new uGUI Prefab plus PNG/Sprite assets. Preserves hierarchy, names, RectTransform size/position, TextMeshProUGUI text, Image/CustomImage sprites, Sprite GUID references, nine-slice borders, and reusable common components. Do not use for Unity Prefab to Figma or texture-only batch export.
---

# Figma To Prefab

## Hypothesis-Action-Verification Loop

Use this loop for every write or cross-phase operation. Treat each step as a hypothesis that can be disproved by live evidence, not as a linear checklist.

1. State the current hypothesis before acting.
2. Check for counter-evidence before writing.
3. Take the smallest reversible action that can advance or test the hypothesis.
4. Immediately verify with live MCP/script/Unity evidence.
5. If verification contradicts the hypothesis, stop that path, preserve rollback artifacts, revise the plan, and continue from the revised hypothesis.
6. Do not treat `status=completed` or `allPass=true` as semantic correctness; they only prove operation-level checks passed.
7. When a failure pattern repeats, add or request a script/validator gate instead of relying on judgment alone.

For Figma-to-Prefab imports, every phase must prove it still targets the same locked Figma root and the same Unity output location. Figma export success does not prove image processing, Prefab generation, Unity import, or visual verification success.

## Fast MCP Execution Contract

- 【强制】Figma 侧读取/导出必须使用 `scripts/figma_to_prefab_mcp_client.py` 脚本（脚本内部调用 MCP Relay）。脚本会做 `build_payload` 组装完整请求数据，避免 MCP tool 的 `assetPaths` 简写被截断导致超时。
- `figmaMcpRelay.figma_health` 等轻量查询仍可直接用 MCP tools。脚本统一使用 `--file-key` 指定目标文件。
- Figma plugin/runtime traffic may still use local HTTP/WebSocket internally. That is companion-to-plugin transport, not the agent-facing API. Do not hand-write `/jobs`, `/figma/pending`, `/figma/result`, or `/assets/...` calls.
- Export commands write full evidence to `figma_to_prefab_mcp_result.json`, `figma_node_manifest.json`, `image_export_manifest.json`, and `mcp_screenshots/`. Stdout is for `[SUMMARY_JSON]` only.
- Never paste or read full manifest/result JSON into LLM context for normal analysis. Read compact summary first, then use targeted reports for specific failing gates.
- Do not use MCP `fullResult` or wrapper `--verbose-result` for normal work. Full results require explicit bounded debugging (`fullResult=true` plus `debugFullResult=true`) and still strip inline base64 before returning to the model.
- If a detailed report is slow, inspect only gate counts first: `status`, `blockingErrorCount`, `warningCount`, exported/expected node counts, missing image count, text metadata missing count, slice metadata count, and result paths.
- `run_full_import.py` must write real wall-clock timing for every import attempt. Use `--wall-clock-report JellybeanUnity/.tmp/<name>_wall_clock.json` for named runs; the default is `JellybeanUnity/.tmp/figma_to_prefab_wall_clock.json`. Timing reports must stay outside `Assets/`.
- `run_full_import.py` is an execution accelerator, not a reasoning shortcut. After it runs, read its `[SUMMARY_JSON]`, wall-clock report, `spec_audit_report.json`, `image_process_report.json`, and `verify_prefab_result.json` as separate phase evidence. Do not collapse them into one vague “import succeeded” claim.
- `--skip-mcp-export` is allowed only when the manifest target guard passes: requested `fileKey + nodeId` must match manifest `fileKey + rootNodeId`, MCP result status must be `completed`, blocking error count must be zero, and any supplied root snapshot guards must match.
- For high-risk reruns, pass root snapshot guards: `--expect-root-name`, `--expect-root-width`, `--expect-root-height`, and `--expect-direct-child-count`. These guards prevent importing a child frame when the intended target is the full root frame.
- Evidence JSON files are not Unity assets. `verify_prefab_result.json`, wall-clock JSON, audit reports, and temporary import reports must be written under `JellybeanUnity/.tmp/` or a benchmark artifact folder, never directly under a Unity `Assets/...` root.
- Formal imports must not use benchmark placeholders or run folders. Do not create `Assets/FigmaImportBenchmark/<run-id>/Prefabs/Import_001.prefab` for a user-facing import. Prefer `run_full_import.py --infer-formal-names --formal-output-dir <Unity Assets folder>` so the Prefab name is inferred from the Figma root node and images go under `<Unity Assets folder>/Images/`.
- `Import_001`, `Import_###`, node-id folder names such as `seven_day_task_import_6284_1213`, and `Prefabs/Import_###.prefab` are benchmark/test artifacts only. If a user asks for a normal/new Prefab import, the target Prefab must be a formal business name directly under the selected target folder unless the user explicitly names a different business subfolder.

Use this skill only for **Figma node/component → Unity uGUI Prefab and required PNG/Sprite assets**.

## 边想边做执行契约

本技能默认按“先证明当前阶段，再进入下一阶段”执行。每一步都必须有结构化证据；不要把 Figma 导出、Spec 生成、图片写入、Prefab 写入、验证修复压成一次不可解释的大跑。

| 检查点 | 当前假设 | 最小动作 | 证据 | 继续 / 停止条件 |
|---|---|---|---|---|
| 0. 输入锁定 | 本轮 Figma 节点、Prefab 路径、图片目录、覆盖策略是明确的 | 读取插件提示词/用户输入；必要时 `figma_query_selection` 只读回显 | `fileKey/nodeId/rootName`、目标 Prefab、目标图片目录、overwrite policy | 缺少 Unity 写入目标时只做只读分析；不要用实时选区覆盖已锁定输入 |
| 1. 层级门禁 | Figma 节点适合导入 Unity | MCP Relay/analyze 读取 direct children，包含隐藏节点 | `directChildCount`、是否超过 15、cleanup 结论 | `directChildCount > 15` 或用户说未整理时先停到 cleanup；未通过 cleanup 不生成 export/spec/图片 |
| 2. Figma 导出 | Relay 能导出当前目标的完整结构和图片数据 | `figma_to_prefab_mcp_client.py` 导出 | `[SUMMARY_JSON]` 或 compact report、manifest/result/screenshot 路径、blockingErrors | `status != completed`、blockingErrors 非空、节点/图片/text/slice gate 失败时停止并针对性诊断 |
| 3. Spec 草案 | manifest 与目标 Unity 路径一致，且没有错目录/错 ID 空间 | `gen_spec.py --output-audit-report` | `spec_audit_report.json`、`manifestProvenance`、`image_download_plan.json`、componentset report | provenance mismatch、namespace mismatch、specMissing 或 blockingErrors 时停止；不要读错目录继续 |
| 4. 写入计划 | 用户确认要写 Unity 资源 | 输出影响文件、PNG/.meta/Prefab 路径、复用策略、验证方式 | 一次性确认记录、目标路径列表 | 未确认前禁止 `process_images.py` 写入 Assets，禁止 Roslyn 生成 Prefab |
| 5. 图片写入 | 图片计划与 manifest 来源一致，目标目录安全 | `process_images.py` | `image_process_report.json`、normal/reuse/nine-slice counts、blockingErrors | 写 0 图、reuse target missing、provenance/namespace 错误、九宫 oversize 未处理时停止或执行固化修复 |
| 6. Prefab 写入 | Spec 和图片已经满足生成条件 | `uloop execute-dynamic-code` 生成 component Prefab，再生成主 Prefab | CLI result、生成路径、Unity load/check evidence | CLI 执行失败时报告错误；不要手写 Prefab YAML |
| 7. 验证收口 | Prefab 可加载且基础 UI 规则通过 | `verify_prefab.py`、Unity load/importer check、必要 compile/log/screenshot | `allPass`、spriteNull、raycastTarget、autoSize、badImporters、截图差异 | 只修复报告明确指向的问题；截图/编译无法跑时明确验证缺口 |

最终说明必须分清“已经证明”和“尚未证明”：Figma 导出成功不等于 Unity Prefab 可用；`process_images.py` 通过不等于 Prefab 已生成；`verify_prefab.py allPass` 也不等于视觉截图已验收。

阶段证据脚本（只读）：

```powershell
python .figma\plugins\figma-mcp-relay\ai\skills\figma-to-prefab\scripts\figma_to_prefab_phase_evidence.py `
  --manifest-dir .tmp\figma-to-prefab `
  --unity-tmp JellybeanUnity\.tmp
```

该脚本只读取 `figma_to_prefab_request.json`、`figma_node_manifest.json`、`figma_to_prefab_mcp_result.json`、`spec_audit_report.json`、`image_process_report.json`、`verify_prefab_result.json` 和可选 wall-clock 报告，输出 `[PHASE_EVIDENCE_JSON]`。它会检查 request、manifest、MCP result、Spec provenance、verify Prefab 是否来自同一轮；`decision=stop` 时不得继续写图片、写 Prefab 或声称导入完成。

## 最开始必须执行：Figma 层级整理前置门禁

在读取、导出或生成任何 Prefab 相关产物前，必须先通过 MCP Relay/analyze 读取当前 Figma 目标根节点的直接子节点数量，并据此判断是否需要层级整理。

- 判断是否整理的唯一默认门槛是目标根节点 `directChildren` 数量：`directChildCount > 15` 视为未整理，必须停止 Prefab 导出流程并找用户确认是否先运行 `$figma-hierarchy-cleanup-mcp`；`directChildCount <= 15` 默认视为已整理，不需要再次向用户确认整理状态。
- 直接子节点计数必须基于包含隐藏节点的分析结果，避免隐藏 PSD/导入残留层绕过门槛。
- 如果用户明确指出当前节点未整理、仍是 PSD/导入原始扁平层级，或要求先整理，即使 `directChildCount <= 15`，也必须先按用户要求使用 `$figma-hierarchy-cleanup-mcp`。
- `$figma-hierarchy-cleanup-mcp` 必须只通过 `.figma/plugins/figma-mcp-relay` 本地 MCP Relay 操作 Figma，禁止使用 Figma MCP 写入。
- 整理计划必须按 `$figma-hierarchy-cleanup-mcp` 的规则生成、展示完整最终树并获得用户确认；整理 apply 后必须 verify 通过。
- 只有 `$figma-hierarchy-cleanup-mcp` 的最终结果满足 `allPass == true`、`blockingErrors` 为空、节点守恒 / bounds 不漂移 / UTF-8 / 最终截图等门禁通过后，才允许继续本 skill 的 Figma → Prefab 导出流程。
- 未完成整理或整理验证失败时，禁止生成 `.tmp/figma-to-prefab/figma_to_prefab_request.json`，禁止提交 Figma → Prefab MCP Relay 导出请求，禁止生成 `figma_node_manifest.json`、`image_export_manifest.json`、`prefab_spec.json` 或写入 Unity 资源。
- 阶段一摘要必须记录整理门禁结论：`directChildCount`、是否超过 15、是否已由用户确认运行整理，或 `$figma-hierarchy-cleanup-mcp` 的最终 `allPass` / `blockingErrors` 结果。

## 参考文档分层加载策略

AI 第一次加载时只读快速检查清单（~80 行）。后续按确定性的触发条件按需加载完整文档：

### 每次必加载（第一次）

- `references/figma-ugui-import-conventions.md`
- `references/json-spec-format.md`
- `references/workflow-figma-to-unity.md`

### 按触发条件加载

| 条件 | 加载文档 |
|------|---------|
| manifest 任意节点名匹配 `__slice_` | `references/pitfalls-figma-to-unity.md#九宫规则` |
| 九宫容器数 > 5 | `references/pitfalls-figma-to-unity.md` 全文 |
| manifest 任意节点 type=INSTANCE | `references/pitfalls-figma-to-unity.md#INSTANCE规则` |
| MCP Relay result.blockingErrors 非空 | `references/pitfalls-figma-to-unity.md` 全文 |
| 目标模式 = Sync(非 Create) | `references/pitfalls-figma-to-unity.md#图片同步规则` 全文 |
| INSTANCE 数 > 0 | `references/component-reuse.md` |
| `gen_spec.py` 报告中有 `specMissing` | `references/pitfalls-figma-to-unity.md#Spec与磁盘文件名一致性` |
| `process_images.py` 报告 oversize > 0 | 先读 `references/pitfalls-figma-to-unity.md#九宫最小尺寸规则`，然后**自动**调用 `crop_jiugong.py` 裁剪，无需等待用户确认 |
| `verify_prefab.py` allPass=false | 逐项检查失败项对应的 pitfalls 规则 |
| `verify_prefab.py` 报告 `raycastTargetOn` 非零 | **自动**调用 `postprocess_raycast.cs` 修复并重新验证，无需等待用户确认 |

### AI 职责

AI 不再做机械计算和手写报告。AI 的职责是：
- ✅ 调用脚本 → 读取脚本输出的 JSON/Markdown → 审核并转述给用户
- ✅ 对脚本报告的 WARNING/FAIL 逐项判断是否阻塞
- ✅ 根据触发条件加载对应参考文档
- ✅ 只基于结构化报告中的 `allPass`、`blockingErrors`、`warnings`、`summary`、`checks`、`artifacts` 做审核判断
- ❌ 不要手算坐标、border、MD5、尺寸
- ❌ 不要手写 Markdown 确认报告
- ❌ 不要逐节点审查 200+ 节点的 manifest
- ❌ 不要把终端输出中的坐标、颜色、文本、图片 hash 手动复制进 Spec、JS、C# 或报告

## 当前强制执行策略：全量 MCP Relay，不使用 Figma 侧远程工具主流程

- Figma → Unity Prefab 的标准流程必须使用 `figmaMcpRelay` 驱动 `.figma/plugins/figma-mcp-relay` 插件完成 Figma 侧读取、图片导出、截图导出和结果回传。
- Figma MCP Relay 插件负责目标节点解析、节点树导出、图片资源导出、文本与颜色元数据导出、九宫图候选元数据、组件复用标记、截图导出和 Figma 侧校验。
- MCP Relay 导出九宫图时必须携带 `sliceKind` 与 `sourceVisibleSize`：`9slice` 输出 `left+right+2 × top+bottom+2`；`h3slice` 输出 `left+right+2 × sourceVisibleSize.height`；`v3slice` 输出 `sourceVisibleSize.width × top+bottom+2`。父节点有 IMAGE fill 时优先使用父节点 `imageHash`，仅父节点缺失时才 fallback 到 `__slice_*` 子节点并记录 warning。
- 每次运行本 skill 解析 Figma 前，必须优先由 `figmaMcpRelay.figma_health` 检查本地 companion；如果未运行，先启动 `.figma/plugins/figma-mcp-relay/start_mcp_companion.ps1 -Mode mcp`。
- 专用 `figma_to_prefab_mcp_client.py` 是标准入口，内部调用 MCP Relay 提交导出请求、等待结果、保存 `figma_to_prefab_mcp_result.json`、`figma_node_manifest.json`、`image_export_manifest.json` 和 `mcp_screenshots/*.png`。
- MCP 默认 endpoint 是 `http://127.0.0.1:32130/mcp`，插件 URL 默认是 `http://localhost:32130`；如果当前 MCP 配置使用其它端口，以配置为准。AI 不得直接 POST `/figma/pending`、`/figma/result` 或 `/assets/...`。
- 标准流程禁止使用任何 Figma 侧远程工具承担节点读取、图片导出、截图或验证；如果 MCP Relay 环境不可用，必须停止并说明缺少的环境，不得自动切换到其它 Figma 通道。
- Unity 侧所有操作只使用 `uloop` CLI。编辑器内 C#、Prefab 生成和资源刷新使用 `uloop execute-dynamic-code`；编译、Console、截图和层级验证使用对应 `uloop` 命令。不得调用 Roslyn Gateway、UnitySkills 或其他 Unity MCP 执行通道。
- 交付门禁以 MCP Relay result 与 Unity 验证结果共同为准：MCP Relay `status == "completed"`，Figma 侧节点、图片、截图、九宫数据均无阻塞错误；Unity 侧 Prefab、Sprite、TMP、Raycast、编译和日志校验均通过。

## MCP Relay 协议与产物

### 导出请求：`figma_to_prefab_request.json`

主控 Agent 在阶段一只读准备时生成请求草案，写入 `.tmp/figma-to-prefab/figma_to_prefab_request.json`。写入 `.tmp` 之前仍需遵守仓库规则：列出计划、影响文件、验证方式并等待用户确认。

```json
{
  "task": "figma-to-prefab-export",
  "figma": {
    "url": "https://www.figma.com/design/FILE/NAME?node-id=1-2",
    "fileKey": "FILE",
    "nodeId": "1:2"
  },
  "unity": {
    "targetPrefabPath": "Assets/.../Example.prefab",
    "targetImageDirectory": "Assets/.../Images",
    "overwritePolicy": "create-new-only"
  },
  "export": {
    "includeHidden": false,
    "includeScreenshot": true,
    "includeImages": true,
    "flattenUnsupportedVectors": true
  }
}
```

### 节点清单：`figma_node_manifest.json`

MCP Relay 必须返回可直接转换为 Unity Prefab Spec 的节点清单，禁止 Agent 手动转录坐标。所有位置、尺寸、颜色、透明度、文本、层级、图片引用都必须来自 manifest。

```json
{
  "root": {
    "nodeId": "1:2",
    "name": "Panel",
    "width": 720,
    "height": 1280
  },
  "nodes": [
    {
      "nodeId": "1:3",
      "parentNodeId": "1:2",
      "path": "Panel/Title",
      "name": "Title",
      "kind": "Text",
      "x": 120,
      "y": 40,
      "width": 480,
      "height": 64,
      "opacity": 1,
      "visible": true,
      "text": {
        "characters": "标题",
        "fontSize": 36,
        "color": "#FFFFFF",
        "lineHeight": "AUTO"
      }
    }
  ],
  "warnings": []
}
```

### 图片导出清单：`image_export_manifest.json`

MCP Relay 必须导出图片资源清单，供主控 Agent 生成 `.tmp/image_download_plan.json` 和 `.tmp/prefab_spec.json`。

```json
{
  "images": [
    {
      "nodeId": "1:4",
      "nodePath": "Panel/Bg",
      "imageHash": "hash",
      "downloadUrl": "http://localhost:32130/assets/hash.png",
      "targetAssetPath": "Assets/.../Images/Bg.png",
      "expectedSize": { "width": 64, "height": 64 },
      "expectedMD5": "md5",
      "imageType": "Sliced",
      "sliceKind": "h3slice",
      "border": { "left": 12, "bottom": 12, "right": 12, "top": 12 },
      "sourceVisibleSize": { "width": 520, "height": 300 }
    }
  ],
  "warnings": []
}
```

### 截图与校验结果：`figma_to_prefab_mcp_result.json`

MCP Relay result 是 Figma 侧交付门禁。至少包含：

- `status`：必须为 `completed`。
- `exportedNodeCount` / `expectedNodeCount`：节点导出数量必须一致。
- `imageCount` / `missingImageCount`：缺图必须为 0。
- `textCount` / `textMetadataMissingCount`：文本元数据缺失必须为 0。
- `slicedImageCount` / `invalidSliceMetadataCount`：九宫元数据错误必须为 0。
- `screenshotPath`：必须存在本地截图路径，供 Unity 导入后对比。
- `warnings` / `blockingErrors`：`blockingErrors` 必须为空。

## 两阶段执行流程（性能优化）

本技能采用两阶段模式，将 AI 分析决策与批量脚本执行分离，大幅减少 LLM 往返次数。Figma 侧读取全部由 MCP Relay 一次性完成，Unity 侧写入全部由 JSON Spec + `FigmaPrefabGenerator` 完成。

### 阶段一：分析（MCP Relay 主导导出，主控 Agent 生成 Spec 草案）

0. **Figma 层级整理门禁**：先通过 MCP Relay/analyze 读取当前 Figma 目标根节点直接子节点数量；`directChildCount > 15` 判定为未整理，停止并询问用户是否先运行 `$figma-hierarchy-cleanup-mcp`；`directChildCount <= 15` 默认视为已整理，记录结论后继续本流程。
1. 加载 workflow、pitfalls、conventions、json-spec-format 参考文件。
2. 检查 Required Inputs：Figma URL 或 file key + node id、目标 Prefab 路径、目标图片目录、覆盖策略。
   - **初始确认只问一次**：Prefab 名称、图片目录、覆盖策略（这 3 项无法从 Figma 自动推断）
   - **插件提示词快照优先**：如果用户请求或插件生成的提示词已经包含 Figma fileKey/nodeId/selectionBlock、Unity Prefab 路径或图片目录，则这些值视为已锁定输入。后续 `figma_query_selection` 只能做只读回显或诊断，不能覆盖已锁定目标；实时选区为空或变化时，不要要求用户重新点击 Figma，除非缺少 fileKey/nodeId 或用户明确要求切换目标。
3. 环境检查（并行）：MCP Relay health、Unity 在线、目录存在、脚本可用。
4. 在用户已明确确认 Figma URL、目标 Prefab 路径、目标图片目录、覆盖策略以及允许写入 `.tmp/figma-to-prefab/figma_to_prefab_request.json` 后，生成 MCP Relay 请求并提交导出 → 等待结果。
   - 如果这些参数和 `.tmp` 写入授权已在 step 2 同一批次确认过，则无需重复确认；否则必须先输出计划、影响文件、验证方式和风险并等待确认。
5. 加载 Common_Texture 缓存索引 → 直接调用固化脚本生成 Spec：
   ```bash
   python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/gen_spec.py --figma-url "..." --target-prefab "..." --target-image-dir "..." --output-audit-report JellybeanUnity/.tmp/spec_audit_report.json
   ```
   `gen_spec.py` 默认会自动检测本节点内 ComponentSet，命中时写出 `JellybeanUnity/.tmp/figma_component_specs/*.json` 和 `JellybeanUnity/.tmp/componentset_report.json`，并把主 spec 中对应业务实例改为 `PrefabInstance + activeVariant`。Component Prefab 内会按实例名最后一个 `_` 后的状态后缀去重；例如多个 `*_Locked` 只保留一个代表 Variant，主 spec 的重复状态实例通过 `activeVariant` 指向该代表 Variant。LLM 只读取 `spec_audit_report.json`、`componentset_report.json` 和脚本生成的 Markdown 摘要，不手工统计 manifest。
   `INSTANCE` 复用公共 Prefab 时必须优先使用 MCP Relay manifest 的 `component.componentName`、`mainComponentName`、`componentSetName`，最后才回退到 Figma 节点名；节点名如 `Help_Btn` 不得阻止命中 `Common_Prefab_TipBtn_1` 这类真实组件名。
   所有 `ImageSpec.targetDir` 与 `image_download_plan.images[].targetAssetPath` 必须通过脚本的 Unity 资产路径 join 逻辑生成，禁止用字符串相加拼 `Assets/...` 路径，避免 `Assets/.../ExportTimerBackplate.png` 这类漏斜杠路径。
   Unity GameObject 显示名会自动去掉 Figma 层级开头的数字排序前缀，例如 `75--ui--main--view` → `ui--main--view`。只移除开头纯数字加分隔符，不移除业务名中间的数字，例如 `Level_75_Reward` 不变。
6. **批量确认（一次确认代替原来 3 次）**：输出以下完整摘要 → **等待用户一次性确认**：
   - MCP Relay result（status / 错误 / 警告 / 节点数）
   - Spec 预检结果（节点类型分布 / imageId 完整性 / childIndices 合法性）
   - 九宫容器最小尺寸门禁表
   - 图片去重 / Common_Texture 复用 / INSTANCE 降级汇总
   - 影响文件列表
7. 用户确认后直接进入阶段二，无需再次确认 MCP Relay 或 Spec。

### 阶段二：执行（uLoop CLI 主导 Unity 写入与验证）

**前置步骤 — 每次阶段二必做**：确认 Unity 工程路径为 `E:\Project\Work\JellybeanUnity\JellybeanUnity`，并使用 `uloop` CLI。不得调用 Gateway status，也不得根据其他工具返回结果猜测工程路径。

1. **并行合成九宫 + 导出图片** → 直接调用固化脚本：
   ```bash
   python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/process_images.py --manifest-dir .tmp/figma-to-prefab --output-dir <targetImageDir> --workers 6 --output-report JellybeanUnity/.tmp/image_process_report.json
   ```
   脚本负责：九宫 ThreadPool 并行合成或直接写入 MCP Relay 正确导出 → 普通图片 base64 解码 → Common_Texture 复用 → 文件名对齐。`--output-dir` 必须规范化到 Unity 工程目录；传入 `Assets/...` 时脚本应解析为 `JellybeanUnity/Assets/...`，并校验它与 `image_download_plan.json` 中非复用图片的 `targetAssetPath` 父目录一致，否则阻塞且不写文件。若 `targetAssetPath` 对应的 Unity PNG 已存在，必须直接复用现有文件，记录到 `existingImageReused` / `existingImageReuse`，禁止覆盖、删除后重建或重写 `.meta`。`white_1x1.png` 只允许在 Spec 实际引用 `builtin_white_1x1` 时创建；没有 SOLID fill 白像素引用时禁止创建。
   `INSTANCE` 父节点没有直接导出图时，脚本必须自动解析到唯一/最大可导出的子节点，并在报告中写出 `plannedNodeId`、`resolvedExportNodeId`、`resolvedReason`。
   **如果 `image_process_report.json` 中 `nineSliceSizeMismatch` 或 `nineSliceOversize > 0`**：在用户已确认阶段二图片写入范围后，读取报告的 blockingErrors 九宫尺寸列表 → 调用固化裁剪脚本（AI 无需手工裁剪）：
   ```bash
   python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/crop_jiugong.py --spec .tmp/prefab_spec.json --image-dir <targetImageDir>
   ```
   裁剪脚本负责：从全尺寸九宫源图中提取 9 个切片区域，使用 CROP 算法重排为最小可拉伸 PNG（`L+R+2 × T+B+2`）。缺失的副本图（duplicateOf）自动从原图复制。
2. **AssetDatabase.Refresh** → 使用 uLoop CLI 刷新 Unity 资源数据库：
   ```bash
   uloop execute-dynamic-code --code 'UnityEditor.AssetDatabase.Refresh(); return "Refreshed";'
   ```
3. **执行前门禁** → 读取 `image_process_report.json`，确认所有 spec image fileNames 对应的文件存在，且 `blockingErrors` 为空。
4. **Unity Prefab 创建** → `uloop execute-dynamic-code` 反射调用 `FigmaPrefabGenerator.Generate(...)`
   - 如果 `componentset_report.json` 中存在 component specs，必须先按报告中的 `unitySpecPath` 逐个生成 component Prefab，再生成 `.tmp/prefab_spec.json`。
   - `gen_spec.py` 会生成 `JellybeanUnity/.tmp/roslyn_import_plan.txt`，内容包含 `imageDir` 和按生成顺序排列的 `specPath`；执行前确认该文件存在，不要手改模板。
   - 以单次 CLI 动态代码执行完成图片导入设置和按 spec 顺序生成；不得拆分到其他 Unity 工具。
   - **反射调用固定模式**：动态代码仅包含直接语句，并通过反射调用 Editor 程序集。
     ```bash
     uloop execute-dynamic-code --code '<approved direct C# statements that import sprites and invoke FigmaPrefabGenerator.Generate() by reflection>'
     ```
5. **静态验证** → Python 快速扫描 Prefab YAML：
  ```bash
  python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/verify_prefab.py --prefab <targetPrefabPath> --json
  ```
  - `m_Sprite: {fileID: 0}` = 0
   - `m_RaycastTarget: 1` = 0（图片组件）
   - `m_enableAutoSizing: 0` = 0（TMP）
   - `m_fontAsset` GUID = CommonFont.asset GUID
   - `m_sharedMaterial` GUID = CommonFont.mat GUID
   - **后处理跳过规则**：FigmaPrefabGenerator 已自动完成 CommonFont/AutoSize(关闭)/RaycastTarget 设置。静态验证通过后直接跳过手动后处理步骤，不要盲走后处理。
   - **RaycastTarget 修复**：如果静态验证 `raycastTargetOn.count > 0`，且用户已确认阶段二 Prefab/资源写入范围，则调用固化修复脚本：
     ```bash
     uloop execute-dynamic-code --code '<approved direct C# statements that set generated image raycastTarget to false>'
     ```
     修复后重新运行 `verify_prefab.py` 确认 `raycastTargetOn.count == 0`。如果再次验证仍有残留，记录 warning 到最终报告。仅当 `raycastTargetOn.count > 0` 时才调用，避免空跑浪费 ~60s（2026-05-12 教训）。
   - **AutoSize 修复**：如果静态验证 `autoSizeOff.count < totalTmp`（即存在 `enableAutoSizing=true` 残留），且用户已确认阶段二 Prefab/资源写入范围，则调用固化修复脚本：
     ```bash
     uloop execute-dynamic-code --code '<approved direct C# statements that set generated TMP enableAutoSizing to false>'
     ```
     修复后重新运行 `verify_prefab.py` 确认 `autoSizeOff.count == totalTmp`。
6. **Spec 契约验证（ComponentSet 必做）** → 对主 spec 和所有 component spec 运行结构门禁：
   ```bash
   python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/verify_spec_contract.py \
     --spec JellybeanUnity/.tmp/prefab_spec.json \
     --spec JellybeanUnity/.tmp/figma_component_specs_4550_5956/Milestone.json \
     --expected-image-dir "Assets/_Resources/7日任务拆分_Images" \
     --expect-prefab-instance Milestone_1_100=prefab_Milestone \
     --json
   ```
   该脚本只验证 JSON 契约，不证明 Unity 能加载源 Prefab；`sourcePrefabPath` 的真实可加载性仍必须通过 `uloop execute-dynamic-code` 的 AssetDatabase 加载验证。
7. **Console 日志检查** → 使用 uLoop CLI：
   ```bash
   uloop get-logs
   ```
   只有检测到错误或本次导入疑似报错时，再获取最近错误摘要。不得切换到其他 Unity 工具。
8. **导入后参考 Prefab 分析**（只读）→ 输出建议报告后停止，等待用户对具体建议项的二次确认

### JSON Spec 格式

AI 在阶段一生成的 `.tmp/prefab_spec.json` 是 AI 与 `FigmaPrefabGenerator.cs` 之间的契约。详见 `references/json-spec-format.md`。

### 性能对比

| 原流程 | MCP Relay 流程 |
|--------|-------------|
| 多次远程读取 Figma 节点和截图 | MCP Relay 一次性导出节点、图片和截图 |
| 50-80 次 LLM 往返（逐行写 YAML） | **3-4 次** LLM 往返（生成 JSON Spec） |
| 图片串行下载 | **并行**下载 |
| AI 手写 .meta 文件 | Unity `AssetDatabase` **自动生成** |
| AI 手写 Prefab YAML | `FigmaPrefabGenerator` **C# API 创建** |

## 固化脚本（性能优化 v2）

以下脚本已固化在 `.figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/`，阶段一/二直接调用，无需 AI 每次重写：

所有生产脚本都必须优先输出统一审核结构，供 LLM 只做审核、判断和纠错：

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

LLM 规则：

- `blockingErrors` 非空：必须视为阻塞，停止写入或停止交付。
- `warnings` 非空：逐项判断是否需要用户确认；不要自行改写产物。
- `summary/checks/artifacts`：只用于转述证据，不用于重新计算。

### `gen_spec.py` — 参数化 Spec 生成器

```bash
python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/gen_spec.py \
  --figma-url "https://www.figma.com/design/FILE/NAME?node-id=1-2" \
  --target-prefab "Assets/_Resources/Sharders/UI_X.prefab" \
  --target-image-dir "Assets/_Art/Texture/GUI/Sharders/" \
  --prefab-name "UI_X" \
  --output-audit-report "JellybeanUnity/.tmp/spec_audit_report.json"
```

功能：九宫识别 → 去重 → INSTANCE 处理 → Hash 去重 → 名称+尺寸兜底去重 → 坐标转换 → Spec + DownloadPlan 输出
报告：`spec_audit_report.json`，包含 Spec lint、childIndices、imageId、下载计划与目标路径门禁；`image_dedup_review.json` 记录“基础名称一致且尺寸一致”兜底合并项，供人工审核。
硬规则：INSTANCE 公共 Prefab 匹配顺序为 `component.componentName` → `mainComponentName` → `componentSetName` → 节点名；下载计划 `targetAssetPath` 必须由 `targetDir + fileName` 的规范化 Unity 资产路径 join 生成。
耗时：<1s（纯 Python，无网络 IO）

### `process_images.py` — 并行图片处理

```bash
python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/process_images.py \
  --manifest-dir .tmp/figma-to-prefab \
  --output-dir JellybeanUnity/Assets/_Art/Texture/GUI/Sharders \
  --workers 6 \
  --output-report JellybeanUnity/.tmp/image_process_report.json
```

功能：ThreadPool 并行九宫合成（默认 6 线程）→ 普通图片 base64 解码 → Common_Texture 复制
报告：`image_process_report.json`，包含九宫实际尺寸、跳过项、普通图片写入数和 Common_Texture 复制结果
耗时：~30s（原 2min，并行加速 4x）

### `common_texture.py` — 公共贴图缓存索引

```bash
python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/common_texture.py  # 构建/读取缓存
python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/common_texture.py --query "Common_Texture_Lock"  # 查询
```

功能：首次扫描 `_Common/` 目录 216 个 PNG → 写入 `.tmp/common_texture_index.json`；后续通过文件数量校验自动增量更新
耗时：首次 0.3s，后续 <1ms

### 优化效果

| 阶段 | 优化前 | 优化后 | 手段 |
|------|--------|--------|------|
| Spec 生成 | AI 手写 3-4min | 固化脚本 <1s | 模板复用 |
| 确认报告 | AI 手写 3min | 脚本生成 <1s | Markdown 预生成 |
| 九宫合成 | 串行 2min | 并行 ~30s | ThreadPoolExecutor |
| 确认往返 | 3-4 次 | 1 次 | 批量确认 |
| Common_Texture 扫描 | 每次 0.5s | <1ms (缓存) | 文件数量校验 |
| **静态验证** | AI grep 统计 30s | **verify_prefab.py <0.1s** | 脚本固化 |
| **文件名一致性** | AI 手工对比 1min | **gen_spec.py 自动检测 <0.1s** | 脚本固化 |
| **九宫尺寸校验** | AI 手算 30s | **process_images.py 自动标记** | 脚本固化 |
| 总耗时 | ~17min | **~3.5min** | **减少 80%** |

### 新增脚本

#### `verify_prefab.py` — Prefab YAML 静态验证器

```bash
python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/verify_prefab.py --prefab Assets/_Resources/Sharders/<targetPrefab>.prefab
# 或 --json 输出机器可读格式
```

功能：读取 Prefab YAML → 检测 m_Sprite{fileID:0} / RaycastTarget / AutoSize / TMP默认字体 → 输出 ✅/❌ 通过状态
报告：JSON 模式包含 `allPass`、`blockingErrors`、`warnings`、`summary`、`checks`、`artifacts`
保存规则：导入主流程必须把 JSON 验证报告写入 `JellybeanUnity/.tmp/verify_prefab_result.json`；benchmark 只可把它复制到 `Runs/iter_xxx/artifacts/` 证据目录。禁止把 `verify_prefab_result.json` 直接写入 Unity `Assets/...` 测试根目录或业务资源目录，避免 Unity 把验证报告当资产导入。
路径规则：脚本会自动解析 Unity 工程根；从仓库根或 `JellybeanUnity/` 工程根运行时，`--prefab Assets/...` 都必须解析到同一个磁盘 Prefab。不得因为当前工作目录不同手工拼 `JellybeanUnity/Assets/...`。
耗时：<0.1s

#### `run_import_benchmark.py` — 50 次导入基准测试

```bash
python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/run_import_benchmark.py \
  --figma-url "https://www.figma.com/design/FILE/NAME?node-id=1-2" \
  --iterations 50 \
  --modes reuse-manifest
```

功能：在 Unity 工程内创建 `Assets/FigmaImportBenchmark/<run-id>/` 测试文件夹，循环调用 `run_full_import.py`，每轮隔离生成 Prefab 和图片目录，记录耗时、阶段 timings、`spec_audit_report.json`、`image_process_report.json`、`verify_prefab.py` 结果和 MCP manifest 证据副本。
报告：`benchmark_records.jsonl` 记录每轮明细；`benchmark_summary.json` 和 `benchmark_summary.md` 汇总成功率、准确度、median/p95/stdev 耗时、blocking/warning 数，并输出 `fastestMode`、`stablestMode`、`bestOverallMode`。
准确度口径：一轮成功必须满足 `run_full_import.py` summary completed、Spec audit allPass、图片处理 allPass、Prefab 静态验证 allPass；准确度分数为所有自动 gate 的通过比例，不由 AI 主观打分。
模式：`reuse-manifest` 第一轮导出 Figma manifest，后续复用同一 manifest 评估 Unity 导入稳定性；`full` 每轮重新走 MCP 导出；`check-only` 只评估 Figma→Spec 阶段。
约束：真实运行前仍需明确 Figma URL、目标节点、Relay/Unity 在线环境；脚本只负责记录和聚合，不替代 Figma 层级整理门禁和标准导入门禁。

#### `gen_spec.py --output-report` — Markdown 确认报告

```bash
python .figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/gen_spec.py ... --output-report .tmp/confirmation_report.md
```

功能：生成 AI 可直接展示的 Markdown 确认报告（含九宫门禁表、去重汇总、影响文件）
耗时：<0.1s

#### `gen_spec.py --check-disk-dir` — 文件名一致性检测

功能：对比 Spec 中 fileName 与磁盘实际 PNG 文件名，检测 `__slice` vs `_jiugong` 命名不匹配。
同步/只读审计已有图片目录时使用默认阻塞模式；新建或覆盖导入的写入前报告必须加 `--check-disk-prewrite`，否则尚未由 `process_images.py` 写入的图片会被误判为 `filenameMismatch` 阻塞。写后文件存在性、尺寸、MD5 和九宫尺寸以 `process_images.py --output-report` 的结构化报告为准。
输出：`filename_mismatch_report.json`

## Multi-Agent Execution

当 Figma 节点较多、存在复杂图片/九宫图、需要参考现有 Unity Prefab 或用户要求多 Agent 时，默认采用“主控 Agent + 子 Agent 并行只读分析”的协作方式。该规则用于固定多 Agent 生效，但不放宽任何写入确认、执行门禁或验证要求。

### 主控 Agent 职责

- 主控 Agent 是唯一决策者、唯一 Spec owner 和唯一写入协调者。
- 主控 Agent 负责读取必读文档、确认 Required Inputs、准备 MCP Relay 请求、拆分只读任务、汇总证据、处理冲突、输出计划并等待用户确认。
- 主控 Agent 只能生成一份最终 `.tmp/prefab_spec.json` 和一份最终 `.tmp/image_download_plan.json`；不得保留多份互相竞争的 Spec。
- 主控 Agent 必须在写入前列出修改计划、影响文件、验证方式、风险和待确认项，等待用户明确确认后才能进入阶段二。
- 多 Agent 分析结果冲突时，主控 Agent 必须采用保守策略：优先保留现有 Unity 资产和项目规范，无法判断的内容列为待确认项，不得自动推断写入。

### 子 Agent 只读边界

所有子 Agent 默认只能做只读分析，禁止执行任何 Unity 资产写入或外部状态修改。子 Agent 禁止：

- 修改、创建或覆盖 Prefab、PNG、`.meta`、Scene、C# 脚本、Addressables、生成数据、Hotfix DLL bytes。
- 创建最终 `.tmp/prefab_spec.json` 或最终 `.tmp/image_download_plan.json`。
- 提交 MCP Relay 写入任务、调用 `FigmaPrefabGenerator.Generate()`、执行 Unity 代码、Unity 编译、Unity 保存资源或任何会改变工程状态的工具。
- 凭相似 Prefab 自动挂业务脚本、自动绑定 `[SerializeField]` 字段、自动替换组件或自动修改交互结构。

子 Agent 输出必须是分析报告，并且所有结论必须带证据：Figma nodeId / node path、Unity Prefab 路径、Unity 对象路径、组件名、字段名、文档或代码行号。信息不足时必须明确说明缺少证据。

### 推荐子 Agent 拆分

- **Figma 结构分析 Agent**：只读分析 MCP Relay 导出的 `figma_node_manifest.json`，分类 Image / Text / Panel / PrefabInstance，提取尺寸、位置、文本、颜色、透明度和图片候选。
- **Unity 参考 Prefab 分析 Agent**：只读扫描目标目录、相似命名 Prefab 和用户指定 reference Prefab，输出层级、组件、字段绑定和公共复用建议。
- **图片与九宫图分析 Agent**：只读分析 `image_export_manifest.json`，判断 Simple / Sliced，计算 border，检查九宫图最小可拉伸尺寸规则。
- **Spec 门禁审查 Agent**：只读审查主控准备的 Spec 草案，检查 JSON 契约、TMP CommonFont、TMP AutoSize、图片 RaycastTarget、PrefabInstance 映射和手写 YAML 风险。

### 写入串行规则

- 多 Agent 只能并行加速“看、查、审”，不能并行写 Prefab、PNG、`.meta`、MCP Relay 请求或 Spec。
- 阶段二写入必须由主控 Agent 在用户确认后串行执行：先下载并校验图片，再通过 `uloop execute-dynamic-code` 执行 `FigmaPrefabGenerator.Generate(".tmp/prefab_spec.json")` 生成 Prefab，最后通过 `uloop` CLI 执行编译、日志和截图验收。
- 导入后参考 Prefab 分析仍然只读，只能输出建议报告；建议报告输出后必须停止并等待用户对具体建议项二次确认。

## Execution Contract

- Follow repository `AGENTS.md` first.
- Before any Unity Prefab, PNG, `.meta`, Figma export request, `.tmp` request/plan file, or automation write, list plan, affected files, validation method, risks, and wait for explicit user confirmation. If the user has already confirmed the exact paths and write scope in the same batch, record that confirmation and do not ask again.
- Load required workflow, pitfalls, and conventions before acting, then include these audit lines in the plan:
  - `已加载 workflow: references/workflow-figma-to-unity.md`
  - `已加载 pitfalls: references/pitfalls-figma-to-unity.md`
  - `已加载 conventions: references/figma-ugui-import-conventions.md`
  - `已加载 json-spec-format: references/json-spec-format.md`
- Default to creating new Prefab, PNG, and `.meta`; never overwrite existing assets unless the user explicitly approves exact paths.
- Do not modify Unity C# scripts, Scenes, Addressables, generated data, or Hotfix DLL bytes.
- **MCP Relay 请求路径**：`.tmp/figma-to-prefab/figma_to_prefab_request.json`。
- **MCP Relay 输出路径**：`.tmp/figma-to-prefab/figma_node_manifest.json`、`.tmp/figma-to-prefab/image_export_manifest.json`、`.tmp/figma-to-prefab/figma_to_prefab_mcp_result.json`、`.tmp/figma-to-prefab/mcp_screenshots/`。
- **MCP Relay Client 命令**：标准入口，内部调用 MCP。Windows 环境优先使用 `python`：`python .claude\skills\figma-to-prefab\scripts\figma_to_prefab_mcp_client.py --request .tmp\figma-to-prefab\figma_to_prefab_request.json --result .tmp\figma-to-prefab\figma_to_prefab_mcp_result.json`。
- **Spec 路径**：从仓库根目录写入 `JellybeanUnity/.tmp/prefab_spec.json`；在 Unity 工程根目录 `JellybeanUnity/` 的上下文中通过 `uloop execute-dynamic-code` 调用 `FigmaPrefabGenerator.Generate(".tmp/prefab_spec.json")`。命令必须显式传入 `--project-path "E:\Project\Work\JellybeanUnity\JellybeanUnity"`，禁止猜测工程路径或混用仓库根/Unity 工程根相对路径。
- **图片处理**：阶段二必须调用 `process_images.py` 读取 MCP Relay manifest/base64 并写入 PNG；`ImageSpec` 不包含下载 URL，必须同时生成 `JellybeanUnity/.tmp/image_download_plan.json` 作为脚本侧校验契约。禁止 LLM 手写 PowerShell 下载循环。
- **JSON UTF-8 规则**：修改带中文的 spec、plan、manifest 或报告 JSON 时，只能使用 Python 读写，并显式 `encoding="utf-8-sig"` 读取、`encoding="utf-8"` 写入。禁止用 PowerShell `ConvertFrom-Json` / `ConvertTo-Json` / `Set-Content` 改写这类 JSON，避免中文节点名被转码破坏。
- **禁止手动转录**：不得从终端输出手抄坐标、尺寸、颜色、文本或图片 hash 到 Spec；必须由脚本从 MCP Relay manifest 生成 Spec 或下载计划。
- **父子相对坐标硬规则**：`prefab_spec.json` 中除根节点外，所有 `NodeSpec.rect.x/y` 必须是相对**直接 Unity 父节点**的 anchoredPosition，不得统一使用相对 Figma 根节点的坐标。因为 `FigmaPrefabGenerator.BuildNodeTree()` 会按 `childIndices` 递归挂载子节点，`ApplyRectTransform()` 会直接把 `node.rect.x/y` 写入当前父节点下的 `RectTransform.anchoredPosition`。如果子节点仍使用根坐标，会导致整批 UI 位置叠加父节点偏移而全部错乱。
- **父子坐标抽查门禁**：调用 `FigmaPrefabGenerator.Generate(".tmp/prefab_spec.json")` 前，必须至少抽查一个有子节点的父节点和一个子节点，确认子节点坐标已从 `child.relativeBounds - parent.relativeBounds` 转换。例如父节点 `Attack_TopBanner` 内的背景图不应继续使用根坐标 `y≈876`，而应是相对父节点的小偏移 `y≈-19`。抽查结果必须写入执行前门禁摘要。
- **九宫图导出尺寸**：`9slice` PNG 必须满足 `width = left + right + 2`、`height = top + bottom + 2`；`h3slice` 必须满足 `width = left + right + 2` 且高度保留父节点 `sourceVisibleSize.height`；`v3slice` 必须满足宽度保留父节点 `sourceVisibleSize.width` 且 `height = top + bottom + 2`。严禁把标准 9slice 的可见大图直接保存为 Unity 九宫 Sprite，也严禁把 h3/v3 的非拉伸轴压成 2px。
- **九宫隐藏源图硬规则**：识别到 `__slice_*` 子节点后，必须优先把父节点按九宫容器处理，并允许读取父节点 invisible/opacity=0 的 IMAGE fill 作为 Sprite 源图。不要按普通可见图层规则跳过隐藏 IMAGE fill，否则会把 `[jiugong_dbx1]` 一类节点降级为 Panel 或造成丢图。
- **九宫临时导出硬规则**：MCP Relay 为九宫图生成最小 PNG 时，临时 Frame/Rectangle 不能设置 `visible=false`；Figma 对不可见临时节点可能导出 `1x1` PNG。正确做法是保持可见、放到远离画布的位置（如 `x=-100000,y=-100000`），导出后立即删除。
- **九宫逐张门禁**：执行 `FigmaPrefabGenerator.Generate()` 前必须逐张列出所有 Sliced 图片的文件名、实际 PNG 尺寸、border、期望尺寸和 `sliceKind`。`9slice` 按最小九宫校验，`h3slice/v3slice` 按完整非拉伸轴校验。任何 `1x1`、标准 9slice 显示态大图、或 h3/v3 非拉伸轴被压成 2px 都是阻塞失败。
- **TMP CommonFont 后处理**：只要生成或修改了 `TextMeshProUGUI`，必须在执行计划中列出后处理：`font = Assets/MagicWarrior/_Resources/Font/Package/CommonFont.asset`，`fontSharedMaterial = Assets/MagicWarrior/_Resources/Font/Package/CommonFont.mat`。禁止保留 TMP 默认字体或默认材质。
- **TMP AutoSize 强制关闭规则**：只要生成或修改了 `TextMeshProUGUI`，必须统一设置 `enableAutoSizing = false`。`ApplyPostProcessing()` 在设置字体和材质后必须紧跟 `tmp.enableAutoSizing = false`，防止 TMP 内部序列化重设。如确有例外需开启 AutoSize，必须由用户明确指定具体节点路径。
- **TMP 文本框宽高硬规则**：所有 Text 节点的 `NodeSpec.rect.w/h` 必须来自 MCP Relay manifest 中该 Figma 文本节点自身的 `bounds.width/height`，Unity 生成后对应 `TextMeshProUGUI` 所在 `RectTransform.sizeDelta.x/y` 必须与 Spec 宽高一致，容差 0.5px。任何 Unity 文本框比 Figma 小或大的残留都视为阻塞失败，不能作为 warning 交付。
- **图片 RaycastTarget 强制规则**：所有生成或修改的 `UnityEngine.UI.Image`、`CustomImage`、Simple Image、Sliced Image、九宫图 Image 组件必须统一取消勾选 `RaycastTarget`（对应 `raycastTarget = false`）。除非用户明确指定某张图片用于点击拦截，否则不允许开启。
- **执行前门禁**：只有 MCP Relay result 通过、`spec_audit_report.json` 通过、`childIndices` 合法、所有 Image 节点引用的 `imageId` 存在、父子相对坐标抽查通过、`image_process_report.json` 通过、所有图片文件存在且尺寸/MD5 校验通过、九宫图最小尺寸校验通过、TMP CommonFont 后处理计划明确、TMP AutoSize 字号锁定计划明确、TMP 文本框宽高门禁明确、图片 RaycastTarget=false 后处理计划明确后，才能调用 `FigmaPrefabGenerator.Generate()`。
- **TextureImporter refresh gate**: After PNG files are written into the Unity project, the first Prefab generation may only create default `.meta` files that still use `textureType: 0`; in that state `AssetDatabase.LoadAssetAtPath<Sprite>()` can return null. After running the generator, statically check the target Prefab for `m_Sprite: {fileID: 0}`. If the count is greater than 0, first confirm every target PNG `.meta` has `textureType: 8`, `spriteMode: 1`, `alphaIsTransparency: 1`, and correct nine-slice `spriteBorder`, then run `FigmaPrefabGenerator.Generate(".tmp/prefab_spec.json")` again. Never report completion while SpriteNull residues remain.
- **Feature-local ComponentSet gate**: Every import runs default detection for internal ComponentSet / 自己的 ComponentSet / reusable business instances. When detected, do not accept a visually correct main Prefab alone. Generate one feature-local Prefab per expected set, make the main spec reference it through `PrefabInstance + activeVariant`, and run `verify_spec_contract.py` with explicit `--expect-prefab-instance Name=prefabId` mappings. This is required even if `verify_prefab.py` passes, because an expected component can otherwise be flattened into `Image`.
- **Prefab 创建**：阶段二中只通过 `uloop execute-dynamic-code` 执行 `FigmaPrefabGenerator.Generate()`，**严禁 AI 手写 Prefab YAML**。
- **CLI-only 规则**：Unity 动态代码、编译、日志、截图验证都只使用 `uloop` CLI。CLI 命令失败时停止并说明原因，不得自行切换到其他 Unity 工具。
- **CLI 引号规则**：在 PowerShell 中调用时，`--code` 使用单引号包裹，C# 字符串字面量使用双引号，例如：`--code 'var path = ".tmp/prefab_spec.json"; ...'`。动态代码仅限直接语句，不使用类、命名空间或 `--code-file`。
- **CLI 反射调用规则**：`FigmaPrefabGenerator` 位于 `MagicWarrior.Editor` 程序集中，动态代码默认 using 不包含该程序集。**禁止**尝试直接调用或完全限定名（均会报 CS0103），**必须**使用反射模式：
  ```csharp
  var asm = AppDomain.CurrentDomain.GetAssemblies().First(a => a.GetName().Name == "MagicWarrior.Editor");
  var type = asm.GetType("MagicWarrior.Editor.FigmaMcpRelay.PrefabImport.FigmaPrefabGenerator");
  var method = type.GetMethod("Generate");
  method.Invoke(null, new object[] { ".tmp/prefab_spec.json" });
  return "Done";
  ```
  此模式也适用于调用其他非默认程序集中的 Editor 类。遇到 `CS0103` 且确认类存在于 Editor asmdef 中时，不要反复尝试 using 或完全限定名，直接走反射。
- **CLI 防错规则**：每次命令显式传入工程路径；`--code` 仅使用直接语句；资源加载、Prefab 内容和导入状态由 `uloop execute-dynamic-code` 的 Unity 返回值确认。不要依赖 Shell 当前目录推断资源路径。
- **多 Agent 固定规则**：启用多 Agent 时，子 Agent 只能只读分析；最终 Spec、最终图片下载清单、写入计划和 Unity 写入只能由主控 Agent 统一收口。

## Required Inputs

- Figma node URL, or file key plus node id.
- Target intent: create new Prefab, sync existing Prefab, create image assets, or Prefab plus assets.
- Target Prefab path/directory, or an existing reference Prefab.
- Target image directory when images need to be created or replaced.
- Overwrite policy for existing Prefab, PNG, and `.meta` files.
- When the request comes from the Figma MCP Relay plugin AI prompt, treat the prompt's `selectionBlock` / URL / fileKey / node id and Unity path fields as a captured target snapshot. Do not ask the user to click Figma again after these values are present.

## Required Reads

- Always read `references/workflow-figma-to-unity.md`.
- Always read `references/pitfalls-figma-to-unity.md`.
- Always read `references/figma-ugui-import-conventions.md`.
- Always read `references/json-spec-format.md` before generating JSON Spec.
- Read `references/figma-to-unity-import.md` before writing Unity assets.
- Read `references/component-reuse.md` before replacing, reusing, or creating common components.
- Read `uloop-execute-dynamic-code` skill before executing any Unity-side C# code; use `uloop` command patterns for all Generate, compile, log, and screenshot operations.

## Environment Checks

- Confirm `.figma/plugins/figma-mcp-relay/` exists.
- Confirm `.figma/plugins/figma-mcp-relay/server/figma_mcp_relay_server.py` exists.
- Confirm `.figma/plugins/figma-mcp-relay/ai/skills/figma-hierarchy-cleanup-mcp/scripts/figma_hierarchy_cleanup_mcp_client.py` exists when the Figma node still needs cleanup.
- Confirm `.figma/plugins/figma-mcp-relay/ai/skills/figma-to-prefab/scripts/figma_to_prefab_mcp_client.py` exists.
- Confirm `figmaMcpRelay.figma_health` succeeds（轻量只读查询，直接 MCP tool 即可）。
- Confirm Figma Desktop has opened the target file and the MCP Relay plugin is connected before submitting export requests.
- Confirm `JellybeanUnity/Assets/` exists.
- Confirm `JellybeanUnity/.tmp/` exists or create it only after user confirmed Unity-side writes.
- Confirm `JellybeanUnity/Assets/MagicWarrior/Scripts/Editor/FigmaMcpRelay/PrefabImport/FigmaPrefabGenerator.cs` exists.
- Confirm `uloop execute-dynamic-code --help` and `uloop compile --help` are available before Unity-side writes.
- Do not start Unity until the task is in validation and the user has confirmed Unity-side writes.
- Do not auto-install dependencies.

## Hard Boundaries

- Missing required inputs means stop and ask.
- A later `figma_query_selection` result must not invalidate a complete prompt snapshot. If current Figma selection is empty or different, continue with the snapshot target by default and only report the mismatch as a risk. Ask the user to reselect Figma only when the snapshot itself lacks fileKey/nodeId or the user explicitly wants to switch targets.
- If the current Figma target root has `directChildCount > 15`, treat it as not production-hierarchy-cleaned, stop the Prefab export flow, and ask the user whether to use `$figma-hierarchy-cleanup-mcp` first. If `directChildCount <= 15`, treat cleanup as satisfied by default and do not ask again.
- When cleanup is required or requested by the user, Figma hierarchy cleanup must complete with `allPass == true` and empty `blockingErrors` before this skill may create export requests, manifests, specs, Prefabs, PNGs, or `.meta` files.
- MCP Relay unavailable, target file not open, or plugin not connected means stop and report; do not continue with another Figma channel.
- Existing Prefab sync must name the exact Prefab path.
- `.meta` changes must state Sprite settings and nine-slice border handling.
- 如果 Unity 中已存在目标 PNG 或 Common_Texture / Common_Prefab / UI_Common 资源，导入流程必须直接引用现有资源；不得删除、覆盖、复制成新文件或重建 `.meta`，除非用户明确批准 overwrite 的精确路径。
- **已有的 Common_Texture / Common_Prefab 静默门禁**：gen_spec.py 完成后，必须扫描 `prefab_spec.json.images[]`，对每个 `targetAssetPath` 对应磁盘已存在 `.png` **且** 文件名以 `Common_Texture_` 或 `Common_Prefab_` 开头的条目，**直接从 `images[]` 移除**。该门禁必须在 process_images.py 和 CLI 动态代码前执行。因为即使不覆盖 PNG，导入后处理也可能修改这些已有文件的 `.meta`（如改写 `spriteBorder`），属于上述规则的违反。移除后 Prefab 生成时仍通过 GUID 引用原资源，import 管线不再触及它。（教训 2026-05-26：Common_Texture_Bg_2.png 的 spriteBorder 被 border=0 覆写。）
- `white_1x1.png` 是 SOLID fill 兜底资源，只能在当前 Spec 的节点或 images 明确引用 `builtin_white_1x1` 时按需创建；没有引用时不得为了“预备”而创建。
- 公共组件 RaycastTarget 保护：`Common_`、`Common_Texture_`、`Common_Prefab_`、`UI_Common_` 或 PrefabInstance 内部节点必须保持源 Prefab 设置，后处理和验证都不要把这些节点当作本次生成图片去统一设置 RaycastTarget。
- 九宫图写入必须按类型校验尺寸：`9slice = left + right + 2 × top + bottom + 2`；`h3slice = left + right + 2 × sourceVisibleSize.height`；`v3slice = sourceVisibleSize.width × top + bottom + 2`。Prefab 中 RectTransform 使用 Figma 可见显示尺寸；标准 9slice 不得使用可见大图尺寸，h3/v3 不得把非拉伸轴压成 2px。
- 公共 PrefabInstance 默认保留源 Prefab 根名；feature-local ComponentSet 允许使用业务实例名（如 `[Milestone_1_100]`），但必须显式记录 `name -> prefabId -> sourcePrefabPath` 映射，并通过 spec contract 与 Unity AssetDatabase 加载验证。不要把“静态验证通过”当作组件化成功。
- 当前 `FigmaPrefabGenerator` 新建文本节点只支持静态 `TextMeshProUGUI` 视觉还原；项目级 `CommonFont.asset`、TMP Material、`CustomLanguageText` / `CustomText` 必须通过复用现有 Prefab 或明确后处理计划实现。新建静态 TMP 节点也必须绑定 `CommonFont.asset` + `CommonFont.mat`，并在验证中证明没有 TMP 默认字体/材质残留。
- 所有新建或同步的 `TextMeshProUGUI` 必须保持 `AutoSize = false`（由 `ApplyPostProcessing` 强制关闭）；任何 `AutoSize = true` 残留都视为阻塞失败，不得作为 warning 交付。
- 所有新建或同步的图片组件必须保持 `RaycastTarget = false`；任何未获用户明确批准的 `RaycastTarget = true` 残留都视为阻塞失败，不得作为 warning 交付。
- 导入后参考 Prefab 分析默认只读，只能输出建议；不能凭相似 Prefab 自动挂业务脚本、自动绑定 `[SerializeField]` 字段或自动替换组件。
- 如建议涉及挂载组件、绑定字段、替换为 `CustomText` / `CustomLanguageText`、调整 `ScrollRect` / `Button` 交互结构，必须另行输出影响文件、修改计划、验证方式和风险，并等待用户二次确认。
- 导入成功、基础验证通过、或用户已确认“导入 Prefab”，都不等于授权执行导入后的推断建议；推断报告不是执行许可。
- 开启导入后推断时，每次都必须在输出建议报告后停止并询问用户；用户没有明确确认具体建议项前，禁止继续改 Prefab、挂组件、绑定字段或替换交互结构。
- High-frequency runtime logic is out of scope; this skill edits assets only.
- **严禁 AI 手写 Prefab YAML** — 必须通过 JSON Spec + FigmaPrefabGenerator 创建 Prefab。
- 子 Agent 不得生成最终 Spec、不得调用 `FigmaPrefabGenerator.Generate()`、不得写入 Unity 资产；若发现子 Agent 输出包含写入动作，必须丢弃该动作并由主控 Agent 重新审查。
- 多 Agent 分析结果互相冲突时，不得任选其一直接写入；必须在计划中列出冲突、证据、推荐处理和需要用户确认的项。

## Validation

- Validate this skill after edits:
  `$env:PYTHONUTF8='1'; python C:\Users\li182\.codex\skills\.system\skill-creator\scripts\quick_validate.py .figma\plugins\figma-mcp-relay\ai\skills\figma-to-prefab`
- Report validation by phase. If a phase was skipped, blocked, or not applicable, say so explicitly; never infer Unity loadability, image importer correctness, compile health, or screenshot fidelity from an earlier Figma/export/spec phase.
- Confirm the Figma hierarchy cleanup precondition was satisfied before export: MCP Relay/analyze reported the target root `directChildCount <= 15`, or the user confirmed running cleanup for `directChildCount > 15` and `$figma-hierarchy-cleanup-mcp` completed apply + verify with `allPass == true` and empty `blockingErrors`.
- Confirm MCP Relay result status is `completed`, `blockingErrors` is empty, exported node count matches expected node count, and screenshot path exists.
- Confirm `figma_node_manifest.json` and `image_export_manifest.json` are the only sources used for Spec generation; no manual coordinate, color, text or image hash transcription.
- Confirm new Prefab references expected image GUIDs, and `m_Sprite: {fileID: 0}` residue count is 0. If residue is not 0, treat it as a blocking failure and check TextureImporter refresh timing before regenerating.
- Confirm new image `.meta` has expected Sprite settings, nine-slice border, `textureType=Sprite`, `alphaIsTransparency=true`, and `mipmapEnabled=false`.
- Confirm `white_1x1.png` is created only when `prefab_spec.json` contains `builtin_white_1x1`; when absent from Spec, report that no white pixel asset was generated.
- Confirm every sliced PNG size matches its `sliceKind`: `9slice` uses the minimum size, `h3slice` preserves full height, and `v3slice` preserves full width; list any exception as a blocking failure, not a warning.
- Confirm every `TextMeshProUGUI` in the generated Prefab uses `CommonFont.asset`; TMP material must be `CommonFont.mat`, a spec-declared Figma material, or a `fallbackCommonFontFigmaMaterial` warning that is explicitly listed for manual review. Report TMP count, CommonFont count, material count, fallback warning count, and default-font residue count.
- Confirm every `TextMeshProUGUI` in the generated Prefab has `AutoSize = false` (forced by `ApplyPostProcessing` after font binding); report TMP count, AutoSize=false count, AutoSize=true residue count. Any `AutoSize=true` residue is a blocking failure.
- Confirm every generated Text node RectTransform width/height equals its Spec/Figma text bounds within 0.5px; report Text count, matched count, mismatch count, and mismatch node names. Any mismatch is a blocking failure.
- Confirm every generated or synchronized non-common `Image` / `CustomImage` has `RaycastTarget = false`; report image component count, RaycastTarget=false count, RaycastTarget=true residue count, and skipped common component count. Common prefab instances and `Common_` / `Common_Texture_` / `Common_Prefab_` / `UI_Common_` nodes keep their source RaycastTarget values and are not failures by themselves.
- After successful import, include a read-only reference Prefab analysis report: reference prefab paths, hierarchy patterns, mounted component patterns, serialized field binding patterns, suggested adjustments, evidence paths/line numbers or Unity object paths, and items requiring user confirmation.
- Run Unity compile through `uloop compile` only when `.cs` files were modified (asset-only operations skip this); Console log checks use `uloop get-logs` and report any CLI error directly.
- Compare Unity result with MCP Relay-exported Figma screenshot for position, size, hierarchy, text, color, transparency, edges, and slicing.
- If Multi-Agent Execution was used, final report must include whether multi Agent was enabled, each child Agent read-only summary, conflicts found, main Agent resolution, and any suggestions not adopted with reasons.

## Project Steering

When executing Figma → Unity Prefab, also follow:

#[[file:.kiro/steering/figma-to-unity.md]]

