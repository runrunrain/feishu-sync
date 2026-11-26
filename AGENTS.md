# AGENTS.md

本文件是 `feishu-sync` 仓库面向所有编码代理与协作者的统一工程契约。改动代码、配置、脚本或文档前先核对本文件；细则与专题说明见 `docs/`，设计动机以各模块头部注释为准。Claude Code 专属速查与核对清单见 [CLAUDE.md](./CLAUDE.md)。

## 项目定位与当前形态

`feishu-sync` 是跨平台桌面应用，把飞书知识库子树定时检测并选择性同步为本地 Markdown 与 Excel 原件，同时提供自定义归档、Agent 标准知识库工作台、只读 MCP 服务（本机 HTTP、WSL 桥接、可信局域网）、标准库文档导出与内网网页分享，以及 `feishu-sync` CLI。

- **进程分层**：桌面态由 Electron 主进程经 `utilityProcess.fork` 托管 Hono 业务后端（`electron/server-process.ts`），HTTP、SQLite、工作簿解析与 Agent 工具不占主进程 UI 线程；唯一反向回调是 `vision` 图片裁剪（`utilityProcess` 无 `nativeImage`，经消息通道回主进程执行）。独立模式（`dev:all` / `node server/dist`）直接运行同一套 Hono 后端。
- **双包结构**：根目录承载 React 前端（`src/`）、Electron 壳（`electron/`）与构建工具链；`server/` 承载 Hono 后端、业务模块、Agent/KB/MCP/CLI 源码与服务端测试。根目录运行依赖留在 `devDependencies`，桌面打包仅收集 `server/node_modules/**`，不迁移 monorepo。

## 协作边界与安全红线

以下红线不可妥协：

1. **零飞书凭据**：代码与配置中不得出现飞书 token、`app_id`、`app_secret`；全部飞书读写委托 `lark-cli` 的 user 认证态。`larkCliPath` 已从配置移除，发现仅走 PATH 与桌面目录，部署级逃生口仅保留环境变量 `LARK_CLI_PATH`。
2. **明文模型密钥不入库**：应用内模型提供商的 `apiKey` 按既有架构明文存于 `config.json`（含 `_warning` 提醒，加密延后）。不得提交真实 `config.json` 或任何密钥。
3. **测试隔离用户数据**：跑测试或调试脚本一律设置独立 `FEISHU_SYNC_HOME`，不触碰真实 `~/.feishu-sync/` 与正式知识库。真实模型 fixture 与生产资料分开记录。
4. **前端改动真机验证**：界面与交互修改须在真实浏览器或 Electron 中实测，不能只用 API 或单元测试替代。
5. **发布身份不可轻改**：`electron-builder.config.cjs` 中的 `appId`、产物命名规则与更新 feed 保持现状，避免破坏存量安装包的更新识别。
6. **改动前先读头注释**：核心模块（尤其 `sync-engine.ts`、`local-map-store.ts`、`config-manager.ts`、`kb-build-service.ts`）头部记录了大量实测结论与历史教训，先读懂原因再改，不凭直觉重写。

## 常用命令

依赖需在根目录与 `server/` 分别安装：

```bash
npm install
cd server && npm install && cd ..
```

### 开发

```bash
npm run dev          # 仅前端（Vite，:5173）
npm run server:dev   # 仅后端（先构建 share-render.cjs，再 tsx watch :3001）
npm run dev:all      # 前端 + 后端并行（浏览器联调，非 Electron）
npm run dev:desktop  # 编译 server/dist 与 dist-electron 后并行启动 Vite + Electron
```

### 构建与打包

```bash
npm run build:all             # vite build + server tsc + build-agent-assets
npm run electron:build        # esbuild 输出 dist-electron/{main,preload,server-process-entry}.cjs
npm run desktop:dist:win:x64  # Windows NSIS 安装包
npm run desktop:dist:mac:arm64
npm run desktop:dist:mac:x64
# macOS 对外正式包（Developer ID 签名 + Apple 公证）：在对应 mac 命令后加 :release
# macOS 本机一键打包脚本：./build.command
```

