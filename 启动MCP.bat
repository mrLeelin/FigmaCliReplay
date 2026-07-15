@echo off
chcp 65001 >nul
setlocal
call "%~dp0start_mcp_oneclick.bat" %*
endlocal
