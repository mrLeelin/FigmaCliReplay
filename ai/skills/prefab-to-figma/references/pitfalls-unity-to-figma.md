# 踩坑规则: Unity → Figma 专用

本文件收录 Unity Prefab 导入 Figma 方向的已知踩坑与防错规则。执行 Unity → Figma 工作流前必须阅读。

## 硬加载审计门槛

Unity Prefab 导入 Figma 前，必须先加载 `references/workflow-unity-to-figma.md` 和本文件。修改计划中必须显式写出：

- `已加载 workflow: references/workflow-unity-to-figma.md`
- `已加载 pitfalls: references/pitfalls-unity-to-figma.md`

如果计划没有这两行，禁止解析 Prefab、创建 `.tmp` 输出、上传图片、调用 Figma 写工具或宣称可以开始导入。

## 必须先读脚本审核报告，禁止 LLM 手工补计划

Unity Prefab 导入 Figma 的解析和写入计划必须由固化脚本生成：

1. `prefab_to_figma.py` 输出 `prefab_export_audit_report.json`。
2. `build_figma_write_plan.py` 输出 `figma_write_plan.json` 和 `figma_write_plan_audit_report.json`。
3. `figmaMcpRelay`、runtime relay 和插件 UI 只能基于 `allPass`、`blockingErrors`、`warnings`、`summary`、`checks`、`artifacts` 更新任务状态；AI 只能转述结果。

禁止行为：

- ❌ 不看审核报告，直接读取 `prefab-to-figma.json` 后手工统计节点、图片、文本或九宫数量。
- ❌ 从终端输出中复制 imageHash、坐标、颜色、文本到 Figma JS。
- ❌ 跳过 `figma_write_plan_audit_report.json`，凭经验决定图片上传、描边、九宫或 PrefabInstance 写法。
- ❌ 绕过 `figmaMcpRelay` / `prefab_to_figma_mcp_client.py`，让 LLM 直接手写大段官方/通用 Figma MCP `use_figma` 创建脚本作为标准写入路径。
- ❌ 把 `warnings` 当作普通日志忽略。每条 warning 都必须由脚本/插件结构化分类；需要用户决策时必须产出明确 decision 项。

## 不要把视觉或几何判定外包给大模型

Prefab → Figma 的目标是无大模型确定性导入。发现视觉偏移、层级错位、翻转错位、截图缺失或资源异常时，正确修复位置是 exporter、write plan、MCP Relay plugin、server status 或验证报告，而不是让 AI 肉眼判断是否“差不多”。

必须固化的判定包括：

- 父子节点 local rect 是否与 JSON 一致。
- `relativeTransform` 是否正确表达旋转和负 scale。
- 九宫切片 `imageTransform` 是否来自 source rect。
- 图片 hash 是否为有效 40 位 SHA1。
- PrefabInstance 是 INSTANCE、自动组件还是允许的 FRAME 降级。
- 截图是否生成；未生成时必须有结构化 skip reason。

AI 只能用这些报告定位失败阶段，并提出修改计划；不能用手算或截图主观判断替代流水线验收。

如果 `blockingErrors` 非空，必须停止在当前阶段；不能靠手工补写 Figma 节点绕过脚本门禁。

## TMP 文字颜色必须使用 fontColor

解析器 JSON 现在同时输出 `text.color`（`m_Color`，Graphic 基类）和 `text.fontColor`（`m_fontColor`，TMP 实际渲染颜色）。写入 Figma 文本颜色时，优先使用 `text.fontColor`，仅当 `fontColor` 不存在时才回退到 `text.color`。

如果 JSON 中还有 `text.effects.outline` 和 `text.effects.underlay`，需要在 Figma 文本节点上添加 Stroke，并优先用 `__text_underlay` 复制文本层模拟 TMP Underlay；不要默认用大面积 Drop Shadow。详见 `references/figma-layer-mapping.md` 的"文本写入"章节。

> **注意**：此规则在 Figma → Unity 同步时同样适用（读取颜色时也需要区分 fontColor 和 color）。详见 `../../figma-to-prefab/references/pitfalls-figma-to-unity.md`。

## 标准写入必须走 figmaMcpRelay / MCP Relay，官方 MCP 占位清理只用于 fallback

标准 Unity Prefab → Figma 写入路径是：

```text
AI MCP client → figmaMcpRelay → runtime relay → prefab_to_figma.py → build_figma_write_plan.py → figma-mcp-relay 插件
```

命令行调试兼容路径是：

```text
prefab_to_figma.py → build_figma_write_plan.py → prefab_to_figma_mcp_client.py → figmaMcpRelay → runtime relay → figma-mcp-relay 插件
```

runtime relay 路径由插件下载 `/assets/{requestId}/{assetId}` 图片字节并调用 `figma.createImage`，不使用官方/通用 Figma MCP `upload_assets`，因此不会产生占位节点。

