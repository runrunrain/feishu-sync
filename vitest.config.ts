// 根 vitest 配置：仅运行前端测试（src/**/*.test.{ts,tsx}）。
// server 测试有独立配置（server/ 下 vitest run），避免双包 better-sqlite3
// 解析到根 node_modules（Electron ABI 场景）导致误报 NODE_MODULE_VERSION。
// 测试当前均为纯逻辑/SSR（react-dom/server）断言，无需 jsdom 环境。
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
