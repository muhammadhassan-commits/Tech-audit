@echo off
REM Start the audit dashboard and open it in the default browser.
REM Double-click this file, or run it from a terminal. Close the window to stop the server.
title Initial Technical SEO + LLM Visibility Audit
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this machine.
  echo   Install Node 20 or newer from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

REM If something is already serving on the port, just open the browser rather than starting a second copy.
netstat -ano | findstr /r /c:"LISTENING" | findstr ":4317" >nul 2>nul
if not errorlevel 1 (
  echo   The dashboard is already running. Opening it...
  start "" "http://localhost:4317"
  exit /b 0
)

echo.
echo   Starting the audit dashboard...
echo   Leave this window open. Close it to stop the server.
echo.

start "" /b cmd /c "timeout /t 3 >nul & start """" ""http://localhost:4317"""
node src/server.js

echo.
echo   The server stopped. Press any key to close.
pause >nul
