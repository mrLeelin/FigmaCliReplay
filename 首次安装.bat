@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup_relay.ps1"
set "setupExit=%errorlevel%"
echo.
if not "%setupExit%"=="0" echo Setup failed. Install Node.js 18+ and Python 3.10+ with PATH enabled, then retry.
if "%setupExit%"=="0" echo Setup complete. Run start_relay.bat to start the Relay.
pause
exit /b %setupExit%
