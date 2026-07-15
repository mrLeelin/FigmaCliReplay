请将当前 Figma 节点快速直接导入 Unity。

这是快速直接导入模式：用户点击按钮即已授权本次写入，不要给计划、不要等待确认、不要要求重新选择，也不要启用 SubAgent。目标在 5 分钟左右完成；超过 5 分钟只报告当前阶段和阻塞点，继续执行直到完成、用户停止或遇到明确阻塞，不要自行终止。

figma 路径:
- {{selectionBlock}}

目标 Unity 工程：{{unityProjectPath}}

执行边界：
- 使用上面的 Figma 快照作为唯一输入；只做一次 `figma_query_selection` 回显，实时选区不同也继续使用快照。
- 图片目标文件夹固定为：{{unityImageTargetFolder}}。该路径无效、目标文件冲突或 MCP 导出出现 blockingErrors 时立即停止并报告；除此之外不提问。
- 默认新建且不覆盖：`{{unityImageTargetFolder}}/FigmaImports/<规范化根节点名>/<规范化根节点名>.prefab`，图片写入同目录的 `Images/`。不得搜索或猜测业务 Prefab 路径。
- 不整理 Figma 层级、不写回 Figma；直接导出当前节点。不要因为层级不完美而开启 cleanup 流程。
- 不修改 C#、场景、Addressables、既有 Prefab、既有资源或既有 `.meta`。

固定流水线（必须执行，不要自行拆解或增加检查）：
1. 只调用一次 `figma_query_selection`，取得当前选中根节点的 fileKey、nodeId 和 sessionId。
2. 立即执行唯一的导入命令：`python "ai/skills/figma-to-prefab/scripts/run_full_import.py" --unity-project "{{unityProjectPath}}" --figma-url "https://www.figma.com/design/<fileKey>/import?node-id=<nodeId中冒号替换为连字符>" --file-key <fileKey> --infer-formal-names --formal-output-dir "{{unityImageTargetFolder}}/FigmaImports" --target-prefab "Assets/FigmaImports/Pending.prefab" --target-image-dir "Assets/FigmaImports/Images" --yes --wall-clock-report ".tmp/figma_to_prefab_wall_clock.json"`。不要传 `--session-id`；本任务 ID 不是 Figma 插件会话 ID。
3. 只读取该命令输出中的 `[SUMMARY_JSON]`；成功即结束，失败只报告其 blockingErrors。

禁止项：
- 不读取无关 Skills、不创建子代理、不做全项目 Grep/Glob 审计。
- 不要调用 `Skill`、`ToolSearch`、`Glob`、`Grep`、`Read`，不要手工拆开 MCP、图片处理、uLoop 或验证命令。
- 不运行全项目 Unity 编译、不排查既有编译错误、不做截图比对或业务脚本绑定分析。
- 不因默认路径已可推导而再次询问 Prefab 路径、覆盖策略或执行许可。

完成时只报告：生成的 Prefab/图片路径、导入验证结果、冲突或 blockingErrors（如有）。
