@echo off
setlocal
pushd "%~dp0" || exit /b 1
py -3.12 -m taleside
if errorlevel 1 pause
popd
