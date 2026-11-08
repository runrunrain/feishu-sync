# 运维与打包

## 发布打包

### 触发链（release workflow）

推送 `v*` 标签 → [release.yml](../.github/workflows/release.yml) 自动构建 macOS dmg/zip（arm64 + x64 矩阵）+ Windows NSIS exe 并发布 Release（说明从 CHANGELOG 提取；产物存在即跳过上传，支持给既有 release 补产物）。mac 双架构更新通道分离（arm64 走 `latest-arm64-mac.yml`，x64 走 `latest-mac.yml`），产物命名 `FeishuSync-*`；electron-updater generic provider 指向 `releases/latest/download/`。CI 无 Developer ID 证书，走 adhoc 签名（`DESKTOP_MAC_SIGNING=adhoc`，下载安装后需 `xattr -dr com.apple.quarantine` 解除隔离）。

### 内嵌 amagi-pi 版本与访问令牌（release workflow）

- release.yml 首个 job `amagi-ref` 用 `git ls-remote` 解析 amagi-pi 默认分支 HEAD（固定 40 位 sha，tag 停在旧版不能作判据），三个构建 job `needs` 它并共用同一 sha，一次发布内嵌的 amagi-pi 版本一致；构建后各 job summary 回写内嵌版本/commit/来源。
- 仓库 Settings → Secrets and variables → Actions → Secrets 新增 `AMAGI_PI_TOKEN`：fine-grained PAT，仅授予 `runrunrain/amagi-pi` 的 Contents: Read-only。令牌只经 `GIT_CONFIG_*` 环境变量注入 git，不进命令行与日志。未配置时 `amagi-ref` 发 `::warning::` 并输出空 ref，构建内嵌检入冻结包（见下）。配置了令牌但 ls-remote 失败则发布直接失败，不静默田检入旧版。
- 可选 Variables 新增 `AMAGI_PI_REQUIRE_LATEST=1`：取不到远端最新时发布构建失败（对「必须内嵌最新」的发布门要求）。
- 本机构建（`npm run desktop:dist:*`）默认同样自动取远端最新（用本机 git/gh 凭据）：`AMAGI_PI_LATEST=0` 显式关闭，`AMAGI_PI_USE_BUNDLED=1` 强制检入冻结包（离线构建）；其余构建（dev、`server:build`、CI 测试）不联网。
- 刷新检入冻结包：`cd server && npm run build && npm run amagi:refresh`（远端最新链路、禁止降级与主版本门检见 [build-operations.md](./build-operations.md) §6）。

### 本地打包命令

```bash
npm run desktop:dist:win:x64        # Windows NSIS
npm run desktop:dist:mac:arm64      # Apple Silicon（adhoc 签名）
npm run desktop:dist:mac:arm64:release  # 正式分发（Developer ID + 公证，需证书）
npm run desktop:dist:mac:x64:release    # 同上，Intel
```

macOS 一键脚本：`./build.command`（按本机架构自动选）。

### 发布不可变约束（改前必读）

- **不改** `appId`（`com.yourcompany.feishu-sync` 占位但已随历史安装包发布——改 appId 会让已装用户的应用失去更新识别）、产物命名 `FeishuSync-*`、更新 feed（generic → GitHub Releases）、`server/package.json` 打包字段。
- 版本推进：合入 main 后按 Keep a Changelog 在 CHANGELOG 顶部归档，`npm version <patch> --no-git-tag-version`，打 `v*` 标签推送。
- 打包后验证 better-sqlite3 ABI：`npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/verify-abi.cjs`（必须由 Electron 执行，不能以系统 Node 代替）（build-desktop-target.cjs 已自动跑 @electron/rebuild）。

## 正式知识库回填（独立脚本，不走 GUI）

```bash
cd server
npx tsx scripts/sync-latest.ts --skip-index            # 不提交KB正文；仍会写配置/SQLite/报告（dry-run）
npx tsx scripts/sync-latest.ts --skip-index --apply    # 提交KB正文，仅 create/replace
```

- 已有配置只读加载，除非显式 `--persist-config`。
- 正式知识库根目录解析顺序：`--kb <绝对路径>` → `FORMAL_KB` 环境变量 → 已有 config.json 的 `knowledgeBaseRoot`；首次运行需显式指定其一。
- move/delete/路径冲突/父链不完整/未知类型/无权限保留为 blocker，绝不自动覆盖。
- 正式运维还应保留 operation manifest 与备份；恢复时同时还原知识库、SQLite 和配置。
- 运维 npm 入口（server/）：`npm run audit:corpus` / `backup:state` / `reconcile:dry-run` / `reconcile:apply` / `migrate:v5`。

## server/scripts 脚本风险分级

