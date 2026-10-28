# P1-S3 引用入库：source_references 表 + 同步事务内写边 + 生命周期

- **日期**：2026-10-28 · **切片**：P1 §5 P1-S3（设计 §2.2 表 + §2.3 解析到本地——同步事务内写边/生命周期 + §2.4 消费——仅入库与被引用查询面）
- **产物**：`server/src/modules/local-map-store.ts`（表 + 预编译语句 + 生命周期钩）、`server/src/modules/sync-engine.ts`（提交事务内写边）、`server/src/sources/reference-rebuild.ts`（新文件，全量重建）、`server/src/routes/sources.ts`（重建路由）、`server/src/routes/content.ts` + `routes/kb.ts`（referencedBy）、`server/src/ops/command-table.ts`（命令登记）
- **上游输入**：设计 `lark-cli-newcaps-P1.md` §2.1–2.3；`P1-S2-report.md`（reference-graph 签名清单：`extractDocumentReferences`/`SourceReferenceEdge`）；`P1-S1-probe.md`（RP-3 键缺失形态）
- **状态**：完成。消费面（raw_read/raw_links/prompt/预览面板/reference_loss_risk）= P1-S4。

## 1. 表结构（LMS additive 双登记）

```sql
CREATE TABLE IF NOT EXISTS source_references (
  src_obj_token TEXT NOT NULL,
  target_token TEXT NOT NULL,
  target_type TEXT NOT NULL,
  origin TEXT NOT NULL,          -- body|refmap
  kind TEXT NOT NULL,
  label TEXT,                    -- ← 抽取层 SourceReferenceEdge.title
  occurrences INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (src_obj_token, target_token, origin, kind)
);
CREATE INDEX IF NOT EXISTS idx_source_references_target ON source_references(target_token);
```

- **双登记**：`getCreateTablesDDL()`（fresh 库）+ `applyAdditiveMigrations()` 末尾新表 exec（旧库升级同款 `CREATE TABLE IF NOT EXISTS`），与 kb_publications/source_push_log 同模式；列序/PK 与设计 §2.2 逐字一致（无 direction 列——抽取层恒出链，入链按 target 反查）。
- **预编译语句**（LocalMapStore 方法，行形态 `SourceReferenceRow`/入边 `IncomingReferenceRow`/写入 `SourceReferenceInsert`）：
  - `replaceSourceReferences(srcObjToken, edges)` → `{deleted, inserted}`：同事务**先删该源旧边、再批量插入**；自包 `db.transaction`，从 SyncEngine 外层事务嵌套调用时按 better-sqlite3 savepoint 语义随外层回滚；**零边数组 = 合法清空**（正文不再含引用）。
  - `deleteSourceReferencesBySrc(objToken)`：生命周期钩原语。
  - `listSourceReferencesBySrc(objToken)`：出链查询（occurrences 降序确定性排序）。
  - `listSourceReferencesByTarget([objToken, wikiNodeToken])`：**被引用关系**——双键并集入边查询，LEFT JOIN documents 附源行 `title`/`local_rel_path`（源行已删时为 null，入边保留）。
  - `countSourceReferencesByTarget()`：target → 计数 Map（源列表徽标用）。
- **references_truncated 标记**：设计定位是**同步警告**（§2.1），非持久状态——落点为 `SyncedDocument.referencesTruncated?: boolean`（types/index.ts additive）+ sync 时 console.warn；重建命令结果携带 `truncatedDocs` 计数。无表结构偏离（设计 §2.2 表无 truncated 列）。

## 2. 写入点（sync-engine.ts 文档提交成功路径，最小追加）

