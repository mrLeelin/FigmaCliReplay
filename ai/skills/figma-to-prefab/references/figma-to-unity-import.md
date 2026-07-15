# Figma 到 Unity 导入参考

本参考用于把 Figma 节点导入 `JellybeanUnity`，生成新的 uGUI Prefab 和新的图片资源。执行写入前必须先输出计划并等待用户确认。

## LLM 只审核原则

- MCP Relay 和 Python 脚本负责读取 Figma、导出图片、生成 `prefab_spec.json`、生成 `image_download_plan.json`、处理 PNG、验证 Prefab。
- LLM 只读取脚本输出的统一报告：`allPass`、`blockingErrors`、`warnings`、`summary`、`checks`、`artifacts`。
- LLM 不手算坐标、border、MD5、尺寸，不手写 Prefab YAML，不手写 `.meta`，不把终端输出手动复制进 Spec。
- `blockingErrors` 非空时必须停止；`warnings` 只允许由 LLM 判断是否需要用户确认。

## 触发语义

用户输入包含以下语义时使用本流程：

- `导入Unity` / `导入 Unity`
- `Figma 到 Unity`
- `生成预制体`
- `新预制体`
- `新图片`

## 必读输入

- Figma 文件 key 和 node id，优先从用户给的 URL 提取。
- 是否要求新 Prefab、新图片。未说明时，默认不覆盖已有资源。
- 目标目录。如果用户未指定，先根据相似 Prefab 和资源目录给出建议并等待确认。

## 只读分析流程

1. 通过 `figmaMcpRelay` 驱动 `.figma/plugins/figma-mcp-relay` 插件导出 Figma 节点、图片、截图和校验结果。
2. MCP-backed wrapper 保存 `figma_to_prefab_mcp_result.json`、`figma_node_manifest.json`、`image_export_manifest.json` 和 `mcp_screenshots/*.png`。
3. 加载 `references/json-spec-format.md`（JSON Spec 格式规范）。
4. 调用 `gen_spec.py` 从 MCP Relay manifest 生成：
   - `JellybeanUnity/.tmp/prefab_spec.json`
   - `JellybeanUnity/.tmp/image_download_plan.json`
   - `JellybeanUnity/.tmp/spec_audit_report.json`
5. `gen_spec.py` 默认自动调用 ComponentSet 后处理：
   - 优先使用 MCP Relay manifest 中的 `component.componentSetId` / `mainComponentSetId`
   - 命中时生成 `JellybeanUnity/.tmp/figma_component_specs/*.json`
   - 改写主 spec 的业务实例为 `PrefabInstance + activeVariant`
   - 写出 `JellybeanUnity/.tmp/componentset_report.json`
6. LLM 读取 `spec_audit_report.json` 和 `componentset_report.json`，只审核 `blockingErrors`、`warnings` 和 `summary`，不逐节点重算 manifest。
7. 在 Unity 工程内只读查找相似 Prefab 和相似图片目录，用于输出建议，不自动改结构。
8. 列出修改计划 + MCP Relay result + Spec 审核摘要 + 影响文件，等待用户确认。

## 写入规则（优化后）

**严禁 AI 手写 Prefab YAML 或 .meta 文件。** 所有 Unity 资源写入通过以下方式完成：

### 阶段二执行流程

