@echo off
setlocal
title Kai Remote launcher
rem ---------------------------------------------------------------------------------------------
rem  Launch or relaunch the Kai Remote daemon. Double-click it, or put a shortcut to it on the desktop.
rem
rem    "Launch Kai Remote.bat"          start the daemon, restarting it if it is already running
rem    "Launch Kai Remote.bat" build    rebuild the release exe first (use after changing the code), then start
rem
rem  The daemon opens in its own window. That window shows the pairing link and QR code for your phone.
rem  Closing the window stops the remote.
rem ---------------------------------------------------------------------------------------------
cd /d "%~dp0"
set "REL=%~dp0target\release"
set "DBG=%~dp0target\debug"

if /i "%~1"=="build" goto build
if not exist "%REL%\kai-remote.exe" goto build
goto start

:build
echo Building the release version. The first time takes a minute or two...
cargo build --release
if errorlevel 1 (
  echo.
  echo The build failed. Is Rust installed ^(is "cargo" on your PATH^)?
  pause
  exit /b 1
)

:start
rem The pairing token is stored next to the exe. Reuse the one from the debug build on the first release run,
rem so the phone stays paired and the pairing link does not change.
if not exist "%REL%\kai-remote.token" if exist "%DBG%\kai-remote.token" copy /y "%DBG%\kai-remote.token" "%REL%\kai-remote.token" >nul

taskkill /f /im kai-remote.exe >nul 2>&1 && echo Stopped the running Kai Remote.
timeout /t 1 /nobreak >nul

start "Kai Remote" /d "%REL%" cmd /k "kai-remote.exe"
exit /b 0
