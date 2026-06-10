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

where patch.exe >nul 2>nul
if errorlevel 1 (
  call :add_git_usr_bin_to_path
)

where patch.exe >nul 2>nul
if errorlevel 1 (
  echo Failed to find patch.exe. Install Git for Windows or add Git\usr\bin to PATH.
  pause
  exit /b 1
)

if "%PKG_TARGET%"=="" set "PKG_TARGET=node22-win-x64"

call npx --yes esbuild manualBuild\server.js --bundle --platform=node --format=cjs --outfile=dist\zbcx-web-pack.bundle.cjs
if errorlevel 1 (
  echo Failed to bundle server.
  pause
  exit /b 1
)

call npx --yes @yao-pkg/pkg dist\zbcx-web-pack.bundle.cjs --targets %PKG_TARGET% --output dist\zbcx-web-pack.exe
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
exit /b 0

:add_git_usr_bin_to_path
for /f "delims=" %%G in ('where git.exe 2^>nul') do (
  if exist "%%~dpG..\usr\bin\patch.exe" (
    set "PATH=%%~dpG..\usr\bin;%PATH%"
    exit /b 0
  )
  if exist "%%~dpG..\..\usr\bin\patch.exe" (
    set "PATH=%%~dpG..\..\usr\bin;%PATH%"
    exit /b 0
  )
)

if exist "%ProgramFiles%\Git\usr\bin\patch.exe" (
  set "PATH=%ProgramFiles%\Git\usr\bin;%PATH%"
  exit /b 0
)

if exist "%ProgramFiles(x86)%\Git\usr\bin\patch.exe" (
  set "PATH=%ProgramFiles(x86)%\Git\usr\bin;%PATH%"
  exit /b 0
)

exit /b 0
