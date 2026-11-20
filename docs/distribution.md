# Figma Relay 使用说明（Windows）

这个 Windows x64 ZIP 包含 Figma 开发插件、本机 Relay、Node.js、Python、运行依赖和 Unity Editor Bridge。接收者只需要 Figma 桌面版。安装与启动无需管理员权限、修改 PATH 或联网下载依赖。

## 首次安装

1. 完整解压 ZIP，双击根目录的 `Open Figma Relay.bat`。它会安装到 `%LOCALAPPDATA%\FigmaRelay`，启动 Relay 并验证连接，设置当前 Windows 用户登录时自动启动，再在资源管理器里选中 manifest 文件。
2. 打开 Figma 桌面版，在 Plugins → Development → Import plugin from manifest 选择该 `plugin\manifest.json`。导入一次后，从 Figma 的开发插件菜单打开即可。更新后关闭并重新打开插件。
3. 需要同步 Unity 时，点击侧栏的 Unity 状态，进入「Unity 连接」。选择或添加工程，按面板提示安装 Unity 插件，然后在 Unity 编辑器中打开该工程并等待编译。显示「已连接 Unity」后即可同步。

如需自定义安装位置或关闭登录自启，在解压目录运行以下命令。

```powershell
& '.\Open Figma Relay.bat' -InstallRoot 'D:\Tools\FigmaRelay' -SkipAutostart
```

再次双击会检查并复用已经运行的同一安装。端口被其它程序或另一套 Relay 占用时，启动器会显示端口占用错误。可以从固定目录运行 `start_relay.bat` 或 `更新修复.bat`。如需取消登录自启，可在当前用户的 `shell:startup` 中删除 `Figma Relay` 快捷方式。

已有固定目录安装的用户通过原插件的“版本与更新”升级。旧版更新器完成首次切换时仍可能调用该旧版依赖的系统 Node.js、Python 和依赖源。已有 AI Skill 可在新插件的“设置 → AI Skill”中检查并更新，使入口指向固定安装目录。本地路径、账号和令牌保存在 `data` 中。

## PSD 导入

Photoshop 是可选依赖。已安装且 COM 可用时优先使用 Photoshop，其余情况自动使用包内的 psd-tools。psd-tools 对部分复杂阴影等效果支持有限，导入日志会列出兼容警告。

由导入启动的 Photoshop 会在导入结束后自动退出，导入前已运行的实例保持打开；如果导入期间另外打开了文档，也会保留并提示原因。PSD 文件最大支持 1 GiB。

## 检查和安装更新

打开左侧的“版本与更新”页签，点击“检查更新”，查看版本和更新内容，再点击“立即更新”。默认启动时自动检查，可关闭此选项；安装更新始终由用户点击。

更新会下载 ZIP，校验发布者签名和 ZIP 哈希，验证新版本的包内依赖，等待当前任务结束后切换 Relay。签名和 ZIP 下载走现有更新源。切换失败会恢复之前的程序版本，个人 Key、工程列表和设置保存在独立目录。

更新完成后，关闭并重新打开 Figma 插件以加载新代码；无需重新导入 manifest。更新器不会重启 Figma 或 Unity。勾选“同时更新当前工程的 Bridge”时，仅更新已选中的工程，保留工程已有 `.meta` GUID 和设置；安装文件成功、Unity 编译通过、Bridge 已重连会分别报告，不能把复制成功当作编译完成。

未勾选时，只更新本机程序和随包 Bridge 模板。需要使用新版本 Unity 功能时，可在「Unity 连接」中更新当前工程的 Unity 插件。

如果 Relay 无法启动或插件断开连接，在固定目录中运行 `更新修复.bat`，按输出检查或恢复中断的更新。重复点击不会并行安装多个版本。下载失败或校验失败时，原版本仍可继续使用。

如果界面显示“发布者尚未配置更新源”，表示这个包还没有可访问的发布地址，不能在线检查最新版本。请使用发布者提供的正式分发包；这个状态不代表当前已经是最新版本。

## 日常使用和个人配置

- 登录后可以直接打开 Figma 插件。日志保存在固定目录的 `data\.logs`，本机设置和令牌保存在 `data\.local`。
- PowerShell 中可以调用固定 CLI 入口。

  ```powershell
  & "$env:LOCALAPPDATA\FigmaRelay\figma-relay.cmd" --help
  ```

- AI 对话仍需要用户自己安装并登录相应 AI CLI。DXX 图片拆层使用自己的 Key；Unity 真值采集需要另行安装 Unity CLI。账号和密钥不随包提供。
- “设置 → AI Skill”可以为当前电脑的 Codex、Claude Code 写入或更新 Skill，不修改全局 AI 配置。技能列表未出现时重新打开会话。

## 发布者：打包和上传

本项目使用公开的 GitHub 仓库 [mrLeelin/FigmaCliReplay](https://github.com/mrLeelin/FigmaCliReplay) 分发。接收者可从 [最新发布](https://github.com/mrLeelin/FigmaCliReplay/releases/latest) 下载 ZIP，插件的固定检查地址为 `https://github.com/mrLeelin/FigmaCliReplay/releases/latest/download/latest.json`。

```powershell
npm run package:release -- -NoLaunch -ReleaseNotesFile "release-notes.txt"
```

发布机需要 Windows x64、Node.js、npm 和 64 位 CPython 3.11+。打包时需要联网下载官方 Node.js 发行版及生产依赖。`release-notes.txt` 为 UTF-8 文本，每行一条更新说明，也可以使用 JSON 字符串数组。打包命令会提升 patch 版本、同步各端版本、构建，并生成：

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

这是 Figma 桌面版的开发插件分发方式。Figma Community 上架是独立流程，Community 插件代码由 Figma 分发。
