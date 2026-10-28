# S11 报告：源编辑服务（受控写原始库 + 脏状态防覆盖）

- 上游输入：`docs/design/kb-agent-upgrade-design.md` §7.1–7.4 / §8 / §9.1 / §10（S11 行）、`server/src/modules/sync-engine.ts`、`server/src/modules/local-map-store.ts`、`server/src/modules/index-scanner.ts`
- 产物代码：见下文「改动清单」；测试 `server/tests/source-edit.test.ts`（20 用例）
- 范围外（按任务书）：飞书写回（S12）、UI（S13）

## 一、改动清单（写面登记）

### 本切片写面内（新文件）

| 文件 | 内容 |
|---|---|
| `server/src/sources/source-write-lock.ts` | `SourceWriteLock`（per-objToken FIFO 互斥）+ `sharedSourceWriteLock` 进程级共享实例 |
| `server/src/sources/source-edit-service.ts` | `SourceEditService`（read/edit/revert/listEdits/editStatus）+ `SourceEditError` + 纯函数 `applyOp`/`sha256`/`pruneSeqBackups` + 守卫助手 `pendingLocalEditTokens`/`pendingLocalEditRelPaths` |
| `server/src/routes/sources.ts` | API 工厂 `sourcesRoutes(deps)`（§7.4 契约）+ `createSourceEditService` |
| `server/tests/source-edit.test.ts` | 20 用例（验收点全覆盖，见 §六） |

### 公共文件（只追加）

| 文件 | 追加内容 |
|---|---|
| `server/src/modules/local-map-store.ts` | DDL：`source_edits` 表（getCreateTablesDDL；**新表无需 documents 列迁移**，`applyAdditiveMigrations` 的 additive 数组是 documents 列专用，新表 `CREATE TABLE IF NOT EXISTS` 对旧库同样生效——与 kb_builds/agent_sessions 同模式）+ 访问器 `getSourceEdit/createSourceEdit/markSourceEditDirty/markSourceEditPushed/clearSourceEdit/listSourceEdits/listPendingSourceEdits`（全部预编译语句）+ import 两个类型 |
| `server/src/types/index.ts` | `SyncFailureReasonCode` 增 `'local_edit_pending'`；新增 `SourceEditActor/SourceEditState/SourceEditOp/SourceEditRecord/SourceEditStateDto` |
| `server/src/modules/sync-engine.ts` | 最小侵入（见 §三）：import 锁、deps 增 `sourceWriteLock?`、dry-run blocker、apply 循环锁包裹 + 锁内 dirty 检查、`finalizePushedSourceEdit`（pushed 行 + 备份目录清理）、`localEditPendingFailure` 工厂。**既有逻辑零改动**（syncSingleDocument 调用参数原样保留） |
| `server/src/index.ts` | 路由注册追加（`sourcesRoutes({...})`，kbBuild 探针 = `kbBuildService.activeBuild(localMapStore) != null`）。注：同文件还含并行任务 S8 的 CLI 追加，互不冲突 |

### 越出任务书写面清单的守卫追加（**请 Leader 按此扩写面**）

| 文件 | 追加性质 | 改动 |
|---|---|---|
| `server/src/kb/source-cleanup.ts` | 最小追加（+9 行） | `prepareSourceCleanup` 在 selected 解析后追加 dirty 守卫：任一选中 token 有非 pushed `source_edits` 行 → `ToolError('local_edit_pending', 409)`。**该函数是 kb routes cleanup / trash manual-delete / source-batch 的公共咽喉，一处守卫覆盖全部调用方** |
| `server/src/routes/trash.ts` | 最小追加（+41 行） | ① `POST /api/trash/restore`：构建活跃 409 `kb_build_running` + dirty 409 `local_edit_pending`；② `DELETE /api/trash/purge` 单条同款两守卫，`all=1` 按行跳过 dirty 行并响应新增字段 `skipped_local_edit_pending`（构建活跃仍整体拒绝）；③ `POST /api/trash/bulk-process`：构建活跃整体 409 + 逐 token `failed[]{reason:'local_edit_pending'}`；④ `POST /api/trash/manual-delete`：路由级 dirty 409（覆盖 `delete_local_files=false` 分支——该分支不经过 prepareSourceCleanup）+ 既有构建活跃检查保留 |
| `server/src/routes/orphan-files.ts` | 最小追加（+15 行） | `POST /api/orphan-files/cleanup`：构建活跃 409；目标按 `listPendingSourceEdits().local_rel_path` 前缀排除（`relPath === pending \|\| pending.startsWith(relPath + '/')`），排除项上报新增响应字段 `skipped_local_edit_pending: string[]`；dry-run 同样排除（这些路径在解决编辑前永远不可清理） |

