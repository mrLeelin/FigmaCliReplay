# 踩坑规则: writePlan prefabInstanceWrites 必须包含 parentNodeId/Path

## 发现时间

2026-05-14，UI_Buff_1 导入

## 错误现象

`figma_write_verify_report.json` 中 `prefabInstanceNodeType` 验证失败：

```json
{
  "code": "prefabInstanceNodeType",
  "reason": "parser_did_not_provide_instance_node_mapping",
  "details": {
    "matchedComponentId": "1835:6",
    "matchedComponentName": "Common_Prefab_Timer",
    "pass": false
  }
}
```

Figma Relay 插件虽然在 Figma 中找到了已有 Component（`Common_Prefab_Timer` at `1835:6`），但因为写入计划的 `prefabInstanceWrites` 条目缺少 `parentNodeId` 和 `parentNodePath`，插件不知道该把 Instance 挂到哪个父节点下，最终创建了 0 个 INSTANCE。

## 根因

`build_figma_write_plan.py` 在生成 `prefabInstanceWrites` 时，只包含 `sourceGuid`、`sourcePrefabAssetPath` 等标识信息，没有从父 Prefab 的 `m_TransformParent` 中提取父节点信息写入计划。

## 写入计划缺少的字段

每个 `prefabInstanceWrites` 条目应该包含：

```json
{
  "parentNodeId": "auto|待写入阶段解析",
  "parentNodePath": "UI_Buff_1/[[Header]]",
  "parentTransformFileId": "5174278684993491260",
  "anchoredPosition": {"x": -63.9, "y": -23.4},
  "sizeDelta": {"x": 244.3, "y": 147.9},
  "anchorMin": {"x": 0.5, "y": 0.5},
  "anchorMax": {"x": 0.5, "y": 0.5},
  "pivot": {"x": 0.5, "y": 0.5},
  "overrideName": "[Common_Prefab_Timer]"
}
```

- `parentNodePath` 从父 Prefab 的 `m_TransformParent.fileID` 回溯查表得到 GameObjet name。
- `parentTransformFileId` 是 Unity 中父 RectTransform 的 fileID，供 Figma Relay 插件在导入后通过元数据匹配父 Frame。
- 位置/尺寸信息从 `m_Modification` 段提取（`m_AnchoredPosition`、`m_SizeDelta`）。

## 替代方案

在 `build_figma_write_plan.py` 修复前，可通过以下步骤手工修正：

1. 从父 Prefab 的 `m_Modification` 段读取 override 数据
2. 从 `m_TransformParent.fileID` 查父节点在 JSON `nodes` 中的 `name`
3. 用 `use_figma` 或 Relay 补充任务创建 Instance 并定位

## 预防

1. `build_figma_write_plan.py` 必须在解析 prefabInstances 时，读取父 Prefab 的 `m_Modification` 段
2. 从 `m_TransformParent` 回溯到父节点名称，写入 `parentNodePath`
3. Figma Relay 插件侧的 prefabInstanceHandler 优先使用 `parentNodePath` 定位，回退到 `figma.root.findAll` 匹配名称
