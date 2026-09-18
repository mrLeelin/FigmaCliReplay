# PSD Layer To Figma：Figma Relay Companion 快速路径

## 目标

用本地 `figmaRelay` Relay 驱动 `<relay-root>` 下的公共 Figma 插件完成 PSD 导入标准全流程，替代官方/通用 Figma MCP 的大量往返：

```text
export_psd_layers.py
  -> manifest_summary.json + PNG
  -> figmaRelay / figma_relay_cli.py 通过 /relay WebSocket 提交任务
  -> Figma Relay Relay
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
3. Relay 由外部管理，AI 不负责启动或重启。独立任务使用 `node dist/cli.js sessions` 检查目标会话；插件任务以接单为预检。
4. 保持 Figma 插件 UI 打开，使用显式 fileKey/sessionId 固定目标。CLI 地址为 `ws://127.0.0.1:32130/relay`，插件命令和结果走 `/figma`。

## 推荐命令

先导出 PSD 图层和摘要：

```powershell
python "<relay-root>\ai\skills\psd-layer-to-figma\scripts\export_psd_layers.py" `
  Doc\Psd\example.psd `
  --out .tmp\psd_layer\example `
  --composite-check `
  --summary
```

再通过 Python CLI wrapper 提交：

```powershell
python "<relay-root>/ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py" `
  .tmp/psd_layer/example/manifest_summary.json `
  --file-key <fileKey> --session-id <sessionId> `
  --target-node-id 62:2087 --root-name UI_Example --wait `
  --result-output .tmp/psd_layer/example/figma_relay_result.json
```

- Relay 生命周期由外部管理。AI 不得启动、重启、停止或重配服务；插件任务以 Relay 接受为预检，独立任务使用 `node dist/cli.js sessions`。连接失败记录原始错误并停止，不探测替代端口。

## 数据契约

CLI wrapper 会把 `manifest_summary.json` 原样提交给 `figmaRelay`，再由 Relay 转给内部 relay：

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

CLI wrapper 结果保存在 `--result` 指定路径，至少检查：

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

- MCP 回退入口已移除。Relay 或插件不可用时记录阻塞及实际资产状态，修复环境后继续 CLI + WebSocket 流程。

- MCP 回退入口已移除。Relay 或插件不可用时记录阻塞及实际资产状态，修复环境后继续 CLI + WebSocket 流程。
