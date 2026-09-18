@echo off
rem Remove the Figma Relay logon auto-start task. Double-click this file.
setlocal
echo Removing Figma Relay logon auto-start ...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\register_relay_autostart.ps1" -Remove
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
