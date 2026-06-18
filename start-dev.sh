#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "========================================"
echo "  feishu-sync 开发态启动"
echo "========================================"
echo ""

echo "[1/4] 检查 Node.js..."
if ! command -v node &> /dev/null; then
    echo "错误：未找到 Node.js，请安装 Node.js 18+ 后重试"
    echo "下载地址：https://nodejs.org/"
    exit 1
fi
node --version
echo ""

echo "[2/4] 检查依赖（根目录）..."
if [ ! -d "node_modules" ]; then
    echo "未找到根目录依赖，正在安装..."
    npm install
else
    echo "根目录依赖已存在"
fi
echo ""

echo "[3/4] 检查依赖（server 子包）..."
if [ ! -d "server/node_modules" ]; then
    echo "未找到 server 依赖，正在安装..."
    cd server
    npm install
    cd ..
else
    echo "server 依赖已存在"
fi
echo ""

echo "[4/4] 启动开发态..."
echo "========================================"
echo "前端地址：http://localhost:5173"
echo "Electron 窗口将自动打开"
echo "按 Ctrl+C 停止服务"
echo "========================================"
echo ""

npm run dev:desktop
