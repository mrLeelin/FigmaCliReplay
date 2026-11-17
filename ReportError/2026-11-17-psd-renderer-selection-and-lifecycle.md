# PSD 合成器选择与 Photoshop 启动归属

## 本轮行为

首次 PSD 导入默认在本机 Photoshop COM 可用时选择 Photoshop，否则选择 psd-tools 独立合成。显式诊断参数 `FIGMA_RELAY_PSD_RENDERER=auto|photoshop|psd-tools|raw` 保留，`auto` 是正常默认值。

Photoshop 模式在渲染前建立会话归属记录，直到 Figma 创建、验证和文字校正结束后再收尾：

- 导入前已运行的 Photoshop 始终保持打开，包括失败或取消。
- 导入启动的新实例记录显式启动返回的 PID 与 Windows 进程创建时间；释放只连接仍然匹配的实例。
- 正常完成、失败、取消都调用独立清理脚本。已有用户文档、身份变化或多个实例歧义时保留并记录原因。
- Photoshop 任务持有整个导入会话的串行槽，释放后下一个任务才能使用 Photoshop。
- 清理 helper 的 30 秒超时只终止本任务的 Python helper，不终止 Photoshop；警告保留在任务日志中，队列继续运行。
- receipt 模式的渲染失败和 COM 激活失败不在 renderer 内内联调用 Quit，防止失败清理先卡住而绕过独立清理的超时。

## 真实环境验证

`剧情对话.psd` 的 psd-tools 完整导出：46.23 秒，73 层（56 图片、17 原生文字），没有调用 Photoshop。输出目录 `.tmp/psd-tools-fallback-worker-20261117`。有 10 条图片 InnerShadow/DropShadow 兼容警告；本轮没有声称 psd-tools 与 Photoshop 完全一致。

另用临时 64×64、两图层 PSD，通过新编译的任务模块及真实 Python、现有 Relay 的 CLI/Figma 提交通道运行两次完整导入：

| 请求 | 实际合成器 | 结果 | 耗时 | Photoshop 会话 |
| --- | --- | --- | ---: | --- |
| `psd-policy-smoke-auto-2a8d4273` | Photoshop | completed，3 节点 | 32.335 秒 | startedByImport=false、wasRunning=true、release=kept |
| `psd-policy-smoke-psd-tools-76ea3ced` | psd-tools | completed，3 节点 | 24.312 秒 | 没有创建 Photoshop receipt |

真实 Photoshop 进程在测试前后均为 PID 83768，启动时间不变。没有关闭用户已经打开的 Photoshop。两个临时 Figma 根节点 `34:1177`、`34:1180` 已按精确 ID 清除，原始删除请求核对为 succeeded，再次检查确认这两个节点均不存在。

新启动 Photoshop 后实际退出的分支使用自动测试验证，没有为了实机覆盖而关闭用户现有实例。真实全量 PSD 已验证独立导出，完整 Figma 链路的本轮现场测试使用上述小 PSD。

## 自动验证

- `npm run build`：通过，插件 build 341。
- `node --test tests/psd-renderer-lifecycle.test.mjs tests/psd-photoshop-render-task.test.mjs tests/psd-render-visibility.test.mjs tests/psd-import-progress-ui.test.mjs`：40/40。
- `.venv/Scripts/python.exe -m unittest discover -s ai/skills/psd-layer-to-figma/tests`：69/69。
- `.venv/Scripts/python.exe -m unittest discover -s tests -p test_psd_export.py`：16/16，覆盖依赖从 psd-tools 1.20 升级到 1.26.1 后的 PSD 写出回归。
- 独立审查发现的清理挂死、保留原因误报问题已修正并加入回归测试。

扩展 Node 检查为 134 项：127 通过、6 失败、1 跳过。六个失败是组件索引容错、增量 staging 收尾和旧文字布局修复的源码断言；将同样测试指向 `HEAD:code.js` 后得到完全相同的六个失败。本轮没有改动这些实现。证据：`.tmp/psd-policy-live-20261117/broad-node-tests-summary.json` 和 `baseline-node-tests.log`。

## 运行与产物

Python 依赖安装在本项目 `.venv`，没有升级用户全局 Python 的 psd-tools 1.20。解释器优先使用显式 `FIGMA_RELAY_PYTHON`，其次本项目 `.venv`。

该轮验证时常驻 Relay 是修改前启动的进程；测试直接运行新编译任务模块，复用现有 Relay 的 Figma 提交通道。随后用户明确授权重启，已执行 `scripts/start_relay.ps1 -Restart`，旧进程 84200 替换为 81412，并核对插件 build 341 已重新连接。后续打包升版不自动切换当前服务。

本地产物：`.tmp/psd-policy-live-20261117/results.json`（真实任务与会话记录）、`auto-status.json`、`psd-tools-status.json`、`smoke-node-cleanup.json`、`broad-node-tests-summary.json`。