`server:build` 同步执行 `server/scripts/build-agent-assets.mjs`：
- 复制 `prompts/`、角色卡（`roles/`）、Pi 转发扩展（`pi-extension/`）、`claude-bridge.cjs`、补丁目录（`patches/`）、CLI Skill（`cli/skills/`）以及 `agent/skills/knowledge-build/`（缺失时 `pi-amagi` 构建拒绝启动）。
- 构建静态分享渲染器 `server/dist/share-render.cjs`。
- 用 esbuild 打出 4 个零原生依赖单文件 CJS：`dist/mcp/kb-mcp.cjs`、`dist/mcp/kb-mcp-gateway.cjs`、`dist/mcp/kb-mcp-http-bridge.cjs`（配 `kb-mcp-wsl.cmd`）、`dist/cli/feishu-sync-cli.cjs`。
- 维护内置 `amagi-pi` 快照至 `dist/agent/bundled-amagi`（`desktop:dist:*` 会拉取远端最新 `amagi-pi` 并回写冻结包 `server/bundled/amagi-pi/`；开发与 CI 不联网，使用同级源码或检入冻结包，见 `docs/build-operations.md`）。

### 质量门禁与测试

```bash
npm run check          # lint + typecheck + 前端与服务端全部测试（CI 同口径）
npm run lint           # eslint（flat config，保持 0 error）
npm run typecheck      # 根 src + 根配置 + server 三段 tsc --noEmit
npm test               # 前端 vitest（src/**/*.test.{ts,tsx}）
npm run test:all       # 前端 + 服务端全部测试
npm run format:check   # prettier 检查（渐进采纳，不做全仓格式化）
```

服务端单测（在 `server/` 下执行）：

```bash
npm test                                    # 先构建 share-render.cjs 再全量跑 vitest
npx vitest run tests/sync-engine.test.ts    # 单文件
npx vitest run -t "sheet header"            # 按用例名筛选
npm run test:migrations                     # migration-v5 专项
npm run typecheck                           # server tsc --noEmit
```

CI（`.github/workflows/ci.yml`）单独安装 `@earendil-works/pi-coding-agent` 后经 `FEISHU_SYNC_PI_CLI` 拆跑 `pi-plugin-service.test.ts` 与 `pi-native-work.test.ts`，不把 Pi 包写入仓库依赖树。

### 正式知识库回填（独立脚本）

```bash
cd server
npx tsx scripts/sync-latest.ts --skip-index          # dry-run：不提交 KB 正文，仍写配置/SQLite/报告
npx tsx scripts/sync-latest.ts --skip-index --apply  # 提交 KB 正文，仅执行 create / replace
```

- 已有 `config.json` 默认只读，改写配置须加 `--persist-config`；配置缺失时会首次创建。
- 知识库根目录解析顺序：`--kb <绝对路径>` → `FORMAL_KB` → `config.json` 的 `knowledgeBaseRoot`。新机器首次运行须至少提供其一。
- 未传 `--apply` 也会初始化或迁移 SQLite 并推进 `observed` 检测状态，操作真实数据目录前须先备份。

## 进程、端口与鉴权契约

### 进程与端口

| 服务 | 监听地址 / 端口 | 说明 |
| --- | --- | --- |
| Electron 内嵌后端 | `127.0.0.1:0`（系统分配） | 主进程拿到 `startedServer.url` 后经 preload 注入前端；前端唯一请求出口是 `src/api/client.ts` |
| Standalone 后端 | `127.0.0.1:3001` | `npm run server:dev` / `dev:all` / `server:start` |
| Vite 开发前端 | `localhost:5173` | 仅开发态 |
| 本机 HTTP MCP | `127.0.0.1:47392/mcp` | 桌面态启动；`allowStandaloneKbMcp`（默认开）决定退出托盘后是否保持独立监听；`.agents`、WSL 版 Claude Code 和 WSL 版 Codex 的 stdio 桥接复用此端口，旧 HTTP 会话失效时重新握手并重试只读调用一次 |
| 局域网只读 MCP | `47391`（可配） | `kbLanMcp.enabled` 默认关；仅限可信私网，明文 HTTP |
| 标准库内网网页分享 | `47393` | 独立端口，排除 Hyper-V / WSL / Docker / VPN 等虚拟网卡 |

