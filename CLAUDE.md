# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

跨平台桌面应用，定时检测飞书知识库子树变更并选择性同步到本地，把飞书导出内容重构为本地偏好的 Markdown 结构（表格 A/B/C/D/E 分型、层级格式），可选 LLM 风格对齐。结构树之外的零散云文档可快捷归档到 `_custom/<文件夹>/`（自定义归档，见下）。详见 `README.md`。

三层同进程架构：**Electron 主进程内嵌 Hono server**（不是独立进程）→ 业务模块 → SQLite，React 前端通过 preload bridge 调 server。better-sqlite3 是原生模块，其 ABI 必须与运行它的 Electron/Node ABI 一致（见下「原生模块 ABI」）。

## Commands

依赖装两份：根目录（前端 + electron + 打包）和 `server/`（业务 + 测试）。

```bash
npm install                       # 根目录
cd server && npm install && cd .. # server 子包

# 开发
npm run dev          # 仅前端 (vite, :5173)
npm run server:dev   # 仅 server (tsx watch, :3001, standalone)
npm run dev:all      # 前端 + server 并行（浏览器调，非 Electron）
npm run dev:desktop  # 编译 server/dist + dist-electron 后并行 vite + electron（内嵌 server）

# 构建
npm run build:all     # vite build + server tsc
npm run electron:build   # esbuild main.ts/preload.ts → dist-electron/*.cjs

# 测试（根目录统一入口；server 测试在 server/ 下，vitest）
npm run check             # lint + typecheck + 前端/server 全部测试（CI 同口径）
npm test                  # 前端测试（根目录 vitest，src/**/*.test.*）
npm run test:all          # 前端 + server 全部测试
npm run typecheck         # 根 src + 根配置文件 + server 三段 tsc --noEmit
npm run lint              # eslint（flat config，遗留问题已清零）

# 单独跑 server 测试
cd server
npm test                       # 全量
npm run test:watch
npx vitest run tests/sync-engine.test.ts          # 单文件
npx vitest run -t "sheet header"                   # 单用例名
npm run test:migrations        # migration-v5 专项
npm run typecheck              # tsc --noEmit

# 打包桌面安装包（electron-builder，需目标平台环境）
npm run desktop:dist:win:x64
npm run desktop:dist:mac:arm64   # Apple Silicon
npm run desktop:dist:mac:x64     # Intel
# macOS 一键脚本（按本机架构自动选 arch）：./build.command
```

**正式知识库回填**（独立脚本，不走 GUI）：

```bash
cd server
npx tsx scripts/sync-latest.ts --skip-index            # 不提交KB正文；仍会写配置/SQLite/报告（dry-run）
npx tsx scripts/sync-latest.ts --skip-index --apply    # 提交KB正文，仅 create/replace
# 已有配置默认只读，改写需 --persist-config；缺失配置会首次创建。
# 即使 --skip-index 且未 --apply，也会初始化/迁移SQLite与推进检测状态，使用真实状态目录前备份。
```

## Architecture

### 进程与启动契约

- `electron/main.ts` 是入口：生成 desktop token → 动态 `import()` server 的 `startServer()` → 健康检查 → 开窗口。**生产**从 `app.asar.unpacked/server/dist/index.js` 加载 server；**开发**从 `../server/dist/index.js`。
- Electron 下 server 端口传 `0`（系统自动分配），主进程拿到 `startedServer.url` 再注入前端；**standalone** 模式（`npm run dev:all` / 直接 `node server/dist`）固定 `127.0.0.1:3001`。
- 前端通过 preload（`window.desktop.getApiHeaders()`）取 `X-Desktop-Token`，而非硬编码。`src/api/client.ts` 是唯一出口。

### 鉴权与 CORS（两处关键 gotcha）

- `X-Desktop-Token`（`crypto.randomBytes(32)`）+ Origin/Referer 校验，仅 `desktopMode=true` 时挂 `authMiddleware`；`/api/health` 永远 public 且必须先注册。
- **CORS dev gate 不由 `desktopMode` 决定**。`dev:all`（vite `:5173` 跨域调 `:3001`）和真 Electron 生产**都** `desktopMode=true`，但只有前者需要放行 `localhost:5173`。因此用显式 `corsDevMode` 参数驱动（`server/src/index.ts` `CreateServerOptions.corsDevMode`）。改 CORS 逻辑前先读该字段的注释。

