@echo off
chcp 65001 >nul
setlocal

set "SCRIPT_DIR=%~dp0"

echo Starting Figma MCP Relay and opening Figma Desktop...
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\start_mcp_oneclick.ps1" -OpenFigma -NoPause
if not "%ERRORLEVEL%"=="0" (
  pause
  exit /b 1
)

pause

endlocal
