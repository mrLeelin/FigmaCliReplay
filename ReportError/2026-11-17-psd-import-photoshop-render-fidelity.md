# 2026-11-17 PSD 导入还原：Photoshop 渲染踩坑

## 现象
`剧情对话.psd` 导入 Figma 后与 PSD 不一致：头像外圈/名字标签/色块颜色错误、渐变丢失、蒙版外的白底露出、隐藏组内气泡显示、画板外内容溢出、5176px 背景层变灰色占位。

## 根因
`export_psd_layers.py` 只读图层原始通道像素：图层样式（描边/内阴影/颜色与渐变叠加/投影）、图层蒙版、剪贴蒙版、组级样式、画板裁切全部丢失；超过 4096px 的图 Figma 无法创建。

## 修正方案
`ai/skills/psd-layer-to-figma/scripts/photoshop_render_units.py` + `.jsx`：用本机 Photoshop 原位渲染每个视觉单元（组级样式/蒙版的组整体渲染，剪贴链合并），按画板裁切；普通文字仍为原生 Text。

## 不要再犯
1. **不要把图层复制到新文档再渲染**：Photoshop 会重算渐变填充/渐变叠加（结果与源文档不同，变成纯色），复制画板内图层还会改用画板相对坐标；153MB 文档反复复制还导致 Photoshop 崩溃。必须原位隐藏无关图层后 `saveAs(PNG, asCopy)`。
2. 剪贴链里的隐藏图层复制后设 `grouped=true` 会重新显示（MALL 图变成另一张隐藏图）。
3. 隐藏其他图层后画板背景（默认白色）会被输出：渲染期间把画板背景改为透明（`artboardBackgroundType=3`）。
4. `editArtboardEvent` 按图层 ID 引用会被静默忽略，必须先 `select` 画板再按 `targetEnum` 修改，并回读校验。
5. JSX 遍历 `app.documents[i].fullName` 遇到未保存文档会抛 8103，需 try/catch。
6. 文字描边不透明度（如 56%）原先被写成 100%；`numericOr(null)` 返回 0，判空要先排除 null。
7. Figma 文字按 PSD 包围盒居中会整体偏上 3~5px（字体度量差异），需以 Photoshop 合成图做逐像素对齐校正。
