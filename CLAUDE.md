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
# 注：server build 同时运行 build-agent-assets.mjs —— 复制 prompts/转发扩展，
# 并 esbuild 打包独立 MCP（server/dist/mcp/kb-mcp.cjs）与 CLI 客户端
# （server/dist/cli/feishu-sync-cli.cjs，随 asarUnpack server/** 解包）。

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

### Agent 标准知识库工作台（开发分支，未发版）

- 先读 `docs/design/agent-knowledge-design.md`（基线）与 `docs/design/kb-agent-upgrade-design.md`（2026-10 升级增补），使用说明在 `docs/agent-knowledge.md`；`server/src/agent/`、`kb/`、`mcp/`、`sources/`、`ops/`、`cli/` 独立于既有同步/整理流水线。不要把 pi 接入 ContentBackend registry，也不为 pi 升级 Electron。
- pi 经外部 Node≥22.19、pi≥1.4/<2 的 JSONL RPC 启动。应用自身的转发扩展只调用回环内部API；服务端裁决工具集与能力令牌。应用自带的Discuss工具只读，Work不提供shell。显式添加的原生Pi插件是受用户信任的Node代码，以当前用户权限运行；不能用宿主工具围栏宣称它们具备OS沙箱。
- Workspace 与原始库、标准库、数据根、完整应用代码/依赖、Node/pi运行资源和凭据根隔离；配置变更要做反向交叉验证，不能只在登记目录时校验。文件围栏不是同uid/外部自动执行器的OS沙箱。
- 原始源以成功本地版本和hash为准，不能仅筛status=synced，也不能因cloudDeleted观测而删仍存在的源；CSV附件与主文档同围栏，源变化须阻断构建，模型skip不能绕过。
- 标准库先staging校验，再生成不可变release、原子切CURRENT；提交后DB异常按指针对账，清理异常不得删除current release。不要把原同步引擎的“DB失败回滚文件”套在此处。
- 会话历史真相在pi JSONL树，元数据节点不能截断回溯；SSE message_end必须是完整DTO，初始0游标、溢出resync、工具多轮与停止ACK竞态都需实际流回归。状态只能按权威事件推进，不用“请求停止”冒充完成。
- Pi插件以原生package为单位，由正式CLI安装/更新/移除，SDK解析manifest与资源；仅管理应用agent/pi-home。knowledge-workbench内置包包含对话/Work/构建/文风/任务编排配置项。运行期只显式加载应用启用的资源，通用Pi认证经Pi只读存储复用，不复制密钥。插件包变更须拒绝活跃任务并回收空闲进程，本地插件源码也受Workspace保护。
- `server/scripts/build-agent-assets.mjs` 随server build复制prompts/转发扩展并生成独立MCP CJS；MCP只读已发布文件，不导入SQLite。测试一律临时FEISHU_SYNC_HOME；真实模型fixture与真实生产资料严格分开记录。

#### 2026-10 升级增补（kb-agent-upgrade S0–S14 已合入）