只有 `figmaMcpRelay` / MCP Relay 环境故障且用户明确书面同意 fallback 时，才允许使用官方/通用 Figma MCP `upload_assets` / `use_figma`。此时必须记住：`upload_assets` 会在 Figma 文件中自动放置占位节点（返回 `placedOnNodeId`）。这些占位节点的 ID 是递增的，可能与后续 `use_figma` 创建的新节点 ID 冲突。

**fallback 中严禁在 `use_figma` 创建正式节点的同一段代码中删除上传占位节点。** 正确做法：

1. 上传图片，记录 `placedOnNodeId`
2. 用单独的 `use_figma` 调用删除占位节点
3. 再用 `use_figma` 创建正式节点层级

也可以先创建正式节点，再用单独的 `use_figma` 调用清理占位节点。核心规则是“清理占位节点”和“创建正式节点”不能在同一次 `use_figma` 调用中混在一起。

踩坑案例：在同一个 `use_figma` 代码块中先创建 OneBtnTipsBad 层级，再删除上传占位节点，结果把刚创建的根节点也一起删了（ID 冲突）。

## Figma Frame 名称必须严格等于 JSON name

创建 Figma Frame 时，名称必须严格等于 JSON 节点的 `name` 字段，不能翻译、不能改写、不能加前缀后缀。Figma 可能会自动翻译某些名称（如 "Title" → "标题"），但代码中必须使用原始英文名。

## 必须在目标节点所在页面创建内容

用户提供的 Figma URL 中的 `node-id` 可能不在第一个页面。创建内容前必须：

1. 通过 `figma.getNodeById(targetNodeId)` 获取目标节点。
2. 向上遍历找到所在的 Page：`let page = node; while (page.type !== "PAGE") page = page.parent;`
3. 用 `await figma.setCurrentPageAsync(page)` 切换到目标页面。
4. 在该页面上创建内容。

踩坑案例：用户给的 URL 指向第二个页面的节点 `470:2752`，但 `figma.currentPage` 默认是第一个页面，导致内容创建到了错误的页面。

## 嵌套 Prefab 必须优先复用文件中已有的通用组件

导入含嵌套 PrefabInstance 的 Prefab 时，**严禁直接新建子 Prefab 的 Component**。必须先搜索目标 Figma 文件的**所有页面**（不仅是当前页面），查找是否已有同名或同 GUID 的 Component。找到就直接创建 Instance 引用它，绝不重复创建。

**搜索范围必须覆盖全文件**：通用按钮、图标等组件通常放在独立的"通用资源库"页面，不在导入目标页面上。只搜索当前页面会漏掉它们。

**正确做法**：

```javascript
// 搜索全文件所有页面的本地 Component
const existing = figma.root.findAll(n => n.type === "COMPONENT" && n.name === "RedBtn__ImportBounds");
if (existing.length > 0) {
  // 直接创建 Instance，不要新建 Component
  const instance = existing[0].createInstance();
  parentFrame.appendChild(instance);
}
```

**`search_design_system` 不能替代本地搜索**：它只搜索已发布到组件库的组件，不包含文件内的本地 Component。必须用 `use_figma` + `figma.root.findAll` 遍历。

踩坑案例 1：文件中已有 `RedBtn` Component（节点 `405:11`），但 `search_design_system` 返回空，导致重复创建了一个新的 RedBtn Component。

踩坑案例 2：导入 TwoBtnTips 时，`通用资源库` 页面已有 `RedBtn__ImportBounds`（1021:11）和 `FbBtn__ImportBounds`（1023:23），但只搜索了目标页面 `View_弹板_通用`，没找到就直接新建了重复组件。正确做法是搜索 `figma.root`（覆盖所有页面）后发现已有组件，直接用 Instance 引用。

## 引用已有组件 Instance resize 前必须检查 Constraints

已有的 Figma Component 内部节点可能全部使用默认 Constraints（`MIN`，固定左上角）。此时对 Instance 做 resize，内部内容不会跟随拉伸，导致九宫格和文字位置错乱。

**必须在 resize 前检查并修复 Constraints**：

- `__slice_left`: `horizontal: MIN, vertical: STRETCH`
- `__slice_center`: `horizontal: STRETCH, vertical: STRETCH`
- `__slice_right`: `horizontal: MAX, vertical: STRETCH`
- `__slice_top`: `horizontal: STRETCH, vertical: MIN`
- `__slice_bottom`: `horizontal: STRETCH, vertical: MAX`
- 容器层（AnimationRoot、Icon）: `horizontal: STRETCH, vertical: STRETCH` 或 `CENTER`
- 文本容器（PreLevel）: `horizontal: STRETCH, vertical: CENTER`

踩坑案例：引用已有 `RedBtn__ImportBounds`（405:11）创建 Instance 并 resize 到 451x112，但组件内部 Constraints 全是 MIN，导致按钮内容固定在左上角不跟随拉伸。

## figma.getNodeById 跨页面可能返回 null

`figma.getNodeById` 在未切换到目标页面时可能无法访问该页面的节点。必须先切换页面再访问。

