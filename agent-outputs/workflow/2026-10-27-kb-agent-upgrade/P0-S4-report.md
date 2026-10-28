# P0-S4 报告：CloudHistoryService 回滚服务 + 轮询器 + 命令表 + 互斥门

- **日期**：2026-10-29 · **分支**：`feat/agent-knowledge-workbench`（共享树）
- **上游输入**：`lark-cli-newcaps-P0.md` §4.3/§4.4/§4.6（§4.1 行形态）、`P0-S2-report.md`（五方法契约：`listDocumentHistory`/`revertDocumentHistory{,Status}`，错误码 `10020 conflict`/`3380002 invalid_target`）、`P0-S3-report.md`（source_push_log 行形态/锚点规则/访问器）
- **下游消费者**：P0-S5 回滚 UI（本文 §一/§二 即消费契约）、P0-S9 标题同步（`cloud_revert_running` 门同源消费）

## 一、API（routes/feishu.ts 追加，DI 单例 `c.cloudHistoryService`）

| 路由 | 风险 | 语义 |
|---|---|---|
| `GET /api/sources/:objToken/push-log` | read | 写回记录倒序（≤50 行，`SourcePushLogRecord` 形态，含 revert_* 字段） |
| `GET /api/sources/:objToken/history?pageToken=&pageSize=` | read | 云端历史。**缺省分页聚合**（默认 3 页、硬上限 10 页；`truncated:true` + `nextPageToken` 续翻；has_more 无 token 时终止防死循环）；显式 pageToken 单页透传 |
| `POST /api/sources/:objToken/history-revert/preview` | read | 回滚计划 `HistoryRevertPlan`（body `{pushLogId}` \| `{historyVersionId}` 严格二选一） |
| `POST /api/sources/:objToken/history-revert` | destructive | 执行回滚。**confirm = `REVERT_CLOUD:<historyVersionId>`**（任务书：锚点版本 id 必须出现在确认值中；裸 `REVERT_CLOUD` 拒 400）；异步起步返回 **202** `{state:'running', taskId, pushLogId}`，同步完成 200 |

`HistoryRevertPlan.blockedReason` 值域（任务书增补 `invalid_target`）与 HTTP 映射：`write_disabled`/`scope_missing`→403；`local_edit_pending`/`kb_build_active`/`cloud_revert_running`→409；`anchor_missing`/`history_not_found`/`invalid_target`→422。warnings：`anchor_inexact`（push_log 源且 !anchorExact）、`cloud_changed_since_push`（云端 obj_edit_time > post_obj_edit_time ?? pre_obj_edit_time，只警告不阻断）、`cloud_time_unreadable`。

**关键裁定（任务书 > 设计差异）**：① revert 走 `--wait-timeout-ms 0` 异步起步（设计 §4.4 写 30000 同步等待，任务书定值 0，收敛统一交轮询器）；② 最新历史条目不可作目标——**本地预校验直接拒**（P0-S1 实测 3380002 两形态同码；云端仍返回 3380002 时映射 422 `invalid_target`）；③ 命令命名 `cloud.history_list`/`cloud.revert`（任务书），风险级 destructive（设计写 remote_write）；④ 回滚后**只触发单文档回拉**（与写回同一 `pullSyncSingleDocument` 入口），服务本身零 synced 基线写入。

## 二、互斥规则（cloud_revert_running，§4.4/§4.6）

- **共享状态**：`source_push_log.revert_state='running'` 行（新访问器 `getRunningRevertPushLog(objToken)` / `listRunningRevertPushLogs()`）。
- **互斥分支**：同一 objToken 回滚进行中 → 新回滚 409；**FeishuWriteService.push 409**（最小追加：push 顶部门 + preview `blocked(cloud_revert_running)`，S3 报告约束的"不改其代码路径"内——锁与状态机零改动，访问器缺失时按无回滚容错）；P0-S9 标题同步按同一访问器消费。
- **回滚行形态**：INSERT `mode='revert'`、`outcome='started'`、anchor_*=回滚前最新历史（回滚可再回滚，HP-2）→ 云端接受 → `outcome='pushed'`+`revert_state='running'`（async）或立即 `done`；3380002/10020/业务错误 → `failed`；timeout/不可解析 → `unknown`（非幂等**绝不自动重试**）。
- **门控顺序**（执行路径锁内复核）：write_disabled → scope_missing → kb_build_active → local_edit_pending（source_edits 有 dirty/pushing/conflict 行）→ cloud_revert_running → 目标校验（前 3 页 60 条内、非最新）→ confirm。
- 10020（云端并发单飞）→ 409 `cloud_revert_conflict`；轮询 done+failedBlockTokens 非空 → `revert_state='done'` 但 `revert_error=partial_blocks_failed:…`（HP-2 上抛）。

