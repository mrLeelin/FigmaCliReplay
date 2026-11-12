# Figma Relay 使用说明（Windows）

这个 ZIP 包含 Figma 开发插件、本机 Relay 和 Unity Editor Bridge。首次安装完成后，程序保存在固定目录，以后在插件内检查和安装更新。每台电脑都需要运行自己的 Relay。

## 首次安装

1. 安装 Node.js 18+ 和 Python 3.10+，并加入 PATH。安装完成后重新打开终端或资源管理器。首次安装与更新需要联网下载依赖。
2. 完整解压 ZIP，打开其中的 `figma-relay` 文件夹，双击 `首次安装.bat`。不要直接在压缩包内运行。
3. 等待安装成功。默认固定目录是 `%LOCALAPPDATA%\FigmaRelay`；安装器会打印实际目录、启动入口和插件路径。Node 依赖与 Python `.venv` 按版本保存，个人设置集中保存在固定目录的 `data` 中。
4. 双击固定目录中的 `start_relay.bat`。打开 Figma 桌面版，在 Plugins → Development → Import plugin from manifest 选择固定目录下的 `plugin\manifest.json`。这个路径只需导入一次；更新后关闭再重新打开插件即可。
5. 需要连接 Unity 时，在插件设置中选择自己的 Unity 工程，点击“安装/更新 Bridge”，等待 Unity 编译、重连完成。

如果需要自定义安装位置，可在解压包的 `figma-relay` 目录执行：

```powershell
node scripts/install_release.mjs --source . --install-root "D:\Tools\FigmaRelay"
```

安装器不自动启动或停止已有 Relay。第一次从旧版切换时，先结束旧目录启动的 Relay，再运行固定目录中的启动入口。端口被其它进程占用时不会结束无关进程。

旧版用户需要先手动安装一次带更新功能的版本。旧目录中的 `.local` 配置会迁移到固定目录的 `data\.local`，已有目标设置会保留，发布签名私钥不会迁移。已有 AI Skill 可在新插件的“设置 → AI Skill”中检查并更新，使入口指向固定安装目录；本地改过的 Skill 文件会保留。

## 检查和安装更新

打开“设置 → 版本与更新”，点击“检查更新”，查看版本和更新内容，再点击“立即更新”。默认启动时自动检查，可关闭此选项；安装更新始终由用户点击。

更新会下载并校验发布者签名和 ZIP 哈希，在新目录准备依赖，等待当前任务结束后切换 Relay。过程中显示下载和安装状态。切换失败会恢复之前的程序版本；个人 Key、工程列表和设置不随程序版本覆盖。

更新完成后，关闭并重新打开 Figma 插件以加载新代码；无需重新导入 manifest。更新器不会重启 Figma 或 Unity。勾选“同时更新当前工程的 Bridge”时，仅更新已选中的工程，保留工程已有 `.meta` GUID 和设置；安装文件成功、Unity 编译通过、Bridge 已重连会分别报告，不能把复制成功当作编译完成。

未勾选时，只更新本机程序和随包 Bridge 模板。需要使用新版本 Unity 功能时，再对当前工程执行“安装/更新 Bridge”。

如果 Relay 无法启动或插件断开连接，在固定目录中运行 `更新修复.bat`，按输出检查或恢复中断的更新。重复点击不会并行安装多个版本。下载失败或校验失败时，原版本仍可继续使用。

如果界面显示“发布者尚未配置更新源”，表示这个包还没有可访问的发布地址，不能在线检查最新版本。请使用发布者提供的正式分发包；这个状态不代表当前已经是最新版本。

## 日常使用和个人配置

- 从固定目录的 `start_relay.bat` 启动 Relay，再打开 Figma 插件。日志保存在 `data\.logs`，本机设置和令牌保存在 `data\.local`。
- CLI 可使用 `node "%LOCALAPPDATA%\FigmaRelay\dist\cli.js" --help`；自定义目录时替换为实际路径。这个固定入口会转发到当前版本。
- AI 对话仍需要用户自己安装并登录相应 AI CLI。DXX 图片拆层使用自己的 Key；Unity 真值采集需要另行安装 Unity CLI。账号和密钥不随包提供。
- “设置 → AI Skill”可以为当前电脑的 Codex、Claude Code 写入或更新 Skill，不修改全局 AI 配置。技能列表未出现时重新打开会话。