**关键**：`setCurrentPageAsync` 在跨 `use_figma` 调用时不持久。页面切换和所有后续操作必须在同一个 `use_figma` 调用中完成。

踩坑案例：第一个 `use_figma` 调用中切换了页面，第二个调用中 `figma.currentPage` 又回到了第一个页面，导致 `getNodeById` 返回 null。

## 子节点顺序：按 JSON children 原始顺序 appendChild 即可

Unity Hierarchy 中子节点从上到下是渲染顺序（上面的先渲染，在底层）。Figma Layers 面板中从上到下是前景到背景（后 appendChild 的在面板底部 = 背景层）。

**正确做法：按 JSON children 数组的原始顺序依次 `appendChild`。** 这样 JSON 中第一个子节点（Unity 最先渲染 = 最底层）会在 Figma 层级面板的最上方，最后一个子节点（Unity 最后渲染 = 最前景）在面板最下方。Figma 层级面板的视觉顺序和 Unity Hierarchy 面板一致，方便用户对照。

**严禁在 appendChild 后再做"反转"操作。** `appendChild` 会把节点从原位置移走再插到末尾，在遍历过程中移动节点会导致索引错乱、节点丢失或嵌套到错误的父节点中。

踩坑案例：TwoBtnTips_2 导入时，创建完所有子节点后执行了一段"反转子节点顺序"的代码，结果 Bg(2) 被意外嵌套到 Bg(1) 内部，层级顺序也完全错乱。删除反转代码后，按原始顺序 appendChild 即可得到正确结果。

## 创建前必须对照已有正确版本的层级结构

如果目标 Figma 文件中已有同名节点（旧版导入产物），创建新版本前**必须先用 `use_figma` 递归打印旧版的完整层级树**（节点名、类型、子节点顺序），然后严格按照旧版结构创建。

**禁止凭记忆或假设创建层级。** 特别注意以下容易出错的点：

- 某些 Unity 节点（如 Title 的 `__text`）可能直接挂在父节点下，没有中间 Frame 包裹
- 所有子节点必须是同一个父节点的直接子节点，不能嵌套到兄弟节点内部
- 创建完成后必须打印新版层级树，和旧版逐行对比确认一致

踩坑案例：TwoBtnTips_2 导入时，Title 在旧版中是 `__text` 直接挂在 Root 下，但新版错误地创建了一个 "Title" Frame 包裹 `__text`，导致层级结构和旧版不一致。

## 节点 scaleX/scaleY 必须应用到 Figma

解析器 JSON 的 `rect` 对象中，如果 `scaleX` 或 `scaleY` 不为 1.0，必须在 Figma 中应用对应的变换：

- `scaleX = -1`：水平翻转。使用 `relativeTransform` 设置 `[[-1, 0, rect.x + width], [0, 1, rect.y]]` 实现，不能只用 `rect.x`，否则子节点会相对父节点额外左偏一个自身宽度。
- `scaleY = -1`：垂直翻转。使用 `relativeTransform` 设置 `[[1, 0, rect.x], [0, -1, rect.y + height]]` 实现，不能只用 `rect.y`，否则子节点会相对父节点额外上偏一个自身高度。
- `scaleX != 1.0 && scaleX > 0`：已经体现在 rect 的 width/height 中（resolve_rect 已处理），无需额外操作。
- 仅负值 scale 需要额外的翻转 transform。

踩坑案例：OpenComicView 的 TopMask/Right 节点有 `m_LocalScale: {x: -1, y: 1, z: 1}`（水平翻转，和 Left 共用同一张图做对称遮罩），但导入 Figma 时未应用翻转，导致 Right 和 Left 方向相同。

## 上传图片后必须验证 imageHash 为正确的 40 位 SHA1

使用 PowerShell `Invoke-RestMethod` 上传图片到 Figma 时，如果用 `ConvertTo-Json -Compress` 输出响应，终端行宽可能截断 `imageHash` 字段，导致提取到错误的 hash（多一位或少一位）。

Figma 对无效 SHA1 的行为是**静默失败**：`set_fills` 不报错，但 fill 不生效，节点显示为空白无图片。

**正确做法**：

```powershell
# ✅ 正确：用 raw bytes 上传，直接从响应对象属性读取 hash
$bytes = [System.IO.File]::ReadAllBytes($filePath)
$resp = Invoke-RestMethod -Uri $uploadUrl -Method Post -ContentType "image/png" -Body $bytes
$hash = $resp.imageHash  # 直接属性访问，不经过字符串序列化
Write-Output "$name|$hash|len=$($hash.Length)"  # 必须验证 len=40
```

```powershell
# ❌ 错误：用 ConvertTo-Json 序列化后从字符串中提取 hash
$resp = Invoke-RestMethod -Uri $url -Method Post -ContentType "multipart/form-data; boundary=$boundary" -Body $body
Write-Output "$($resp | ConvertTo-Json -Compress)"  # 终端行宽截断导致 hash 不完整
```

