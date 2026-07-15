# Unity Prefab YAML 静态解析参考

本参考用于 `scripts/prefab_to_figma.py` 的静态解析流程。解析器只读取 Unity 文本 Prefab / `.meta` 文件，不启动 Unity，也不依赖 `AssetDatabase`。

## 关键字段

### GameObject

- `GameObject.m_Name`：Figma 节点同名 Frame 的名称来源，禁止改名。
- `GameObject.m_Component`：组件 fileID 列表，用于把 Image、TextMeshProUGUI、RawImage 等组件挂回节点。
- `GameObject.m_IsActive`：导出为 `active` 元数据，不删除非激活节点。

### RectTransform

- `RectTransform.m_GameObject`：连接 RectTransform 与 GameObject。
- `RectTransform.m_Father`：父 RectTransform fileID，`0` 或缺失时可作为根候选。
- `RectTransform.m_Children`：子 RectTransform fileID 列表，决定导出层级顺序。
- `RectTransform.m_AnchorMin`：Unity anchor min，包含 `x`、`y`。
- `RectTransform.m_AnchorMax`：Unity anchor max，包含 `x`、`y`。
- `RectTransform.m_AnchoredPosition`：锚点相对位置。
- `RectTransform.m_SizeDelta`：相对锚点区域的尺寸差。
- `RectTransform.m_Pivot`：轴心点。
- `RectTransform.m_LocalScale`：第一版只按 x/y 缩放尺寸。
- `RectTransform.m_LocalRotation`：第一版只导出 z 轴旋转角。

## 组件字段

- `m_Sprite`：Unity Image / CustomImage 的 Sprite 引用，读取 `{fileID, guid, type}`。
- `m_Texture`：RawImage 的 Texture 引用，第一版仅支持可解析为 PNG 的资源。
- `m_Type`：Unity Image 类型；`0=Simple`、`1=Sliced`、`2=Tiled`、`3=Filled`。
- `m_FillAmount`：Filled / SlicedFilledImage 的填充比例；非 1 时降级并记录 warning。
- `m_FillCenter`：Sliced Image 是否填充中间区域，写入 JSON 供 Figma 创建层时参考。
- `m_Text` / `m_text`：Text 或 TextMeshProUGUI 文本内容。
- `m_fontSize`：基础字号。
- `m_Color`：基础颜色。
- `m_EditorClassIdentifier`：MonoBehaviour 脚本类型标识，用于识别 CustomImage、TMP、Unsupported 组件。

## 坐标换算公式

Unity UGUI 使用左下原点；Figma 使用左上原点。第一版按父节点尺寸逐层换算：

```text
anchorWidth = parentWidth * (anchorMax.x - anchorMin.x)
anchorHeight = parentHeight * (anchorMax.y - anchorMin.y)
width = anchorWidth + sizeDelta.x
height = anchorHeight + sizeDelta.y
pivotX = parentWidth * anchorMin.x + anchorWidth * pivot.x + anchoredPosition.x
pivotY = parentHeight * anchorMin.y + anchorHeight * pivot.y + anchoredPosition.y
figmaX = pivotX - width * pivot.x
figmaY = parentHeight - (pivotY - height * pivot.y) - height
```

`m_LocalScale.x/y` 会乘到 `width/height` 上；旋转只记录 `rotationZ`，不参与子节点坐标重排。

## 静态解析限制

- 不合并复杂 Prefab Variant 覆盖。
- 静态求解受支持的 HorizontalLayoutGroup、VerticalLayoutGroup、GridLayoutGroup、LayoutElement 和同节点 ContentSizeFitter；不执行 Animator 或运行时脚本，也不等同完整 Unity runtime layout pass。
- 不解析动态图集回调，只通过 GUID 查找 `.meta` 和同名 PNG。
- 遇到缺失字段时使用默认值并在报告中记录 warning。
