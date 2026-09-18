请使用 $figma-to-prefab 快速同步 Figma 变更到 Unity Prefab。

Figma 节点（美术修改后的版本）：
{{selectionBlock}}

已锁定输入：
- 上面的 Figma 文件、页面、选中节点数量、nodePath 和 node id 是本提示词生成瞬间的同步目标快照；后续执行以这个快照为准。
- 不要让我重新点击或重新选择 Figma。只有当上面缺少 fileKey/nodeId，或者用户明确说“换目标”，才可以要求重新选择。
- 可以用 `figma-relay selection` 做只读回显诊断；如果实时选区为空或和快照不同，不要覆盖本提示词里的目标，也不要因此停止要求我重选。应改用快照里的 Figma URL/fileKey/nodeId 通过项目 CLI 提交 WebSocket analyze/export 任务。
- 如果必须确认目标一致，只报告“实时选区和提示词快照不一致”的风险，并询问是否切换目标；默认继续使用提示词快照。

Unity 目标 Prefab：
- 选中 Prefab：{{unitySelectedPrefabPath}}
- 如果该值为空或不是 .prefab 文件，停止执行并让我重新选择。
- 这是美术改 Figma 之前，Unity 侧已存在的对应 Prefab。

图片目录：
- {{unityImageTargetFolder}}
- 只有图片变更时才需要写入新 PNG。

核心流程（自动判断轻量/完整链路）：
1. 通过项目 CLI + WebSocket analyze 当前 Figma 节点 → 拿到最新 manifest + 图片 hash
2. 运行 compare_figma_to_unity.py 对比 Unity Prefab 当前值 → 生成差异报告 + 路径判决
3. 展示判决结果（轻量 / 轻量+图片 / 完整）→ 等我确认
4. 确认后自动走对应路径：
   - 轻量：Roslyn Gateway 直接改 Prefab（位置/颜色/文字），~20s
   - 轻量+图片：process_images + Refresh + Roslyn 改 Prefab，~40s
   - 完整：走 $figma-to-prefab 完整两阶段导入，~3.5min

判决逻辑（脚本自动，不需要你判断）：
- 节点数量变了 → 完整
- 层级结构变了（新增/删除组）→ 完整
- 九宫 border 变了 → 完整
- 图片 MD5 变了 → 轻量+图片
- 只有位置/颜色/文字/锚点变了 → 轻量
- 没有任何变化 → 无需同步

要求：
- 不要跳过 compare_figma_to_unity.py，直接凭感觉判断路径。
- 对比结果出来后，一次性展示差异报告 + 判决 → 等我确认。
- 我确认后不要再次询问覆盖策略或路径。
- 轻量/轻量+图片链路不要重建 Prefab，直接改现有 Prefab。
- 不要修改 Unity Prefab 上挂载的 C# 脚本、SerializedField 绑定、Animator 或嵌套 PrefabInstance 引用。
- 完成后必须做 Unity 编译检查和 verify_prefab.py 验证。
