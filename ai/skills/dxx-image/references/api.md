# CLI 与 API

本项目使用 `ai/skills/dxx-image/scripts/dxx_image.py`，Python 3.9+，仅标准库。设置页和 Python 读取同一份 `<relay-root>/.local/dxx-config.json`；项目已保存字段优先，其次进程环境变量，再其次 Windows 当前用户环境变量。兼容变量为 `GORILLA_API_KEY` / `GORILLA_API_BASE`；默认源站 `https://canvas.dxx.cn`，只支持 HTTPS。配置格式为 `{"version":1,"apiBase":"https://canvas.dxx.cn","apiKey":"..."}`，Key 不写入请求或输出文件。

只读认证测试：

```powershell
python -X utf8 ai/skills/dxx-image/scripts/dxx_image.py Test
```

生成/编辑请求通过 stdin 传入（在项目根目录执行）：

```powershell
@'
{"function":"dxx_image2.5","prompt":"武侠游戏主界面，9:16竖屏","config":{"image25Size":"1152x2048"}}
'@ | python -X utf8 ai/skills/dxx-image/scripts/dxx_image.py Run --request-file - --out-dir './outputs/run-001'
```

macOS/Linux 使用同一相对脚本路径与 `python3 -X utf8`。`Run` 完成上传、提交、等待和下载；不必先 List 或分开启动 Submit/Wait。恢复已知任务时用 `Wait --task-id <id> --out-dir <原目录>`。输出目录记录恢复所需的请求、taskId、响应和文件；不要新提交来恢复结果未知的任务。

编辑的 `images` 接受本地绝对路径、相对请求文件的路径或 HTTPS URL，支持 PNG/JPEG/WebP。本地图片按原始字节 multipart 上传，单文件上限 50 MiB；不静默压缩。`--request-file -` 的相对路径基于当前工作目录。含空格的路径需加引号。

生成入口 `Run/List/Submit/Status/Wait` 使用 `--request-file`、`--task-id`、`--out-dir`。默认轮询 4 秒、等待上限 1800 秒，可显式传 `--timeout-seconds` 和 `--poll-seconds`。`--refresh-modules` 只在明确要刷新模块信息时使用；默认校验随附 snapshot。拆层入口见 [拆层说明](layer-decomposition.md)。

## 参数

- banana：`aspectRatio`、`resolution`，默认 `default`、`1K`。
- seedream5.0：`size`，默认 `2048x2048`。
- image2：`size`、`quality`、`background`，默认均为 `auto`。
- image2.5：`image25Size`（默认 `1024x1024`）、`image25Quality`（默认 `auto`）、`image25Background`（默认 `auto`）、`image25OutputFormat`（默认 `png`）。自定义尺寸支持 `auto` 或 `宽x高`：宽高为 16 的倍数，最长边 3840，比例不超过 3:1，总像素 655360–8294400。透明背景只能使用 PNG。

完整枚举和模块 ID 见 [modules.json](modules.json)，于 2026-09-20 通过已认证只读接口核实。以实时发现为准；已知 ID 或功能名发生变化时停止并重新核实。

## 数据流和输出

1. 本地模块快照校验；仅 List 或 `--refresh-modules` 请求 `GET /api/mcp/modules`。
2. Python 默认按新版 `POST /api/media/upload`：本地原始二进制 multipart，恰好一个 file 字段，50 MiB 上限，读取 `file.url` 并补全 API 基址。远程图片导入沿用 `/api/media/upload-json` 的 `{remoteUrl,purpose}`，读取 `file.assetUrl`。本项目入口统一使用 Python。
3. `POST /api/execute/playground-tasks`：`{moduleId,moduleName,inputs,config}`；提示词键为 `文本输入`，图片键为 `图像输入1`…`图像输入10`。异步接口不附加同步专用的 source。
4. `GET /api/execute/playground-tasks/<taskId>`：等待 completed/error，完成读取 `task.result.outputs`，错误读取 errorMsg/nodeLogs。不实现同步执行。

CLI 支持显式的根级 task / data.task / data / 根任务对象信封，以及创建响应中的 taskId 或任务对象 id。实际 image2.5 生图和 banana 编辑已确认根级 task 信封及 result.outputs 输出。不匹配时安全停止并保存脱敏响应。图片输出识别字符串 URL、数组及 url/assetUrl/imageUrl/value 等嵌套结构；仅下载 HTTP(S) 资源且要求 HTTPS 和图片 Content-Type，非图片资源跳过。不能识别图片时报告错误。

输出目录记录 `submission-started.json`、`request.json`、`created.json`、`task.json`、`task-id.txt`、`files.json` 及图片。记录不含 Bearer；URL 查询参数脱敏，恢复时按任务 ID 重新获取 URL。普通模块 POST 无公开幂等保证，保存请求后仅提交一次，响应不明时先核对最近任务/历史，不自动再次提交。`Wait` 超时退出码为 2，其他错误为 1，成功为 0。临时 GET 失败最多三次（1、2 秒退避），不重试 401/403/404。

API 请求禁止自动重定向。下载最多跟随 5 次 HTTPS 重定向，每一跳独立判断来源：只有与 API 基址同源的请求携带 Bearer，第三方源不携带。生成输出会保存到本机，CLI 不修改机器或用户级环境变量。

## 自动预览与计时

如果已有 Pillow，下载后顺带生成最长 1280、高宽范围 720×1280 的 JPEG 预览，返回 `previews`。无 Pillow 或预览失败时正常交付原图，不临时安装软件，不降低原图质量。可用 `--no-preview` 关闭。

Python 会保存 `timing.json`，成功响应也包含 timing：`upload_http_seconds`、`submit_http_seconds`、`poll_http_seconds`、`wait_wall_seconds`、`download_seconds`、`preview_seconds`、`cli_total_seconds`；显式刷新还有 `discovery_http_seconds`。阶段不存在时字段省略。服务端 `executionTime` 原值保存为 `server_execution_ms`，同时保留服务端起止时间。等待与网络轮询时间重叠，服务端与客户端时间也重叠，不做简单求和。上传文件读取/编码等本地工作计入 CLI 总时间，不计入 HTTP 时间。CLI 总时间不包含对话思考、工具调度、权限审批或图片展示的耗时。Wait 恢复命令的总时间仅代表该次恢复进程。