### Hono 依赖注入

`server/src/index.ts` `buildServer()` 实例化所有模块后，用一个 `app.use('*')` 中间件把它们挂到 Hono context 本身（当前写法为 `(c as any).configManager` 等，并非 `c.env`）（`configManager` / `larkCliClient` / `localMapStore` / `changeDetector`，以及 `desktopToken`）。**该中间件必须挂在 auth 之前**。路由文件（`routes/*.ts`）从 context 上的同名属性取依赖，不要 `new` 新实例。路由用 `app.route('/', xxxRoutes)` 挂载（前缀在路由文件内写死）。

### 核心同步流水线

变更检测与同步是两条独立链路，都围绕 `obj_edit_time`：

- **检测** `ChangeDetector`（`server/src/modules/change-detector.ts`）：遍历 wiki 子树，对比本地 SQLite 的 `observed_obj_edit_time`。检测**只推进 observed 字段**。
- **同步** `SyncEngine`（`sync-engine.ts`，1800+ 行量级、仓库最大核心模块，改前先读模块头注释）：`分型读取(docx/sheet/slides) → 媒体引用解析/下载 → 本地引用重写 → staged 原子提交 → 推进 synced 基线`。**只有原子提交成功才推进 `synced_obj_edit_time` 并置 `synced`**——这是不可破的契约，资源缺失/下载失败/提交异常一律不推进。

### 自定义归档与双身份契约

文档归属有两条**互斥**身份通道，`custom_folder_id` 与 `watched_root_*` 不得并存，归属冲突时结构树所有权优先：

- **结构树成员**：`watched_root_url/id` 绑定 watchedRoot，走检测→同步全链路。
- **归档文档**：`custom_folder_id` 绑定 `custom_folders` 表，本地文件在 `_custom/<文件夹名>/`；常规写入点是快捷添加 API（`POST /api/custom-folders/:id/docs` → `setDocumentCustomFolder`，带结构树竞态守卫）。
- **动态纳管**：手工放进 `_custom/` 的带 `feishu_sync` 头文件由全量重建兜底——`IndexScanner.reconcileCustomFolders` 自动注册含 md 的一级子目录（`ScanPolicy` 保留目录除外；`_custom/` 根下散档不纳管），`LocalMapStore.backfillCustomFolders` 按 `local_rel_path` 最长前缀回填 `custom_folder_id`（候选行须 watched_root 为空；与 `backfillWatchedRoots` 对称）。
- **契约细节**：回填**不清** `wiki_node_token`——upsert 的 COALESCE 会把头部解析出的 wiki 身份写回，且 `detectCustomFolderChanges` 依赖它做云端身份校验；因此飞书树两个出口（`getTreeDetailed` feishu 视图 + legacy `getTree`）都必须按 `customFolderId IS NULL` 过滤归档行，wiki 身份单独不能作为排除依据。归档变更检测只报 modified（无新增/删除语义）。

### 安全写盘：dry-run 默认 + 原子提交

- `SyncOptions.apply` 默认 false（dry-run）；提交知识库文件需要 `apply:true` + `confirmation:'APPLY'`。move/delete/路径冲突/父链不完整/未知类型/无权限 → 保留为带 `reasonCode` 的 **blocker**，绝不自动覆盖。
- `atomic-commit.ts`：所有写入先进**库外** staging 目录，校验后 rename 入位；失败从 rollback 快照恢复；`assertInsideRoot` 拒绝路径逃逸。改写盘逻辑必须保持「staging → 校验 → rename → DB 事务」顺序，文件已提交但 DB 失败时用 `SyncEngineTestHooks` 验证回滚。

### LLM 通道（direct 单通道）

`content-backend.ts` + `content-backend-registry.ts` + `direct-channel.ts`：

- **单 channel 注册**（`ChannelName = 'direct'`）：OpenAI SDK 打 OpenAI 兼容远程端点（默认智谱 bigmodel GLM），无本地 CLI 通道。
- Registry 的 `getFallback()` 恒为 null——整理失败由 sync-engine 的确定性 B6 结果兜底。channel 失败不抛异常，返回 `finishReason='error'/'timeout'`。
- 默认超时 `timeoutMs = 600_000`（10 分钟）——远程模型过载时 SDK 内部重试，旧 60s 会误判超时。

### 数据层

