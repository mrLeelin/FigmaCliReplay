@echo off
chcp 65001 >nul
setlocal

title Figma MCP Relay Companion
cd /d "%~dp0"

echo Starting Figma MCP Relay Companion...
echo.
echo AI / Codex MCP endpoint:
echo   http://127.0.0.1:32130/mcp
echo.
echo Figma plugin panel URL:
echo   http://localhost:32130
echo.
echo Keep this window open while using the Figma plugin.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_mcp_oneclick.ps1" -VisibleLog -NoPause

endlocal
