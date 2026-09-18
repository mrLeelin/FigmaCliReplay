# PSD 导入硬规则与错误教训

本文件记录 `$psd-layer-to-figma` 必须内化的错误教训。执行 PSD 分层导入、九宫/三切片生成、Text 导入和最终验证时必须遵守。

## 一、h3-slice 错误：禁止复用九宫中间行

### 错误现象

`jiugong_daily_xxgreen1` 这类横向三切片在 Figma 中完全不像 PSD：上下边缘、圆角和阴影消失，只剩中间横条。

### 错误数据示例

源图层：

```text
name=jiugong_daily_xxgreen1
size=830x173
sliceKind=h3-slice
```

错误生成的 Figma 子切片：

```text
__slice_left   x=0,   y=44, w=44,  h=78
__slice_center x=44,  y=44, w=743, h=78
__slice_right  x=787, y=44, w=43,  h=78
```

这等于只取九宫中间行，丢掉了完整高度 173 中的上 44px 与下 51px。

### 正确规则

`h3-slice` 是横向三切片，只允许切 X 方向，不允许切 Y 方向。

正确生成：

```text
__slice_left   x=0,   y=0, w=left,   h=fullHeight
__slice_center x=left,y=0, w=center, h=fullHeight
__slice_right  x=..., y=0, w=right,  h=fullHeight
```

对应 `imageTransform`：

```javascript
left:   [[left / imageWidth, 0, 0], [0, 1, 0]]
center: [[center / imageWidth, 0, left / imageWidth], [0, 1, 0]]
right:  [[right / imageWidth, 0, (imageWidth - right) / imageWidth], [0, 1, 0]]
```

### 强制验证

```javascript
if (kind === 'h3-slice') {
  assert(children.length === 3);
  for (const child of children) {
    assert(child.y === 0);
    assert(Math.round(child.height) === Math.round(parent.height));
    assert(child.fills[0].imageTransform[1][0] === 0);
    assert(child.fills[0].imageTransform[1][1] === 1);
    assert(child.fills[0].imageTransform[1][2] === 0);
  }
}
```

## 二、v3-slice 错误：禁止复用九宫中间列

### 错误风险

纵向三切片如果复用九宫中间列，会丢失左边缘、右边缘、圆角和阴影。

### 正确规则

`v3-slice` 是纵向三切片，只允许切 Y 方向，不允许切 X 方向。

正确生成：

```text
__slice_top    x=0, y=0,       w=fullWidth, h=top
__slice_center x=0, y=top,     w=fullWidth, h=center
__slice_bottom x=0, y=top+..., w=fullWidth, h=bottom
```

对应 `imageTransform` 第一行必须是 `[1, 0, 0]`。

### 强制验证

```javascript
if (kind === 'v3-slice') {
  assert(children.length === 3);
  for (const child of children) {
    assert(child.x === 0);
    assert(Math.round(child.width) === Math.round(parent.width));
    assert(child.fills[0].imageTransform[0][0] === 1);
    assert(child.fills[0].imageTransform[0][1] === 0);
    assert(child.fills[0].imageTransform[0][2] === 0);
  }
}
```

## 三、Text 错误：固定小文本框 + 过大 leading 导致文字折断

### 错误现象

Figma 文字出现折断、裁切或上下缺失，带描边数字和 `day` 文本尤其明显。

### 错误数据示例

```text
day: fontSize=36, frame=83x33, lineHeight=72, textAutoResize=NONE, strokeWeight=3
2:   fontSize=48, frame=34x42, lineHeight=72, textAutoResize=NONE, strokeWeight=3
9:   fontSize=28, frame=18x25, lineHeight=72, textAutoResize=NONE, strokeWeight=2
```

37 个直接 Text 全部存在风险。

### 根因

PSD 的文本边界不等于 Figma Text 的安全显示框。把 PSD `leading` 直接写入固定高度 Figma Text，会让 Figma 在固定小框中裁切文字。