**custom folder 移动**：核实当前代码无文件移动操作——`renameCustomFolder` 只改 DB 名（local-map-store.ts:1555-1559，`local_rel_path` 不变），DELETE folder/移出文档均保留本地文件。守卫不需要接线；若 S13 新增移动操作，必须消费 `pendingLocalEditTokens`（见 §五）。

## 二、source_edits schema（设计 §7.4 原样）

```sql
CREATE TABLE IF NOT EXISTS source_edits (
  obj_token TEXT PRIMARY KEY, local_rel_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('dirty', 'pushing', 'pushed', 'conflict')),
  base_obj_edit_time TEXT, base_body_hash TEXT NOT NULL, current_body_hash TEXT NOT NULL,
  edit_count INTEGER NOT NULL DEFAULT 0, last_actor TEXT NOT NULL,
  push_mode TEXT, push_revision_id TEXT, last_error_code TEXT, last_error_message TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pushed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_source_edits_state ON source_edits(state);
```

- 行生命周期：首次编辑 `createSourceEdit`（count=0 基线）→ 同一事务语义内 `markSourceEditDirty` 收敛 count=1（对齐设计步骤 4→6）；后续编辑仅 `markSourceEditDirty`（count+1）；revert/回拉成功 → `clearSourceEdit`（DELETE）。
- **写回失败回滚语义（实测修正）**：首编的 round-trip 失败会回滚「本次新建的行」（文件已恢复原样，不应残留 dirty 行阻断同步）；`base.md` 为覆盖写（revert 后重新首编时必须重新对齐当前同步版）。
- `pushing`→`conflict` 启动对账（设计 §7.4）属 S12 写回链职责，未实现（S12 需在 server 启动时调 `UPDATE ... WHERE state='pushing'`；建议补 `markInterruptedSourceEditPushes()` 到 store）。

## 三、SyncEngine 防覆盖契约（§7.3）

- **apply 模式**：每文档提交全程持 `SourceWriteLock(objToken)`（与 SourceEditService 共享 `sharedSourceWriteLock`），dirty/pushing/conflict 检查**在锁内**执行（消除 check-then-write 窗口）→ `FailedDocument{ reasonCode:'local_edit_pending', error:'本地有未写回的修改：写回飞书或放弃修改后再同步', repairAction:'manual_review', retryable:false }`。不写文件、不推进 synced 基线、不触发云端拉取（lark 哨兵测试证明）。
- **dry-run 模式**：同样产出 blocker（同步列表在正式提交前可见），不写任何东西。
- **pushed 行**：不阻断；提交成功（markDocumentSynced 后）自动 `clearSourceEdit` + 删 `<dataRoot>/source-edits/<objToken>/` 备份目录（清行失败仅 warn，不影响同步成功）。
- **mock 兼容**：`getPendingLocalEditState` 对无 `getSourceEdit` 的旧测试替身返回 null（全量 999 用例不回归）。
- ChangeDetector / IndexScanner 重建：零改动（设计：不变 / source_edits 不参与重建）。

## 四、API 契约（`server/src/routes/sources.ts`）

错误体沿用 `{ error, message, details? }`。所有路由挂 desktop auth 之后（index.ts 注册顺序）。

