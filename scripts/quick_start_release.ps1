param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'FigmaRelay'),
    [int]$Port = 32130,
    [switch]$SkipAutostart,
    [switch]$NoExplorer
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$source = Split-Path -Parent $PSScriptRoot
$node = Join-Path $source 'runtime\node\node.exe'

try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'This Figma Relay package requires Windows x64.' }
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Bundled Node.js is missing. Extract the entire ZIP before launching.' }
    Write-Host '[Figma Relay] Starting and checking the local connection...'
    $resultJson = & $node (Join-Path $PSScriptRoot 'install_release.mjs') --source $source --install-root $InstallRoot --start --port $Port
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $result = ($resultJson -join "`n") | ConvertFrom-Json
    Write-Host "[Figma Relay] Ready (v$($result.version), port $Port)."
    if (-not $SkipAutostart) {
        try {
            $startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
            if (-not $startup) { throw 'The current user Startup folder is unavailable.' }
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut((Join-Path $startup 'Figma Relay.lnk'))
            $shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
            $shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $result.installRoot 'start_installed.ps1') + '" -Port ' + $Port
            $shortcut.WorkingDirectory = $result.installRoot
            $shortcut.Description = 'Start the local Figma Relay when you sign in'
            $shortcut.Save()
        } catch {
            Write-Warning "Relay is ready, but automatic startup could not be enabled: $($_.Exception.Message)"
        }
    }
    Write-Host 'First use in Figma Desktop: Plugins > Development > Import plugin from manifest...'
    Write-Host $result.manifestPath
    if (-not $NoExplorer) {
        # Explorer must be visible so the user can select the manifest in Figma.
        & explorer.exe ('/select,"' + $result.manifestPath + '"')
    }
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
