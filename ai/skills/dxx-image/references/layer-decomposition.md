# 内置图片拆层（新版 2026-09-20）

依据用户新版 Gorilla Flow Agent Access Pack 与只读 `GET /api/v1/layer-decomposition`：enabled=true，支持 manifest、zip、upstream-response，psd=false。未公开确切上游版本；用户说 Seedream5.0Pro 拆层时使用此内置能力，不虚构同名模块。

2026-11-23 只读复查：`input.model` 为 `seedream50pro`（默认）与 `seedream55`，`modelOptions.seedream55` 公布了 5.5 专属参数和输入限制（见下文“选择模型”）。

## 一条命令

Python 3.9+，读取项目设置 `.local/dxx-config.json`，兼容 GORILLA_API_KEY/GORILLA_API_BASE，无新增依赖或 MCP。

```bash
python3 -X utf8 ai/skills/dxx-image/scripts/dxx_image.py Decompose \
  --file '/Users/yourname/Pictures/interface.png' \
  --prompt '分离人物、背景、按钮与图标' --size 2K \
  --out-dir './outputs/layers-001'
```

```powershell
$cli = 'ai/skills/dxx-image/scripts/dxx_image.py'
python -X utf8 $cli Decompose --file 'D:\images\界面.png' --prompt '分离人物、背景和UI' --size 2K --out-dir './outputs/layers-001'
# Seedream5.5：尺寸默认 auto，可指定最多输出图数（含底图）、文字识别与输出格式
python -X utf8 $cli Decompose --file 'D:\images\界面.png' --model seedream55 --max-images 20 --text-recognition --out-dir './outputs/layers-002'
```

## 选择模型

| | 不传 `--model` / `seedream50pro` | `seedream55` |
|---|---|---|
| 请求 body | 不传时不含 model，与旧版完全一致；显式指定时发送 `model` | 发送 `model: "seedream55"` |
| `--size` | 1K / 1.5K / 2K，默认 1K | auto / 1K / 1.5K / 2K，默认 auto |
| `--max-images` | 不可用 | 2–64，包含底图；不传则用服务端默认 30 |
| `--text-recognition` | 不可用 | 开启时发送 `textRecognition: true`；默认关闭且不发送 |
| `--output-format` | 不可用 | png / jpeg；不传则用服务端默认 png |
| 输入 | PNG/JPEG/WebP，≤ 50 MiB，≥ 262144 像素 | 仅 PNG/JPEG（按文件头核对），≤ 31457280 字节，262144–36000000 像素 |

只有用户要求 Seedream5.5 时才传 `--model seedream55`。5.5 专属参数与其它模型组合、尺寸不属于所选模型、或输入超出限制时，在创建输出目录、上传和提交之前失败。`--check-only` 同样按 `--model` 检查。`maxImages`、`textRecognition`、`outputFormat` 的字段名取自能力接口的 `modelOptions`。2026-11-23 收费实测：`model: "seedream55"`、`size: "auto"`、`maxImages: 64` 被接受，任务记录的模型为 seedream55，约 1 分 40 秒完成，返回底图加 30 个透明层；`textRecognition`、`outputFormat` 尚未实测。服务端拒绝时保留响应和 requestId，不改名重提。

`Decompose` 的客户端等待超时（退出码 2）时，`error.json` 和 stderr 会带上已保存的 taskId，直接用它执行 `Layerwait`。插件「工具 → 拆图」只生成并复制提示词，不提供 `--text-recognition` 选项；需要时可在命令行显式传入。

本项目从仓库根目录调用以上相对路径；其它工作目录使用项目内脚本的绝对路径。仅一张 PNG/JPEG/WebP，单文件最多 50 MiB，保留原始字节。prompt 可省略，最多 2000 字符；size 与模型相关，见“选择模型”。不保证固定数量或名称的图层。

提交前自动检查图片头部尺寸与总像素，当前已观察到的上游下限为 262144 像素（不是每边 512）。尺寸不足在上传前失败，避免局部切片逐个提交后等待失败。不自动缩放、补边或修改原始字节。扩大裁切范围或显式调整图片时须保留对应坐标变换。仅经确认服务端规则已变更时用 `--min-input-pixels` 覆盖下限。

