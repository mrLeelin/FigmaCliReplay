@echo off
setlocal
chcp 65001 >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\package_release.ps1" %*
if errorlevel 1 (
  echo.
  echo Packaging failed. Check the error above.
  pause
  exit /b 1
)

endlocal
