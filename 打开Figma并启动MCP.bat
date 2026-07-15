@echo off
chcp 65001 >nul
setlocal
call "%~dp0start_figma_with_mcp.bat" %*
endlocal
