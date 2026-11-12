# Figma Relay 使用说明（Windows）

请先完整解压 ZIP 到固定目录，再进行安装。不要直接在压缩包里运行，也不要只复制 manifest.json。

## 首次使用

1. 安装 Node.js 18 或更高版本、Python 3.10 或更高版本，安装 Python 时勾选加入 PATH。安装完成后重新打开终端或资源管理器；下面的首次安装需要联网下载依赖。
2. 打开本说明旁边的 `figma-relay` 文件夹，双击 `首次安装.bat`，等待出现 Setup complete。Python 依赖安装在该文件夹自己的 `.venv` 中。
3. 双击 `figma-relay/start_relay.bat` 启动本机 Relay。它在后台运行，正常使用时保留此目录。
4. 打开 Figma 桌面版，在 Plugins → Development → Import plugin from manifest 中，选择 `figma-relay/manifest.json`。以后从 Development 菜单运行 LKS Figma Relay。
5. 需要连接 Unity 时，双击 `figma-relay/安装Unity桥接插件.bat`，选择包含 Assets 和 ProjectSettings 的 Unity 工程根目录。等待 Unity 编译完成，再在 Figma 插件设置里选择对应工程。也可以使用插件设置中的“安装/更新 Bridge”。

每台电脑都需要安装和运行自己的 Relay。安装脚本会读取该副本启动后生成的本机令牌，不需要手动填写。安装或更新 Bridge 会保留工程已有的 .meta GUID 和其它导入设置。

## 日常使用和检查

每次使用先启动 `figma-relay/start_relay.bat`，再打开 Figma 插件。可在 `figma-relay` 文件夹打开 PowerShell 执行 `npm run doctor` 检查连接；日志保存在该文件夹的 `.logs` 中。CLI 使用说明见 `figma-relay/docs/cli.md`。

AI 对话还需要在本机安装并登录所选择的 AI CLI。DXX 图片拆层需要在插件设置里填写自己的 Key。这些账号和密钥不随安装包提供。Unity 真值采集需要另行安装 Unity CLI。

要让其他项目里的 Codex 或 Claude Code 发现本机 Figma 插件，打开插件「设置 → AI Skill」，分别点击对应客户端的「写入 Skill」。页面会检查当前电脑用户目录里的实际文件，显示安装路径和状态；写入后再次检查。更新或移动解压目录后，在新插件副本中检查状态并点击「更新 Skill」，同步本机路径。检测到本地手工修改时保留文件并提示处理。

也可在 `figma-relay` 目录执行 `npm link --ignore-scripts --offline` 和 `npm run ai:install-skill`。前者注册 `figma-relay` 命令，后者安装 Skill；界面写入的 Skill 自带绝对路径后备入口，因此未注册全局命令也能使用。不修改全局 AI 配置。可显式使用 `$figma-relay`（Codex）或 `/figma-relay`（Claude Code）；技能列表未出现时重新打开会话。

## 更新版本

将新 ZIP 解压到新的目录，运行新目录里的首次安装。先关闭旧的 Figma 插件，并停止旧 Relay（当前版本没有停止按钮，可在任务管理器中根据命令行路径确认并结束旧目录对应的 Node.js 进程），再启动新目录的 Relay。

在 Figma 中将开发插件重新导入为新目录里的 manifest.json，并运行新目录的 Unity 桥接安装脚本更新工程。Figma 插件、Relay、Unity Bridge 必须使用同一发布版本。

## 此版本的分发方式

这是 Windows 开发插件分发包，包含插件代码、本机 Relay 和 Unity Editor Bridge。它需要 Node.js、Python 和首次联网安装依赖。它不是 Figma Community 发布版本，也不是内置全部运行环境的独立安装程序。
