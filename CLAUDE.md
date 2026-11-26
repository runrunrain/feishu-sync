# CLAUDE.md

本文件面向 Claude Code（`claude.ai/code`），提供在本仓库开发、排查与交付时的直接契约。完整协作规范与详细边界与 [AGENTS.md](./AGENTS.md) 保持一致；细则见 [docs/README.md](./docs/README.md)，设计动机以各模块头部注释为准。

## 项目概览

`feishu-sync` 是跨平台桌面应用，把飞书知识库子树定时检测并选择性同步为本地 Markdown 与 Excel 原件，同时承载自定义归档（`_custom/<文件夹>/`）、Agent 标准知识库工作台、只读 MCP 服务（本机 HTTP / WSL 桥接 / 局域网）、标准库文档导出与内网网页分享，以及 `feishu-sync` CLI。

- **桌面架构**：Electron 主进程经 `utilityProcess.fork` 运行 Hono 后端（`electron/server-process.ts`），业务负载不占主进程 UI 线程；仅 `vision` 图片裁剪因 `utilityProcess` 无 `nativeImage` 而经消息通道回调主进程。独立模式（`dev:all` / `node server/dist`）直接运行同一 Hono 后端。
- **双包结构**：根目录负责前端（`src/`）、Electron（`electron/`）与构建脚本；`server/` 负责后端业务与测试。打包只收 `server/node_modules/**`，根目录运行库留在 `devDependencies`。

## 命令速查

```bash
# 双包安装
npm install && cd server && npm install && cd ..

# 开发
npm run dev          # 仅前端（Vite :5173）
npm run server:dev   # 仅后端（先打 share-render.cjs，再 tsx watch :3001）
npm run dev:all      # 前端 + 后端并行（浏览器联调，须同终端设 FEISHU_SYNC_DEV_TOKEN）
npm run dev:desktop  # 编译 server/dist + dist-electron 后并行启动 Vite + Electron

# 构建
npm run build:all       # vite build + server tsc + build-agent-assets
npm run electron:build  # esbuild → dist-electron/{main,preload,server-process-entry}.cjs

# 质量门禁（提交前必跑，CI 同口径）
npm run check           # lint + typecheck + 前端与服务端全部测试
npm run lint            # eslint（保持 0 error）
npm run typecheck       # 根 src + 根配置 + server 三段 tsc --noEmit
npm test                # 前端 vitest
npm run test:all        # 前端 + 服务端全部测试

# 服务端单测（server/ 目录下）
cd server
npm test
npx vitest run tests/sync-engine.test.ts
npx vitest run -t "sheet header"
npm run test:migrations
npm run typecheck

# 桌面打包（需对应平台环境；macOS 正式签名公证加 :release 后缀，本机一键脚本 ./build.command）
npm run desktop:dist:win:x64
npm run desktop:dist:mac:arm64
npm run desktop:dist:mac:x64
```

`server:build` 同时执行 `server/scripts/build-agent-assets.mjs`：复制 `prompts/`、`roles/`、`pi-extension/`、`claude-bridge.cjs`、`patches/`、`cli/skills/` 与 `agent/skills/knowledge-build/`（缺失时 `pi-amagi` 构建拒绝启动），生成 `share-render.cjs`，用 esbuild 打包 4 个零原生依赖单文件 CJS（`kb-mcp.cjs`、`kb-mcp-gateway.cjs`、`kb-mcp-http-bridge.cjs` 配 `kb-mcp-wsl.cmd`、`feishu-sync-cli.cjs`），并装配内置 `amagi-pi` 快照至 `dist/agent/bundled-amagi`（`desktop:dist:*` 会拉取远端最新 `amagi-pi` 并回写 `server/bundled/amagi-pi/`；开发与 CI 不联网）。

**正式知识库回填（独立脚本，不走 GUI）**：

```bash
cd server
npx tsx scripts/sync-latest.ts --skip-index          # dry-run：不提交 KB 正文，仍写配置/SQLite/报告
npx tsx scripts/sync-latest.ts --skip-index --apply  # 提交 KB 正文，仅 create / replace
```

已有配置默认只读，改写需 `--persist-config`；根目录按 `--kb` → `FORMAL_KB` → `config.json` 的 `knowledgeBaseRoot` 解析。未加 `--apply` 也会初始化或迁移 SQLite 并推进 `observed` 状态，操作真实数据目录前须备份。

## 架构与关键坑点

### 启动、端口与前端出口

