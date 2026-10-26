# 开发指南

## 环境要求

- Node.js **22.19+（22.x）或 24.x LTS**（实测 v24；CI 用最新22；根 engines 与锁定工具链一致）。此处是开发/打包宿主要求，不改变 Electron31 内置 Node20。
- lark-cli 1.0.89+（全局安装 `npm install -g lark-cli`，用于飞书认证/读取，工具本身零 token）
- 依赖装两份：根目录（前端 + electron + 工具链）和 `server/`（业务 + 测试）

```bash
npm install && cd server && npm install && cd ..
```

## 双包结构（本阶段不迁移 monorepo）

| 包 | 职责 | 测试 |
|----|------|------|
| 根 | React 前端 `src/`、Electron `electron/`、构建脚本 | vitest（`src/**/*.test.{ts,tsx}`，8 文件） |
| `server/` | Hono server、业务模块、运维脚本 | vitest（`tests/**/*.test.ts`，43 文件） |

根 `dependencies` 为空、运行库全在 devDependencies——这是既定结构（打包只收 `server/node_modules/**`，见 `electron-builder.config.cjs` files 列表），不是错误。

## 常用命令（根目录）

```bash
# 开发
npm run dev            # 仅前端 (vite, :5173)
npm run server:dev     # 仅 server (tsx watch, :3001, standalone)
npm run dev:all        # 前端 + server 并行（浏览器调，非 Electron）
npm run dev:desktop    # 编译 server/dist + dist-electron 后并行 vite + electron

# 质量门禁（CI 同口径，提交前必跑）
npm run check          # lint + typecheck + 前端/server 全部测试
npm run lint           # eslint
npm run typecheck      # 根 src（含测试）+ 根配置 + server 三段
npm run test:all       # 双包全部测试

# 构建
npm run build:all      # vite build + server tsc
npm run electron:build # esbuild main/preload → dist-electron/*.cjs
```

单跑 server 测试/用例：

```bash
cd server
npx vitest run tests/sync-engine.test.ts   # 单文件
npx vitest run -t "sheet header"           # 单用例名
```

## 原生模块 ABI（better-sqlite3，最大的环境坑）

better-sqlite3 是原生模块，其 `.node` 二进制 ABI 必须与运行它的运行时一致：

- **桌面打包/跑 Electron**：`scripts/build-desktop-target.cjs` 在构建后跑 `@electron/rebuild` 编成 Electron ABI；验证用 `scripts/verify-abi.cjs`。
- **切回跑测试**：`cd server && npm rebuild better-sqlite3`（恢复 Node ABI）。跑完桌面构建再跑 vitest 时按此切换，否则报 `NODE_MODULE_VERSION` 不匹配。
- **Node 24 teardown 崩溃**：better-sqlite3 11.x 在 Node 24 有 worker teardown 时序缺陷（GC 触发 `Statement::~Statement` 时 env 已销毁，断言崩溃、worker 静默退出）。已升级 ^12 修复；遇类似 worker 崩溃先查原生模块版本矩阵。

## 数据目录与隔离

- 运行时数据：`~/.feishu-sync/`（SQLite + config.json）；`FEISHU_SYNC_HOME` 环境变量可整体改根（server 与 desktop 共享，**不是** Electron userData）。
- 跑测试/调试时建议设 `FEISHU_SYNC_HOME` 指向临时目录，避免污染真实用户数据。

## 安全红线

- 零飞书 token：全部委托 lark-cli user 认证态；禁止 app_id/app_secret/硬编码 token。
- LLM apiKey 当前明文存 config.json（架构决策，含 `_warning` 字段；加密 deferred）——不要提交任何真实 config。
- 前端改动必须真机浏览器/Electron 交互验证，不能只靠 API 测试。

## Lint / Format

- ESLint（flat config `eslint.config.js`）：只抓代码质量不做格式检查；历史违规已清零，CI 强制。
- Prettier（`.prettierrc.json`）：**渐进采纳**——不做全仓一次性 format（避免无语义大 diff）；新文件建议 `npx prettier --write <file>`。历史遗留的格式差异是已知状态，不算违规。

## 已知技术债（改动时注意）

- `server/scripts/e2e-integration-test.ts` 端口硬编码 `4123`（应为环境变量读取）。
- `electron-builder.config.cjs` 的 appId 仍为 `com.yourcompany.feishu-sync` 占位——**不可随手改**：改 appId 会破坏已发布安装包的更新识别（见 docs/operations.md 发布约束）。
