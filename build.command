#!/usr/bin/env bash
set -euo pipefail

echo "========================================"
echo "  feishu-sync 一键打包 (macOS)"
echo "========================================"
echo

cd "$(dirname "$0")"

# Finder 双击 .command 时 PATH 往往不含用户安装的 Node，补齐常见路径
export PATH="/usr/local/bin:/opt/homebrew/bin:${HOME}/.local/bin:${HOME}/.local/node/bin:${PATH}"

# 若仍找不到 node，尝试加载登录配置（nvm / fnm / asdf 等常写在 profile 里）
if ! command -v node &>/dev/null; then
    # shellcheck disable=SC1090,SC1091
    [[ -f "${HOME}/.zprofile" ]] && source "${HOME}/.zprofile" || true
    [[ -f "${HOME}/.zshrc" ]] && source "${HOME}/.zshrc" || true
    [[ -f "${HOME}/.bash_profile" ]] && source "${HOME}/.bash_profile" || true
    [[ -f "${HOME}/.profile" ]] && source "${HOME}/.profile" || true
fi

echo "[1/4] 检查 Node.js..."
if ! command -v node &>/dev/null; then
    echo "[错误] 未检测到 Node.js, 请安装 Node.js 18+ : https://nodejs.org/"
    echo ""
    echo "按 Enter 键退出..."
    read -r
    exit 1
fi
echo "[提示] Node 版本:"
node --version
echo

# 按本机 CPU 架构选择对应 npm script（package.json 无 desktop:dist:mac）
HOST_ARCH="$(uname -m)"
case "${HOST_ARCH}" in
    arm64)
        MAC_ARCH="arm64"
        ;;
    x86_64)
        MAC_ARCH="x64"
        ;;
    *)
        echo "[错误] 不支持的 macOS 架构: ${HOST_ARCH}"
        echo "       仅支持 arm64 (Apple Silicon) 与 x86_64 (Intel)"
        echo ""
        echo "按 Enter 键退出..."
        read -r
        exit 1
        ;;
esac
NPM_SCRIPT="desktop:dist:mac:${MAC_ARCH}"
OUTPUT_DIR="$(pwd)/dist-desktop/darwin-${MAC_ARCH}"
echo "[提示] 目标架构: ${MAC_ARCH} (主机: ${HOST_ARCH})"
echo "[提示] 将执行: npm run ${NPM_SCRIPT}"
echo "[提示] 默认生成完整 ad-hoc 签名的本机测试包；对外分发请使用 :release 命令"
echo

echo "[2/4] 检查根目录依赖(node_modules)..."
if [ ! -d "node_modules" ]; then
    echo "[提示] 未检测到 node_modules, 正在执行 npm install..."
    npm install
fi
echo "[提示] 根目录依赖已就绪."
echo

echo "[3/4] 检查 server 依赖(node_modules)..."
if [ ! -d "server/node_modules" ]; then
    echo "[提示] 未检测到 server/node_modules, 正在执行 npm install..."
    (cd server && npm install)
fi
echo "[提示] server 依赖已就绪."
echo

echo "[4/4] 正在打包 macOS 安装包 (${MAC_ARCH})..."
echo "[说明] 打包脚本(build-desktop-target.cjs)内部流程:"
echo "       build:all -> electron:build -> 原生模块重建 -> electron-builder"
echo "========================================"
npm run "${NPM_SCRIPT}" || {
    echo ""
    echo "[错误] 打包失败!"
    echo "[提示] 常见原因:"
    echo "  - 缺少 Xcode Command Line Tools: xcode-select --install"
    echo "  - Electron 二进制下载失败: 检查网络或清理 ~/Library/Caches/electron"
    echo "  - 磁盘空间不足(产物+缓存约需 1GB+)"
    echo ""
    echo "按 Enter 键退出..."
    read -r
    exit 1
}

echo ""
echo "========================================"
echo "  打包完成!"
echo "  产物目录: ${OUTPUT_DIR}"
echo "  产物类型: .dmg / .zip"
echo "========================================"
echo ""
echo "按 Enter 键退出..."
read -r