**写入 Figma 后必须验证**：

```javascript
// 上传完所有图片、写入 fills 后，必须用 use_figma 验证
const fills = node.fills.filter(f => f.type === "IMAGE");
if (fills.length === 0 || fills[0].imageHash.length !== 40) {
  // hash 无效，需要重新上传
}
```

踩坑案例：BuffChapterDashView 导入时，15 张图片中有 9 张因 PowerShell 输出截断导致 hash 从 `a27a34ef9334aa9872c52d11f4ea8d976f606c9b`（正确 40 位）变成 `a27a34ef9334aa9872c52d11f4ea88d976f606c9`（错误 40 位，中间多了个字符挤掉了末尾），Figma 静默拒绝，节点显示空白。改用 raw bytes 上传 + 直接属性读取后修复。

## 九宫格 CROP imageTransform 公式必须基于 source rect

Figma CROP 模式的 `imageTransform` 是一个 2×3 矩阵 `[[scaleX, 0, tx], [0, scaleY, ty]]`，定义源图片中哪个区域映射到节点。参数必须基于 **source rect**（源图中的裁剪区域）相对于整张图片的比例：

```text
scaleX = source.width / sourceImageWidth
scaleY = source.height / sourceImageHeight
tx = source.x / sourceImageWidth
ty = source.y / sourceImageHeight
imageTransform = [[scaleX, 0, tx], [0, scaleY, ty]]
```

**严禁使用 target rect（节点在画布上的显示尺寸）来计算 imageTransform。** target rect 只决定 Figma 节点的 x/y/width/height，与图片裁剪无关。

踩坑案例：TwoBtnTips_2 导入时，`__slice_center` 的 target 宽度是 865px 但 source 宽度只有 9px。错误地用 `target.width / imageWidth`（865/185=4.68）作为 scaleX，导致图片显示区域完全错误，九宫格背景变形。正确值应该是 `source.width / imageWidth`（9/185=0.0486）。修正后通过读取已有正确导入节点的 imageTransform 值验证公式正确。

## nine-slice-sync Plugin 禁止使用 ES6 展开运算符

Figma Plugin sandbox 的 JavaScript 运行环境不支持对象展开运算符 `{ ...obj }`。在 `.figma/nine-slice-sync/code.js` 中必须使用 `Object.assign({}, obj)` 替代。数组展开 `arr.push(...otherArr)` 也不支持，需要用 `otherArr.forEach(function(e) { arr.push(e); })` 替代。

踩坑案例：`code.js` 第 131 行 `return { ...f, imageHash: sourceHash }` 导致运行时报错 `Syntax error on line 131: Unexpected token ...`。修复为 `var updated = Object.assign({}, f); updated.imageHash = sourceHash; return updated;`。

## 嵌套 Prefab Instance 不能盲目用 sizeDelta resize

放置嵌套 Prefab 的 Instance 时，**不能直接把父 Prefab 的 `m_SizeDelta` override 当作 Instance 的目标视觉尺寸来 resize**。必须先检查子 Prefab 内部的 anchor 结构：

- 如果子 Prefab 根节点的直接子节点使用了 **stretch anchor (0,0)→(1,1)**（如 AnimationRoot），而 stretch 子节点内部的孙节点使用了 **固定 anchor (0.5,0.5) + 固定 sizeDelta**（如 Icon），那么视觉尺寸由孙节点决定，不随根节点 sizeDelta 变化。
- 此时 **不应该 resize Instance**，直接用组件默认尺寸即可。

**判断流程**：

1. 读取子 Prefab 根节点的第一层子节点 anchor：
   - 如果是 `anchorMin=(0,0), anchorMax=(1,1), sizeDelta=(0,0)` → 这是 stretch 容器
2. 继续检查 stretch 容器内的子节点：
   - 如果是 `anchorMin=(0.5,0.5), anchorMax=(0.5,0.5)` + 固定 sizeDelta → 视觉尺寸固定
3. 结论：override 的 sizeDelta 只改变逻辑边界，不影响视觉渲染，**不要 resize**

**正确做法**：

```javascript
// 通用组件库中的组件尺寸本身就是正确的视觉尺寸
const instance = component.createInstance();
parentFrame.appendChild(instance);
// 不要 resize！直接用默认尺寸
instance.x = calculatedX;
instance.y = calculatedY;
```

**错误做法**：

```javascript
// ❌ 错误：把 sizeDelta override 当作视觉尺寸来 resize
const instance = component.createInstance();
instance.resize(overrideSizeDelta.x + importBoundsPadding, overrideSizeDelta.y + importBoundsPadding);
```

踩坑案例：TwoBtnTips 中 RedBtn 的 override `sizeDelta=(451, 112)`，但 RedBtn 内部结构是 `RedBtn → AnimationRoot(stretch) → Icon(固定 484x150)`。Icon 不随 RedBtn 根节点变化，视觉上按钮始终是 484px 宽。错误地 resize ImportBounds 到 572x150，导致按钮在 Figma 中比 Unity 实际渲染宽了 88px。正确做法是不 resize，直接用组件默认尺寸 484x150。

