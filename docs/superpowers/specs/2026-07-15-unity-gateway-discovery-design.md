# Unity 网关配置发现设计

## 目标

Figma UI 连接 Unity 网关时，应优先读取所选 Unity 项目写出的实际监听地址，而不是把 `localhost:32129-32135` 逐个请求作为主流程。端口扫描只在配置不存在、失效或无法访问时兜底。

## 现状与根因

- Unity Bridge 将首选端口保存在 `EditorPrefs`，但端口冲突时可能监听后续端口。
- Figma UI 无法直接读取 Unity 进程内的 `EditorPrefs`。
- 当前 UI 因而写死 `32129-32135` 并逐个探测 `/health`，无法利用已经注册的 Unity 项目路径。
- `/health` 只有在已经知道监听地址后才能访问，不能承担首次发现职责。

## 方案比较

### 方案 A：项目级发现文件（采用）

Unity Bridge 在成功监听后，将实际地址写入 `<UnityProject>/Library/FigmaBridge/gateway.json`。本地 Companion 根据已注册项目路径读取该文件，再通过 HTTP 接口返回给 UI。

优点：不污染 Git；不要求 Unity 预先知道 Companion 的端口；项目与网关一一对应；记录的是实际端口而非首选端口。缺点：需要处理崩溃留下的陈旧文件。

### 方案 B：Unity 主动向 Companion 注册

Unity 启动后向 Companion POST 实际地址并周期续约。

优点：实时性好。缺点：Unity 必须知道 Companion 地址；Companion 后启动时还要增加重试和心跳，协议耦合更重。

### 方案 C：读取 `EditorPrefs`

Companion 从系统注册表读取 Unity 的首选端口。

优点：改动少。缺点：首选端口不等于实际监听端口；多 Unity 实例和跨平台场景不可靠，因此不采用。

## 数据格式

`Library/FigmaBridge/gateway.json`：

```json
{
  "version": 1,
  "projectPath": "E:/Project/Work/JellybeanUnity",
  "gatewayUrl": "http://localhost:32132",
  "processId": 12345,
  "updatedAtUtc": "2026-07-15T09:20:00.000Z"
}
```

`gatewayUrl` 必须是 Unity Bridge 成功启动后的 `CurrentGatewayUrl`。路径统一为绝对规范路径。写入使用临时文件加替换，避免 UI 读到半份 JSON。

## 组件修改

### Unity Bridge

- `TryStartOnPort` 成功后写入发现文件。
- `Stop` 时只删除与当前 `processId` 和 `gatewayUrl` 匹配的记录，避免多个 Unity 实例互相删除。
- 写入失败只记录警告，不影响 Bridge 本身启动。

### 本地 Companion

- 增加 `GET /unity-projects/:id/gateway`。
- 先由 `UnityProjectRegistry` 将 `id` 解析为已注册项目，禁止客户端直接传任意磁盘路径。
- 读取并验证发现文件：JSON 结构正确、`projectPath` 与项目注册路径一致、URL 仅允许本机 HTTP 地址、端口在 Bridge 允许范围内。
- 返回 `{ "found": true, "gatewayUrl": "...", "updatedAtUtc": "..." }`；文件缺失或无效时返回 `{ "found": false }`，不把磁盘路径或解析异常暴露给 UI。

### Figma UI

- 自动连接时，先调用 Companion 的项目网关查询接口。
- 若返回地址，则仅探测该地址的 `/health`，并继续校验 `/health.projectPath` 与当前选中项目一致。
- 配置缺失、配置地址不可达或项目不匹配时，才扫描 `32129-32135`。
- 日志明确区分：`正在读取 Unity 网关配置`、`已从项目配置连接`、`项目配置不可用，开始兜底扫描`，不再把扫描描述成自动读取。

## 错误与陈旧状态

- Unity 崩溃可能留下发现文件；Companion 仍可返回它，但 UI 必须以 `/health` 成功及项目路径匹配作为最终真值。
- 配置中的 URL 不可访问时不直接报连接失败，而是进入现有端口扫描兜底。
- 发现多个运行实例时，以当前所选项目的发现文件为主；不跨项目复用地址。

## 测试

- Unity 结构测试：成功启动写入实际端口，停止时进行所有权校验后清理。
- Companion 单元/HTTP 测试：有效记录、缺失记录、项目路径不匹配、非法 URL。
- UI 测试：配置地址优先；有效配置时不扫描；配置失败时扫描；健康响应项目不匹配时拒绝并兜底。
- 完整验证：Node 测试、Python 测试（如受影响）、TypeScript 类型检查、C# 源码结构检查及中文 UTF-8 检查。

## 非目标

- 不开放局域网或远程 Unity 网关。
- 不移除端口冲突时 Unity Bridge 自身的端口避让。
- 不把发现文件放入 `ProjectSettings`，避免产生需要提交的项目文件。
