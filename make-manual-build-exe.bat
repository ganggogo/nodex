@echo off
setlocal
cd /d "%~dp0"

if not exist "dist" mkdir "dist"
if exist "dist\manual-build.exe" del /f /q "dist\manual-build.exe"
if exist "dist\zbcx-web-pack.exe" del /f /q "dist\zbcx-web-pack.exe"

set HTTP_PROXY=
set HTTPS_PROXY=
set http_proxy=
set https_proxy=
set ALL_PROXY=
set all_proxy=

call npx --yes esbuild manualBuild\server.js --bundle --platform=node --format=cjs --outfile=dist\zbcx-web-pack.bundle.cjs
if errorlevel 1 (
  echo Failed to bundle server.
  pause
  exit /b 1
)

call npx --yes @yao-pkg/pkg dist\zbcx-web-pack.bundle.cjs --targets node20-win-x64 --output dist\zbcx-web-pack.exe
if errorlevel 1 (
  echo Failed to build exe.
  pause
  exit /b 1
)

if not exist "dist\manualBuild\public" mkdir "dist\manualBuild\public"
xcopy /E /I /Y "manualBuild\public" "dist\manualBuild\public" >nul

if not exist "dist\autoBuild" mkdir "dist\autoBuild"
type nul > "dist\autoBuild\cfg.yaml"
echo {} > "dist\autoBuild\build-history.json"

echo Built dist\zbcx-web-pack.exe
echo Empty config file: dist\autoBuild\cfg.yaml
pause
