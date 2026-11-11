param(
    [string]$ProjectPath,
    [string]$BridgeToken = $env:FIGMA_RELAY_BRIDGE_TOKEN
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'relay_logging.ps1')
$installLog = [RelayScriptLogger]::new('unity.bridge-install-launch')
$installLog.Write('started', 'Select a Unity project and run the shared Bridge installer')
$previousBridgeToken = $env:FIGMA_RELAY_BRIDGE_TOKEN
try {
    if (-not $ProjectPath) {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        try {
            $dialog.Description = 'Select the Unity project root (contains Assets and ProjectSettings)'
            $dialog.ShowNewFolderButton = $false
            if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
                $installLog.Write('cancelled', 'No Unity project selected')
                exit 2
            }
            $ProjectPath = $dialog.SelectedPath
        } finally {
            $dialog.Dispose()
        }
    }
    if ($BridgeToken) { $env:FIGMA_RELAY_BRIDGE_TOKEN = $BridgeToken }
    $installLog.Write('progress', 'Load packaged installer; preserve existing .meta files and ProjectSettings')
    & node (Join-Path $PSScriptRoot 'install_unity_bridge.mjs') $ProjectPath
    if ($LASTEXITCODE -ne 0) { throw 'Bridge installation failed. See the structured error above.' }
    $installLog.Write('succeeded', 'Unity Bridge installed or updated')
} catch {
    $installLog.Write('failed', $_.Exception.Message)
    exit 1
} finally {
    $env:FIGMA_RELAY_BRIDGE_TOKEN = $previousBridgeToken
}