1. **[脚本处理图片]** 调用 `process_images.py` 读取 MCP Relay manifest/base64，按 `sliceKind` 直接写入或 fallback 合成九宫 PNG、导出普通图片、复制 Common_Texture。脚本必须校验 `--output-dir` 与 `image_download_plan.json` 的非复用 `targetAssetPath` 父目录一致；`Assets/...` 参数必须解析到 Unity 工程下的 `JellybeanUnity/Assets/...`。
2. `process_images.py` 必须写入 `JellybeanUnity/.tmp/image_process_report.json`。
3. **[执行前门禁]** LLM 读取 `image_process_report.json`，确认 `blockingErrors` 为空；文件存在性和导入状态由 `uloop execute-dynamic-code` 的 Unity 返回值确认。
4. **[uLoop CLI]** 反射执行生成。若存在 `componentset_report.json` 中的 component spec，必须先生成所有 component spec，再生成 `.tmp/prefab_spec.json`
   - C# 脚本在 Unity Editor 内部：
     - 读取 JSON Spec
     - `new GameObject` + `AddComponent` 创建节点树
     - `AssetDatabase.Refresh` 识别新图片并自动生成 `.meta`
     - `TextureImporter` 设置 spriteBorder/pivot
     - `PrefabUtility.SaveAsPrefabAsset` 保存 Prefab
     - 清理临时对象
5. `.meta` 文件由 Unity `AssetDatabase` 自动生成，**严禁 AI 手写 .meta**
6. 调用 `verify_prefab.py --json`，读取统一报告并确认 `blockingErrors` 为空。
7. 如果本次包含 feature-local ComponentSet，调用 `verify_spec_contract.py` 检查主 spec 和 component spec：
   - 所有 `images[].targetDir` 必须等于本次目标图片目录。
   - 每个预期业务实例必须通过 `--expect-prefab-instance Name=prefabId` 显式声明。
   - 脚本通过只能说明 JSON 契约正确；仍要通过 `uloop execute-dynamic-code` 的 AssetDatabase 检查证明 `sourcePrefabPath` 可加载。
8. 图片更新策略仍按 `references/workflow-figma-to-unity.md` 中的 MD5 对比规则执行，但 MD5 计算必须由 MCP Relay/脚本报告提供，不由 LLM 手算。
9. 导入成功并完成基础验证后，必须只读分析目标 Prefab 同目录和相似命名 Prefab，推算层级、组件挂载、字段绑定和公共复用习惯，并输出建议报告。
10. 建议报告输出后必须停止并询问用户是否执行具体建议项；没有二次确认前，不得执行任何推断建议产生的 Unity 写入。

### 默认写入策略

- 默认新增，不覆盖已有 Prefab/PNG/`.meta`
- 覆盖已有文件需要用户明确确认
- 不修改 Addressables 分组、ServerData、热更 DLL 或生成物

## Figma 九宫图识别规则

当 Figma 节点满足以下任一条件时，必须在 Unity 中使用 `imageType: "Sliced"`：

- 节点类型为 `COMPONENT` 或 `INSTANCE`，且内部有多个 `__slice_*` 子节点
- 节点内部有 3 个或更多子矩形，且子矩形的 x/width 呈现 left-center-right 三段分布
- 节点的 Shared Plugin Data 包含 `imageType: "Sliced"` 或 `spriteBorder`
- 节点名称包含 `bg`、`panel`、`底` 等背景关键词，且宽度远大于高度（宽高比 > 2:1）

识别为九宫图后：
1. 从切片尺寸推算 `spriteBorder`（left/bottom/right/top），写入 JSON Spec 的 `spriteSettingJson`
2. 导出图片时必须按 `sliceKind` 输出：`9slice = (left + 2 + right) × (top + 2 + bottom)`；`h3slice = (left + 2 + right) × sourceVisibleSize.height`；`v3slice = sourceVisibleSize.width × (top + 2 + bottom)`
3. 在 JSON Spec 中设置 `"imageType": "Sliced"`，FigmaPrefabGenerator 自动设置 `m_Type: 1`
4. MCP Relay 父节点有 IMAGE fill 时优先使用父节点 `imageHash`；父节点缺失时才解析 `__slice_*` 子节点，并在报告中记录 fallback。

## TMP 文字 AutoSize 规则

从 Figma 导入文字到 Unity TMP 时，**强制关闭 AutoSize**：

