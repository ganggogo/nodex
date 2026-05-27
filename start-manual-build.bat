@echo off
setlocal
cd /d "%~dp0"
set MANUAL_BUILD_PORT=3921
node manualBuild\server.js
pause