- `FetchedDocument.referenceMap?: unknown` ← `fetchDocumentContent` 读 `document.reference_map`（RP-3：键整体缺失 → undefined，容错零 refmap 边）。sheet/bitable/slides 不走 docs+fetch → 无 referenceMap → 仅正文链接解析（§2.2）。
- 抽取在 `commitDocumentContent` 成功后、DB 事务**外**（纯函数零 IO，不拉长 SQLite 事务）：`extractDocumentReferences({ markdown: finalContent, referenceMap, selfTokens: [objToken, wikiNodeToken×2来源], excludeTokens: 媒体计划 token 集（docx 图片/白板/附件 + sheet 浮动图 + bitable 附件） })`——输入是**实际提交的本地正文**，保证「边与当前本地正文一致」。
- 插入在 `applyDbWrites` 内 `markDocumentSynced` 之后、`failAfterMarkDocumentSynced` 注入点之前——事务中止时边随基线一起回滚；`typeof replaceSourceReferences === 'function'` 守卫（旧测试替身/旧版本库静默跳过，既有用例零回归）。
- legacy 写入路径（`FEISHU_SYNC_LEGACY_WRITE`）不写边（保持零边缺省；env 门控的遗留路径）。
- 自引用防线：头 YAML 的 `original_link`（指向自身 wiki node）由 selfTokens 过滤；重同步旧边替换不累积。

## 3. 生命周期点（§2.2/§2.3；全部同事务挂边清理）

| 路径 | 挂点 | 行为 |
|---|---|---|
| 源清理/多源清理（cleanupSources → deleteDocumentsByTokens） | `deleteDocumentByToken`（事务内） | 出边同删；**作为 target 的入边保留** |
| 节点删除/移出/屏蔽（deleteSourceNode → clearLocalDocument） | `clearLocalDocument` pending 分支 | 本地基线清零（行保留挂 pending）→ 出边同删；下次成功同步重算 |
| 回收站彻底清除（trash purgeOne） | `purgeCloudDeleted`（新增事务包裹） | 仅行确实被硬删（deleted_confirmed）时删边 |
| watchedRoot 移除 | `purgeWatchedRootData` | 子查询依赖 documents 行尚在，先于 deleteDocs 批量删边 |
| 孤立/失链清理 | `pruneMissingLocalDocs` | 逐 token 删边 + `NOT EXISTS` 防御式孤儿边清扫（与孤立 sheet_sheets 同款） |
| 脏文档（source_edits dirty/pushing/conflict） | 不动 | 同步被 `local_edit_pending` blocker 拒绝，边保持与本地正文一致；下次同步自然重算 |
| 同步变 blocker | 无需清理 | blocker 不提交、文件回滚，旧边与旧正文仍一致（语义自洽） |

## 4. sources.references-rebuild（设计 §2.2 存量段）

- **命令**（ops/command-table.ts）：`sources.references-rebuild`，risk **mutate**，`confirm: 'REBUILD'`，**agentExposed=false**（不进 Agent 工具面）；`POST /api/sources/references-rebuild`（routes/sources.ts，同 confirm 门 + invalid_json 400 + knowledgeBaseRoot 未配置 400）。
- **实现**（`sources/reference-rebuild.ts` 纯本地）：扫全部 documents 行——cloud_deleted=0、有本地身份、有成功基线（与 pruneMissingLocalDocs 同款判定：status/sync_state/synced 基线/lastSyncedAt 任一）→ 剥当前规范 feishu_sync 头 → `extractDocumentReferences`（无 referenceMap：**零云端调用，body-only**；refmap 边随下次同步补齐）→ 全库**一个事务**逐源 replace。跳过项带 reason：`local_edit_pending`/`file_missing`/`outside_root`/`read_failed`；16MB 单文件读上限；返回 `{scanned, rebuilt, skipped, totalEdges, replacedEdges, truncatedDocs}`。
- 头部口径：与同步链一致（同步抽取无头 finalContent → 重建剥头后抽取）；自引用由 selfTokens 双键过滤。

## 5. referencedBy 查询 API（S4 UI 消费面）

