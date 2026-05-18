@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found.
  echo Please install Node.js first: https://nodejs.org/
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm.cmd install
  if errorlevel 1 exit /b 1
)

if not exist dist\index.html (
  echo Building app...
  call npm.cmd run build
  if errorlevel 1 exit /b 1
)

echo Opening browser...
start "" "http://127.0.0.1:3001"

echo Starting app server...
echo Keep this window open while the app is running.
node server\index.js