- `electron/main.ts` 生成 `X-Desktop-Token` 后 fork `dist-electron/server-process-entry.cjs` 动态加载 `server/dist/index.js`（生产取 `app.asar.unpacked/server/dist/index.js`，开发取 `../server/dist/index.js`），健康检查通过后开窗。
- 端口分工：Electron 内嵌后端传 `0` 自动分配；standalone 后端固定 `127.0.0.1:3001`；本机 HTTP MCP 固定 `127.0.0.1:47392/mcp`（`.agents`、WSL 版 Claude Code 和 WSL 版 Codex 的 stdio 桥接复用此端口，旧会话失效时重新握手并重试只读调用一次；`allowStandaloneKbMcp` 默认开启）；局域网只读 MCP 默认 `47391`（默认关）；内网静态网页分享固定 `47393`。
- 前端唯一 API 出口是 `src/api/client.ts`，经 preload `window.desktop.getApiHeaders()` 取桌面令牌，禁止硬编码。

### 鉴权、CORS 与 Hono 注入顺序

- **四令牌域双向隔离**：Desktop（`X-Desktop-Token`）、CLI（`X-Cli-Token`）、Agent 运行（`X-Agent-Run-Token`）与 LAN MCP（`Authorization: Bearer`）互不接受对方令牌。
- **挂载顺序不可变**（`server/src/index.ts`）：`app.use('*')` 依赖注入（将模块挂到 context 同名属性 `(c as any).configManager`，非 `c.env`；路由不得自行 `new`）→ `/api/health`（永远公开）→ `agentInternalRoutes` → `cliAdminRoutes` → `cliRoutes` → `authMiddleware`（仅 `desktopMode=true`）→ 其余受保护业务路由（共 23 个路由文件）。
- **CORS 开发放行由 `CreateServerOptions.corsDevMode` 显式驱动**，不看 `desktopMode`。`dev:all` 与 Electron 生产态都是 `desktopMode=true`，只有前者放行 `localhost:5173`。改 CORS 前先读该字段注释。
- **`RETIRED_REQUEST_SCOPES`**（`config-manager.ts`）：`docs:document:read` 在上游已失效，加载迁移与 device flow 发起前均会剔除，防止整单授权被拒。

## 不可破业务契约

### 同步引擎、安全写盘与双身份归档

- **检测/同步解耦**：`ChangeDetector` 只推进 `observed_obj_edit_time`；`SyncEngine` 只有在 `库外 staging → 校验 → rename → DB 事务` 全部成功后才推进 `synced_obj_edit_time` 并置 `synced`。任何资源缺失、下载失败或提交异常均不推进基线。
- **dry-run 默认**：`SyncOptions.apply` 默认 `false`，写盘须同时传入 `apply: true` 与 `confirmation: 'APPLY'`。`move`、`delete`、路径冲突、父链不完整、未知类型、无权限与未写回源编辑一律生成带 `reasonCode` 的 blocker，不自动覆盖。文件落盘后 DB 失败须经 `atomic-commit.ts` 快照回滚并用 `SyncEngineTestHooks` 验证。
- **双身份互斥**：`custom_folder_id` 与 `watched_root_*` 互斥，冲突时结构树所有权优先。全量重建自动纳管 `_custom/<子目录>/` 下带头 `.md`（根散档除外），回填**不清 `wiki_node_token`**；飞书树两处出口（`getTreeDetailed` 飞书视图与 legacy `getTree`）必须按 `customFolderId IS NULL` 过滤归档行。归档变更检测仅报 `modified`。
- **同步并发与表格原件**：批量同步并发上限为 2；只读 XLSX 重建保留自动行高与样式，单元格页缓存在 `<dataRoot>/sync-cache/`，性能流水记入 `sync-performance.jsonl`。

### LLM 多协议与 direct 通道

- `direct-channel.ts` 为 `direct` 单通道，按所选提供商协议分别支持 `openai-completions`、`openai-responses` 与 `anthropic-messages`（OpenAI SDK + Anthropic SDK），初始配置不预置提供商或密钥，`contentAdaptationEnabled` 默认关闭。
- `getFallback()` 恒为 `null`，风格对齐失败不抛异常，返回 `finishReason='error'|'timeout'` 并由确定性重构结果兜底；默认超时 `600_000` ms。

### Agent 工作台、Pi 编排与源受控写

