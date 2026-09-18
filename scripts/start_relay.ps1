param([int]$Port = 32130, [switch]$Foreground)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'relay_logging.ps1')
$launchLog = [RelayScriptLogger]::new('relay.launch')
$launchLog.Write('started', 'Validate independent Relay launch')
try {
$launchLog.Write('progress', 'Check runtime, entrypoint and port')
$PluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$localNode = Join-Path $PluginRoot '.local\node'
if (Test-Path -LiteralPath (Join-Path $localNode 'node.exe')) { $env:Path = "$localNode;$env:Path" }
$node = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $PluginRoot 'dist\index.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Run npm ci and npm run build before starting Relay.' }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid port' }
$localDir = Join-Path $PluginRoot '.local'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$tokenFile = Join-Path $localDir 'admin-token.txt'
if (-not (Test-Path -LiteralPath $tokenFile)) { [guid]::NewGuid().ToString('N') | Set-Content -LiteralPath $tokenFile -Encoding ASCII }
$env:FIGMA_RELAY_TOKEN = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
$launchLog.Write('progress', 'Runtime and build validated')
if ($Foreground) {
    & $node $entry --port $Port
    $relayExitCode = $LASTEXITCODE
    if ($relayExitCode -ne 0) { throw "Relay exited with code $relayExitCode" }
    $launchLog.Write('succeeded', 'Foreground Relay exited normally')
    exit 0
}
$logs = Join-Path $PluginRoot '.logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$process = Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"'), '--port', $Port) -WorkingDirectory $PluginRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'relay.stdout.log') -RedirectStandardError (Join-Path $logs 'relay.stderr.log') -PassThru
$launchLog.Write('succeeded', "Launch dispatched: pid=$($process.Id). Use npm run doctor to verify the WebSocket handshake.")
} catch {
    $launchLog.Write('failed', $_.Exception.Message)
    throw
}