> 这是保守的操作风险目录，不是执行授权。`verify`、`test`、`debug` 命名不证明只读；例如 verify-media-gap 会 initialize SQLite，gate5 包含 apply。未逐项证明隔离的历史探针按高风险处理，执行前核对路径、配置加载与写入调用，先备份。`lib/` 下的 `kb-eval-*`、`build-fidelity-*`、`mcp-bundle.mjs`、`cli-bundle.mjs`、`bundled-amagi.mjs` 是被引用的库文件，不独立执行。

### L1 只读/诊断入口（可写报告或临时文件，仍需核对参数）

| 脚本 | 用途 |
|------|------|
| `audit-knowledge-base.ts` | 知识库一致性审计（npm `audit:corpus`） |
| `debug-path.ts` / `debug-sheet-info.ts` | 路径/sheet 调试探针 |
| `probe-spawn-stdin-paths.ts` | 子进程 stdin 路径探针 |
| `build-metrics-report.ts` | pi-amagi 构建度量只读报告：读 `kb_builds`（sqlite readonly）与构建权威落盘记录，打印人读摘要；不写文件、不回填旧构建（见 [build-operations.md](./build-operations.md)） |
| `kb-eval.ts` | 检索评测 E0 离线评估器：无数据库/模型/API 访问、不写输入 release（见 [kb-evaluation.md](./kb-evaluation.md)） |
| `preview-sheet-workbook.ts` | 本地起 vite server 预览 xlsx 工作簿渲染；无生产配置/数据库/云端写入 |

### L2 默认不提交知识库正文 / 需真实服务或模型（状态与报告仍可能写入）

| 脚本 | 用途 |
|------|------|
| `sync-latest.ts` | 有状态回填：默认不提交KB正文，但可创建配置、初始化/迁移SQLite、更新observed及写报告；真实目录先备份 |
| `reconcile-knowledge-base.ts` / `reconcile-apply.ts` | 映射核对/回填（`--apply` 前不改库） |
| `kb-lan-bench.ts` | LAN MCP 基准测试：对运行中的 MCP 端点发起真实查询负载（token 仅经 `FEISHU_KB_TOKEN` 等环境变量，不走 argv）；见 [kb-lan-mcp.md](./kb-lan-mcp.md) |
| `probe-build-runtime.ts` | v2 构建运行时端到端 probe：真实 pi + amagi + 子任务 MCP 桥，默认本地 fixture 模型驱动；`--real-model` 显式可选（真实端点+额度）；默认报告写 `agent-outputs/workflow/build-runtime-v2/live-probe-report.md`（见 [build-operations.md](./build-operations.md)） |
| `verify-channel-test-timeout.ts` | `/api/llm/test-channel` 超时验证：启动 standalone server（端口 3099）并可能打到真实 provider |
| `verify-direct-config-fix.ts` | direct-channel 401 修复验证：**直接读取真实 `~/.feishu-sync/config.json`** 走迁移路径并发起真实 LLM 请求——运行前先隔离/备份生产配置 |
| `verify-media-gap.ts` | media-gap 检测验证：真实 config/DB/lark-cli 跑一次 full detect（会 initialize SQLite、推进 observed 状态），不写知识库文件 |
| `verify-sheet-workbook.ts` | 工作簿导出只读验证：真实 lark-cli 拉 sheet 并渲染 xlsx，仅写显式指定的 --output 新文件 |
| `agent-real-model-smoke.ts` | 显式真实模型验证；创建临时raw/config/SQLite/会话与Workspace并触发真实写入/构建、消耗模型额度；必须先给新临时FEISHU_SYNC_HOME，禁止指向生产目录 |

### L3 直接写数据/高风险操作

| 脚本 | 用途 |
|------|------|
| `backup-operation-state.ts` | 运行状态备份（写备份文件） |
| `repair-media-gaps.ts` / `resync-one-doc.ts` / `retry-slides.ts` / `sync-troop-unit-cell.ts` / `canary-atomic-commit.ts` | 定向修复/重同步/金丝雀——直接操作知识库与 SQLite，使用前先备份 |
| `migrate-kb-structure.mjs` | KB 结构迁移（历史） |
| `verify-*`（历史探针）/ `test-fetch.ts` / `test-sheet-export.ts` | 历史验收探针，不能统一视作只读：部分初始化数据库、加载或迁移用户配置、执行同步或写临时文件；只有逐脚本验证隔离后才运行 |
| `gate2-closeout.ts` / `gate5-live-shadow-canary.ts` | 内含文件/SQLite 写入与 apply，不可假定运行前还有确认门 |
| `smoke-custom-folders.mjs` | 会创建隔离 home、配置与目录并通过接口操作；先核对隔离参数，不能用于生产目录 |

