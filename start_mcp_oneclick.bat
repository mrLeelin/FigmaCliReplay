@echo off
chcp 65001 >nul
setlocal

title LKS Figma MCP Relay One-Click
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_mcp_oneclick.ps1" %*
exit /b %ERRORLEVEL%
