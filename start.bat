@echo off
rem Double-click this file on Windows to set up and start GodsView Command.
setlocal
cd /d "%~dp0"
title GodsView Command

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed, or this window cannot see it yet.
  echo  1. Install the LTS version ^(24 or later^) from https://nodejs.org/en/download
  echo  2. Restart your computer so Windows picks it up.
  echo  3. Double-click start.bat again.
  echo.
  pause
  exit /b 1
)

node scripts\start.mjs %*
if errorlevel 1 (
  echo.
  echo  GodsView Command stopped with an error. Read the message above.
  echo.
  pause
)
endlocal