- **运行时与独立边界**：设置页仅提供 Pi 运行时，`agent.runtime.backend` 归一为 `pi`（启动自动迁移旧应用级 Claude Code 配置；已有会话按 `agent_sessions.runtime_backend` 继续，见 `docs/claude-runtime.md`）。`server/src/agent/`、`kb/`、`mcp/`、`kb-lan/`、`sources/`、`ops/`、`cli/` 独立于同步流水线，不把 Pi 接入 `ContentBackend` registry，也不为 Pi 升级 Electron。
- **Pi 侧车与插件**：经外部 Node ≥ 22.19、Pi ≥ 1.4/< 2 以 JSONL RPC 启动。内置转发扩展只调回环内部 API，工具集与能力令牌由服务端单点裁决；Discuss 只读，Work 仅在授权 Workspace 内操作且无内置 shell（原生 Pi 插件为受信任 Node 代码，非 OS 沙箱），支持按会话切换本机插件资源与「从此轮分叉」。Workspace 与原始库、标准库、数据根及受保护运行根双向隔离，改配置须反向交叉校验。
- **构建编排 v2（`pi-amagi`）**：`standardKb.orchestrationMode` 唯一开放值为 `'pi-amagi'`；角色（`luban` / `diting` / `baize`）当前要求 `openai-completions` 协议并在创建/恢复构建前预检。epoch 换代与残留进程对账未确认即拒绝启动；标准库走 `staging 校验 → 不可变 release → 原子切 CURRENT.json`，提交后 DB 异常按文件指针对账、清理异常不得删当前 release，**不可沿用原同步引擎“DB 失败回滚文件”的逻辑**。编排度量记入 `kb_builds.metrics_json`。
- **进程池三通道**（`agent-process-pool.ts`）：`session` 立即准入（满返 409 `agent_busy`，M ≥ 2 至少留 1 槽）；`background` 合计 ≤ `M - 1`（`agent.maxConcurrentProcesses`，1–6 默认 3）；`build` 独立通道容量 `N = standardKb.buildConcurrency`（1–6 默认 2，兼容读 `buildParallelism`），总上限 `N + M`。
- **CLI、批准流与三写者**：`ops/command-table.ts` 40 条命令表供 CLI（默认开启）与 `app_command` 共用。`app_command` 的非 `read` 命令逐次经会话批准，模型传入的 `confirm`/`confirmation` 一律剔除，批准绑定服务端轮次。原始库正文只由 `SyncEngine`、源生命周期操作（只移删）、`SourceEditService` 三者修改，`feishu_sync` 头只由 `SyncEngine` 生成；非 `pushed` 的 `source_edits` 行令同步与清理以 `local_edit_pending` 拒绝。写回飞书（`feishuWrite` 默认关）三段式执行，**不推进任何 `synced` 基线**，成功后单文档回拉收敛。

### 数据层与 Header round-trip

- 数据根默认 `~/.feishu-sync/`（`feishu-sync.db` + `config.json`），`FEISHU_SYNC_HOME` 可整体覆盖（服务端与桌面共享，非 Electron `userData`）。
- SQLite 现含 **22 张表**（清单见 `docs/data-contract.md`）。启动自动跑 `applyAdditiveMigrations()`，**新增表或列必须双登记到 additive 迁移数组与 `getCreateTablesDDL()`**。`watchedRoots` 是真相源，`watchedRootUrls` 仅内存派生投影。
- 原始库头 `feishu_sync`（YAML-in-HTML-comment，兼 3 种历史格式）由 `SyncEngine.generateHtmlHeader` 写、`IndexScanner.parseMetadata` 读；标准库头 `feishu_sync_kb` 独立维护，互不混用。改字段须同步两端并验证 round-trip。

## 安全红线、原生 ABI 与代码约定

- **安全红线**：代码零飞书 token/`app_id`/`app_secret`（`larkCliPath` 已废弃，仅留环境变量 `LARK_CLI_PATH`）；不提交含明文 API Key 的 `config.json`；前端改动必须真机浏览器或 Electron 实测。
- **better-sqlite3 ABI**：Electron 打包由 `scripts/build-desktop-target.cjs` 执行 `@electron/rebuild` 并经 `scripts/verify-abi.cjs` 校验。运行 `npm test` 时，`pretest` 会自动调用 `scripts/ensure-node-sqlite.cjs` 探测并修复 Electron/Node ABI 差异；如需手动切回系统 Node ABI，执行 `cd server && npm rebuild better-sqlite3`。依赖已锁定 `better-sqlite3 ^12` 以规避 Node 24 worker teardown 崩溃。
- **代码约定**：全仓 TypeScript + ESM（`"type": "module"`），`server/` 内 import 使用 `.js` 扩展名（`moduleResolution: bundler`）；`electron/` 打包为 CJS。改动前必读目标模块头注释；后端测试优先算法层 + 内存 mock。已知技术债：`server/scripts/e2e-integration-test.ts` 端口硬编码 `4123`；`electron-builder.config.cjs` 的 `appId` 不可轻改。

## 交付前核对

1. 本地跑通 `npm run check`；涉及前端/桌面交互的改动完成真机实测。
2. 新增数据表或列已完成 `applyAdditiveMigrations()` 与 `getCreateTablesDDL()` 双登记。
3. 改动契约、路由、端口或配置段时同步更新 `AGENTS.md`、`CLAUDE.md` 与对应 `docs/` 文档。
4. 确认提交中无真实凭据、临时日志或未清理测试产物。
