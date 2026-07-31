@echo off
chcp 65001 >nul
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_mcp_hidden.ps1"
if errorlevel 1 pause

endlocal
