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

## Agent 与标准库（开发分支）

| 数据 | 真相与维护责任 |
|---|---|
| `agent_sessions` | 会话标题、模式、Workspace绑定、pi JSONL文件定位与最近错误；正文历史不放SQLite |
| `<dataRoot>/agent/sessions/*.jsonl` | pi v3树形会话历史；沿当前叶回溯全部节点，输出时才筛消息，不能让compaction/model_change父节点截断历史 |
| `<dataRoot>/agent/audit/<sessionId>.jsonl` | 写入工具/路径/结果元数据，不含写入正文 |
| `agent_tasks`（2026-10 升级） | 任务编排记录（role/status/output_dir/tools_json/plugin_revision/rounds/result/questions）；状态机 queued/running/done/blocked/failed/cancelled/interrupted；启动时非终态置 interrupted；跨会话访问校验归属 |
| `source_edits`（2026-10 升级） | 原始库受控编辑登记（state dirty/pushing/pushed/conflict、base/current_body_hash、push_mode/revision）；启动时 pushing 置 conflict（push_interrupted）；SyncEngine/回收站/源清理遇非 pushed 行一律 `local_edit_pending` 拒绝 |
| `kb_builds` | 构建状态与统计（含增列 parallelism/unit_total/vision_model/warnings_json）；CURRENT提交后的异常以文件发布事实为准启动对账，不可用旧DB状态否认已发布内容 |
| `<dataRoot>/agent/vision-cache/` | 图片描述内容寻址缓存（`<hash[0:2]>/<imageHash>.<modelKey>.json`，tmp+rename）；v1 无淘汰 |
| `<dataRoot>/source-edits/<objToken>/` | 源编辑前备份（base.md 同步版正文 + 最近 20 份编辑前版本） |
| `<dataRoot>/agent/audit/{cli,source-edits,source-pushes}.jsonl` | CLI 命令（非 GET）、源编辑、写回的审计流水；只记时间/方法/路径/hash 等元数据，不记正文 |
| `<dataRoot>/run/endpoint.json` | CLI 端点发现文件（url/pid/cliToken，0600，tmp+rename）；仅 `cli.enabled` 时发布，pid 匹配才可 revoke |
| `<outputRoot>/CURRENT.json` | 当前发布指针；一次读取绑定一个release，不能混读两个版本 |
| `<outputRoot>/releases/<releaseId>/manifest.json` 与 `docs/` | 完整已发布快照及来源（快照条目含 mediaHash/imageCount）；应用不修改已发布正文，MCP只读此处，不读取SQLite |
| `.staging/<buildId>` 与 `.builds/<buildId>` | 暂存内容、构建事件和校验报告；不是可对外查询的发布 |

以上新表仍经幂等DDL/additive策略建立（agent_tasks/source_edits 新表与 kb_builds 新列均双登记 additive 数组与 `getCreateTablesDDL()`），不改原`documents`身份及同步基线语义。`dataRoot`与桌面/服务端共用`FEISHU_SYNC_HOME`解析。

配置新增`agent`（runtime/model/**vision**/**orchestration**/maxConcurrentProcesses/workspaces）与`standardKb`段，另有可选段`cli`（命令行访问，默认关）与`feishuWrite`（飞书写回，默认关）；`LlmModelPreset` 增可选 `supportsImages`（仅 UI 提示）。`agent.vision` 以 providerId/modelId 引用 `llm.providers`，不新增密钥字段，缺省 disabled。`standardKb.buildParallelism` 1..6 默认 2，`agent.maxConcurrentProcesses` 1..6 默认 3（后台类合计 ≤ M−1）。`cli`/`feishuWrite` 只接受 desktop token 修改，CLI 主体提交的 `PUT /api/config` 会丢弃这两个字段。Workspace通过专用API登记，普通PUT配置不接受`agent.workspaces`；改变原始库、标准库或运行资源根也必须对已有Workspace做反向交叉校验，不能只在最初登记时检查。

标准文档使用独立的`feishu_sync_kb` YAML-in-comment头（`doc_id/build_id/sources`），不要与原始库的`feishu_sync`头混用。改标准头需同时维护构建写入/校验和`StandardKbStore.parseStdHeader/stripStdHeader`，并验证UI/MCP读取。

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
- move/delete/路径冲突/父链不完整/未知类型/无权限 → 带 `reasonCode` 的 blocker，绝不自动覆盖；源编辑未写回（`source_edits` 非 pushed）同样产生 `local_edit_pending` blocker。
- 原子提交顺序不可变：库外 staging → 校验 → rename → DB 事务；失败从 rollback 快照恢复；`assertInsideRoot` 拒绝路径逃逸。
- 源编辑写入（SourceEditService，另序）：持按 objToken 进程内写锁 → baseHash OCC 校验 → 新内容 = **原 header 字节 + 新 body** 同目录临时文件 fsync+rename → 写后重读 `parseMetadata` 逐字段复核，失配即从备份恢复并报 `source_header_roundtrip_failed`；`documents` 表与 observed/synced 基线不动，下次构建按 changed 处理。
