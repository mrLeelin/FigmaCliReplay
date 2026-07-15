@echo off
chcp 65001 >nul
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_mcp_hidden.ps1" %*
exit /b %ERRORLEVEL%
