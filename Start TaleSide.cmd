@echo off
setlocal
pushd "%~dp0" || exit /b 1
title TaleSide
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 LTS, then start TaleSide again.
  pause
  popd
  exit /b 1
)
set "NODE_NO_WARNINGS=1"
node scripts/start.mjs
set "TALESIDE_EXIT=%errorlevel%"
if not "%TALESIDE_EXIT%"=="0" pause
popd
exit /b %TALESIDE_EXIT%
