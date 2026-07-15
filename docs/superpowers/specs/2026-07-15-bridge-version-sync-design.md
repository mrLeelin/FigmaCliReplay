# Bridge 与插件版本同步设计

## 目标

Unity Bridge 的发布版本必须与当前 Figma 插件发布版本完全一致。连接时发现版本不一致或 Bridge 未报告版本，UI 必须阻止连接、在设置入口显示错误，并提供可直接执行的“同步 Bridge”按钮。

## 单一版本源

- `package.json.version` 是唯一发布版本源。
- `scripts/build.py` 在现有 UI 版本同步基础上，同时更新 `FigmaBridgeServer.cs` 中由标记包围的版本常量。
- UI 不再声明第二份 JavaScript 版本常量，而是从标题中的 `BEGIN_RELEASE_VERSION` 内容读取当前插件版本，去掉前缀 `v` 后参与比较。
- Bridge `/health.version` 返回同步后的同一版本字符串。

这样发布版本只需修改 `package.json`，构建过程负责同步 UI 与 Bridge；测试负责在未运行构建脚本时阻止版本漂移进入发布。

## 连接规则

1. UI 探测 Unity `/health` 后，先确认 `projectPath` 与所选项目一致。
2. 再比较 `health.version` 与插件发布版本，使用严格字符串相等。
3. 两者一致才允许进入“已连接”状态。
4. Bridge 版本缺失、为空或不一致均视为版本不匹配，不继续把该网关当作有效连接。
5. 版本不匹配是终止性错误，不再扫描其他端口；端口扫描无法修复已确认项目上的版本漂移。

## UI 状态

版本不匹配时：

- `unityConnected` 保持 `false`，Unity badge 显示“版本错误”。
- Unity 状态区显示：`Bridge 版本不一致：插件 0.1.37，Bridge 1.0.0`；未报告版本时显示“未报告”。
- “设置”页签保留红色错误标记，悬浮提示包含 `Unity Bridge 版本不一致`。
- 现有 `installUnityBridgeBtn` 变为醒目的“同步 Bridge”按钮并保持可点击，不增加重复按钮。
- 图片导出、层级同步、文字同步等所有依赖 Unity 连接的操作继续禁用。

版本一致或尚未检测版本时：

- 按钮恢复默认文案“安装/更新 Bridge”和常规样式。
- 成功连接后清除版本错误状态。
- 普通未连接仍按现有规则在设置页签提示。

## 同步按钮行为

- 点击“同步 Bridge”复用现有 `/unity-projects/install-bridge` 安装流程，把仓库内最新版 Bridge 复制到所选 Unity 项目。
- 安装成功后提示：`Bridge 已同步到 0.1.37，等待 Unity 编译后重新连接。`
- 不假设 Unity 编译已经完成，不在复制完成时伪造“版本一致”或“已连接”状态。
- 用户再次点击“自动连接”并通过 `/health.version` 校验后，错误状态才清除。

## 构建同步

在 `FigmaBridgeServer.cs` 中加入稳定标记：

```csharp
// BEGIN_RELEASE_VERSION
private const string Version = "0.1.37";
// END_RELEASE_VERSION
```

`scripts/build.py` 读取 `package.json.version`，要求语义版本格式有效，并同时更新：

- `ui.html` 的 `BEGIN_RELEASE_VERSION` 标记块；
- `FigmaBridgeServer.cs` 的 `BEGIN_RELEASE_VERSION` 标记块。

任一标记缺失、重复或替换失败时构建立即失败。

## 错误处理

- Bridge `/health` 无 `version`：按“未报告”处理并要求同步。
- 版本不匹配：不进入端口扫描兜底，避免连接到已知不兼容版本。
- 同步 Bridge 失败：保留版本错误状态并显示安装接口返回的具体错误。
- Companion 不可用或网关不可达：继续沿用现有连接错误和端口扫描逻辑，不误报为版本问题。

## 测试

- 构建测试：`package.json`、UI 标记、Bridge 版本常量保持一致；构建同步函数同时更新两处标记。
- Bridge 健康测试：`/health` 继续输出 `version`，且版本常量处于同步标记内。
- UI 测试：一致版本允许连接；缺失/不一致版本阻止连接；不一致时不扫描；设置错误标记和“同步 Bridge”按钮出现。
- 安装流程测试：同步按钮仍调用现有 Bridge 安装接口，成功文案包含目标版本且不提前清除错误状态。
- 完整验证：Node 测试、TypeScript 构建与类型检查、Python 构建脚本测试、UTF-8 与 diff 格式检查。

## 非目标

- 不引入独立“协议版本”或兼容版本范围；本功能要求发布版本完全一致。
- 不通过文件哈希替代可读版本号。
- 不自动重启 Unity Editor 或 Companion。
- 不在用户未点击同步时自动覆盖 Unity 项目文件。
