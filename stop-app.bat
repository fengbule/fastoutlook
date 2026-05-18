@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -Command "$conn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $conn) { exit 2 }; Stop-Process -Id $conn.OwningProcess -Force; exit 0"

if errorlevel 2 (
  echo No running server was found for this project.
  exit /b 0
)

if errorlevel 1 (
  echo Failed to stop the server.
  exit /b 1
)

echo Server stopped.
exit /b 0
