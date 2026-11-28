请生成可双击离线打开的 `index.html`，包含入场、待机循环、退出重开和可点击按钮。

先用 UTF-8 读取本地文件：

- 技能：`{{skillPath}}`
- 模板：`{{templatePath}}`

{{pathResolution}}

如果我提供了导出的分层 HTML，请直接修改其 `preview-config`，沿用原始节点 ID、层级和内嵌图片。其他情况按技能复制模板，以我提供的设计或素材为准，其次使用单选快照；没有输入时生成可操作的通用示例。

读取 Figma 时用 `figma-relay` 核对文件和节点，优先使用快照中的会话。会话离线时只查同一文件。Relay 服务由外部管理。收费拆层与 Figma 写入需另行授权。

在浏览器实测四项交互，用简体中文提供 HTML 链接和验证结果。下方 JSON 是定位数据。

```json
{{contextJson}}
```
