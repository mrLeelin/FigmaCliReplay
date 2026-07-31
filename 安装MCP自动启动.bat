@echo off
chcp 65001 >nul
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_mcp_autostart.ps1" -Action Install
if errorlevel 1 pause

endlocal
