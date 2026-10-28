# P0-S3 报告：source_push_log 写前锚点 + push 时序修订

- **日期**：2026-10-28 · **分支**：`feat/agent-knowledge-workbench`（共享树）
- **上游输入**：`lark-cli-newcaps-P0.md` §4.1/§4.2（U22/U23）、`P0-S2-report.md` §一（`listDocumentHistory` 签名：`listDocumentHistory(objToken, {pageToken?, pageSize?}) → DocumentHistoryPage`，条目含 `historyVersionId/revisionId/editTime/type`）、`P0-S1-probe.md`（HP-4 历史异步定型 → U23 保守设计）
- **下游消费者**：P0-S4 回滚服务（`revert_*` 列 + `listSourcePushLogs` + `getSourcePushLog` + `updateSourcePushLog`）、P0-S5 UI（preview `rollbackAnchor` 字段 + push-log 行形态）

## 一、产物清单

| 文件 | 改动 |
|---|---|
| `server/src/types/index.ts` | `SourcePushLogRecord`（表行 camelCase 投影）+ `SourcePushPlanDto` 增 `rollbackAnchor`/`anchorBlockedReason` 字段、`blockedReason` union 增 `rollback_anchor_unavailable` |
| `server/src/modules/local-map-store.ts` | `source_push_log` 表 additive 双登记（`applyAdditiveMigrations` 新表 exec + `getCreateTablesDDL()`）+ 访问器 6 个（§二） |
| `server/src/sources/feishu-write-service.ts` | push 时序修订（§三）+ preview 锚点字段（§四）+ `fetchRollbackAnchor`/`computeAnchorExact`/`safeUpdatePushLog` |
| `server/src/ops/command-table.ts` | `source.push` confirmPlan.planKey 改 `${mode}\|${anchorAvailable}`（§四） |
| `server/src/index.ts` | 启动对账接线：`markInterruptedSourcePushLogs()`（紧邻既有 `markInterruptedSourceEditPushes()`） |
| `server/tests/source-push.test.ts` | +8 用例（P0-S3 describe）+ makeLarkStub 默认 `listDocumentHistory` 锚点 + 1 处 ops 序列断言适配 |
| `server/tests/local-map-store.test.ts` | +5 用例（双登记/insert-list/update 四态/对账/prune） |

锁、`source_edits` 状态机、append/overwrite 三段式协议**零改动**（约束遵守：`pushLocked` 只在时间门与执行段之间插入取锚/落行步骤）。

## 二、锚点行形态（P0-S4/S5 消费契约）

DDL（两处登记字节一致；`revert_*` 列本切片只建列，S4 写值）：

```sql
CREATE TABLE IF NOT EXISTS source_push_log (
  id TEXT PRIMARY KEY,                 -- sp_<yyyymmddHHMMSS>_<6hex>
  obj_token TEXT NOT NULL,
  local_rel_path TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('append','overwrite','revert')),
  actor TEXT NOT NULL,                 -- ui|cli|agent
  pre_obj_edit_time TEXT,              -- 写前云端 obj_edit_time（force 时尽力补读，可空）
  anchor_history_id TEXT,              -- 写前最新 history_version_id（回滚锚点）
  anchor_history_time TEXT,
  anchor_exact INTEGER NOT NULL DEFAULT 0,  -- 锚点时间 ≥ 写前云端时间（秒级取整；任一侧不可读 → 0 保守）
  anchor_error TEXT,                   -- 取锚失败原因（仅 append 空锚继续）
  post_revision_id TEXT,               -- 写后 revision（成功时）
  post_obj_edit_time TEXT,             -- 回拉成功后抄录 SyncEngine synced 值（只读）
  outcome TEXT NOT NULL CHECK(outcome IN ('started','pushed','conflict','failed','unknown')),
  revert_state TEXT, revert_history_id TEXT, revert_task_id TEXT,
  revert_error TEXT, reverted_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_push_log_token ON source_push_log(obj_token, created_at);
```

**outcome 四态迁移（任务书 `committed` ↔ 设计 §4.2 `pushed` 名称裁定：采用设计值 `pushed`）**：

| 事件 | outcome | 对应 source_edits |
|---|---|---|
| 写前落行（§4.2 步骤 4） | `started` | pushing |
| 写入成功 | `pushed` + `post_revision_id` | pushed |
| conflict 类（revision 未来值/回读失配/前置冲突） | `conflict` | conflict |
| 非 conflict 失败（fetch 失败等未写入） | `failed` | dirty |
| `push_outcome_unknown`（超时/回读读不回——写入结果未知） | `unknown` | conflict |
| 启动对账：`started` 残留 | `unknown`（不自动判定成败） | —（pushing→conflict 由既有 S12 对账负责） |

**LocalMapStore 访问器**：`insertSourcePushLog(input) → id`、`getSourcePushLog(id)`、`listSourcePushLogs(objToken, limit=20)`（created_at 倒序）、`updateSourcePushLog(id, {outcome?, postRevisionId?, postObjEditTime?})`（post* 走 COALESCE，NULL 保留原值）、`markInterruptedSourcePushLogs() → 行数`、`pruneSourcePushLogs(keepPerToken=50)`（跳过 `revert_state='running'` 行，§4.1 保留策略）。

## 三、push 时序修订（§4.2，锁与状态机不变）

