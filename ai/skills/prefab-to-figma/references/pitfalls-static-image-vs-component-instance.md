# 踩坑规则: 带 `Common_Prefab_` 前缀的节点应优先匹配已有 Figma Component

## 发现时间

2026-05-14，UI_Buff_1 导入

## 错误现象

`[Common_Prefab_KaToneGreenBtn_2]` 节点被导出为 simple image（FRAME + `__image` fill），但 Figma 文件中实际已存在同名的 `Common_Prefab_KaToneGreenBtn_2` Component（`2206:55`，位于 `-----------通用资源库` 页面）。用户反馈「没有找到公共组件」。

## 根本原因

`prefab_to_figma.py` 静态解析器根据 Unity Prefab YAML 判定该节点不是 PrefabInstance（`m_PrefabInstance: {fileID: 0}`），所以没有列入 `prefabInstances` 数组，而是按普通 Image 节点导出为 simple PNG。

但该节点名称中的 `Common_Prefab_KaToneGreenBtn_2` 暗示它在 Unity 中可能来自一个已解引用的 Prefab（Prefab 已 Apply，不再保留 PrefabInstance 链接），而在 Figma 中有一个同名的独立 Component。

## 判定规则

写入阶段（Relay 或 use_figma）对以下条件的节点应搜索 Figma 文件中的已有 Component：

1. 节点名称以 `[Common_Prefab_` 开头
2. 或节点名称匹配 Figma 文件中某个 Component 的名称（忽略大小写）
3. 该 Component 位于当前文件内（非库组件，用 `figma.root.findAll` 搜索）

如果找到匹配的 Component，且节点当前是 FRAME 类型，应：
1. 记录原 FRAME 的 id、位置、尺寸
2. 删除 FRAME
3. 在相同位置创建 Component 的 INSTANCE
4. 如有尺寸差异，resize INSTANCE 到原 FRAME 尺寸

## 适用范围

- Figma Relay 插件的 `prefabInstanceHandler` 或图片写入阶段
- 所有 non-PrefabInstance 但名称暗示通用组件的节点
- 特别是 `Common_Prefab_`、`Common_`、`KaTong`、`KaTone` 等前缀

## 预防

1. Figma Relay 插件在创建 `__image` 节点前，先用节点名称搜索 Figma 文件中所有 Component
2. 如果找到同名 Component，直接创建 INSTANCE 替代 FRAME+`__image`
3. `build_figma_write_plan.py` 也可在 `imageUploads` 中标记这些节点为 `candidateComponentRef: true`，供 Relay 特殊处理