**补充**：此规则也说明了为什么截图验收是硬性步骤——纯数学推算无法发现 anchor 层级导致的视觉尺寸与 sizeDelta 不一致问题，必须对照 Unity 实际渲染截图才能发现。

## 嵌套 Prefab Instance 不能盲目用 sizeDelta resize

放置嵌套 Prefab 的 Instance 时，**不能直接把父 Prefab 的 `m_SizeDelta` override 当作 Instance 的目标视觉尺寸来 resize**。必须先检查子 Prefab 内部的 anchor 结构：

- 如果子 Prefab 根节点的直接子节点使用了 **stretch anchor (0,0)→(1,1)**（如 AnimationRoot），而 stretch 子节点内部的孙节点使用了 **固定 anchor (0.5,0.5) + 固定 sizeDelta**（如 Icon），那么视觉尺寸由孙节点决定，不随根节点 sizeDelta 变化。
- 此时 **不应该 resize Instance**，直接用组件默认尺寸即可。

**判断流程**：

1. 读取子 Prefab 根节点的第一层子节点 anchor：
   - 如果是 `anchorMin=(0,0), anchorMax=(1,1), sizeDelta=(0,0)` → 这是 stretch 容器
2. 继续检查 stretch 容器内的子节点：
   - 如果是 `anchorMin=(0.5,0.5), anchorMax=(0.5,0.5)` + 固定 sizeDelta → 视觉尺寸固定
3. 结论：override 的 sizeDelta 只改变逻辑边界，不影响视觉渲染，**不要 resize**

**正确做法**：

```javascript
// 通用组件库中的组件尺寸本身就是正确的视觉尺寸
const instance = component.createInstance();
parentFrame.appendChild(instance);
// 不要 resize！直接用默认尺寸
instance.x = calculatedX;
instance.y = calculatedY;
```

**错误做法**：

```javascript
// ❌ 错误：把 sizeDelta override 当作视觉尺寸来 resize
const instance = component.createInstance();
instance.resize(overrideSizeDelta.x + importBoundsPadding, overrideSizeDelta.y + importBoundsPadding);
```

踩坑案例：TwoBtnTips 中 RedBtn 的 override `sizeDelta=(451, 112)`，但 RedBtn 内部结构是 `RedBtn → AnimationRoot(stretch) → Icon(固定 484x150)`。Icon 不随 RedBtn 根节点变化，视觉上按钮始终是 484px 宽。错误地 resize ImportBounds 到 572x150，导致按钮在 Figma 中比 Unity 实际渲染宽了 88px。正确做法是不 resize，直接用组件默认尺寸 484x150。

**补充**：此规则也说明了为什么截图验收是硬性步骤——纯数学推算无法发现 anchor 层级导致的视觉尺寸与 sizeDelta 不一致问题，必须对照 Unity 实际渲染截图才能发现。

## 旋转节点必须使用 relativeTransform，禁止使用 rotation 属性

当 JSON 节点的 `rect.rotationZ != 0` 时，**严禁使用 Figma 的 `node.rotation` 属性**。Figma 的 `rotation` 是围绕节点左上角旋转的，而 Unity 的旋转是围绕 pivot（通常是中心）旋转的。直接设置 `rotation` 会导致节点视觉位置偏移。

**必须使用 `relativeTransform` 矩阵**，根据旋转角度计算正确的变换。

### 关键概念：rect.x/y 是未旋转时的左上角位置

解析器 `rect_transform.py` 输出的 `rect.x/y` 是**未旋转状态下节点左上角**相对于父节点的位置（基于 anchor/pivot/sizeDelta 计算），**不是旋转后 AABB 的左上角**。因此必须以 pivot 中心为旋转原点来计算 `relativeTransform`。

### 通用公式（适用于所有角度，包括非整数倍 90° 的任意角度）

```javascript
const rad = -rect.rotationZ * Math.PI / 180; // Figma 旋转方向与 Unity 相反
const cos = Math.cos(rad);
const sin = Math.sin(rad);
const cx = rect.width / 2;
const cy = rect.height / 2;

// rect.x/y 是未旋转时的左上角，pivot 中心在父空间中的位置：
const pivotX = rect.x + cx;
const pivotY = rect.y + cy;

// 以 pivot 为旋转中心，计算旋转后节点本地原点 (0,0) 在父空间中的位置：
// Figma relativeTransform: 本地点 (lx,ly) → 父空间 (cos*lx + sin*ly + tx, -sin*lx + cos*ly + ty)
// 要求本地中心 (cx,cy) 映射到父空间 (pivotX, pivotY)：
const tx = pivotX - cos * cx - sin * cy;
const ty = pivotY + sin * cx - cos * cy;

node.relativeTransform = [[cos, sin, tx], [-sin, cos, ty]];
```

### 180° 旋转（最常见：上下翻转按钮）

