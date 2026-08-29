@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%audit-squash-merge.mjs" %*
endlocal