### 四令牌域与路由挂载顺序

四个令牌域互不接受对方令牌（细节见 `docs/security-model.md`）：

| 令牌域 | 请求头 | 校验规则 | 职责范围 |
| --- | --- | --- | --- |
| Desktop | `X-Desktop-Token` | `middleware/auth.ts`（timing-safe + Origin/Referer，仅 `desktopMode=true` 挂载） | 全部业务 API 与管理面（含 `/api/cli/enable\|token/rotate\|info\|install-shim\|remove-shim\|skill/*`、`cli.*`/`llm.*`/`agent.workspaces`/`feishuWrite`） |
| CLI | `X-Cli-Token` | `middleware/cli-auth.ts`（回环 Host + 拒 Origin + timing-safe） | `/api/cli/:command` 命令执行；不进 `/api/agent-internal/*`，不可访问 desktop 管理面 |
| Agent 运行 | `X-Agent-Run-Token` | `routes/agent-internal.ts`（回环 Host + 拒 Origin + 内存上下文表） | 外部 Pi / Claude 侧车回调服务端工具 |
| LAN MCP | `Authorization: Bearer` | `kb-lan/http-gateway.ts`（私网 CIDR + 拒 Origin + 摘要比对，连续 401 达阈值封禁 5 分钟） | 局域网只读 20 工具 |

`server/src/index.ts`（`buildServer()`）的挂载顺序不可打乱：
1. `app.use('*')` 将全部模块实例挂到 Hono context 属性（`(c as any).configManager` 等，非 `c.env`），路由一律从 context 取依赖，不自行 `new`。**该注入中间件必须位于 `authMiddleware` 之前**。
2. `/api/health` 永远公开且最先注册。
3. `agentInternalRoutes`、`cliAdminRoutes`、`cliRoutes` 依次注册在 `authMiddleware` 之前；其中 `cliAdminRoutes` 须在 `cliRoutes` 之前注册，避免被 `/api/cli/*` 的 CLI 令牌中间件拦截。
4. `authMiddleware` 之后挂载其余业务路由（共 23 个路由文件，前缀在各路由文件内定义，以 `app.route('/', xxxRoutes)` 挂载）。
5. **CORS 开关**：`CORS` 开发放行由显式 `CreateServerOptions.corsDevMode` 驱动，不由 `desktopMode` 推导。`dev:all` 与 Electron 生产态均为 `desktopMode=true`，但只有前者放行 `localhost:5173`。改 CORS 前先读该字段注释。
6. **失效 scope 清理**：`RETIRED_REQUEST_SCOPES`（`config-manager.ts`，当前含 `docs:document:read`）在配置加载迁移与 device flow 发起前都会剔除，防止上游失效 scope 导致整单授权被拒。

## 核心业务不变量

### 同步流水线与写盘安全

- **检测与同步分离**：`ChangeDetector`（`change-detector.ts`）遍历飞书知识库子树并对比 `observed_obj_edit_time`，检测**只推进 `observed` 字段**。`SyncEngine`（`sync-engine.ts`）按 `分型读取（docx / sheet / slides）→ 媒体解析与下载 → 本地引用重写 → staging 原子提交 → 推进 synced 基线` 执行。
- **不可破基线契约**：只有 staging 原子提交成功后，才推进 `synced_obj_edit_time` 并置为 `synced`。任一资源缺失、媒体下载失败或提交异常均不推进基线。
- **写盘默认 dry-run**：`SyncOptions.apply` 默认 `false`；落盘须同时传入 `apply: true` 与 `confirmation: 'APPLY'`。`move`、`delete`、路径冲突、父链不完整、未知类型、无权限以及未写回的本地源编辑，一律保留为带 `reasonCode` 的 blocker，绝不自动覆盖。
- **原子提交顺序不可重排**：`atomic-commit.ts` 严格执行 `库外 staging → 校验 → rename → DB 事务`；文件落盘后 DB 失败时从 rollback 快照恢复（用 `SyncEngineTestHooks` 验证），`assertInsideRoot` 拒绝路径逃逸。
- **并发与表格缓存**：批量同步并发上限为 2 篇，同文档与同路径互斥；表格只读重建从 `256 × 32` 窗口二分自适应，保留自动行高，单元格页缓存于 `<dataRoot>/sync-cache/`（7 天 / 128 MiB），同步耗时指标追加写入 `<dataRoot>/sync-performance.jsonl`。

