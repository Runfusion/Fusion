@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%dev-with-memory.mjs" %*
endlocal
