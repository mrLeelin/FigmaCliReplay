@echo off
rem Let the logon task finish after launching the hidden Relay supervisor.
setlocal
set "LOG_DIR=%~dp0..\.logs"
if defined FIGMA_RELAY_DATA_ROOT set "LOG_DIR=%FIGMA_RELAY_DATA_ROOT%\.logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0start_relay.ps1" -Supervise >> "%LOG_DIR%\relay.autostart.log" 2>&1
exit /b %errorlevel%