| 方法/路径 | 请求 | 响应 |
|---|---|---|
| GET `/api/sources/edits` | — | `{ edits: SourceEditStateDto[] }`（含 pushed） |
| GET `/api/sources/edits/:objToken` | — | `SourceEditStateDto & { body }`；无行 404 `source_edit_not_found`；文档不存在 404 `source_not_found` |
| GET `/api/sources/:objToken/edit-status` | — | `{ objToken, relPath, title, bodyHash, editState: SourceEditStateDto \| null }`——**S13 预览面板/CLI 取 baseHash 的入口**（无编辑行时 editState=null 但仍有 bodyHash） |
| POST `/api/sources/:objToken/edit` | `{ op: SourceEditOp; baseHash; confirm:'EDIT'; actor? }`（设计原生）或 `{ ops: SourceEditOp[]; ... }`（顺序应用）或 `{ newText: string; ... }`（整体替换别名，任务书形态） | `{ bodyHash, state: SourceEditStateDto }`；冲突 409 `{error:'source_edit_conflict', details:{currentBodyHash}}` |
| POST `/api/sources/:objToken/revert` | `{ confirm:'REVERT'; actor? }` | `{ ok: true }`（恢复 base.md 正文 + 删行；无行 404） |

`SourceEditOp = { mode:'replace_body'; body } | { mode:'str_replace'; old; new; replaceAll? }`（str_replace old 须唯一，除非 replaceAll；违反 400 `invalid_edit_op`）。
`actor`: `'ui' | 'cli' | 'agent'`（缺省 ui；agent 走 S10 批准通道时由其传）。

### 错误码落实（§8 表内）

409 `source_edit_conflict`/`source_push_in_progress`/`local_edit_pending`(blocker+生命周期)/`source_not_editable`(cloud_deleted/屏蔽名单)/`kb_build_active`；422 `source_edit_unsupported_type`(非 docx)/`source_header_unsupported`(历史头/无头/身份不符)；404 `source_edit_not_found`；500 `source_header_roundtrip_failed`(已恢复)。

### §8 表外新增码（需 S14 并入基线 §8）

404 `source_not_found`（文档行/文件不存在）、400 `invalid_edit_op`/`invalid_body`/`confirmation_required`/`invalid_source_path`（PathGuard 拒绝）、500 `source_revert_failed`（base.md 丢失）、500 `source_edit_failed`（路由兜底）。

## 五、给 S12/S13 的消费接口

**S12（写回）**：
- `LocalMapStore.markSourceEditPushed(objToken, {pushMode, pushRevisionId})`、`listPendingSourceEdits()`、`clearSourceEdit()` 已备。
- 锁：`sharedSourceWriteLock.withLock(objToken, fn)`（推送持锁期间 SyncEngine 提交同 token 会排队，符合设计「提交经 SourceWriteLock」）。
- `SourceEditService.read(objToken)` 返回 `{ header, body, bodyHash, state }`——push-planner 的 baseBody/currentBody 数据源。
- 回拉成功后**无需自行清行**：SyncEngine `finalizePushedSourceEdit` 已在同步成功路径自动清行+删备份（S12 只需在推送成功后置 `pushed` 并发起回拉同步）。
- 待补（S12 落地时）：pushing→conflict 启动对账；push/preview 两路由。

**S13（UI/CLI）**：
- 预览面板取 baseHash：`GET /api/sources/:objToken/edit-status`（设计 §7.4 提到的 mapping/content 增字段未在本切片实现——edit-status 已覆盖需求，如仍要加由 S13 顺手追加）。
- blocker 文案消费：`FailedDocument.reasonCode === 'local_edit_pending'` → 显示 error 字段（文案即设计原文）。
- 生命周期操作若新增移动/删除源文件能力，必须先调 `pendingLocalEditTokens(store, tokens)`（`server/src/sources/source-edit-service.ts` 导出，duck-typed 安全）。
- 备份目录 `<dataRoot>/source-edits/<objToken>/`（base.md + 000001.md…保留 20 份）；审计 `<dataRoot>/agent/audit/source-edits.jsonl`。

## 六、验证证据