- SQLite 在 `~/.feishu-sync/feishu-sync.db`，config 在 `~/.feishu-sync/config.json`；环境变量 `FEISHU_SYNC_HOME` 可整体改根目录（server 与 desktop 共享，**不是** Electron userData）。除 documents/sync_log/run_log 主表外还有 localDirs/custom_folders/sheet_sheets/feishu_pending_items 等辅助表，全部经 additive 迁移演进。
- `LocalMapStore`（`local-map-store.ts`）用 better-sqlite3 **同步** API + 预编译语句。`initialize()` 每次启动跑 `applyAdditiveMigrations()`：每条 `ALTER TABLE ADD COLUMN` 用 `PRAGMA table_info` 守卫，旧库原地升级。新列加到该数组 + `getCreateTablesDDL()` 两处。
- 历史迁移脚本（`server/scripts/migration_v2..v5`）是文件级参考；线上升级靠上面的 additive 自动迁移，不再手工跑。
- **`watchedRoots`（`WatchedRootConfig[]`）是真相源**，`watchedRootUrls` 是 ConfigManager 内存派生、不落盘的兼容投影。

### Markdown header 契约（round-trip 必须闭环）

`SyncEngine.generateHtmlHeader` 写、`IndexScanner.parseMetadata` 读。当前规范是文件首部 YAML-in-HTML-comment：

```
<!--
feishu_sync:
  obj_token: ...
  obj_type: docx
  ...
-->
```

`IndexScanner` 还兼容 3 种历史格式（`legacy_html_zh` / `blockquote` / `bold_kv`）。改 header 字段必须同步两端，并保证 round-trip（参考 `tests/sync-engine.test.ts` 的 (d) 项用例）。

## 安全红线（不可妥协）

- **零飞书 token**：代码中不得出现任何飞书 token/app_id/app_secret 变量；全部委托 `lark-cli` user 认证态。`LarkCliClient` 是 lark-cli 子进程封装（QPS 节流 + 错误分类，`99991400` 指数退避）。
- bigmodel apiKey 当前**明文**存 config.json（架构决策，含 `_warning` 字段提醒勿提交），加密 deferred。
- 前端改动必须真机浏览器/Electron 交互验证，不能只靠 API 测试。

## 原生模块 ABI（better-sqlite3）

打包/跑 Electron 时 better-sqlite3 的 `.node` 二进制必须匹配 Electron ABI，否则启动崩。`scripts/build-desktop-target.cjs` 在 `build:all → electron:build` 后会跑 `@electron/rebuild`。验证用 `scripts/verify-abi.cjs`。开发态 `dev:desktop` 与 standalone server 用同一份 server/dist，ABI 必须一致。

**实测坑**：node_modules 被 `@electron/rebuild` 编译成 Electron ABI 后，直接用系统 Node 跑 vitest 会报 `NODE_MODULE_VERSION` 不匹配，横跨所有直连 better-sqlite3 的测试（20+ 用例）。切回系统 Node ABI：`cd server && npm rebuild better-sqlite3`。跑桌面构建后再跑测试时按此切换。

**Node 24 teardown 崩溃（2026-10 实测）**：better-sqlite3 11.x 在 Node 24 上存在 worker teardown 时序缺陷——GC 弱回调触发 `Statement::~Statement` 时 Environment 已销毁，`RemoveEnvironmentCleanupHook` 断言 `env != nullptr` 崩溃（表现为 custom-folders.test.ts 等 worker 静默退出、49 用例丢失）。已升级 better-sqlite3 ^12 修复（12.4.1+ 含修复）；如再遇类似 worker 崩溃先查原生模块版本矩阵。

## 代码约定

- 模块/路由/类型注释密度很高，大量「P0-Qx 实测 / 实测 confirmed / 历史教训」标注记录了为什么这样写。改动前读模块头注释，不要凭直觉重写。
- TypeScript，ESM（`"type": "module"`），server 源码用 `.js` 扩展名 import（`moduleResolution: bundler`，非 NodeNext）；electron 经 esbuild 打成 CJS（`dist-electron/*.cjs`）。
- 后端测试在 `server/tests/`（vitest），倾向算法层 + in-memory mock（避免 better-sqlite3 ABI 依赖，参考 `change-detector.test.ts` / `sync-engine.test.ts` 的模式）。
- 已知技术债：`server/scripts/e2e-integration-test.ts` 端口硬编码（应为环境变量读取）。
