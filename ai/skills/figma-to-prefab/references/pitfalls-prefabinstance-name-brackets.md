# 踩坑规则: gen_spec.py 搜索 PrefabInstance 时必须去除节点名中的方括号

## 发现时间

2026-05-14，UI_Buff_1 Figma→Unity 覆盖

## 错误现象

Figma 中 `[Common_Prefab_KaToneGreenBtn_2]`（INSTANCE 类型节点）和 `[Common_Prefab_Timer]` 被 `gen_spec.py` 降级为 Image/Panel，没有匹配到项目中的公共 Prefab。导致 Prefab 中生成的是静态图片 + Image 组件，而不是 `PrefabInstance` 嵌套引用。

## 根本原因

1. **方括号未去除**：`gen_spec.py` 搜索 Prefab 时，直接用节点名 `[[Common_Prefab_KaToneGreenBtn_2]]`（双括号 Unity 命名）去匹配 `KaToneGreenBtn_2.prefab`，匹配失败。

2. **搜索目录不全**：`KaTongGreenBtn_2.prefab` 位于 `_Common/Buttons/New/`，但搜索路径可能只覆盖了 `_Common/` 或 `_Common/Buttons/`，漏掉了 `New/` 子目录。

## 修复

1. 搜索前去除节点名中的 `[` 和 `]`：`[[Common_Prefab_KaToneGreenBtn_2]]` → `Common_Prefab_KaToneGreenBtn_2`
2. 递归搜索 `_Common/` 所有子目录（包括 `Buttons/New/`）
3. 对 INSTANCE 类型的 Figma 节点，优先尝试匹配项目中的公共 Prefab；匹配成功则标记为 `PrefabInstance`，失败则降级为 Image

## 搜索匹配逻辑

```python
# 1. 去除方括号
search_name = node_name.replace('[', '').replace(']', '')

# 2. 递归搜索所有子目录
matches = []
for root, dirs, files in os.walk(common_prefab_dir):
    for f in files:
        if f.endswith('.prefab'):
            stem = f[:-7]  # 去掉 .prefab
            # 3. 精确匹配（去除括号后）
            if stem.lower() == search_name.lower():
                matches.append(os.path.join(root, f))
            # 4. 也尝试模糊匹配：Common_Prefab_KaToneGreenBtn_2 → KaToneGreenBtn_2
            elif search_name.lower().endswith(stem.lower()) or stem.lower().endswith(search_name.lower()):
                matches.append(os.path.join(root, f))
```

## 后续

已更新 `spec`，手工将这两个节点改为 `PrefabInstance`。`gen_spec.py` 的搜索逻辑需要同步修复。
