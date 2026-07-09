@echo off
chcp 65001 >nul 2>&1
title feishu-sync 一键打包 (win x64)

echo ========================================
echo   feishu-sync 一键打包 (Windows x64)
echo ========================================
echo.

cd /d "%~dp0"

echo [1/4] 检查 Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js, 请安装 Node.js 18+ : https://nodejs.org/
    pause
    exit /b 1
)
echo [提示] Node 版本:
node --version
echo.

echo [2/4] 检查根目录依赖(node_modules)...
if not exist "node_modules" (
    echo [提示] 未检测到 node_modules, 正在执行 npm install...
    call npm install
    if errorlevel 1 (
        echo [错误] 根目录依赖安装失败!
        pause
        exit /b 1
    )
)
echo [提示] 根目录依赖已就绪.
echo.

echo [3/4] 检查 server 依赖(node_modules)...
if not exist "server\node_modules" (
    echo [提示] 未检测到 server\node_modules, 正在执行 npm install...
    pushd server
    call npm install
    if errorlevel 1 (
        popd
        echo [错误] server 依赖安装失败!
        pause
        exit /b 1
    )
    popd
)
echo [提示] server 依赖已就绪.
echo.

echo [4/4] 正在打包 win x64 安装包...
echo [说明] 打包脚本(build-desktop-target.cjs)内部流程:
echo        build:all -^> electron:build -^> 原生模块重建 -^> electron-builder
echo ========================================
call npm run desktop:dist:win:x64
if errorlevel 1 (
    echo.
    echo [错误] 打包失败!
    echo [提示] 常见原因:
    echo   - 缺少 C++ 构建工具(Windows): 安装 Visual Studio Build Tools (C++ workload)
    echo   - Electron 二进制下载失败: 检查网络或清理 %%LOCALAPPDATA%%\electron\Cache
    echo   - 磁盘空间不足(产物+缓存约需 1GB+)
    pause
    exit /b 1
)

echo.
echo ========================================
echo   打包完成!
echo   产物目录: %~dp0dist-desktop\win32-x64
echo   产物类型: .exe 安装包(NSIS)
echo ========================================
echo.
pause
