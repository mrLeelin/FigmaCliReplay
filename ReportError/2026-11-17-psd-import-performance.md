# 剧情对话 PSD 导入耗时实测与显隐优化

2026-11-17 使用用户提供的 `C:\Users\li182\Downloads\剧情对话.psd` 实际导入 Figma。

## 输入与结果

- 文件大小：153,266,622 bytes；SHA-256：`6cabb0e342fd5a1d8d2dc60b164e8026ce259abb8bd31306643dd620ed1c3579`。
- 目标文件：字体尝试，`fQGhCzNJ2n3WpKhjamuFSb`，Page 1 (`0:1`)。
- 本次任务：`psd-perf-9b81163e41674e7aadfe`；Figma 子任务：`psd-import-1794914780854`。
- [导入结果](https://www.figma.com/design/fQGhCzNJ2n3WpKhjamuFSb?node-id=33-1101)：根节点 `33:1101`，新建 74 个节点（根节点 + 56 图片 + 17 原生文字）。
- `status=completed`，`directChildCount=73`，warnings/errors 均为空。

## 实际耗时（秒）

阶段时间来自 `.logs/relay-2026-11-17.jsonl` 的服务端时间戳；完整客户端时间另外包含分块上传与 CLI 开销。

| 阶段 | 原成功记录 `psd-e2e-1794910857` | 优化前最近任务 `psd-1794913400432-8f35b787644d7` | 本次优化后 |
| --- | ---: | ---: | ---: |
| 原始图层导出 | 13.597 | 13.585 | 16.237 |
| Photoshop 渲染及清单生成 | 562.394 | 724.811 | **135.805** |
| Figma 提交、执行及结果读取 | 5.507 | 22.235 | **193.899** |
| 文字校正 | 7.693 | 8.512 | 7.481 |
| 服务端总计 | 589.192 | 769.144 | **353.422** |

本次从客户端开始到完成为 **366.650 秒（约 6 分 7 秒）**，其中 37 个 4 MiB 分块上传约 10.741 秒。不能把 Photoshop 的 135.805 秒当成完整导入耗时。

本次 Figma 子任务的插件内 `durationMs=192142`，说明额外等待确实发生于插件执行期间；具体子阶段尚未定位。完成后再次执行最终节点检查只用 0.213 秒、独立截图只用 2.289 秒，不能据此断定先前等待的原因。没有重放结果未知的导入。

原成功记录的日志起始行 53693、53720（渲染）、57170（提交）、57715（文字校正）、58050（完成）；最近任务为 63154、63335、68353、69002、69178；本次为 70085、70181、70982、72713、73066。

## 根因与本次修正

`photoshop_render_units.jsx` 原来为每个单元隐藏大量可见兄弟图层，另存 PNG，然后全部还原。下一单元又重复相同的显隐操作，造成大量无意义的 Photoshop 状态切换和合成。

现在首次修改前递归快照整棵图层树的可见状态，缓存同级列表；连续单元只应用显隐差异，整个渲染结束后统一还原。40 层的可执行回归用例从 3120 次显隐变化降到不超过 160 次。

Photoshop 的子层 `.visible` 会受父组隐藏影响，快照必须在首次隐藏任何祖先之前完成。懒缓存曾导致跨组切换时把原本可见的子层记为隐藏，真实小样对照已发现该问题，新增回归用例并改为整树预快照后消除。

本轮继续使用源文档原位合成和现有 PNG 导出方式，渲染质量参数与文字数据保持原设置。**仍使用 Photoshop；未实现独立渲染器，也未定位本次 Figma 执行的额外等待。**

## 验证

自动检查：

```powershell
node --test tests/psd-render-visibility.test.mjs tests/psd-photoshop-render-task.test.mjs
python -m unittest discover -s ai/skills/psd-layer-to-figma/tests -p test_photoshop_render_units.py
```

10 项 Node 检查（其中 4 项直接执行 JSX 的显隐逻辑）、9 项 Python 检查通过。覆盖跨组切换、有效可见性、隐藏子层/剪贴链、原子组隐藏文字、PNG 保存失败后的下一单元与最终还原。Python 测试中的既有未关闭图片文件 ResourceWarning 不影响结果。

真实文件对照：

- 73 个源 layer ID、层顺序、模式、位置、尺寸、透明度、约束与优化前最近任务一致。
- 17 个文字层的清单数据一致，比较时只忽略本轮不同的本地输出目录 `path`。
- 56 张最终裁剪图片中 55 张逐像素相同；1 张渐变的 RGB 最大差值为 1/255，所有图片 alpha 差异为 0。
- 用优化前的原脚本单独重复渲染该渐变，同样测得 RGB 最大差值 1、alpha 差异 0，因此不能声称整次输出位级一致。
- 最终通过 CLI 重新读取了 74 个真实节点，并重新导出 5176×2160 的 PNG，`allPass=true`、`fileValid=true`，已查看最终截图。

导入门禁全部为 0：`missingNodeCount`、`emptyImageFillCount`、`badTransformCount`、`textClipRiskCount`、`emptyTextCount`、`textColorMismatchCount`、`textStrokeMismatchCount`、`sliceProblemCount`、`emptySliceLayerCount`、`missingSliceSourceFillCount`、`indexOrderBad`、`positionMismatchCount`、`sizeMismatchCount`。本文件没有九宫/三切片或 Common 组件，相关场景由自动检查覆盖，不算本 PSD 的实测验收。

本轮不进行业务分组或 Unity 导入。用户通过 Esc 停止了 Computer Use，之后未继续界面控制，最终状态和截图均经项目 CLI 验证。

## 本地产物

- `.tmp/psd-perf-20261117/phase-timings.json`：三个任务的服务端阶段与日志行号。
- `.tmp/psd-perf-20261117/import-timing.json`、`import-status.json`：本次客户端计时与最终任务结果。
- `.tmp/psd-perf-20261117/import-pixel-verification.json`：56 张图片逐层比较。
- `.tmp/psd-perf-20261117/native-repeat-result.json`：原脚本重复渲染的原生抖动对照。
- `.tmp/psd-perf-20261117/final-inspection.json`、`final-screenshot.json`：导入完成后的真实节点与截图记录。
- `.tmp/psd-to-figma/psd-perf-9b81163e41674e7aadfe/`：本次上传源文件、清单、渲染图层、提交结果、timeline。
- `.local/artifacts/final-screenshot-psd-perf-9b81163e41674e7aadfe/剧情对话_33_1101.png`：文字校正后的最终截图。