```
pushLocked（持锁，时间门之后）：
 3. fetchRollbackAnchor：listDocumentHistory(token, {pageSize:5}) → entries[0]
      overwrite 无锚（entries 空或 entries[0].historyVersion_id 空/调用失败）
        → 回退 pushing→进入时状态（原 dirty→dirty；原 conflict→conflict）
        → 422 source_push_blocked {reason:'rollback_anchor_unavailable'}；force 不可越过
        （force 语义是「接受覆盖云端新改动」，不是「放弃回退点」——force 唯一不能越过的门）
      append 无锚 → anchor_error 记原因（上游码或 history_list_empty）继续
 4. insertSourcePushLog(outcome='started')（日志写入失败 → fail-closed 500 拒绝写回，
    source_edits 回 dirty——锚点记不下来时 overwrite 无可用回退点记录）
 5. 执行 append/overwrite 三段式（既有，零改动）
 6. 成功 → updateSourcePushLog('pushed', post_revision_id)
    失败 → 'conflict' | 'unknown'(push_outcome_unknown) | 'failed'（映射见 §二表）
 7. 锁外回拉成功 → getDocumentByObjToken().syncedObjEditTime 抄进 post_obj_edit_time
    （best-effort：只读抄录，失败仅记控制台，不改变推送结果）
```

- 取锚在时间门**之后**（时间门失败不浪费 history 调用、不留无意义锚点）。
- overwrite 无锚时**不落锚点行**（步骤 3 拒绝在步骤 4 前），审计记 `result:'blocked', errorCode:'rollback_anchor_unavailable'`。
- push 执行结果 DTO 新增 `pushLogId: string | null`（S5 UI/CLI 可直接定位本行）。

## 四、preview / planKey 字段（S5 UI 消费）

`POST /api/sources/:objToken/push/preview` 新增（preview 实际调用一次 history-list，只读）：

```ts
rollbackAnchor: {
  historyVersionId: string;   // null = 无锚
  revisionId: number | null;
  historyTime: string | null;
  exact: boolean;             // U23：false 时 UI 明示「回滚点早于写前状态」
} | null
anchorBlockedReason?: 'rollback_anchor_unavailable'
```

- overwrite 无锚 → preview 即 `blocked(rollback_anchor_unavailable)` + `anchorBlockedReason`（批准前暴露）。
- append 无锚 → `rollbackAnchor=null` + warning（`写回锚点不可用（<原因>）…`），不阻断。
- `planKey = ${mode}|${anchorAvailable}`（`anchor`/`noanchor`）：批准期间锚点从有到无（或反向）→ `approval_plan_expired` 重新批准。

## 五、验证证据

| 项 | 命令（cwd=server） | 结果 |
|---|---|---|
| 任务书自验口径 | `npx vitest run tests/sync-engine.test.ts tests/source-edit.test.ts tests/source-push.test.ts tests/local-map-store.test.ts` | exit 0，**137/137 passed**（source-push 64=56 既有+8 新；local-map-store 19=14 既有+5 新） |
| 兄弟面回归 | `npx vitest run tests/ops-command-table.test.ts tests/source-edit.test.ts tests/cli-source-commands.test.ts tests/lark-cli-client.test.ts tests/app-command-family.test.ts` | exit 0，114+23=137 passed |
| 类型 | `npx tsc --noEmit` | exit 0 |

新增用例覆盖：overwrite 无锚（空列表/抛错/force）blocked + 状态回退 + 零锚点行零写入；append 无锚警告推送 + `anchor_error` 落库；四态迁移（pushed/failed/unknown/conflict 各一真实链路）；重启对账 started→unknown（终态不动）；preview 三形态（有锚/append 无锚/overwrite 无锚）；anchor_exact 边界（锚点早于写前时间→false）；planKey 锚点派生；迁移双登记（fresh 建表+列序+索引、DDL 文本、DROP 后重建）；prune 50 行保留+running 跳过。

既有测试适配仅 2 处（语义不变）：makeLarkStub 默认加 `listDocumentHistory`（任务书允许「只加 mock」）；overwrite 成功链路的 lark 调用序列断言 `['fetchRevision','overwrite','fetchBody']` → `['historyList','fetchRevision','overwrite','fetchBody']`（新调用步骤是本切片验收行为）。

## 六、撞写记录（并行提示项）

- **P1-S8（kb_publications）**：落笔时 `local-map-store.ts` 无 kb_publications（grep 零命中）——本任务先到；P1-S8 落表时需重读本文件后再追加（我的块在 agent_tasks 之后、`source_push_log` 独立段落，无锚区重叠）。
- 共享树既有未提交改动（`routes/feishu.ts` optionalScopes、`sync-engine.ts`、`config-manager.ts`、`lark-cli-manager.ts`、`custom-folders.*` 等属 P1 兄弟任务）——零触碰；`local-map-store.ts`/`source-push.test.ts` 的 diff 已逐行核实只含本任务改动。

## 七、未覆盖 / 风险

- `GET /api/sources/:objToken/push-log` 查询路由与 `source.push-log` 命令是 §4.3/S4 切片——本切片只落表与写入侧，S4 接消费。
- `revert_*` 列、`cloud_revert_running` 门、S4 轮询器均未实现（S4 范围）。
- append 的 `anchor_error` 记上游错误码字符串（如 `99991400`/`timeout`），非结构化——S5 UI 直接展示原文即可。
- `pruneSourcePushLogs` 已实现并测试，但尚未接线到写回链自动清理（每 token 50 行上限；S4/S5 接入时在 push 成功后调用，或由启动对账顺带执行——留给 S4 决定，避免本切片越界改时序）。

## 回滚方式

改动集中在 5 个源文件的纯增量块 + planKey 一处改写：`git checkout` 前须经 Leader 授权；按共享树纪律以精确 diff 反向恢复（local-map-store 两段 DDL+访问器块、feishu-write-service 取锚/落行/preview 块、command-table planKey 函数、index.ts 对账 4 行、types 两块、两测试文件新增 describe 与 stub 默认项）。表 additive：旧版本应用忽略 `source_push_log`，无需数据迁移逆操作。