| 项 | 命令/入口 | 结果 |
|---|---|---|
| 本切片测试 | `cd server && npx vitest run tests/source-edit.test.ts` | **20/20 通过**（header 字节不变+往返、OCC 409、str_replace 三态、二次编辑 base/seq、round-trip 故障注入恢复+建行回滚、构建活跃 edit/revert 拒绝、非 docx/历史头/回收站拒绝、pushing 拒绝、_custom 归档可编辑、revert 恢复+清 dirty+审计、dirty/conflict/pushing 同步 blocker（文件原样+基线不推进+lark 零调用）+dry-run 预告、pushed 不阻断+成功清行删备份、prepareSourceCleanup dirty 拒绝/pushed 放行、锁 FIFO+异常不卡、applyOp、API 层 6 端点含 confirm 门/409 形状/404 语义） |
| 定向回归（触碰文件） | `npx vitest run tests/sync-engine.test.ts tests/source-cleanup.test.ts tests/trash-llm-routes.test.ts tests/orphan-files.test.ts tests/local-map-store.test.ts tests/migration-v5.test.ts tests/index-scanner.test.ts` | **134/134 通过** |
| 全量 server | `cd server && npm test` | **78 files / 999 tests 全绿**（一次运行中 app-llm-fixture 出现 EEXIST 并发 fixture 竞态，隔离重跑通过且复跑全绿——共享树并行任务（S1/S2/S8 等）的 PiPluginService fixture 竞态，非本切片改动面） |
| 类型 | `npm run typecheck`（root+node+server 三段） | 通过（exit 0） |
| Lint | `npx eslint`（本切片全部新改文件） | 0 error 0 warning |
| ABI | `node -e "require('better-sqlite3')"` | 未触发 NODE_MODULE_VERSION 坑 |

## 七、决策与偏差记录

1. **任务书 vs 设计 API 形态**：edit 请求体同时接受设计 `op` 与任务书 `newText`/`ops` 形态；`confirm:'EDIT'` 为硬门（任务书明确），设计未列 confirm 但 S13 未开工、无既有消费者，以任务书为准。
2. **审计路径**：任务书 `<dataRoot>/agent/audit/source-edits.jsonl`（字段为设计 §7.2 超集：time/actor/objToken/relPath/op/beforeHash/afterHash/bytes/result）。
3. **header 切分**：把规范分隔空行 `-->\n\n` 计入 header 字节（generateHtmlHeader 返回值即含尾空行），正文编辑不触碰分隔行；非规范间距不吞并。
4. **revert 的构建活跃拒绝**：设计 §7.2 拒绝清单针对 edit；revert 同为原始库写者，按同一不变量扩展（已在 §六测试锚定）。
5. **`pushed` 后再次编辑**：`markSourceEditDirty` 会把行拉回 dirty（符合语义；pushed_at 清空）。
6. **trash purge all=1 遇 dirty 行**：跳过并计数上报（不可恢复删除不应因一篇带编辑文档整体失败）；单条/bulk 拒绝语义与设计一致。

## 八、回滚

- 代码回滚：revert 本报告 §一清单中的文件改动（sync-engine/local-map-store/types/index/trash/orphan-files/source-cleanup 均为追加式，可直接反向 patch；index.ts 删 sourcesRoutes 注册块）。
- 数据回滚：`source_edits` 为新表可整表 DROP；**注意设计 §13——删除行/回退版本后，已有 dirty 行的文档会恢复可同步覆盖，回滚前应先 revert 全部未写回编辑**（UI/CLI「放弃修改」或手动恢复备份）。
- 备份与审计文件位于 `<dataRoot>/source-edits/`、`<dataRoot>/agent/audit/`，与应用数据同生命周期，不影响原始库。

## 九、未覆盖/风险

- pushing→conflict 启动对账、push/preview 路由、`GET /api/mapping/content` 增 bodyHash/editState：S12/S13 职责（§五）。
- Electron/浏览器真机交互验证：S11 无 UI，API 行为已由 Hono `app.request` 层测试覆盖；S13 集成时真机过一遍。
- trash/orphan/source-cleanup 的守卫改动在共享树上与并行任务并存，全量绿已验证共存无冲突。