- **文档详情** `GET /api/mapping/content/:objToken` 增 `referencedBy`：`listSourceReferencesByTarget([objToken, wikiNodeToken])` 反向边数组（§2.3 双键并集），行含 `srcObjToken/srcTitle/srcLocalRelPath/targetType/origin/kind/label/occurrences/updatedAt`——预览面板「被引用」区直用；方法缺失安全降级为 `[]`。
- **源列表** `GET /api/kb/sources` 每行增 `referencedBy: number`（KbSourceChoice additive 可选字段）：`countSourceReferencesByTarget` 一次 GROUP BY + obj/wiki 双键计数汇总（树接口 `/api/kb/sources/tree` 经 choices 自动携带）。

## 6. 测试与验证证据

| 命令（cwd=server） | 退出码 | 结果 |
|---|---|---|
| `npx vitest run tests/source-references.test.ts tests/sync-references.test.ts` | 0 | 14/14（新测试：迁移双登记断言、替换幂等/零边清空/嵌套 savepoint、双键入边查询+LEFT JOIN、生命周期 5 路径、同步写边+失败回滚（TestHooks）、重同步替换、RP-3 键缺失容错、rebuild 等价+脏跳过+跳过 reason、重建路由 confirm 门+invalid_json） |
| `npx vitest run tests/sync-engine.test.ts tests/local-map-store.test.ts tests/cli-args.test.ts tests/ops-command-table.test.ts tests/reference-graph.test.ts tests/source-cleanup.test.ts tests/custom-folders.test.ts tests/custom-folder-detect-sync.test.ts tests/orphan-files.test.ts tests/config-routes.test.ts tests/trash-llm-routes.test.ts tests/cli-source-commands.test.ts` | 0 | 283/283（既有 sync-engine 用例零回归——默认 mock 无 reference_map/无新方法，容错零边不破坏） |
| `npx tsc --noEmit` | 0 | 类型干净 |
| `npx eslint`（全部 12 个改动/新增文件，cwd=根） | 0 | 无告警 |
| 全量 `npx vitest run`（诊断性） | 1 | 104 文件中仅 `tests/p1-s5-slides-screenshot.test.ts` 2 例失败——**兄弟任务中间态**：`config-manager.ts` 未提交改动新增 `sync.whiteboardExport` 默认值（+198 行，非本切片写面），与 p1-s5 断言冲突；本切片文件全部通过 |

已知修正（自测发现）：首版 insert 绑定读 `edge.label` 而 S2 抽取层字段是 `title` → label 全 null，已改为 `SourceReferenceInsert.title`（与 SourceReferenceEdge 字段同名直传，消除映射脚印）；重建缺 stat 与读失败分类（`file_missing` vs `read_failed`）已拆分。

## 7. 未覆盖项与边界

- **custom-doc-sync 写边未接线**：设计 §2.2 写入点含 custom-doc-sync（归档链），任务书限定 sync-engine.ts——归档文档下次经其自身同步链重算前无引用边（S4 或后续切片补接线）。
- FEISHU_SYNC_LEGACY_WRITE 路径不写边（env 门控遗留路径）。
- `references_truncated` 为结果面标记（SyncedDocument + 重建计数），无持久列（设计表无此列）；S4 若需 UI 常驻展示可另行决定。
- 并行提示兑现：P0-S9 的 cloud.rename_title 已在表（37 条），本切片 +1（`sources.references-rebuild`）后为 38，`cli-args.test.ts` 计数断言同步更新；types/index.ts 仅追加 `referencesTruncated?`。
- 全量 server 套件的 p1-s5 失败为兄弟中间态（§6 末行），结算隔离快照以基线验证为准。

## 8. 回滚

- 删除 `server/src/sources/reference-rebuild.ts` + 还原 sync-engine 写边调用（`replaceSourceReferences` 调用点与 `referenceMap` 携带）即停写；`source_references` 表保留无害（设计 §6：删表即回现状，且旧版本应用忽略新表）。
- 命令表/路由/类型改动均为 additive，revert 单文件即可；cli-args 计数断言随回滚改回 37。