## 三、轮询器（服务内，index.ts 进程级单例）

- tick 5s 扫 tracked 行；**单行节奏 = revert 响应 poll_after_ms**（缺省 5s，下限 1s）；**单行总上限 10 分钟**（超时 → `unknown` + `poll_deadline_exceeded`）。四分支：done（`reverted_at` + 锁外回拉 best-effort）/ failed / running（续查）/ 超时→unknown。状态查询抛错不判终态，续查至上限。
- **启动对账**（index.ts，紧邻 S3 的 `markInterruptedSourcePushLogs`）：running 且有 task_id → 轮询续查（10 分钟窗口自续查起算）；无 task_id → unknown。close() 停轮询器（残留 running 行留待重启对账）。
- 审计 `<dataRoot>/agent/audit/source-pushes.jsonl`：事件 `history_revert_started|done|failed|unknown`，字段 objToken/pushLogId/historyVersionId/actor/approvalId?/taskId?/error?/failedBlockTokens?。

## 四、命令表（ops/command-table.ts；app-command-family.ts 零改动——批准流/确认剔除/confirmPlan 机制全复用）

| 命令 | 风险 | confirm | 说明 |
|---|---|---|---|
| `cloud.history_list` | read | — | GET history；pageToken 透传查询参数 |
| `cloud.revert` | destructive | `{field:'confirm', value:'REVERT_CLOUD'}`（表基线 = CLI --yes 门） | `request()` 内置 `REVERT_CLOUD:<historyVersionId>`（CLI 面）；`confirmPlan`：previewSpecs=preview（body `{historyVersionId}`），deriveConfirm 遇 blockedReason 抛 `history_revert_blocked`、否则返回 `REVERT_CLOUD:<id>`，`planKey = ${target.historyVersionId}|${warnings.sort().join(',')}` |

- CLI：`feishu-sync cloud revert <objToken> <historyVersionId>`（POSITIONALS 登记）；无 `--yes` → 退出码 4（cli-client e2e 实测）；命令仅收 historyVersionId（pushLogId 解析需 DB，纯函数 request() 不可达——UI/HTTP 面保留 pushLogId 通道，agent 走 preview 派生不受限）。
- app_command 端到端：destructive 需 Work 会话 + 逐次批准；批准卡 confirmValue 含目标 id；停止→ `approval_cancelled`，目标路由零命中（T3b-07/T3e-R3-02 既有机制，新命令零适配即工作）。
- 写面 actor：CLI/app_command 转发均记 `actor:'cli'`（与 source.push 既有形态一致；批准身份在 approvals 审计侧）。

## 五、产物清单

| 文件 | 改动 |
|---|---|
| `server/src/sources/cloud-history-service.ts` | **新文件**（782 行）：listCloudHistory / buildRevertPlan / revertToAnchor / 轮询器 / 审计 |
| `server/src/modules/local-map-store.ts` | +3 访问器（getRunningRevertPushLog / listRunningRevertPushLogs / updateSourcePushLogRevert）；DDL 零改动（revert_* 列 S3 已建） |
| `server/src/sources/feishu-write-service.ts` | 最小追加：`hasRunningCloudRevert` + push 顶部 409 门 + preview blocked 分支；锁/状态机/三段式零改动 |
| `server/src/routes/feishu.ts` | +4 路由 + `createCloudHistoryService` 导出（index.ts 单例构造面）+ 错误映射含 CloudHistoryError |
| `server/src/index.ts` | 单例构造 + resumeRunningReverts + startPoller + DI 注入 + close() stopPoller |
| `server/src/ops/command-table.ts` | +2 命令（cloud.history_list / cloud.revert） |
| `server/src/cli/args.ts` | POSITIONALS +2（cloud.*）；另修复并行合并事故：恢复被 P0-S8 改写掉落的 S13 `source.edit-status`/`source.edit` 两行 |
| `server/src/types/index.ts` | SourcePushPlanDto.blockedReason union + `cloud_revert_running`（一行） |
| `server/tests/cloud-history.test.ts` | **新文件**，45 用例（分页聚合 5 / 计划矩阵 9 / 执行四分支与门控 11 / push 互斥 3 / 轮询器 7 / 路由 5 / app_command 5） |
| `server/tests/ops-command-table.test.ts` / `cli-args.test.ts` / `cli-client.test.ts` | +cloud.* 断言（含 confirmPlan 派生/planKey/CLI 无 --yes→4）；命令计数 30→36（兄弟 +4） |