```javascript
// rotationZ = 180 → cos=-1, sin=0
// tx = pivotX - (-1)*cx - 0*cy = pivotX + cx = rect.x + width
// ty = pivotY + 0*cx - (-1)*cy = pivotY + cy = rect.y + height
node.relativeTransform = [[-1, 0, rect.x + rect.width], [0, -1, rect.y + rect.height]];
```

### 90° 旋转

```javascript
// rotationZ = 90 → rad = -90° → cos=0, sin=-1
// tx = pivotX - 0*cx - (-1)*cy = pivotX + cy
// ty = pivotY + (-1)*cx - 0*cy = pivotY - cx
node.relativeTransform = [[0, -1, rect.x + cx + cy], [1, 0, rect.y + cy - cx]];
```

### 270° 旋转（或 -90°）

```javascript
// rotationZ = 270 → rad = -270° → cos=0, sin=1
// tx = pivotX - 0*cx - 1*cy = pivotX - cy
// ty = pivotY + 1*cx - 0*cy = pivotY + cx
node.relativeTransform = [[0, 1, rect.x + cx - cy], [-1, 0, rect.y + cy + cx]];
```

### 验证方法

设置 `relativeTransform` 后，验证节点 pivot 中心的绝对位置：

```javascript
const abs = node.absoluteBoundingBox;
const parentAbs = node.parent.absoluteBoundingBox;
// 旋转后 AABB 中心应该等于 pivot 在父空间中的绝对位置
const expectedAbsCenterX = parentAbs.x + pivotX;
const expectedAbsCenterY = parentAbs.y + pivotY;
const actualCenterX = abs.x + abs.width / 2;
const actualCenterY = abs.y + abs.height / 2;
// 两者应该相等（允许浮点误差 < 0.1）
```

### 踩坑案例

**案例 1**：GlobalMapView 的 UpRoot 按钮（rotationZ=180），直接设置 `rotation=-180` 后 `relativeTransform` 变成 `[[-1, 0, 839], [0, -1, 46]]`，视觉位置偏移到 (655, -154)。正确做法是设置 `relativeTransform = [[-1, 0, 839+184], [0, -1, 46+200]]` = `[[-1, 0, 1023], [0, -1, 246]]`，视觉区域正确落在 (839, 46) ~ (1023, 246)。

**案例 2**：Timer 的 Center 节点（rotationZ=145.306°），使用旧版错误公式 `tx = rect.x + cx - (cos*cx - sin*cy)` 导致 Center 整体偏移约 57px，其子节点 Clock 指针位置完全错误。旧公式假设 `rect.x/y` 是旋转后 AABB 左上角，但实际是未旋转时的左上角。对于 180° 旋转（sin=0）两个公式恰好结果相同，所以之前没暴露问题；但对于 145.306° 这种非整数倍角度，差异显著。改用 pivot 中心公式后修复。

### ⚠️ 已废弃的错误公式（不要使用）

```javascript
// ❌ 错误：假设 rect.x/y 是旋转后 AABB 左上角
const tx = rect.x + cx - (cos * cx - sin * cy);
const ty = rect.y + cy - (sin * cx + cos * cy);
// 此公式仅在 180° 时碰巧正确，对任意角度会产生位置偏移
```


## ⛔ 嵌套 PrefabInstance 必须主动处理，不能跳过（致命错误）

**严重等级：致命。违反此规则等同于导入失败，必须立即修复。**

当解析器 JSON 的 `prefabInstances` 数组不为空时，**严禁跳过不处理，严禁创建占位 Frame 替代，严禁在委托指令中简化为"占位即可"**。必须：

1. 通过 GUID 在项目 `.meta` 文件中找到子 Prefab 的路径。
2. 从父 Prefab 文件中读取 `m_Modification` 获取 override 数据（`m_TransformParent`、`m_AnchoredPosition`、`m_SizeDelta`、`m_AnchorMin/Max`、`m_Pivot`、文本/名称 override）。
3. 在 Figma 文件中搜索已有的同名 Component（**必须覆盖所有页面**，用 `figma.root.findAll`）。
4. 找到则创建 Instance 并根据 override 计算正确位置。
5. 找不到则先独立导出子 Prefab 为 Component，再创建 Instance。

**静态解析器不合并嵌套 Prefab 内容**，只报告 GUID 列表。这不意味着可以忽略它们——必须手动解析 override 并放置 Instance。

**验证门槛**：导入完成后，必须检查 `prefabInstances` 中列出的每个子 Prefab 在 Figma 中是否以 INSTANCE 类型节点存在。如果存在 type=FRAME 的占位节点，视为导入未完成，必须修复。

踩坑案例：BuffChapterDashView 导入时，`prefabInstances` 包含 Timer 和 KaTongGreenBtn_1 两个组件，但初次导入直接创建了占位 Frame，导致用户反馈"丢失了通用节点"。原因是委托 sub agent 时指令中说了"创建占位 Frame 即可"，覆盖了本规则。**任何情况下都不允许用占位 Frame 替代 Component Instance。**