纯本地预检（不读取凭证、不联网、不创建输出目录）：

```powershell
python -X utf8 ai/skills/dxx-image/scripts/dxx_image.py Decompose --file <crop.png> --check-only
```

成功输出尺寸、字节数、SHA256；正式提交将其保存为 `layer-preflight.json`，用于核对是否可复用旧结果。该检查只解析图片头部，不替代完整解码或最终透明边缘验收。

## 恢复与查询

```bash
python3 ai/skills/dxx-image/scripts/dxx_image.py Layerwait --task-id '<TASK_ID>' --out-dir './outputs/layers-001'
python3 ai/skills/dxx-image/scripts/dxx_image.py Layerstatus --task-id '<TASK_ID>' --out-dir './outputs/layers-001'
# 仅明确需要恢复丢失的提交响应时，复用原记录；已有 ID 则仅 GET：
python3 ai/skills/dxx-image/scripts/dxx_image.py Layerresume --out-dir './outputs/layers-001'
```

默认每 4 秒查询，30 分钟等待上限；可用 --timeout-seconds / --poll-seconds 覆盖。超时退出码 2 表示客户端停止等待，不代表服务端失败。Layerstatus 只查询和保存响应；Layerwait 完成后下载。不要再次 Decompose 到新目录来恢复旧任务。

提交前持久保存 layer-request.json 的 requestId、源站和完整 body。该文件不含 API key，但保留原始资产 URL 和请求文本；不能修改，否则无法保证幂等重放。客户端不自动重试 POST。Layerresume 显式恢复：已有 ID 则只 GET，否则使用相同 UUID 和 body。error/submission_unknown 为终态，保留 taskId/requestId，展示 error.message，不自动新建收费任务。

## 接口契约

1. `POST /api/media/upload`，multipart/form-data，一个 file 字段，读取 file.url（不是 file.assetUrl）并补全基址。JSON upload-json 保留为兼容路径。
2. `POST /api/v1/layer-decomposition/jobs`：Bearer 与 `Idempotency-Key: UUID`；body 为 `{image,size,prompt?,model?,maxImages?,textRecognition?,outputFormat?}`，后四项仅在显式指定时发送。仅用户指定费用组时附加 projectGroupId。不发送 module、PSD 或其它导出格式参数（`outputFormat` 只是 5.5 图层图片的 png/jpeg）。接受 202，幂等重放可能返回 200。
3. 查询返回的 pollUrl；缺失时使用 `GET /api/v1/layer-decomposition/jobs/<taskId>`。容纳根对象、job/task/data 中的 status+done。真实收费任务的响应结构尚未实测；未知结构保存响应并停止。
4. queued/submitting/running/saving 且 done=false：等待。completed 且 done=true：下载。error/submission_unknown 且 done=true：停止并显示 error.message。临时 GET 仅有限重试，不转为新提交。
5. 下载 result.zipUrl、manifestUrl、upstreamResponseUrl；result.base/result.layers 的完整信息保留在 layer-task.json。拆层下载和查询必须是配置的 API 源站，同源请求携带相同 Bearer。重定向到第三方时通用下载层不转发密钥。

仅用户要求费用归属时查询 `GET /api/v1/layer-decomposition/project-groups`。素材、历史和并发仍属于认证用户。

## 输出与还原

- layers.zip：原始 ZIP；layers/：安全解包的底图、透明图层和包内清单，保留文件名，拒绝越界路径和符号链接。
- manifest.json：原始规范清单，保留原图尺寸、位置、zIndex。
- upstream-response.json：未改写的上游响应，保留 upstream_extra、coordinates、z_index、cost 等字段。
- layer-request.json、layer-state.json、layer-task-id.txt、layer-task.json：恢复和诊断；layer-files.json、timing.json：输出索引和实际耗时。

还原时使用 manifest 的 documentWidth/documentHeight、placement.left/top/width/height 与 zIndex。图层 PNG 可能只含局部，不能按自身尺寸猜原图位置，不能并排摆放。ZIP 不是 PSD，Photoshop 不会自动解释 JSON。本次接入不含 PSD 导出或编辑器导入器；另行要求时再基于 manifest 合成或导入。
