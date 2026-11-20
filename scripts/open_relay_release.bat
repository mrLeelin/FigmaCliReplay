@echo off
setlocal
set "relaySetup=%~dp0figma-relay\scripts\quick_start_release.ps1"
if not exist "%relaySetup%" (
    echo Extract the entire Figma Relay ZIP before running this file.
    pause
    exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%relaySetup%" %*
set "relayExit=%errorlevel%"
if not "%relayExit%"=="0" pause
exit /b %relayExit%