### 文件级历史参考（不执行）

`migration_v2..v4.sql`、`run-migration-v2/v3/v4.mjs`、`run-migration-v5.ts`（v5 有专项测试 `test:migrations`）、`run_migration_v2.py`、`update_doc_mapping.py`、`e2e-integration-test.ts`（端口硬编码 4123，已知技术债）、`verify-custom-docx-write.mjs`（历史写入验证）。这些文件保留作参考，不因本分组而获得运行许可。`reconcile-apply.ts` 的 operationDirectory 仍直接取 home，未完全沿 FEISHU_SYNC_HOME；在隔离环境运行前需额外审查。

## Agent 工作台验证与打包

- `npm run server:build` 除tsc外，还运行`server/scripts/build-agent-assets.mjs`：复制内置prompts/转发扩展/角色卡/skill包，借`server/scripts/lib/`esbuild 打包 3 个 CJS（`dist/mcp/kb-mcp.cjs`、`dist/mcp/kb-mcp-gateway.cjs`、`dist/cli/feishu-sync-cli.cjs`），并维护内置 amagi 依赖快照——`server/bundled/amagi-pi/` 冻结 `package.zip`+`manifest.json`（来源链：`AMAGI_PI_SOURCE_DIR`/`AMAGI_PI_USE_BUNDLED` → `AMAGI_PI_LATEST=1` 远端最新（桌面安装包构建自动启用）→ 同级 `../amagi-pi` → 冻结包，见 `scripts/lib/amagi-source.mjs`；刷新冻结包用 `npm run amagi:refresh`），构建时安装到 `dist/agent/bundled-amagi`。写面为 server/dist/** 与 server/bundled/amagi-pi/，不修改用户资料。
- 桌面版业务 server 运行在 Electron utilityProcess（见 [architecture.md](./architecture.md) 进程契约）；pi使用外部Node≥22.19。安装包需核对asarUnpack后的扩展/prompts/MCP/CLI路径，以及外部运行时的实际发现结果；原生SQLite ABI构建成功不等于桌面运行验证成功。
- **CLI 默认开启**（`cli.enabled` 缺省 true，0.4.2 起）：应用运行时自动发布 `<dataRoot>/run/endpoint.json`；设置页可显式关闭（关闭后不再发布端点，CLI 报退出码 3=应用未运行/不可达）。完整命令、风险级与 `--yes` 约定见 [cli-reference.md](./cli-reference.md)。
- CLI 打包形态：应用内「设置 → 应用 → 命令行访问 → 安装命令行工具」经 `/api/cli/install-shim` 写 `<dataRoot>/bin/feishu-sync`（POSIX 0755）与 `feishu-sync.cmd`（Windows）——打包版 shim 以应用 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1` 调起 cli.cjs，开发版用当前 Node。CLI 只调运行中的 server（读 `<dataRoot>/run/endpoint.json`），无离线直写。
- MCP可用独立外部Node运行，不应为连接MCP重编译SQLite。仅使用完整已发布目录；不要把.builds/.staging当知识库，也不要手改CURRENT或已发布正文。
- 局域网 MCP 运维（watchdog、独立 Bearer、回环默认、封禁策略）见 [kb-lan-mcp.md](./kb-lan-mcp.md)；反向发布流程见 [feishu-publish.md](./feishu-publish.md)；源云端历史/回滚/移出操作见 [source-cloud-operations.md](./source-cloud-operations.md)；构建运维与度量见 [build-operations.md](./build-operations.md)。
- 真实模型smoke不是普通单测，需显式授权额度，且只使用脚本自建的无敏感fixture。POSIX shell示例（在server/）：

```bash
FEISHU_SYNC_HOME="$(mktemp -d)" npx tsx scripts/agent-real-model-smoke.ts
```

认证交给pi的显式pi-agent-dir模式；不要复制真实应用配置/DB或打印pi auth/models文件来运行验证。成功会清理临时资料，失败保留现场供诊断；保留或分享日志前仍须核对隐私。真实提供商兼容性、目标平台进程回收和桌面运行需独立记录，不能用协议fixture或浏览器成功替代。

## CI / 质量门禁

- push(main)/PR → [ci.yml](../.github/workflows/ci.yml)：lint → typecheck → 双包测试（pi integration 单独拆步，见 [testing.md](./testing.md)）→ 构建冒烟。
- 发布链（release.yml）与质量门禁（ci.yml）分离：前者只在 tag 触发。

## 归档说明

仓库根历史一次性报告与审查状态文件已移至 `docs/reports/archive/`（2026-10 工程治理）；同步产物空壳（`server/400-*.md`）已删除，见 `docs/reports/archive/engineering-governance.md`。