- `ApplyPostProcessing()` 在设置字体和材质后，必须紧跟 `tmp.enableAutoSizing = false`，防止 TMP 内部重设。
- 不使用 `autoSize` JSON Spec 字段（gen_spec.py 不输出该字段，生成器不强制覆盖但后处理强制关闭）。
- 如确有例外需开启 AutoSize，必须由用户明确指定具体节点路径。
- 验证时必须检查 `enableAutoSizing == false`；任何 `AutoSize=true` 残留都视为阻塞失败。

## TMP 文本框宽高规则

从 Figma 导入 Text 节点时，`NodeSpec.rect.w/h` 必须使用 MCP Relay manifest 中该文本节点自身的 `bounds.width/height`。生成 Prefab 后，对应 `TextMeshProUGUI` 所在 `RectTransform.sizeDelta.x/y` 必须与 Spec 宽高一致，容差 0.5px；任何 Unity 文本框比 Figma 小或大的残留都是阻塞失败。

### 文本业务绑定限制

当前 `FigmaPrefabGenerator` 的 Text 节点只创建静态 `TextMeshProUGUI` 并设置文字、字号、颜色、对齐和 AutoSize。它不会自动设置 `CommonFont.asset`、TMP Material Preset、`CustomLanguageText`、`CustomText` 或多语言 Key。

如果目标 Prefab 需要项目级多语言、动态文本或 TMP 材质，必须：

1. 优先复用已有参考 Prefab 的文本节点和本地化组件。
2. 在修改计划中列出后处理字段、材质路径、GUID 和验证方式。

## 图片 RaycastTarget 规则

从 Figma 导入图片到 Unity 时，所有图片组件必须取消勾选 RaycastTarget：

```text
Image.raycastTarget = false
CustomImage.raycastTarget = false
```

适用范围包括 Simple Image、Sliced Image、九宫图 Image、项目自定义 `CustomImage`。除非用户明确指定某个图片节点用于点击拦截，否则不允许开启 RaycastTarget。验证阶段必须统计图片组件总数、`RaycastTarget=false` 数量和 `RaycastTarget=true` 残留数量；未获批准的残留是阻塞失败。
3. 完成只读验证后才能在最终报告中声明业务绑定完成。

## JSON Spec 生成策略

优先级从高到低：

1. 按 `references/json-spec-format.md` 格式生成完整的 JSON Spec
2. **严禁手写 Prefab YAML** — 所有 Prefab 创建通过 `FigmaPrefabGenerator.Generate()` 完成
3. JSON Spec 中的 `nodes` 使用**扁平数组 + childIndices**，第一个节点必须是 `Root`
4. 坐标必须在生成 JSON 前完成 Figma→Unity 转换（详见 json-spec-format.md 坐标公式）

## 导入后参考 Prefab 分析

导入成功后必须执行只读参考分析：

1. 扫描目标 Prefab 同目录下的 `*.prefab`。
2. 扫描同功能目录下名称相似的 Prefab，例如同样包含 `MainView`、`Popup`、`Item`、`Cell`、`Tips`、`Panel`。
3. 如用户提供 reference Prefab，优先纳入分析。
4. 对比层级结构、组件挂载、`[SerializeField]` 字段绑定、ScrollView 结构、按钮/文本/图片组件习惯。
5. 输出建议报告，不自动修改层级、不自动挂业务组件、不自动绑定字段。
6. 报告后必须停止，明确询问用户是否执行某些建议项。
7. 用户只确认“导入”或“生成 Prefab”时，不能视为确认执行推断建议。

建议报告至少包含：

```text
参考 Prefab 路径
相似依据
发现的层级模式
发现的组件挂载模式
发现的字段绑定模式
建议调整项
风险与需要用户二次确认的操作
等待用户确认的具体建议项
```

### 导入后推断执行门禁