- **双模型与并行构建**：`agent/vision/`（VisionChannel/VisionDescriber，内容寻址缓存 `<dataRoot>/agent/vision-cache/`；配置 `agent.vision` 缺省 disabled，失败不阻断构建、图片标 unavailable + 构建警告）。`kb/build-units.ts` + `kb/path-claims.ts` + `kb/source-images.ts` 支撑多 worker 并行构建：`standardKb.buildParallelism` 1..6 默认 2（=1 等价旧行为）；单元内 `kb_unit_done` 上报，`kb_finish` 仅收尾轮可用；worker 写他单元路径被 `kb_path_owned_by_other_unit` 拒绝；快照条目新增 `mediaHash`（`contentHash` 公式不变，旧 manifest 视为未变）。
- **进程池准入**（`agent-process-pool.ts`）：`acquire('session'|'background')` FIFO 排队，后台类（构建 worker/任务进程）合计 ≤ M−1（M≥2 时为交互会话保留 1 槽）；`agent.maxConcurrentProcesses` 1..6 默认 3。会话仍是立即语义（满 → 409 agent_busy）。
- **任务编排**（`agent/tasks/` + `agent/roles/`）：`task_submit/query/resume/cancel` 工具与 `agent_tasks` 表；三张内置角色卡（analyst/converter/reviewer）；子任务工具集 = 角色请求 ∩ 父会话模式工具集，永不获得 `task_*`/`app_command`；跨会话任务归属校验；开关是 knowledge-workbench 内置插件的「任务编排」条目（默认停用）。
- **CLI 与运维命令面**：`ops/command-table.ts` 30 条命令表，CLI 与内部 Agent 工具 `app_command` 共用（HTTP API 仍是唯一业务契约）。CLI 源码 `server/src/cli/`，产物 `server/dist/cli/feishu-sync-cli.cjs`；应用内一键生成 shim `<dataRoot>/bin/feishu-sync`。开启 `cli.enabled` 后 `cli-endpoint.ts` 发布 `<dataRoot>/run/endpoint.json`（0700/0600，tmp+rename）与独立 CLI 令牌；`middleware/cli-auth.ts` 三重校验（回环 Host + 无 Origin + `X-Cli-Token` timing-safe）。**CLI 令牌与 desktop token 双向隔离**：`/api/cli/enable|token/rotate|info|install-shim` 只接受 desktop token；CLI 令牌不进 `/api/agent-internal/*`，desktop auth 域也不接受 CLI 令牌。命令表 `config.set` 对 CLI/app_command 主体禁改 `cli.*`/`llm.*` 密钥面/`agent.workspaces`/`feishuWrite`；`PUT /api/config` 对 CLI 主体（内部转发 actor 标记）丢弃 `feishuWrite`。CLI 退出码 0/1/2/3/4；destructive/remote_write 需 `--yes`。
- **app_command 批准流**（`agent/approvals/` + `agent/tools/app-command-family.ts`，工具族经 `AgentToolService.registerToolFamily()` 注册）：read 级直通；mutate/destructive/remote_write 逐次经会话内用户批准（`/api/agent/sessions/:id/approvals*` + SSE `approval_request`）；模型传入的 confirm 字段一律剔除，批准执行绑定服务端运行轮次（会话停止即取消待执行复核、拒绝跨轮操作）。
- **源库受控写与写回飞书**（`sources/`）：SourceEditService 是原始库正文第三写者（用户或经批准的 `app_command source.*`）：原 header 字节保全（写后 `parseMetadata` 逐字段复核）+ baseHash OCC + 编辑前备份 `<dataRoot>/source-edits/<objToken>/` + 审计 `agent/audit/source-edits.jsonl`；`source_edits` 表登记 dirty/pushing/pushed/conflict。**SyncEngine/回收站/源清理/孤立清理遇非 pushed 行一律 `local_edit_pending` 拒绝（blocker），绝不覆盖**。FeishuWriteService 经 lark-cli `docs +update` 三段式写回（fetch → 同流程立即写 → 写后回读校验，转义归一化层比对；stale overwrite 会静默损坏正文，绝不重试旧 revision）；写回**不推进任何 synced 基线**，成功后立即单文档回拉收敛。写权限走 `scopeSet:'write'` 增量授权（`WRITE_SCOPES=['docx:document:write_only']`，`feishuWrite.enabled` 默认关）。
- **原始库写者不变量已修订**（基线 §13.1）：正文只由登记在册的受控写者修改——SyncEngine（云端→本地）、源生命周期操作（回收站 restore/purge、源清理、孤立清理，只移动/删除不改正文）、SourceEditService；`feishu_sync` 头部字节只由 SyncEngine 生成；Agent 工具对原始库仍只有读路径，唯一写入口是经用户逐次批准的 `app_command source.*`。

### 数据层

- SQLite 在 `~/.feishu-sync/feishu-sync.db`，config 在 `~/.feishu-sync/config.json`；环境变量 `FEISHU_SYNC_HOME` 可整体改根目录（server 与 desktop 共享，**不是** Electron userData）。除 documents/sync_log/run_log 主表外还有 localDirs/custom_folders/sheet_sheets/feishu_pending_items 等辅助表，以及工作台的 kb_builds/agent_sessions/agent_tasks/source_edits（kb_builds 含 parallelism/unit_total/vision_model/warnings_json 增列），全部经 additive 迁移演进（新表/新列双登记 additive 数组 + `getCreateTablesDDL()`）。config 的工作台段：`agent`（runtime/model/vision/orchestration/maxConcurrentProcesses/workspaces）、`standardKb`（含 buildParallelism）与可选段 `cli`/`feishuWrite`（均默认关，additive）。
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
