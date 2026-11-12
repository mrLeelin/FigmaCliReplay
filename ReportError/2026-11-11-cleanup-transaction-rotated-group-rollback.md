# 2026-11-11 层级整理事务打乱画面（Group / 旋转节点坐标口径）

## 现象
- 目标：主界面尝试 `54:4`「建筑主界面」，用 `structure_resources.py --apply` 提交原生整理事务（6 个 CREATE_GROUP）。
- 事务校验失败：`54:142`（含旋转子层的感叹号标记）移入新建分组后漂移约 39px。
- 自动回滚报 `recovery_required`，并把 141/151 个节点写到错误坐标，画面被打乱；靠 Figma 撤销恢复，撤销后仍残留 4 处结构/几何偏差。

## 根因（已用数据确认）
1. Figma 的 `GROUP` / `BOOLEAN_OPERATION` 不建立坐标系，子节点 `x/y` 相对最近的 Frame；旋转/翻转节点的 `x/y/width/height` 是变换原点与自身尺寸，不等于外接包围盒。
2. `code/08_cleanup_transaction.mjs` 回滚 `cleanupRestoreNodeProperties` 用「外接包围盒 − 父节点包围盒」回写 `x/y`，并按包围盒 `resize`，对 Group 子节点和旋转/翻转节点都是错的。
3. 回滚对实例内部子层（`I54:49;33:510`）执行 `insertChild` / 设 `x`，Figma 不允许，导致回滚报错。
4. 移入新分组时 `preserveHierarchyChildAbsoluteBounds` 对含旋转子层的 Group 产生漂移（具体机制待查）。

## 我的验证失误
- 像素比对用 `ImageChops.difference(RGBA).getbbox()`，RGBA 的 `getbbox` 只看 alpha 通道，两张不透明截图永远返回 None，等于没比。
- 正确做法：先 `.convert("RGB")`，并统计差异像素数量，不能只看 bbox。

## 追加：快照命令忽略 rootNodeId，误删前比对无效
- `ui.html` 的 `executeJob` 把 CLI payload 放进 `message.job`，而 `handleQueryCleanupSnapshot` 只读 `message.rootNodeId`，经 CLI 调用时永远退回「当前选区」。
- 我用两次快照比对 `54:4` 与 `69:162`，其实两次都读到了选中的 `69:162`，得出「完全一致」的错误结论，并据此执行了删除 `54:4`。
- `QUERY_CLEANUP_RECOVERY_BACKUPS` 经 CLI 调用不会返回结果，任务一直 running，堵住会话队列，后续请求全部超时；删除请求在插件重连后被派发执行。

## 下次规则（追加）
- 任何快照结果都必须先断言 `snapshot.rootNodeId == 目标 ID`，不一致立即停止。
- 删除前用按 ID 读取的命令（`FIGMA_INSPECT_NODES`、截图 `job.target`）核对目标，不依赖可能读选区的命令。
- 不经 CLI 调用 `QUERY_CLEANUP_RECOVERY_BACKUPS`；会话出现排队超时先查 `task-status`，不追加新请求。

## 下次规则
- 像素比对一律转 RGB，并输出差异像素计数。
- 含 Group / 旋转 / 翻转 / 实例的界面，在插件事务与回滚修好前，不得提交 `FIGMA_HIERARCHY_CLEANUP_TRANSACTION`。
- 写入前先导出基线截图并确认比对脚本能检出已知差异（用一张故意改动的图自测）。
