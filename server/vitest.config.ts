// server vitest 配置：显式声明测试范围，避免向上解析到根 vitest.config.ts
// （根配置 include 仅覆盖前端 src/，会导致本包 tests/ 找不到测试文件）。
// 测试为算法层 + in-memory 模式；直连 better-sqlite3 的用例需 Node ABI 原生模块
// （node_modules 被 @electron/rebuild 重编译为 Electron ABI 后会报
// NODE_MODULE_VERSION 不匹配，见根 CLAUDE.md「原生模块 ABI」）。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
  },
})
