import { defineConfig } from 'vite'
import path from 'path'
import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// 构建时注入 package.json version，供 UI「关于与更新」显示真实版本（桌面端还会被 Electron 真实版本覆盖）。
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, './package.json'), 'utf-8')) as {
  version: string
}

const DEFAULT_BACKEND_PORT = 3001

function parseBackendPort(rawValue: string | undefined): number {
  const trimmedValue = rawValue?.trim()
  if (!trimmedValue) {
    return DEFAULT_BACKEND_PORT
  }

  const parsed = Number.parseInt(trimmedValue, 10)
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== trimmedValue ||
    parsed < 1 ||
    parsed > 65535
  ) {
    console.warn(`[vite] Ignoring invalid BACKEND_PORT; using ${DEFAULT_BACKEND_PORT}.`)
    return DEFAULT_BACKEND_PORT
  }

  return parsed
}

const devProxyTarget = `http://127.0.0.1:${parseBackendPort(process.env.BACKEND_PORT)}`

// 浏览器 dev:all 免 Electron：server standalone 用 FEISHU_SYNC_DEV_TOKEN 固定
// token 时，vite proxy 自动注入 X-Desktop-Token（浏览器侧 window.desktop 不
// 存在，拿不到 token）。仅开发态生效，生产构建不走 proxy。
const devToken = process.env.FEISHU_SYNC_DEV_TOKEN?.trim()

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: devProxyTarget,
        changeOrigin: true,
        ...(devToken
          ? { headers: { 'X-Desktop-Token': devToken } }
          : {}),
      },
    },
  },
  assetsInclude: ['**/*.svg', '**/*.csv'],
})
