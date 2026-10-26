# 运维与打包

## 发布打包

### 触发链（release workflow）

推送 `v*` 标签 → [release.yml](../.github/workflows/release.yml) 自动构建 macOS dmg/zip（arm64 + x64）+ Windows NSIS exe 并发布 Release（说明从 CHANGELOG 提取）。mac 双架构更新通道分离（arm64 走 `latest-arm64`，x64 走 latest-mac），产物命名 `FeishuSync-*`。

### 本地打包命令

```bash
npm run desktop:dist:win:x64        # Windows NSIS
npm run desktop:dist:mac:arm64      # Apple Silicon（adhoc 签名）
npm run desktop:dist:mac:arm64:release  # 正式分发（Developer ID + 公证，需证书）
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
- move/delete/路径冲突/父链不完整/未知类型/无权限保留为 blocker，绝不自动覆盖。
- 正式运维还应保留 operation manifest 与备份；恢复时同时还原知识库、SQLite 和配置。
- 运维 npm 入口（server/）：`npm run audit:corpus` / `backup:state` / `reconcile:dry-run` / `reconcile:apply` / `migrate:v5`。

## server/scripts 脚本风险分级

> 这是保守的操作风险目录，不是执行授权。`verify`、`test`、`debug` 命名不证明只读；例如 verify-media-gap 会 initialize SQLite，gate5 包含 apply。未逐项证明隔离的历史探针按高风险处理，执行前核对路径、配置加载与写入调用，先备份。

### L1 读取/诊断入口（可写报告或临时文件，仍需核对参数）

| 脚本 | 用途 |
|------|------|
| `audit-knowledge-base.ts` | 知识库一致性审计（npm `audit:corpus`） |
| `debug-path.ts` / `debug-sheet-info.ts` | 路径/sheet 调试探针 |
| `probe-spawn-stdin-paths.ts` | 子进程 stdin 路径探针 |
| `llm-channels-connectivity.ts` | LLM 通道连通性检查（会发起真实模型请求） |


### L2 默认不提交知识库正文 / 显式 apply 才提交（状态与报告仍可能写入）

| 脚本 | 用途 |
|------|------|
| `sync-latest.ts` | 有状态回填：默认不提交KB正文，但可创建配置、初始化/迁移SQLite、更新observed及写报告；真实目录先备份 |
| `reconcile-knowledge-base.ts` / `reconcile-apply.ts` | 映射核对/回填（`--apply` 前不改库） |


### L3 直接写数据/高风险操作

| 脚本 | 用途 |
|------|------|
| `backup-operation-state.ts` | 运行状态备份（写备份文件） |
| `repair-media-gaps.ts` / `resync-one-doc.ts` / `retry-slides.ts` / `sync-troop-unit-cell.ts` / `canary-atomic-commit.ts` | 定向修复/重同步/金丝雀——直接操作知识库与 SQLite，使用前先备份 |
| `migrate-kb-structure.mjs` | KB 结构迁移（历史） |
| `verify-*` / `test-fetch.ts` / `test-sheet-export.ts` / `test-adapter-fallback.ts` | 历史验收探针，不能统一视作只读：部分初始化数据库、加载或迁移用户配置、执行同步或写临时文件；只有逐脚本验证隔离后才运行 |
| `gate2-closeout.ts` / `gate5-live-shadow-canary.ts` | 内含文件/SQLite 写入与 apply，不可假定运行前还有确认门 |
| `smoke-custom-folders.mjs` | 会创建隔离 home、配置与目录并通过接口操作；先核对隔离参数，不能用于生产目录 |

### 文件级历史参考（不执行）

`migration_v2..v4.sql`、`run-migration-v2/v3/v4.mjs`、`run-migration-v5.ts`（v5 有专项测试 `test:migrations`）、`run_migration_v2.py`、`update_doc_mapping.py`、`e2e-integration-test.ts`（端口硬编码 4123，已知技术债）、`verify-custom-docx-write.mjs`（历史写入验证）。这些文件保留作参考，不因本分组而获得运行许可。`reconcile-apply.ts` 的 operationDirectory 仍直接取 home，未完全沿 FEISHU_SYNC_HOME；在隔离环境运行前需额外审查。

## CI / 质量门禁

- push(main)/PR → [ci.yml](../.github/workflows/ci.yml)：lint → typecheck → 双包测试 → 构建冒烟。
- 发布链（release.yml）与质量门禁（ci.yml）分离：前者只在 tag 触发。

## 归档说明

仓库根历史一次性报告与审查状态文件已移至 `docs/reports/archive/`（2026-10 工程治理）；同步产物空壳（`server/400-*.md`）已删除，见 `docs/reports/engineering-governance.md`。