### 自定义归档与双身份契约

文档归属只有两条互斥通道，`custom_folder_id` 与 `watched_root_url/id` 不得并存，冲突时结构树所有权优先：
- 结构树成员绑定 `watched_root_*`，走检测与同步全链路；归档文档绑定 `custom_folder_id`，落盘在 `_custom/<文件夹名>/`，归档变更检测仅报 `modified`。
- 全量重建通过 `IndexScanner.reconcileCustomFolders` 与 `LocalMapStore.backfillCustomFolders` 纳管手工放入 `_custom/<子目录>/` 的带头 `.md`（`_custom/` 根散档与保留目录除外）。
- **回填不清 `wiki_node_token`**（upsert 的 COALESCE 会写回头部解析值，归档检测也依赖它核对云端身份）。飞书树两处出口（`getTreeDetailed` 飞书视图与 legacy `getTree`）均须以 `customFolderId IS NULL` 过滤归档行，不能仅凭 `wiki_node_token` 判断。

### LLM 多协议与 direct 通道

- `content-backend.ts` + `direct-channel.ts` 保留 `ChannelName = 'direct'` 单通道，按所选提供商协议分别走 `openai-completions`、`openai-responses` 或 `anthropic-messages`（OpenAI SDK 与 Anthropic SDK，支持流式与思考强度）。
- 初始配置不预置提供商、模型或密钥；`contentAdaptationEnabled` 默认关闭。`getFallback()` 恒为 `null`，风格对齐失败不抛异常，返回 `finishReason='error'|'timeout'` 并回退确定性重构结果。默认超时 `600_000` ms（10 分钟）。

### Agent 标准知识库工作台与构建编排 v2

设计基线见 `docs/design/agent-knowledge-design.md` 与 `docs/design/kb-agent-upgrade-design.md`，运行细则见 `docs/build-orchestration.md` 与 `docs/agent-knowledge.md`。`server/src/agent/`、`kb/`、`mcp/`、`kb-lan/`、`sources/`、`ops/`、`cli/` 独立于原同步流水线，不把 Pi 接入 `ContentBackend` registry，也不为 Pi 升级 Electron。

