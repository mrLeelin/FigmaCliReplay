param(
    [string]$ProjectPath
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $ScriptDir)).Path

if (-not $ProjectPath) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "选择 Unity 工程根目录"
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        Write-Host "未选择 Unity 工程。"
        exit 2
    }
    $ProjectPath = $dialog.SelectedPath
}

$ProjectPath = [System.IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
$assetsPath = Join-Path $ProjectPath "Assets"
$projectSettingsPath = Join-Path $ProjectPath "ProjectSettings"
if (-not (Test-Path -LiteralPath $assetsPath -PathType Container) -or
    -not (Test-Path -LiteralPath $projectSettingsPath -PathType Container)) {
    throw "目标目录不是 Unity 工程，必须包含 Assets 和 ProjectSettings：$ProjectPath"
}

$sourceBridge = Join-Path $PluginRoot "unity\Assets\Editor\FigmaBridge"
$sourceMeta = Join-Path $PluginRoot "unity\Assets\Editor\FigmaBridge.meta"
if (-not (Test-Path -LiteralPath $sourceBridge -PathType Container) -or
    -not (Test-Path -LiteralPath $sourceMeta -PathType Leaf)) {
    throw "独立仓库中的 FigmaBridge 源码不完整：$sourceBridge"
}

$targetEditor = Join-Path $assetsPath "Editor"
$targetBridge = Join-Path $targetEditor "FigmaBridge"
$targetMeta = Join-Path $targetEditor "FigmaBridge.meta"
New-Item -ItemType Directory -Force -Path $targetBridge | Out-Null
Get-ChildItem -LiteralPath $sourceBridge -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $targetBridge -Recurse -Force
}
Copy-Item -LiteralPath $sourceMeta -Destination $targetMeta -Force

Write-Host "FigmaBridge 已安装/更新：$targetBridge" -ForegroundColor Green
Write-Host "ProjectSettings/FigmaBridgeImportSettings.json 未被修改。" -ForegroundColor Green

