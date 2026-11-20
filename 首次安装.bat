@echo off
setlocal
if exist "%~dp0runtime\windows-x64.json" goto bundled
node "%~dp0scripts\install_release.mjs" --source "%~dp0."
set "setupExit=%errorlevel%"
echo.
if not "%setupExit%"=="0" echo Setup failed. Install Node.js 18+ and Python 3.10+ with PATH enabled, then retry.
if "%setupExit%"=="0" echo Setup complete. Use the fixed installation path printed above to start Relay and import the plugin.
pause
exit /b %setupExit%

:bundled
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\quick_start_release.ps1" %*
set "setupExit=%errorlevel%"
if not "%setupExit%"=="0" pause
exit /b %setupExit%