- **唯一配置入口为 Pi**：设置页仅暴露 Pi 运行时，`agent.runtime.backend` 归一为 `pi`，启动时自动迁移旧的应用级 Claude Code 配置；已有会话仍沿用 `agent_sessions.runtime_backend`（Claude Code 兼容层见 `docs/claude-runtime.md`）。Windows 桌面版为应用管理的 Pi 注册用户 PATH 入口。
- **Pi 侧车与插件边界**：经外部 Node ≥ 22.19 与 `@earendil-works/pi-coding-agent`（≥ 1.4、< 2）以 JSONL RPC 启动。内置转发扩展只调回环内部 API，工具集与能力令牌全部由服务端单点裁决。Discuss 只读；Work 在授权 Workspace 内无内置 shell（原生 Pi 插件属用户信任的 Node 代码，以当前用户权限运行，不能以路径围栏宣称其具备 OS 沙箱），并支持按会话切换本机插件资源与「从此轮分叉」。
- **构建编排 v2（`pi-amagi`）**：`standardKb.orchestrationMode` 唯一开放值为 `'pi-amagi'`。Leader 协调写作（`luban`）、独立审查（`diting`）与调研（`baize`）多角色协作；创建与恢复构建前对角色模型做只读预检（Pi 编排当前要求 `openai-completions` 协议）。epoch 换代与进程残留对账未确认即拒绝启动；构建度量写入 `kb_builds.metrics_json.orchestration`。
- **进程池三通道**（`agent-process-pool.ts`）：`session` 立即准入（池满返 409 `agent_busy`，M ≥ 2 时至少保留 1 槽）；`background`（任务进程、连接探测）上限 `M - 1`（`agent.maxConcurrentProcesses`，1–6 默认 3）；`build` 走独立通道，上限 `N = standardKb.buildConcurrency`（1–6 默认 2，兼容读旧名 `buildParallelism`），总运行上限 `N + M`。`background` 与 `build` 均 FIFO 排队。
- **原始源与发布契约**：原始源以成功本地版本与内容/媒体哈希为准，不因 `status != synced` 或 `cloudDeleted` 观测误删仍存在的源；CSV 附件与主文档同围栏。标准库采用 `staging 校验 → 不可变 release → 原子切换 CURRENT.json`，提交后 DB 异常按文件指针对账，清理异常不得删除当前 release，**不可套用原同步引擎“DB 失败回滚文件”的语义**。
- **会话历史与 SSE**：历史真相在 `<dataRoot>/agent/sessions/*.jsonl`（pi v3 树形日志），沿当前叶回溯全部节点，元数据节点不能截断历史；状态只按权威事件推进，不用“请求停止”冒充完成。
- **图片理解与任务编排**：`agent/vision/` 默认关闭，结果按内容寻址缓存于 `<dataRoot>/agent/vision-cache/`，单张失败或关闭不阻断构建；`agent/tasks/` 与内置三角色卡（`kb-analyst` / `kb-converter` / `kb-reviewer`）的子任务工具集为 `角色请求 ∩ 父会话工具集`，永不授予 `task_*` 与 `app_command`。
- **MCP 与内网分享**：本机 HTTP MCP（`127.0.0.1:47392/mcp`）、WSL 桥接（`feishu-kb-wsl`）与局域网 MCP（`47391`）共用 20 个只读工具，均无 SQLite 依赖，只读已发布标准库与原始库清单。标准库导出与内网网页分享由 `routes/kb-distribution.ts` 与 `kb/web-share.ts` 承载，快照落盘在 `<dataRoot>/agent/web-shares/`。
- **CLI 与 `app_command` 批准流**：`ops/command-table.ts` 维护 40 条统一命令表，CLI 与 `app_command` 共用，HTTP API 仍是唯一业务契约。`cli.enabled` 默认开启，端点文件发布于 `<dataRoot>/run/endpoint.json`（0700/0600，tmp+rename，pid 匹配才可撤销）。`app_command` 的 `read` 级直通，`mutate` / `destructive` / `remote_write` 逐次经会话批准，模型传入的 `confirm`/`confirmation` 字段一律剔除，批准严格绑定服务端运行轮次。CLI / `app_command` 禁改 `cli.*`、`kbLanMcp`、`llm` 密钥面、`agent.workspaces`、`feishuWrite`、`feishuPublish`。

### 原始库受控写与写回飞书

- **三写者不变量**：原始库正文只允许三类受控写者改动——`SyncEngine`（云端→本地）、源生命周期操作（回收站、源清理、孤立清理，只移删不改正文）、`SourceEditService`（用户或经批准的 `app_command source.*`）。`feishu_sync` 头部字节只由 `SyncEngine` 生成。
- **写锁与阻断**：`SourceEditService` 加 `objToken` 级进程内互斥锁，按 baseHash OCC 校验并保全原头字节（写后重读 `parseMetadata` 逐字段复核，失配自动回滚备份），同步留存备份与审计。`source_edits` 存在非 `pushed` 行时，同步、回收站与清理一律以 `local_edit_pending` 拒绝，绝不覆盖。
- **写回飞书**：`FeishuWriteService` 默认关闭（`feishuWrite.enabled: false`），经 `lark-cli docs +update` 与增量权限 `docx:document:write_only` 按 `fetch → 写 → 回读校验` 三段式写回（不重试旧 revision），**不推进任何 `synced` 基线**，成功后单文档回拉收敛。