## ImportBounds Instance 定位必须考虑内部根节点偏移

当子 Prefab 有 `__ImportBounds` 包裹时，ImportBounds 的中心**不等于**子 Prefab RectTransform 根节点的中心。放置 Instance 时必须：

1. 读取 Component 内部根节点（与子 Prefab 同名的 Frame）的 `x`、`y`、`width`、`height`。
2. 计算根节点中心在 ImportBounds 中的坐标：`rootCenterX = child.x + child.width/2`，`rootCenterY = child.y + child.height/2`。
3. 用 `Instance左上角 = 目标中心 - rootCenter` 计算最终位置。

**严禁假设根节点在 ImportBounds 中居中。** ImportBounds 是为了包含视觉溢出而创建的，根节点通常不在正中心。

**正确做法**：

```javascript
// 读取 Component 内部根节点位置
const timerComp = figma.getNodeById(componentId);
const timerRoot = timerComp.children.find(c => c.name === "Timer");
const rootCenterX = timerRoot.x + timerRoot.width / 2;
const rootCenterY = timerRoot.y + timerRoot.height / 2;

// 目标中心（基于 override 的 anchor + anchoredPosition 计算）
const targetCenterX = parentWidth * anchorX + anchoredPositionX;
const targetCenterY = parentHeight * (1 - anchorY) + anchoredPositionY; // Unity y→Figma y

// Instance 左上角
instance.x = targetCenterX - rootCenterX;
instance.y = targetCenterY - rootCenterY;
```

踩坑案例：BuffChapterDashView 中 Timer__ImportBounds（244x148）内部的 Timer 根节点（100x100）位于 (96.43, 23.93)，根节点中心在 (146.43, 73.93)。直接用 ImportBounds 中心对齐导致 Timer 偏移约 24px。改用根节点中心对齐后修复。

## 解析器多行文本可能截断，必须验证完整性

解析器在解析 TMP 的 `m_text` 字段时，如果文本是 YAML 多行字符串（使用 `'` 引号包裹或 `|`/`>` 块标量），可能只输出第一行内容。

**写入 Figma 文本前必须验证**：如果 JSON `text.content` 看起来不完整（以介词、连词结尾，或明显是句子片段），必须回源 `.prefab` 文件中读取完整的 `m_text` 字段。

**检查方法**：

```powershell
# 在 prefab 文件中搜索 m_text 字段
Select-String -Path "path/to/Prefab.prefab" -Pattern "m_text:" -Context 0,5
```

**YAML 多行字符串格式示例**：

```yaml
m_text: 'Complete all buildings in

    the chapter to win:'
```

解析器可能只输出 `'Complete all buildings in`，丢失了后续行 `the chapter to win:`。

踩坑案例：BuffChapterDashView 的 `[DescText]` 完整文本是 `Complete all buildings in\n\nthe chapter to win:`（3 行），但解析器 JSON 只包含第一行 `'Complete all buildings in`，导致 Figma 中文字不完整。从源文件读取完整内容后修复。


## ⛔ 创建主层级后必须立即处理 prefabInstances，不能延后（致命错误）

**严重等级：致命。违反此规则等同于导入不完整，用户会反馈"丢失公共组件"。**

创建 Prefab 主层级（按 JSON `root.children` 递归创建节点）后，**必须在同一次导入流程中立即遍历 `prefabInstances` 数组**，逐个处理每个嵌套子 Prefab。严禁以下行为：

- ❌ 只创建 JSON 中已解析的节点，跳过 `prefabInstances` 不处理
- ❌ 把 prefabInstances 处理"留到后面"或"等用户反馈再补"
- ❌ 委托 sub-agent 时在指令中省略 prefabInstances 处理步骤
- ❌ 认为 report.md 中的 warning "PrefabInstance documents detected" 只是信息提示

**正确流程**：

1. 创建主层级（按 JSON children 递归）
2. **立即**遍历 `prefabInstances` 数组
3. 对每个 entry：
   a. 用 GUID 在项目 `.meta` 文件中找到子 Prefab 路径
   b. 从父 Prefab 的 `m_Modification` 段读取 override（position、size、anchor、name）
   c. 在 Figma 全文件搜索已有同名 Component（`figma.root.findAll`）
   d. 找到 → 创建 Instance 并定位
   e. 找不到 → 解析子 Prefab → 创建 Component → 创建 Instance 并定位
4. 验证：检查每个 prefabInstance 在 Figma 中是否为 INSTANCE 类型节点

**根本原因**：静态解析器 `prefab_to_figma.py` 不会递归合并嵌套 PrefabInstance 的内容到 JSON 的 `root.children` 树中。它只在 `prefabInstances` 数组中报告 GUID 列表，并在 `warnings` 中输出提示。如果只按 `root.children` 创建节点，所有嵌套的公共组件（按钮、头像、下拉面板等）都会丢失。

