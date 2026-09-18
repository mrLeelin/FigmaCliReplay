@echo off
rem ---------------------------------------------------------------------------
rem Start the Figma Relay in the background (used by the logon scheduled task).
rem ASCII only: batch files are parsed with the active console code page.
rem ---------------------------------------------------------------------------
setlocal
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

rem Already listening? Do nothing (keeps a task re-run harmless).
netstat -ano | findstr /R /C:":32130 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [FigmaRelay] 32130 is already listening; nothing started.
  exit /b 0
)

if not exist "%ROOT%\dist\index.js" (
  echo [FigmaRelay] dist\index.js not found. Run: npm ci ^&^& npm run build
  exit /b 1
)

rem Resolve node from PATH (fall back to the bare command name).
set "NODE=node"
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"

rem Admin token: create it once, exactly like scripts\start_relay.ps1 does.
if not exist "%ROOT%\.local" mkdir "%ROOT%\.local" >nul 2>&1
if not exist "%ROOT%\.local\admin-token.txt" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[guid]::NewGuid().ToString('N') | Set-Content -LiteralPath '%ROOT%\.local\admin-token.txt' -Encoding ASCII" >nul 2>&1
set "TOKEN="
if exist "%ROOT%\.local\admin-token.txt" set /p TOKEN=<"%ROOT%\.local\admin-token.txt"
set "FIGMA_RELAY_TOKEN=%TOKEN%"

if not exist "%ROOT%\.logs" mkdir "%ROOT%\.logs" >nul 2>&1
cd /d "%ROOT%"
start "FigmaRelay" /b "%NODE%" dist\index.js --port 32130 >> "%ROOT%\.logs\relay.stdout.log" 2>> "%ROOT%\.logs\relay.stderr.log"
exit /b 0
