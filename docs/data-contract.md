# 数据契约

> 本文是数据层变更前的检查清单；字段级权威定义在 `server/src/modules/local-map-store.ts`（DDL 与迁移数组）与 `config-manager.ts`。

## SQLite（`~/.feishu-sync/feishu-sync.db`）

- 驱动：better-sqlite3 ^12，同步 API + 预编译语句（`LocalMapStore`）。
- 主表：`documents` / `sync_log` / `run_log`；辅助表：`local_dirs` / `custom_folders` / `sheet_sheets` / `feishu_pending_items` 等。
- **迁移策略**：`initialize()` 每次启动跑 `applyAdditiveMigrations()`——每条 `ALTER TABLE ADD COLUMN` 用 `PRAGMA table_info` 守卫，旧库原地升级。新列要同时加到 additive 迁移数组与 `getCreateTablesDDL()` **两处**。
- 历史迁移脚本（`server/scripts/migration_v2..v5`、`run-migration-*`）是文件级参考，线上升级只靠 additive 自动迁移，不手工跑。
- 双身份契约（改动高危区）：
  - `custom_folder_id` 与 `watched_root_url/id` 互斥；归属冲突时结构树所有权优先。
  - 回填**不清** `wiki_node_token`（COALESCE 会把头部解析出的 wiki 身份写回；`detectCustomFolderChanges` 依赖它做云端身份校验）。
  - 因此飞书树两个出口（`getTreeDetailed` feishu 视图 + legacy `getTree`）都必须按 `customFolderId IS NULL` 过滤归档行——wiki 身份单独不能作为排除依据。
  - 归档变更检测只报 modified（无新增/删除语义）。

### 时间基线字段（检测/同步分离的根基）

| 字段 | 推进方 | 语义 |
|------|--------|------|
| `observed_obj_edit_time` | ChangeDetector（检测） | 最近观察到的云端编辑时间；检测只推进此字段 |
| `synced_obj_edit_time` + `synced` | SyncEngine（同步） | **只有 staged 原子提交成功才推进**；任何失败不推进（不可破契约） |

## config.json（`~/.feishu-sync/config.json`）

- **`watchedRoots`（`WatchedRootConfig[]`）是真相源**；`watchedRootUrls` 是 ConfigManager 内存派生、不落盘的兼容投影——不要直接改投影。
- 字段总表见 README「配置说明」；关键字段：`llm.*`（direct 通道，默认智谱 GLM，`timeoutMs` 默认 600_000）、`pollIntervalMinutes`、`knowledgeBaseRoot`、`requiredScopes`（9 项，与 ConfigManager 默认一致）。
- apiKey 明文存储是**已知架构决策**（含 `_warning` 字段），加密 deferred；正式回填脚本默认只读配置，唯一例外是显式 `--persist-config`。

## Markdown header 契约（round-trip 必须闭环）

写入端 `SyncEngine.generateHtmlHeader`，读取端 `IndexScanner.parseMetadata`。当前规范：文件首部 YAML-in-HTML-comment：

```html
<!--
feishu_sync:
  obj_token: ...
  obj_type: docx
  ...
-->
```

- 兼容 3 种历史格式：`legacy_html_zh` / `blockquote` / `bold_kv`。
- 改 header 字段必须同步两端，并保证 round-trip（`server/tests/sync-engine.test.ts` (d) 项用例是守护）。
- 手工放进 `_custom/` 的带 `feishu_sync` 头文件由全量重建兜底纳管：`IndexScanner.reconcileCustomFolders`（注册含 md 的一级子目录，`ScanPolicy` 保留目录除外；`_custom/` 根散档不纳管）+ `LocalMapStore.backfillCustomFolders`（按 `local_rel_path` 最长前缀回填，候选行须 watched_root 为空）。

## 写盘安全（文件层契约）

- `SyncOptions.apply` 默认 false（dry-run）；写盘需 `apply:true + confirmation:'APPLY'`。
- move/delete/路径冲突/父链不完整/未知类型/无权限 → 带 `reasonCode` 的 blocker，绝不自动覆盖。
- 原子提交顺序不可变：库外 staging → 校验 → rename → DB 事务；失败从 rollback 快照恢复；`assertInsideRoot` 拒绝路径逃逸。
