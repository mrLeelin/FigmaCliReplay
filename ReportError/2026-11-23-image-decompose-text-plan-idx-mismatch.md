# 拆图导入：文字计划 idx 与合成后 idx 不一致导致图层错位

## 现象

拆图任务（DXX taskId d7ab5773-bb08-434e-8c1f-d571416d31f0）首次导入的 Frame 中，第 14–16 层错位：
SPIN 文字替换了底部导航面板，底部面板图片丢失，SPIN 美术位图残留。导入校验门全部为 0，没有拦住这个问题。

## 根因

1. 为修正 DXX 返回的层级（SPIN 文字 zIndex 低于按钮底图），只调整了源 manifest 数组顺序，原始 `idx` 没有重排。
2. `compose_resources.py` 按数组位置重新编号输出 `idx`（见 `resource-map.json` 的 `outputIdx`）。
3. 文字计划 `sourceIdx` 仍沿用 DXX 原始 idx，`prepare_native_text.py` 因此把文字套到了错误的层上。
4. 导入器按 `idx` 排序创建节点，所以 idx 与数组顺序不一致时也会错位。

## 正确做法

- 调整层级后，让 `idx` 等于数组位置（自下而上），不要只改数组顺序。
- 合成之后，文字计划的 `sourceIdx` 一律通过 `resource-map.json` 的 `outputIdx` 映射，不要直接使用 DXX zIndex。
- 导入后用 inspect 读回逐层核对名称、类型和内容，不能只看 validation 计数。

## 处理

删除本次创建的有缺陷 Frame 241:3，按映射重新生成 prepared-v2 并导入为 242:35。原节点 207:3 没有改动。
