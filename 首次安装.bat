@echo off
setlocal
node "%~dp0scripts\install_release.mjs" --source "%~dp0."
set "setupExit=%errorlevel%"
echo.
if not "%setupExit%"=="0" echo Setup failed. Install Node.js 18+ and Python 3.10+ with PATH enabled, then retry.
if "%setupExit%"=="0" echo Setup complete. Use the fixed installation path printed above to start Relay and import the plugin.
pause
exit /b %setupExit%
