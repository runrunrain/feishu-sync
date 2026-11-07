# 数据契约

> 本文是数据层变更前的检查清单；字段级权威定义在 `server/src/modules/local-map-store.ts`（DDL 与迁移数组）、`config-manager.ts` 与 `server/src/types/agent-knowledge.ts`（Agent/标准库配置默认值）。文件数/表数为 2026-11 实测，以代码为准。

## SQLite（`~/.feishu-sync/feishu-sync.db`）

- 驱动：better-sqlite3 ^12，同步 API + 预编译语句（`LocalMapStore`）。
- 当前 **22 张表**（2026-11 实测 `getCreateTablesDDL()`）：

| 域 | 表 |
|----|----|
| 同步主表 | `documents` / `sync_log` / `run_log` |
| 同步辅助 | `localDirs` / `custom_folders` / `sheet_sheets` / `feishu_pending_items` / `sync_blocklist` / `local_source_deletions` |
| Agent 会话 | `agent_sessions` / `agent_session_preferences` / `agent_tasks` |
| 源受控写 | `source_edits` / `source_push_log` / `source_references` / `source_comments` / `source_comment_meta` |
| 标准库 | `kb_builds` / `kb_publications` / `kb_source_exclusions` |
| 云端操作 | `cloud_moves` |
| 内部 | `schema_migrations` |

- **迁移策略**：`initialize()` 每次启动跑 `applyAdditiveMigrations()`——每条 `ALTER TABLE ADD COLUMN` 用 `PRAGMA table_info` 守卫，旧库原地升级。新列/新表要同时加到 additive 迁移数组与 `getCreateTablesDDL()` **两处**。
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

**`watchedRoots`（`WatchedRootConfig[]`）是真相源**；`watchedRootUrls` 是 ConfigManager 内存派生、不落盘的兼容投影——不要直接改投影。

### 配置段与默认值（2026-11 实测）

| 段 | 默认值要点 | 备注 |
|----|-----------|------|
| `llm` | direct 单通道；`timeoutMs` 600_000；temperature 0.2；`contentAdaptationEnabled` false | apiKey 明文（含 `_warning`，加密 deferred） |
| `agent.runtime` | `{ backend: 'pi' }` | Claude Code 侧车另见 [claude-runtime.md](./claude-runtime.md) |
| `agent.model` | `maxTokens` 32768 | `LlmModelPreset` 增可选 `supportsImages`（仅 UI 提示） |
| `agent.vision` | `enabled: false`、concurrency 3、maxImageBytes 5 MiB、maxImagesPerBuild 300 | 以 providerId/modelId 引用 `llm.providers`，不新增密钥字段 |
| `agent.orchestration` | `maxActiveTasksPerSession: 5`、`taskTimeoutMinutes: 30` | 任务编排 |
| `agent.maxConcurrentProcesses` | 3（1..6）＝非构建后台容量 M：非构建后台合计 ≤ M−1（M≥2 时为会话保留 1 槽）；标准库构建走独立 `build` 通道，容量 N=`standardKb.buildConcurrency`，不被 M 截断，总运行上限 N+M | 进程池准入（`agent-process-pool.ts`） |
| `agent.workspaces` | `[]` | 经专用 API 登记；普通 `PUT /api/config` 不接受此字段 |
| `standardKb.outputRoot` / `retainReleases` | `<dataRoot>/standard-kb` / 3 | |
| `standardKb.buildConcurrency` | 2（1..6）；**兼容读旧名 `buildParallelism`** | 并行构建 worker 数 |
| `standardKb.orchestrationMode` | `'pi-amagi'`（当前唯一开放值；legacy/claude-native 加载时统一迁移） | 见 [build-orchestration.md](./build-orchestration.md) |
| `standardKb` 构建参数 | `buildBatchSize` 10、`buildBatchWordBudget` 40 000（0 或 4000..400000）、`promptTimeoutMinutes` 15、`buildTimeoutMinutes` 180、`strictGates` false（创建时冻结）、`autoBuildAfterSync` false、`evidenceBudgetBytes` 缺省按冻结工作集来源数给默认额度 | `buildRoles`（writer/reviewer `modelPresetId`，plannerEnabled false）、`reviewPolicy`（maxAutoRevisions 2、maxInterfaceRetries 2） |
| `cli` | **`enabled: true`（默认开启，可显式关闭）** | 0.4.2 起缺省开；保留已保存的显式关闭状态 |
| `kbLanMcp` | `enabled: false`、bindAddress `auto`、port 47391、maxSessions 16 | 默认值定义在 `kb-lan/network.ts`；见 [kb-lan-mcp.md](./kb-lan-mcp.md) |
| `feishuWrite` | `enabled: false` | 飞书写回（增量授权 `docx:document:write_only`） |
| `feishuPublish` | `enabled: false` | 标准库反向发布，见 [feishu-publish.md](./feishu-publish.md) |
| `sync` | `slidesScreenshot.enabled: false`、`whiteboardExport.enabled: true` | 白板旁路导出失败只告警，md 唯一引用仍是 PNG 预览 |
| 顶层 | `pollIntervalMinutes` 30、`requiredScopes` 9 项 | `RETIRED_REQUEST_SCOPES`（`docs:document:read`）加载时剔除 |

`cli.*`/`llm.*` 密钥面/`agent.workspaces`/`feishuWrite` 只接受 desktop token 修改，CLI 主体提交的 `PUT /api/config` 会丢弃这些字段。改变原始库、标准库或运行资源根也必须对已有 Workspace 做反向交叉校验，不能只在最初登记时检查。字段总表见 README「配置说明」。

## Agent 与标准库的数据文件

