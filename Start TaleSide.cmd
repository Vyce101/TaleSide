@echo off
setlocal
pushd "%~dp0" || exit /b 1
if not exist node_modules\typescript\bin\tsc (
  echo Run npm ci in the TaleSide folder before starting the app.
  pause
  popd
  exit /b 1
)
call npm start
set "TALESIDE_EXIT=%errorlevel%"
if not "%TALESIDE_EXIT%"=="0" pause
popd
exit /b %TALESIDE_EXIT%