### 正确规则

导入可编辑 Text 时默认：

```javascript
const cx = text.x + text.width / 2;
const cy = text.y + text.height / 2;
text.lineHeight = { unit: 'AUTO' };
text.textAutoResize = 'WIDTH_AND_HEIGHT';
text.textAlignHorizontal = 'CENTER';
text.textAlignVertical = 'CENTER';
text.x = cx - text.width / 2;
text.y = cy - text.height / 2;
```

### 强制验证

- 直接导入 Text 不应保留 `textAutoResize=NONE`，除非有明确固定框需求。
- 如果 `lineHeight` 是 `PIXELS` 且明显大于文本框高度，必须修正或报告。
- 描边 Text 的框高必须能容纳 `fontSize + strokeWeight * 2` 的视觉需求。

## 四、交付门禁

交付前必须输出验证结论：

```text
h3-slice 检查：子切片数量=3，完整高度，通过/失败
v3-slice 检查：子切片数量=3，完整宽度，通过/失败
9-slice 检查：子切片数量=9，通过/失败
imageTransform 范围：[0,1]，通过/失败
Text 裁切风险：textAutoResize/lineHeight，通过/失败
```

如果任何一项失败，禁止交付，先修复。

## 五、figma_submit_job 格式：禁止传 manifestPath 或用错 job.type

### 错误现象

第一次提交 job 时写了 `type: "psd-layer-import"` 和 `manifestPath: "文件路径"`，结果插件静默忽略，MCP wait 超时。

### 根因

1. 插件 handler 通过 `message.type === "IMPORT_PSD_JOB"` **精确字符串匹配**分派任务。不认识任何变体，也不报错——不匹配就静默跳过。
2. `manifest` 字段必须是**完整嵌入的 JSON 数据**，不能传文件路径。插件无法从文件系统读取路径指向的 JSON。
- 插件命令与结果只走 `/figma` WebSocket；CLI 通过 `/relay` 查询和订阅原任务，不回退 HTTP，不重放结果未知的写入。

### 正确格式

- 业务请求统一使用项目 CLI；`/jobs`、`/figma/pending`、`/figma/result` 已退役并返回 410，`/assets/` 只允许受控下载。

```json
{
  "job": {
    "type": "IMPORT_PSD_JOB",
    "name": "source.psd_<描述>",
    "manifest": {
      "canvas": { "width": ..., "height": ... },
      "layers": [ ... ]
    },
    "assets": [
      { "id": "0", "path": "E:/.../00_xxx.png" },
      { "id": "1", "path": "E:/.../01_xxx.png" }
    ],
    "componentLibrary": {
      "commonRootId": "62:115",
      "imageRootId": "2896:32"
    }
  },
  "assetPaths": {
    "0": "E:/.../00_xxx.png",
    "1": "E:/.../01_xxx.png"
  },
  "fileKey": "ly2b1kkcvLtNBFPSQi4XO4",
  "target": {
    "fileKey": "ly2b1kkcvLtNBFPSQi4XO4"
  }
}
```

关键字段说明：

| 字段 | 规则 |
|------|------|
| `job.type` | **必须**为字符串 `"IMPORT_PSD_JOB"`（在插件 `code.js` 第 80 行做精确匹配） |
| `job.manifest` | 完整的 manifest JSON 对象，**不能**传文件路径字符串 |
| `job.assets` | `[{id, path}]` 数组，插件 UI 通过 `fetchAssets()` 下载这些路径的 PNG 字节 |
| `assetPaths` | `{id: absolute_path}` 映射，relay 端通过 `parseAssetPaths()` 解析并生成可访问 URL |
| `job.componentLibrary` | 可选，默认值即 `{commonRootId:"62:115", imageRootId:"2896:32"}` |
| `fileKey` / `target.fileKey` | 强烈建议必传；用于 runtime relay 精确选择 Figma 插件会话 |
| `sessionId` / `target.sessionId` | 多 Figma 窗口时可传；优先级比 fileKey 更精确 |

