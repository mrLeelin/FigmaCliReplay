param(
  [string]$TaskName = 'FigmaRelay-Autostart',
  [switch]$Remove,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $PSScriptRoot 'relay_autostart.cmd'

function Test-RelayListening {
  param([int]$Port = 32130)
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

if ($Remove) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Host "[FigmaRelay] 计划任务 $TaskName 不存在，无需移除。"
    exit 0
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "[FigmaRelay] 已移除登录自启计划任务：$TaskName"
  Write-Host "           中继进程本身不会被结束；如需停止请用 FigmaBridge 窗口或结束对应 node 进程。"
  exit 0
}

if (-not (Test-Path -LiteralPath $launcher)) { throw "缺少启动脚本：$launcher" }

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $launcher + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description '登录时启动 Figma Relay（Unity 主动出站长连接的本地中继）' -Force | Out-Null

Write-Host "[FigmaRelay] 已注册登录自启计划任务：$TaskName"
Write-Host "           触发：用户 $env:USERNAME 登录时"
Write-Host "           动作：$launcher"

if (-not $NoStart) {
  if (Test-RelayListening) {
    Write-Host "[FigmaRelay] 中继已在运行（32130 已在监听），本次不重复启动。"
  } else {
    Start-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and -not (Test-RelayListening)) { Start-Sleep -Milliseconds 500 }
    if (Test-RelayListening) {
      Write-Host "[FigmaRelay] 中继已启动并监听 32130。"
    } else {
      Write-Warning "[FigmaRelay] 已触发启动，但 20 秒内未监听到 32130；请查看 .logs\relay.stderr.log。"
    }
  }
}

Write-Host ''
Write-Host '提示：移除自启用「移除Relay开机自启.bat」，或执行：'
Write-Host "      powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Remove"
