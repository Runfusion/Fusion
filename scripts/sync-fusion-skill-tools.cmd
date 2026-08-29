@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%sync-fusion-skill-tools.mjs" %*
endlocal