- 推断只负责给出建议，不负责直接落地。
- 二次确认必须发生在任何由推断建议引起的 Unity 写入之前。
- 如果用户确认执行某条建议，必须重新输出该建议对应的影响文件、修改计划、验证方式和风险。
- 禁止把“导入阶段的确认”复用为“推断建议执行确认”。

所有结论必须引用真实 Prefab 路径、节点路径、组件名或字段名；信息不足时明确说明缺少证据。

## uLoop CLI 前置门禁

调用 `FigmaPrefabGenerator.Generate(".tmp/prefab_spec.json")` 前必须确认：

- `JellybeanUnity/.tmp/prefab_spec.json` 存在，且路径相对 Unity 工程根目录可解析。
- `JellybeanUnity/.tmp/image_download_plan.json` 存在，且每个 `imageId` 能对应 JSON Spec 中的 `images[].id`。
- `JellybeanUnity/.tmp/spec_audit_report.json` 存在且 `blockingErrors` 为空。
- `JellybeanUnity/.tmp/image_process_report.json` 存在且 `blockingErrors` 为空。
- 所有 `targetAssetPath` 图片存在，实际尺寸和 MD5 与下载清单一致；h3/v3 的尺寸例外必须由 `sliceKind` 规则解释并记录在脚本报告中。该结论必须来自脚本报告或 `uloop execute-dynamic-code` 的 Unity 返回值。
- `targetDir + fileName` 已获得新增或覆盖授权。
- 所有 `PrefabInstance` 的 `sourcePrefabPath` 能通过 `AssetDatabase.LoadAssetAtPath<GameObject>()` 加载。
- 公共 `PrefabInstance` 默认保留源 Prefab 根名；feature-local ComponentSet 可使用业务实例名，但必须先通过 `verify_spec_contract.py --expect-prefab-instance` 证明预期节点是 `PrefabInstance`，且 `prefabId` 能解析到预期 `sourcePrefabPath`。
- 默认自动检测到 feature-local ComponentSet 时，必须把每个预期业务实例列入 spec contract；不能只依赖 `verify_prefab.py`，因为被压成 `Image` 的主 Prefab 也可能视觉验证通过。

## 验证要求

Unity 验证（仅限 uLoop CLI）：

```bash
uloop compile --project-path "E:\Project\Work\JellybeanUnity\JellybeanUnity" --force-recompile false --wait-for-domain-reload true
# Then poll status until Unity is stable, then check logs
python3 Assets/Editor/RoslynGateway/PyScripts/ai_gateway_client.py do-code --project-root "JellybeanUnity" --code 'Debug.Log("Unity stable");' --timeout 30
```

静态验证：

- 新 PNG 存在且宽高与 Figma 源图一致
- 新 Prefab 可被 Unity 正常加载
- 新 Prefab 中的 Sprite 引用指向正确图片 GUID
- 预期的 feature-local ComponentSet 在主 spec 中仍是 `PrefabInstance`，没有降级为 `Image` / `Panel`
- 九宫格图片的 spriteBorder 与 Figma 切片一致，PNG 尺寸符合 `sliceKind`（9slice 最小宽高，h3slice 完整高度，v3slice 完整宽度）
- 新图片 `TextureImporter` 为 Sprite、`alphaIsTransparency=true`、`mipmapEnabled=false`
- 如果包含 Text 节点，确认是否仅为静态 TMP 视觉还原；业务多语言、动态文本、TMP 材质必须单独列出验证结果。`fallbackCommonFontFigmaMaterial` 只能作为 warning 放行，最终报告必须列出 GUID 和人工确认风险。

如果 Unity MCP 或 Editor 不可用，必须说明未完成的验证项和残余风险。

## 最终汇报必须包含

- 新增 Prefab 路径
- 新增图片路径
- 复用的参考 Prefab / 公共组件
- JSON Spec 中节点数、图片数
- 图片下载清单中的文件数、MD5/尺寸校验结果
- Unity 编译和日志验证结果
- 未覆盖或降级的 Figma 特性
