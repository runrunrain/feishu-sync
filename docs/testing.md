# 测试指南

## 布局与运行器

| 测试面 | 位置 | 运行器 | 入口 |
|--------|------|--------|------|
| 前端单元 | `src/**/*.test.{ts,tsx}` | vitest（根，`vitest.config.ts`） | `npm test` |
| server 单元 | `server/tests/*.test.ts` | vitest（server，`server/vitest.config.ts`） | `npm run test:server` |
| 全部 | — | — | `npm run test:all`（CI 执行） |

双 vitest 配置显式声明各自 include 范围：根配置只扫 `src/`，server 配置只扫 `server/tests/`——避免 server 测试误解析根 `node_modules` 的 better-sqlite3（Electron ABI 场景）。

## 环境注意

1. **自动隔离数据目录**：`server/vitest.config.ts` 的 globalSetup 在测试模块装载前创建临时 `FEISHU_SYNC_HOME`，结束后清理；普通 `npm test` 与 `npx vitest run` 均不会使用真实 `~/.feishu-sync`。由 `test-environment.test.ts` 守护，单个测试另建 fixture 时也必须只用临时目录。
2. **ABI 切换**：跑过桌面构建（`@electron/rebuild`）后需 `cd server && npm rebuild better-sqlite3` 恢复 Node ABI，否则直连 better-sqlite3 的用例报 `NODE_MODULE_VERSION` 不匹配。
3. **Node 24**：better-sqlite3 必须 ^12（11.x 在 Node 24 worker teardown 时崩溃，见 docs/development.md）。

## 编写约定（既有模式，沿用）

- **算法层 + in-memory mock**：server 测试倾向 mock LarkCliClient/LocalMapStore 接口（参考 `change-detector.test.ts` / `sync-engine.test.ts` 的 mock 模式），不依赖真实飞书凭据与网络。
- **round-trip 用例**：Markdown header 契约（`generateHtmlHeader` ↔ `parseMetadata`）必须有 round-trip 验证（`sync-engine.test.ts` (d) 项用例模式）。
- **类型即检查**：前端测试文件已纳入根 `tsc --noEmit`（`tsconfig.json` include `src` 不再排除 `*.test.*`）；测试断言要与受测类型同步演进。
- **hook 依赖**：`react-hooks/exhaustive-deps` 以 warning 运行（已知 2 处遗留：`NodeTreeView` roots、`useSyncStatus` watchedRootUrls——行为敏感未自动修，改动这些组件时人工确认依赖数组）。
- **ESM interop 遗留**：`server/tests` 少量文件用 `const { x } = require('...')`（依赖 vitest SSR transform 的 CJS interop，运行合法）；新测试请用 `import`。

## 验证层级

- 提交前：`npm run check`（与 CI 同口径：lint → typecheck → 双包测试）。
- CI：push(main)/PR 自动执行同样检查 + 构建冒烟（`.github/workflows/ci.yml`）。
- 前端 UI 改动：测试之外必须真机浏览器/Electron 交互验证（项目安全红线）。
- 桌面打包链：仅 release workflow 覆盖（tag 触发），日常 CI 不打包。