| 数据 | 真相与维护责任 |
|---|---|
| `agent_sessions` | 会话标题、模式、Workspace绑定、运行时文件定位与最近错误；正文历史不放SQLite |
| `<dataRoot>/agent/sessions/*.jsonl` | pi v3树形会话历史；沿当前叶回溯全部节点，输出时才筛消息，不能让compaction/model_change父节点截断历史 |
| `<dataRoot>/agent/audit/<sessionId>.jsonl` | 写入工具/路径/结果元数据，不含写入正文 |
| `agent_tasks` | 任务编排记录（role/status/output_dir/tools_json/plugin_revision/rounds/result/questions）；状态机 queued/running/done/blocked/failed/cancelled/interrupted；启动时非终态置 interrupted；跨会话访问校验归属 |
| `source_edits` | 原始库受控编辑登记（state dirty/pushing/pushed/conflict、base/current_body_hash、push_mode/revision）；启动时 pushing 置 conflict（push_interrupted）；SyncEngine/回收站/源清理遇非 pushed 行一律 `local_edit_pending` 拒绝 |
| `kb_builds` | 构建状态与统计（含 parallelism/unit_total/vision_model/warnings_json 增列）；CURRENT提交后的异常以文件发布事实为准启动对账，不可用旧DB状态否认已发布内容 |
| `kb_publications` | 反向发布状态机（预览/发布/映射） |
| `<dataRoot>/agent/vision-cache/` | 图片描述内容寻址缓存（`<hash[0:2]>/<imageHash>.<modelKey>.json`，tmp+rename）；v1 无淘汰 |
| `<dataRoot>/source-edits/<objToken>/` | 源编辑前备份（base.md 同步版正文 + 最近 20 份编辑前版本） |
| `<dataRoot>/agent/audit/{cli,source-edits,source-pushes}.jsonl` | CLI 命令（非 GET）、源编辑、写回的审计流水；只记时间/方法/路径/hash 等元数据，不记正文 |
| `<dataRoot>/run/endpoint.json` | CLI 端点发现文件（url/pid/cliToken，0600，tmp+rename）；CLI 默认开启时发布，pid 匹配才可 revoke |
| `<outputRoot>/CURRENT.json` | 当前发布指针；一次读取绑定一个release，不能混读两个版本 |
| `<outputRoot>/releases/<releaseId>/manifest.json` 与 `docs/` | 完整已发布快照及来源（快照条目含 mediaHash/imageCount）；应用不修改已发布正文，MCP只读此处，不读取SQLite |
| `.staging/<buildId>` 与 `.builds/<buildId>` | 暂存内容、构建事件和校验报告；不是可对外查询的发布 |

以上新表仍经幂等DDL/additive策略建立（新表与 kb_builds 新列均双登记 additive 数组与 `getCreateTablesDDL()`），不改原`documents`身份及同步基线语义。`dataRoot`与桌面/服务端共用`FEISHU_SYNC_HOME`解析。

### `kb_builds.metrics_json` 的 orchestration 段（pi-amagi 编排度量）

pi-amagi 构建完成后聚合写入 `metrics_json.orchestration`（聚合函数 `kb/build-metrics.ts`，磁盘事实由 `kb-build-service.collectLeaderOrchestrationMetricsFromDisk` 采集；运维报告入口 `server/scripts/build-metrics-report.ts`）。口径约束：不可推导的字段省略/置 null 并写入 notes，禁止编造：

- 计数：`wallClockMs`（started_at→finished_at，未收口按采集时刻）、`docsPublished`、`sourcesTotal`；按角色派发数 `authorDispatches`/`reviewDispatches`/`researchDispatches`（luban/diting/baize；来源文件不可得为 null，真实空=0）。
- 审查：`revisionRounds`（docsReviewed、totalReviews、roundsMedian/roundsMax、首审结论 `firstVerdicts` 与 `firstPassRate`；按 scopePaths 归组，无范围的旧回执单独计数）。
- 发布门：`publishRejections`（按 reason 计数）、`dispatchRejections`（派发守卫/任务系统拒绝按 code 计数；additive 可选）。
- 并发：`pool`（peakInflight/avgInflight、推导口径 `derivation`：journal-session | actor-events | none；在途 `submittedPeakInflight`/`submittedAvgInflight` 可选）。
- 时延：`firstDraftToPublish`（每篇首稿→发布结算 nearest-rank 分位；additive 可选）。

字段级定义见 `types/agent-knowledge.ts` 的 `KbBuildMetricsOrchestration`；度量与运维详见 [build-operations.md](./build-operations.md)。

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

标准文档使用独立的`feishu_sync_kb` YAML-in-comment头（`doc_id/build_id/sources`），不要与原始库的`feishu_sync`头混用。改标准头需同时维护构建写入/校验和`StandardKbStore.parseStdHeader/stripStdHeader`，并验证UI/MCP读取。

## 写盘安全（文件层契约）

- `SyncOptions.apply` 默认 false（dry-run）；写盘需 `apply:true + confirmation:'APPLY'`。
- move/delete/路径冲突/父链不完整/未知类型/无权限 → 带 `reasonCode` 的 blocker，绝不自动覆盖；源编辑未写回（`source_edits` 非 pushed）同样产生 `local_edit_pending` blocker。
- 原子提交顺序不可变：库外 staging → 校验 → rename → DB 事务；失败从 rollback 快照恢复；`assertInsideRoot` 拒绝路径逃逸。
- 源编辑写入（SourceEditService，另序）：持按 objToken 进程内写锁 → baseHash OCC 校验 → 新内容 = **原 header 字节 + 新 body** 同目录临时文件 fsync+rename → 写后重读 `parseMetadata` 逐字段复核，失配即从备份恢复并报 `source_header_roundtrip_failed`；`documents` 表与 observed/synced 基线不动，下次构建按 changed 处理。