### 通道选择

| 场景 | 推荐通道 | 原因 |
|------|---------|------|
| 标准批量导入 | `scripts/submit_psd_import_job.py --file-key ... --wait` | 固定目标、构造完整资源清单、WS 等待和摘要输出 |
| 手写 HTTP POST `/jobs` | 禁止 | 容易漏 target、漏轮询容错、把大 JSON 打进 LLM |

两种通道最终都走到插件 `handleImportPsdJob`，格式要求完全相同。

### 强制验证

- 提交前检查 `job.type === "IMPORT_PSD_JOB"`。不是则修正。
- 检查 `job.manifest` 是对象，不是字符串。
- 检查 `job.assets` 数组中每个 `path` 存在。
- 提交必须携带 `fileKey` / `target.fileKey` 或 `sessionId` / `target.sessionId`。
- 脚本轮询必须容错 204、空 body 和非 JSON body；这些状态只能视为 pending/重试，不能让 JSON decode 直接崩溃。
- 导入后先看 `[SUMMARY_JSON]`，不要把完整 `figma_relay_result.json` 直接读入 LLM。

### 辅助脚本

运行 `scripts/submit_psd_import_job.py` 自动生成正确格式并提交：

```powershell
python "<relay-root>/ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py" `
  .tmp/psd-layer-to-figma/psd_layers_xxx/manifest_summary.json `
  --root-name "source.psd_myname" `
  --file-key "ly2b1kkcvLtNBFPSQi4XO4" `
  --wait
```

## 六、PowerShell → Python 跨工具 JSON 编码：禁止 UTF-16 BOM

### 错误现象

用 PowerShell `Out-File` 写入组件缓存 JSON 后，Python 读取时报错：

```
json.decoder.JSONDecodeError: Unexpected UTF-8 BOM (decode using utf-8-sig)
```

结果不得不删掉重写，多花了一轮时间。

### 根因

Windows PowerShell 的 `Out-File` 和重定向 `>` 默认输出 **UTF-16 LE（带 BOM）**。而 Python `json.load()` 默认只认 UTF-8 无 BOM，不识别 UTF-16 编码，更不认识 UTF-8 BOM（`\xEF\xBB\xBF`），所以直接报错。

更隐蔽的是：`ConvertTo-Json | Out-File` 两步走，PowerShell 会先把对象序列化为 .NET string，再按 `Out-File` 的默认编码写出——结果就是 UTF-16 LE。

### 正确做法

PowerShell 写 JSON 给 Python 用时，必须**显式指定 UTF-8 无 BOM**：

```powershell
# ❌ 错误 — 默认 UTF-16 LE
$json | Out-File "cache.json"

# ✅ 正确 — UTF-8 无 BOM
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines("cache.json", $json, $utf8NoBom)

# ✅ 也可用 Set-Content + -Encoding utf8（但 PowerShell 5.1 的 utf8 仍是 BOM）
$json | Set-Content "cache.json" -Encoding utf8   # 仍有 BOM，但 Python 能处理
```

> 注意：PowerShell 5.1 的 `-Encoding utf8` 仍输出 UTF-8 **带 BOM**。Python 的 `json.load` 能自动跳过 UTF-8 BOM，所以 `Set-Content -Encoding utf8` 是半安全的。完全保险还是用 `[System.IO.File]::WriteAllLines` + `UTF8Encoding($false)`。

### 强制规则

- 任何 PowerShell 写给 Python 读取的 JSON 文件，必须使用 `[System.IO.File]::WriteAllLines("path", $content, [System.Text.UTF8Encoding]::new($false))`。
- 不允许用 `Out-File` 不带编码参数写 JSON。
- 如果改写了缓存文件后 Python 报 JSON 解码错，第一反应检查编码 BOM。
