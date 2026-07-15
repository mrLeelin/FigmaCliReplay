@echo off
chcp 65001 >nul
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = [regex]::Escape((Resolve-Path '%~dp0').Path); " ^
  "$targets = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match $root) -and ($_.CommandLine -match 'dist\\index\.js|figma_mcp_companion\.py|figma_mcp_relay_server\.py') }; " ^
  "if (-not $targets) { Write-Host 'Figma MCP Relay Companion is not running.'; exit 0 }; " ^
  "$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Stopped PID ' + $_.ProcessId) }"

endlocal
