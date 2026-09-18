param([int]$Port = 32130, [switch]$Foreground, [switch]$Restart)
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
# 端口预检：否则重复启动会静默失败，让"重启以载入新构建"变成没发生的事。
$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
    $ownerPid = $listeners[0].OwningProcess
    $ownerName = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName
    $ownerIsRelay = $false
    try { $ownerIsRelay = ((Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid").CommandLine -like '*dist\index.js*') } catch { $ownerIsRelay = $false }
    if (-not $Restart) {
        $occupied = "端口 $Port 已在运行：pid=$ownerPid ($ownerName)。未启动第二个实例；要载入新构建请执行 scripts\start_relay.ps1 -Restart"
        Write-Host "[Relay] $occupied"
        $launchLog.Write('succeeded', $occupied)
        exit 0
    }
    if (-not $ownerIsRelay) { throw "端口 $Port 被非 Relay 进程占用：pid=$ownerPid ($ownerName)，未做任何改动。" }
    Stop-Process -Id $ownerPid -Force
    for ($i = 0; $i -lt 40 -and @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0; $i++) { Start-Sleep -Milliseconds 100 }
    if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { throw "结束旧 Relay pid=$ownerPid 后端口 $Port 仍被占用。" }
    Write-Host "[Relay] 已结束旧实例 pid=$ownerPid 并释放端口 $Port，正在启动载入最新构建的新实例。"
    $launchLog.Write('progress', "已结束旧 Relay pid=$ownerPid 并释放端口")
}
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
# 启动后确认真的活着：否则失败只留在 .logs\relay.stderr.log 里，用户以为已经重启。
Start-Sleep -Milliseconds 900
if ($process.HasExited) {
    $stderrPath = Join-Path $logs 'relay.stderr.log'
    $tail = if (Test-Path -LiteralPath $stderrPath) { ((Get-Content -LiteralPath $stderrPath -Tail 3) -join ' | ') } else { '' }
    throw "Relay 启动后立即退出（exit=$($process.ExitCode)）。stderr 末尾：$tail"
}
$launchLog.Write('succeeded', "Launch dispatched: pid=$($process.Id). Use npm run doctor to verify the WebSocket handshake.")
} catch {
    $launchLog.Write('failed', $_.Exception.Message)
    throw
}
