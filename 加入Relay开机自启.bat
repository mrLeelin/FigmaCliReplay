@echo off
rem Register the Figma Relay logon auto-start task. Double-click this file.
setlocal
echo Registering Figma Relay logon auto-start ...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\register_relay_autostart.ps1"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo Finished. Exit code 0) else (echo Failed. Exit code %RC%)
echo.
pause
exit /b %RC%