## 数据层与 Header 契约

- **数据目录**：默认 `~/.feishu-sync/`（含 `feishu-sync.db` 与 `config.json`），设置 `FEISHU_SYNC_HOME` 可整体改根（服务端与桌面共享，不是 Electron `userData`）。
- **SQLite（22 张表）**：`LocalMapStore` 使用 `better-sqlite3 ^12` 同步 API 与预编译语句。全表清单见 `docs/data-contract.md`。启动时 `applyAdditiveMigrations()` 用 `PRAGMA table_info` 守卫原地升级。**新增表或列必须同时登记在 additive 迁移数组与 `getCreateTablesDDL()` 两处**；`server/scripts/migration_v2..v5` 仅作历史参考。
- **配置真相源**：`watchedRoots` 是监听根真相源，`watchedRootUrls` 为内存派生兼容投影，不落盘，不可直接改投影。Workspace 与原始库、标准库、数据根及受保护运行根双向隔离，改任一路径都须触发反向交叉校验。
- **Markdown Header round-trip**：
  - 原始库头由 `SyncEngine.generateHtmlHeader` 写入、`IndexScanner.parseMetadata` 读取，采用文件首部 YAML-in-HTML-comment（`feishu_sync:`），并兼容 `legacy_html_zh`、`blockquote`、`bold_kv` 三种历史格式。改字段须两端同步并补 round-trip 测试（`tests/sync-engine.test.ts`）。
  - 标准库头使用独立 `feishu_sync_kb` YAML-in-comment（`doc_id` / `build_id` / `sources`），不可与原始库头混用，改动须同步 `StandardKbStore.parseStdHeader/stripStdHeader` 与 UI/MCP 读取。

## 原生模块 ABI 与代码约定

- **better-sqlite3 ABI**：打包或运行 Electron 时 `.node` 二进制须匹配 Electron ABI（`scripts/build-desktop-target.cjs` 会运行 `@electron/rebuild`，`scripts/verify-abi.cjs` 校验）。根与 `server/` 的 `pretest` 钩子已接入 `scripts/ensure-node-sqlite.cjs`，跑 `npm test` 前会自动检测并在不匹配时重建为当前 Node ABI；手动切回系统 Node ABI 可执行 `cd server && npm rebuild better-sqlite3`。
- **Node 24 teardown 教训**：`better-sqlite3` 11.x 在 Node 24 上有 worker teardown 崩溃缺陷，现已锁定 `^12`；再遇类似 worker 静默退出先核对原生模块版本矩阵。
- **TypeScript 与模块制式**：前后端源码均为 ESM（`"type": "module"`），`server/` 内 import 带 `.js` 扩展名（`moduleResolution: bundler`）；`electron/` 经 esbuild 输出 CJS（`dist-electron/*.cjs`）。
- **测试风格**：后端测试优先算法层 + 内存 mock（参考 `change-detector.test.ts`、`sync-engine.test.ts`），减少原生模块耦合。
- **已知技术债**：`server/scripts/e2e-integration-test.ts` 端口仍硬编码为 `4123`；`electron-builder.config.cjs` 的 `appId` 占位值不可随手改动。

## 文档索引与交付核对

- 专题文档总引：[docs/README.md](./docs/README.md)（架构、开发、测试、数据契约、运维、安全模型、构建编排、CLI、MCP、网页分享、故障排查）。
- 用户说明与变更记录：[README.md](./README.md)、[CHANGELOG.md](./CHANGELOG.md)、[CONTRIBUTING.md](./CONTRIBUTING.md)。

提交或交付前逐项核对：
- 运行 `npm run check` 全部通过（涉及前端或桌面行为时补做真机交互验证）。
- 新增表或列已完成 `applyAdditiveMigrations()` 与 `getCreateTablesDDL()` 双登记。
- 涉及 header、路由顺序、令牌域或配置段变更时，同步更新 `docs/`、本文件与 [CLAUDE.md](./CLAUDE.md)。
- 确认无真实 `config.json`、API Key、临时日志或过程产物混入提交。
