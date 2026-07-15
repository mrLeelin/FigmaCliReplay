@echo off
setlocal
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_unity_bridge.ps1" %*
if errorlevel 1 pause
endlocal

