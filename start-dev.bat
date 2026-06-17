@echo off
cd /d "%~dp0"
title feishu-sync dev
echo ========================================
echo   feishu-sync dev launcher
echo ========================================
echo.
echo [1/4] Check Node.js...
node --version >nul 2>&1
if errorlevel 1 goto :no_node
node --version
echo.
echo [2/4] Check root dependencies...
if not exist "node_modules" call npm install
echo.
echo [3/4] Check server dependencies...
if not exist "server\node_modules" (pushd server & call npm install & popd)
echo.
echo [4/4] Start dev:desktop...
echo ========================================
echo Frontend: http://localhost:5173
echo Electron window opens automatically. Ctrl+C to stop.
echo ========================================
call npm run dev:desktop
pause
exit /b

:no_node
echo Error: Node.js not found. Install Node.js 18+ from https://nodejs.org/
pause