## 发布者：打包和上传

本项目使用公开的 GitHub 仓库 [mrLeelin/FigmaCliReplay](https://github.com/mrLeelin/FigmaCliReplay) 分发。接收者可从 [最新发布](https://github.com/mrLeelin/FigmaCliReplay/releases/latest) 下载 ZIP，插件的固定检查地址为 `https://github.com/mrLeelin/FigmaCliReplay/releases/latest/download/latest.json`。

```powershell
npm run package:release -- -NoLaunch -ReleaseNotesFile "release-notes.txt"
```

`release-notes.txt` 为 UTF-8 文本，每行一条更新说明，也可以使用 JSON 字符串数组。打包命令会提升 patch 版本、同步各端版本、构建，并生成：

```text
output/
├─ figma-relay-<版本>.zip
├─ figma-relay-<版本>.sha256.txt
├─ figma-relay-<版本>.release.json
├─ figma-relay-<版本>.manifest.json
└─ latest.json
```

ZIP 内的 `release-config.json` 保存固定更新地址和发布公钥。`latest.json` 是 Ed25519 签名清单，包含版本、更新说明、ZIP 下载地址、大小和 SHA-256。ZIP 地址绑定到对应 tag，例如 `https://github.com/mrLeelin/FigmaCliReplay/releases/download/v0.1.50/figma-relay-0.1.50.zip`，不会因为最新版本改变而指向其它包。

完成测试并将本次发布对应的源代码提交推送到仓库后，使用明确的 40 位提交 SHA 发布已经打好的版本；下面的版本与 SHA 需要替换为实际值：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish_github_release.ps1 -Version "0.1.50" -TargetCommit "0123456789012345678901234567890123456789"
```

也可通过 `npm run publish:github -- -Version "0.1.50" -TargetCommit "实际的40位提交SHA"` 执行。发布脚本要求本机已安装 GitHub CLI 并通过 `gh auth login` 登录。先加 `-DryRun` 可以验证本地包并查看上传计划，不访问 GitHub。

脚本先检查本地签名、ZIP 和哈希，再确认公开仓库及指定的远端提交。它创建草稿 Release，上传 ZIP、`latest.json`、版本签名清单、哈希、发布元数据和存在时的验证报告，核对资产完整后才发布并设为 Latest。上传中途失败会保留草稿供检查，不发布半成品，也不会覆盖已有 tag 对应的 Release 或资产。脚本不提交或推送代码；已有 tag 指向其它提交时会拒绝发布。

默认仓库来自 `release-config.json` 的 `githubRepository`。需要分发到另一个公开 GitHub 仓库时，打包传 `-GitHubRepository "owner/repository"`，发布传相同的 `-Repository "owner/repository"`。若使用自己的 HTTPS 下载站，可改用 `-UpdateBaseUrl` 和可选的 `-ManifestUrl`，这时不能同时传 `-GitHubRepository`；自定义下载站的上传由发布者负责。打包只生成本地文件，不提交 Git，也不会自动上传。

发布私钥首次打包时生成在源码仓库的 `.local\release-signing\private.pem`，后续版本重复使用。请离线备份并限制访问，不能把私钥放到下载站、ZIP、Git 或交给接收者。丢失私钥后，新密钥签发的版本不能被已有安装信任；不要通过替换公钥绕过校验。可以用 `-SigningKeyPath` 指定已有 Ed25519 PKCS#8 PEM 私钥。

如果移除了仓库默认的 GitHub 配置且没有配置其它更新地址，仍可生成供本地安装验证的 ZIP、哈希和 `available:false` 的 `.release.json`，但不会生成 `latest.json`，界面会明确显示更新源未配置。这样的包不应作为正式自动更新发行版发送给用户。

当前仍是 Windows 开发插件分发方式，用户需要 Node.js、Python 和首次联网安装依赖。Figma Community 上架是独立流程；Community 插件代码由 Figma 分发，不能用本机更新器替代平台发布。
