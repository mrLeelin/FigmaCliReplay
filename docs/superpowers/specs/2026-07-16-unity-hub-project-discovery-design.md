# Unity Hub 工程自动发现设计

## 目标

Figma MCP Relay 打开时自动读取当前 Windows 用户在 Unity Hub 中登记的 Unity 工程，不再要求用户逐个复制工程根目录。用户仍需从下拉框明确选择目标工程；任务开始后继续使用项目快照，避免多工程串线。

## 数据来源

首选读取：

`%APPDATA%\UnityHub\projects-v1.json`

当前 Unity Hub 文件结构为：

```json
{
  "schema_version": "v1",
  "data": {
    "E:\\Project\\GameA": {},
    "E:\\Project\\GameB": {}
  }
}
```

`data` 的属性名是工程路径。Relay 只读取该文件，不修改 Unity Hub 数据，也不扫描整块磁盘。

## 发现与校验

新增独立的 Unity Hub 发现模块，负责：

1. 定位当前用户的 `projects-v1.json`。
2. 安全解析 JSON；文件缺失、格式未知或读取失败时返回空列表。
3. 读取 `data` 的属性名作为候选路径。
4. 将路径规范化为绝对路径。
5. 只保留同时包含 `Assets` 和 `ProjectSettings` 目录的有效 Unity 工程。
6. 按 Windows 路径大小写不敏感规则去重。

发现失败不能阻止 Relay 启动，也不能破坏已有手动项目列表。

## 与现有注册表合并

`UnityProjectRegistry.list()` 返回两类项目：

- `manual`：用户通过输入框添加，继续存储在 `.local/projects.json`。
- `hub`：从 Unity Hub 动态发现，不写入 `.local/projects.json`。

相同路径同时存在时只返回一条记录，手动记录优先，以保持已有 ID 和选择状态稳定。

项目状态新增 `source: "manual" | "hub"`。Hub 项目使用与当前逻辑相同的路径哈希生成稳定 ID，因此可被选择、用于网关发现并写入任务快照。

`lastSelectedProjectId` 继续存储在 Relay 注册表中。启动后只要该 Hub 工程仍有效，原选择会自动恢复；如果工程已失效，则选择第一个有效项目，但不静默改写任务中的历史项目快照。

## UI 行为

- 插件启动时现有 `GET /unity-projects` 自动带回 Unity Hub 工程，无需新增首次操作。
- “刷新工程”重新读取 Unity Hub 文件和磁盘有效性。
- 下拉框可用简短标识区分来源，例如 `GameA（Unity Hub）`。
- 手动输入框和“添加工程”继续保留，用于没有加入 Unity Hub 的工程。
- Hub 来源项目不支持“移除”；选中 Hub 项目时禁用“移除”按钮。用户若要永久移除，应在 Unity Hub 中移除该项目。
- 安装或更新 Bridge 仍必须由用户明确点击，不因自动发现而自动写入 Unity 工程。

## HTTP 与安全边界

沿用现有 `GET /unity-projects`、选择、Bridge 安装和网关发现接口，不新增任意磁盘扫描接口。

Relay 只信任服务端读取到的 Unity Hub 文件；Figma UI 不能提交 Unity Hub 文件路径。所有用于选择、Bridge 安装和任务快照的工程仍需经过服务端 `Assets` 与 `ProjectSettings` 校验。

## 测试

- Unity Hub 文件缺失时只返回手动项目。
- 正常 `projects-v1.json` 能发现多个有效工程。
- 无效目录和非 Unity 目录被忽略。
- 手动项目与 Hub 项目按规范路径去重，手动记录优先。
- Hub 项目 ID 在多次刷新间稳定。
- 选中的 Hub 项目可被 `snapshot()` 和网关发现接口使用。
- Hub 项目不能通过“移除”接口删除，手动项目保持原行为。
- UI 展示来源、自动刷新并正确控制“移除”按钮。
- 全量 Node 测试、TypeScript 检查、UI 脚本语法和 UTF-8 检查通过。

## 非目标

- 不递归扫描所有磁盘寻找 Unity 工程。
- 不自动打开 Unity。
- 不自动安装或更新 Bridge。
- 不修改 Unity Hub 的项目记录。
- 本次只实现 Windows Unity Hub `projects-v1.json`；其他平台或未来 Hub 格式以兼容扩展处理。
