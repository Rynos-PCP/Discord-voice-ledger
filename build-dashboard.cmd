@echo off
setlocal
rem This file must stay pure ASCII: cmd.exe remembers a byte position while
rem reading. A "chcp" in the middle of the script shifts how bytes are read,
rem and special characters in the script itself would tear apart the lines
rem that follow.
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   Discord Voice Ledger - building your dashboard
echo   ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js was not found. Install it from https://nodejs.org
  echo   and start this window again afterwards.
  echo.
  pause
  exit /b 1
)

node build.mjs %*
if errorlevel 1 (
  echo.
  echo   The build failed. See the message above.
  echo.
  pause
  exit /b 1
)

echo.
echo   Done. Opening the dashboard ...
start "" "dist\discord-voice-ledger.html"
echo.
pause