**识别信号**：
- report.md 中出现 `PrefabInstance documents detected: N`
- JSON `prefabInstances` 数组长度 > 0
- JSON `warnings` 中出现 `Missing child RectTransform XXXX`（这些 missing 的 RectTransform 就是嵌套 Prefab 的根节点）

踩坑案例：ShutdownSwitchOpponentsView 导入时，`prefabInstances` 包含 `Common_Down_1`、`Common_HeadIconRoot`、`KaTongGreenBtn_3` 三个公共组件。初次导入只按 JSON children 创建了主层级节点，完全跳过了 prefabInstances 处理，导致用户连续两次反馈"丢失公共组件"。正确做法是在主层级创建完成后，立即遍历 prefabInstances 数组，搜索已有组件并放置 Instance。

## 文本字体必须自动匹配文件中已有风格（2026-05-19 固化）

### 问题历史
AlbumView 导入后，3 个文本节点的字体为 `Inter Regular`，但目标 Figma 文件中 373 个已有 TEXT 节点的主流字体是 `Lilita One Regular`。导致文本视觉风格与文件中其他界面不一致。

### 强制规则

#### MCP Relay 侧：`code.js` / `02_prefab_to_figma.js`

**必须在写入文本前做全文件字体检测**：

1. `detectPrefabFileFont(context)` 函数遍历所有页面的所有 TEXT 节点，统计 `fontName.family + style` 的出现次数。
2. 取出现次数最多的字体作为 `context.fileFont`。
3. `loadPrefabTextFont` 的字体候选顺序改为：
   ```
   candidates = [
     context.fileFont,                    // 1. 文件主流字体
     fileFont Regular 变体,                // 2. 同字体的 Regular
     { family: "Inter", style },          // 3. Inter 兜底
     { family: "Inter", style: "Regular" } // 4. Inter Regular 兜底
   ]
   ```
4. 写入文本节点的 `figmaFontFamily` / `figmaFontStyle` 元数据反映实际使用的字体。

#### LLM 验证要求
- 导入完成后必须检查文本节点字体是否与文件中已有风格一致（可用 `use_figma` + `fontName` 属性查询）
- 例外：如果文件中完全没有文本节点（新文件），可以使用 Unity TMP 字体名对应查找

#### 字体降级元数据
- 使用非 Inter 字体时，`fontFallback=true`、`figmaFontFamily`、`figmaFontStyle` 已在 `writePrefabTextMetadata` 中自动写入

## PrefabInstance 位置计算规则（2026-05-19 固化）

### 问题历史
AlbumView 导入时，`Common_Prefab_Down_1` 和 `Common_Prefab_TipBtn_1` 两个 Instance 都被放在了 `(0,0)`。原因是：
1. `_parse_variant_modifications` 的 regex 中 `(.+)` 在 DOTALL 模式下贪婪匹配，把所有 modification 吞到一个条目里
2. `_find_parent_rect_size` 未实现（始终返回 `{}`），`rect` 无法计算
3. 即使 parser 输出了 `rectTransform` 原始字段，MCP Relay 的 `resolvePrefabInstanceRect` 也因缺少 `rectTransform` 数据而无法计算位置
4. Unity Y-up → Figma Y-down 转换未正确应用（`anchoredPosition.y` 被直接当成 Figma Y 坐标）

### 强制规则

#### Parser 侧：`prefab_to_figma.py`
- `_parse_variant_modifications` 的 `propertyPath` 和 `value` 捕获都必须使用 lazy `(.+?)` 而非 greedy `(.+)`，否则在 DOTALL 模式下会跨 modification 条目
- `_find_parent_rect_size` 必须从同一 Prefab 的 RectTransform 文档中提取父节点尺寸：
  - 固定锚点（anchorMin ≈ anchorMax）：父尺寸 = sizeDelta
  - stretch 锚点 (0,0)→(1,1)：父尺寸 = canvas 尺寸
  - 其他：锚点跨度 × canvas + sizeDelta
- 计算得到的 rect（已做 Figma Y-up→Y-down 转换）必须写入 `instanceOverride.rect`
- 原始 override 字段必须写入 `instanceOverride.rectTransform`（含 `m_AnchorMin`/`m_AnchorMax`/`m_SizeDelta`/`m_AnchoredPosition`/`m_Pivot`）

#### MCP Relay 侧：`code.js` / `02_prefab_to_figma.js`
- `applyPrefabInstanceGeometry` 必须检查 stretch-to-fill 情况：如果 computed rect 尺寸 ≈ 父节点尺寸（stretch anchor + sizeDelta 0），则**不要 resize Instance**，只将位置置于 `(0,0)`。Component 自身视觉尺寸由子 Prefab 内部布局决定。
- 非 stretch 情况使用 computed rect 设置位置和尺寸

#### 验证要求
- MCP Relay 写入完成后，必须检查每个 prefabInstance 的 `x/y` 和父节点尺寸
- 检查坐标换算是否正确（特别是 Y 轴翻转）
- 检查 stretch anchor 的 Instance 是否被错误 resize