## 六、验证证据（cwd=server）

| 项 | 命令 | 结果 |
|---|---|---|
| 主套件 | `npx vitest run tests/cloud-history.test.ts` | exit 0，45/45 |
| 表/CLI 单元 | `npx vitest run tests/ops-command-table.test.ts tests/cli-args.test.ts` | exit 0，46/46 |
| 兄弟面回归 | `npx vitest run tests/source-push.test.ts tests/local-map-store.test.ts tests/app-command-family.test.ts tests/cli-source-commands.test.ts tests/lark-cli-client.test.ts tests/source-edit.test.ts` | exit 0，192/192 |
| CLI e2e（真实 server + CLI 子进程） | `npx vitest run tests/cli-client.test.ts` | exit 0，17/17（含新 cloud revert 无 --yes→4；同时冒烟了 index.ts 单例接线启动） |
| index 依赖面 | `npx vitest run tests/cli-endpoint.test.ts tests/agent-status-regression.test.ts tests/agent-approvals-routes.test.ts` | exit 0，33/33 |
| 类型 | `npx tsc --noEmit` | **本任务文件零错误**；全局余 2 处错误均属兄弟中间态（sync-engine.ts 的 WhiteboardBackfill* 类型未落、agent-tool-service.ts 未用 import——P0-S6/S7 写面），非本切片改动 |

## 七、撞写记录

- **P0-S8 并行改写 `src/cli/args.ts`**：其 POSITIONALS 重写基于过期快照，掉落 HEAD 既有 S13 两行（`source.edit-status`/`source.edit`，cli-args 测试会红）；我按共享树纪律只恢复掉落行、保留双方新增（cloud.* + sync.whiteboard_backfill），未动其内容。若 P0-S8 后续重写该块，请以当前 diff 为准。
- 命令计数断言 30→36：兄弟（P0-S8 `sync.whiteboard_backfill`、P1-S8 `kb.publish*`×3）+4 与本任务 +2。
- typecheck 全局 exit≠0 由兄弟 sync-engine/agent-tool-service 中间态导致；隔离快照结算时以兄弟合入后为准。

## 八、未覆盖 / 风险

- **SourceEditService edit/revert 未挂 cloud_revert_running 门**（设计 §4.4 提及、任务书未列）：回滚 running 期间新建本地脏编辑的窗口存在——后果限于"done 后回拉被脏状态阻断，交检测链后续收敛"（不变量 1a 保证不覆盖）；如需闭环建议 P0-S9（同消费该门）顺带补。
- `cloud.revert` CLI/agent 面只收 historyVersionId；pushLogId 回滚仅 UI/HTTP（报告 §四）。
- P0-S5 UI 需按 §一 preview → execute 两段流（execute 前必须先 preview 拿 `target.historyVersionId` 组 confirm 值）。
- 轮询器 10 分钟窗口自"轮询器首次见到行"起算（重启续查后重新计时），非 revert 发起时刻——DB 无发起时间列，属保守偏差（可能多轮询、不会提前 unknown）。
- Electron 真机链路（写回→回滚→回拉正文恢复）属 P0-S5 验收，本切片以服务/路由/命令/批准流为界。

## 回滚方式

改动集中：新文件×2（service+test）+ 7 文件纯增量块（store 访问器、write-service 门、feishu 路由段、index 接线、命令表两条、POSITIONALS 两行、types 一行）。表结构零变更（列已存在）；按共享树纪律以精确 diff 反向恢复，`git checkout` 须经 Leader 授权。
