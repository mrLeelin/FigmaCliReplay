# PSD Layer To Figma：Figma MCP Relay Companion 快速路径

## 目标

用本地 `figmaMcpRelay` companion 驱动 `<relay-root>` 下的公共 Figma 插件完成 PSD 导入标准全流程，替代官方/通用 Figma MCP 的大量往返：

```text
export_psd_layers.py
  -> manifest_summary.json + PNG
  -> figmaMcpRelay / figma_mcp_client.py 提交 job 到 /mcp
  -> Figma MCP Relay companion
  -> runtime relay
  -> Figma 插件作为 worker 获取任务
  -> figma.createImage + Plugin API 创建节点
  -> 插件内验证 + exportAsync 截图
```

## 适用场景

- PSD 图层数量较大，`use_figma` 代码容易超过 50000 字符。
- 图片层很多，`upload_assets` 获取上传 URL 成为瓶颈。
- 需要在 3 分钟目标内快速完成分层导入。

## 前置准备

1. 在 Figma Desktop 中导入插件 manifest：

```text
<relay-root>/manifest.json
```

2. 打开目标 Figma 文件和目标页面/容器。
3. 启动本地 companion：

```powershell
powershell -ExecutionPolicy Bypass -File "<relay-root>\start_mcp_companion.ps1" -Mode mcp
```

4. 确认仓库 `.mcp.json` 的 `figmaMcpRelay` 指向：

```text
http://127.0.0.1:32130/mcp
```

5. 运行插件并保持 UI 面板打开。插件默认连接同一 companion 的 relay：

```text
http://localhost:32130
```

## 推荐命令

先导出 PSD 图层和摘要：

```powershell
python "<relay-root>\ai\skills\psd-layer-to-figma\scripts\export_psd_layers.py" `
  Doc\Psd\example.psd `
  --out .tmp\psd_layer\example `
  --composite-check `
  --summary
```

再通过 MCP CLI wrapper 提交：

```powershell
python "<relay-root>\client\figma_mcp_client.py" `
  .tmp\psd_layer\example\manifest_summary.json `
  --source-root .tmp\psd_layer\example `
  --target-node-id 62:2087 `
  --job-name UI_Example `
  --result .tmp\psd_layer\example\figma_mcp_result.json
```

如果 companion 未启动，wrapper 会报错并提示启动命令。不要直接 POST `/jobs`；只有排查插件轮询问题时才手动启动 `start_mcp_companion.ps1 -Mode relay`。

## 数据契约

MCP wrapper 会把 `manifest_summary.json` 原样提交给 `figmaMcpRelay`，再由 companion 转给内部 relay：

```json
{
  "job": {
    "schemaVersion": 1,
    "name": "UI_Example",
    "target": { "nodeId": "62:2087" },
    "manifest": { "canvas": {}, "layers": [] },
    "assets": [
      {
        "id": "17",
        "url": "http://localhost:32130/assets/{requestId}/17",
        "path": "17_layer.png"
      }
    ]
  }
}
```

插件必须直接使用 manifest 字段创建节点，禁止手动转录坐标、颜色、stroke 或切片数据。

## 验证门禁

MCP wrapper 结果保存在 `--result` 指定路径，至少检查：

- `status == "completed"`
- `summary.validation.missingNodeCount == 0`
- `summary.validation.emptyImageFillCount == 0`
- `summary.validation.badTransformCount == 0`
- `summary.validation.textClipRiskCount == 0`
- `summary.validation.textColorMismatchCount == 0`
- `summary.validation.textStrokeMismatchCount == 0`
- `summary.validation.sliceProblemCount == 0`
- `summary.validation.indexOrderBad == 0`
- `summary.validation.screenshotExported == true`
- `screenshot.path` 指向本地 PNG 截图且文件存在
- `errors` 为空；如果非空，必须逐条处理或向用户说明降级

## 强制策略

PSD 标准导入流程必须全量使用 `figmaMcpRelay` + 插件。官方/通用 Figma MCP 仅允许作为人工排查 fallback，不能作为标准交付链路。

如果插件不可用、Figma 未打开目标文件、common 组件 nodeId 不可访问，必须先修复 `figmaMcpRelay`/插件环境；只有用户明确允许 fallback 时，才可以回退官方/通用 Figma MCP。
