@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_relay.ps1"
exit /b %errorlevel%
