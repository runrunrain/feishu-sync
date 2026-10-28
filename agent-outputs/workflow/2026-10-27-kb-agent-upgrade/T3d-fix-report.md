# T3d 修复报告：diting R2 终审 8 项 findings（1 Critical + 7 Major）

- 基线：`T3b-r2-diting-review.md`（VERDICT: FIX，逐项定位/触发/证据均以其为准）。
- 范围：8 项逐项修复 + 逐项测试；附带 2 个修复过程中实测复现的连带缺陷（见 §3）。
- 全部改动仅限写面内文件（server 源码 + server 测试）；无写面外改动。

## 1. 逐项：finding → 修复 → 测试锚点 → 结果

### R2-01 [Critical] task_resume/task_cancel 跨会话越权 — FIXED

- 修复：
  - `server/src/agent/tasks/task-service.ts`：`cancel`/`resume` 新增可选 `options.callerSessionId`；任何状态修改/结果返回/调度之前经 `assertOwnership` 校验 `row.session_id === callerSessionId`，不匹配 → `task_not_owned_by_session` 403。不传（desktop 面板路由）保留独立全局授权契约，行为不变。
  - `server/src/agent/tasks/task-tools.ts`：task_resume/task_cancel 执行器消费 `requireParentSession` 返回的调用方会话 id，传入 `{ callerSessionId }`。
  - `server/src/routes/agent.ts`：desktop 路由注释标明契约差异（不传 callerSessionId）。
- 测试：`server/tests/agent-tasks.test.ts` `R2-01 describe`——A/B 双会话：B resume/cancel A 的 blocked 任务 → 403、状态未动、零新 spawn、`resume_answers_json` 零写入；A 同会话工具面 resume → queued → done；desktop 入口（不传 callerSessionId）cancel 回归。
- 结果：✅ `tests/agent-tasks.test.ts` 27/27（含 3 次连续全绿复跑）。

### T3b-05R [Major] append+allowOverwrite 确认值回归 — FIXED

- 修复（按 diting 方向：server 批准前取权威 plan 派生）：
  - `server/src/ops/command-table.ts`：新增 `OpsConfirmPlan`（`previewSpecs`/`deriveConfirm`/`planKey`）挂到 `source.push`；派生规则与 `FeishuWriteService.pushLocked` 同一契约：`plan.mode === 'overwrite' || force → 'OVERWRITE_CLOUD'，否则 'PUSH'`（append+allowOverwrite 仍 PUSH）；plan blocked → `source_push_blocked` 快速失败（不产生批准）。`OpsArgumentError.code` 放宽为 string（新增非 invalid_args 码）。
  - `server/src/agent/tools/app-command-family.ts`：挂 confirmPlan 的命令在 begin 批准前经内部 preview 请求取得真实 plan → 派生确认值；批准卡 `preview.confirmValue` 与执行注入**同一派生值**（覆盖 request() 的静态猜测）；批准后执行前复核 planKey（plan.mode 变化 → `approval_plan_expired` 409 拒执行，重新发起即重新批准）。CLI 通道（routes/cli.ts）不受影响（静态基线值 + 服务端最终裁决）。
- 测试：
  - 真实服务全链（任务书要求的四态）：`server/tests/source-push.test.ts` `T3d-05R describe`——真实 feishuRoutes + 真实 FeishuWriteService + 真实 ApprovalService：append(PUSH)/append+allowOverwrite(PUSH，回归锚点)/overwrite(OVERWRITE_CLOUD，lark overwrite 实调)/force+append(OVERWRITE_CLOUD，append 执行)；计划过期（批准前 append→overwrite → 409、lark 零写、行保留 dirty）。
  - 工具族面（preview 派生/批准卡展示/blocked/过期）：`server/tests/app-command-family.test.ts` `T3d-05R 用例`（重写原 T3b-05 mock 用例——其 stub 与真实服务契约不符，正是 diting 指出的证据缺口）。
- 结果：✅ `tests/source-push.test.ts` 51/51；`tests/app-command-family.test.ts` 23/23。

### T3b-07R [Major] 批准缺 runId/epoch 绑定 — FIXED

- 修复（工具请求与批准绑定 server 权威轮次标识）：
  - `server/src/agent/session-service.ts`：`tool_execution_start` 事件记录 toolCallId → runId 归属（每会话有界 512 条 FIFO）；新增 `currentRunId(sessionId)` 与 `runOfToolCall(sessionId, toolCallId)`；会话删除时清理。
  - `server/src/agent/agent-tool-service.ts`：`executeTool` 增加可选 `meta.toolCallId` 透传（`ToolRequestMeta`，族 execute 第三参，additive）。
  - `server/src/routes/agent-internal.ts`：内部工具 API 把请求体 `toolCallId` 透传给 executeTool。
  - `server/src/agent/tools/app-command-family.ts`：非 read 命令在产生批准请求**之前**校验 `toolCallRun(sessionId, toolCallId) === currentRunId(sessionId)`——旧轮迟到 HTTP 请求（toolCallId 属于已结束轮/未知）→ `stale_tool_request` 409，零批准零执行；批准后执行前再复核 `currentRunId === 批准所属轮`（abort/新轮使旧批准失效 → `approval_round_expired`）。
  - `server/src/agent/approvals/approval-service.ts`：`begin` 记录 `runId`，`ApprovalRequestDto` 增 `runId`（批准卡可展示所属轮）。
  - `server/src/index.ts`：生产接线 `toolCallRun`/`currentRunId`。
- 测试（真实流时序，非 stub runState）：`server/tests/app-command-family.test.ts` `T3b-07R describe`——真实 SessionService + 复用进程：run1 运行中 pi 发起 tc_r1 → run1 结束 → run2 开始（同进程同令牌）→ 迟到请求携 tc_r1 → 409 stale_tool_request、pendingCount=0、目标路由零命中；同轮 tc_r2 → 批准卡 `runId === run2.runId`、批准 → 执行成功。
- 结果：✅ 上述用例通过；`tests/approval-service.test.ts`/`agent-approvals-routes.test.ts`（runId additive）回归绿。

### R2-02 [Major] 任务派发用父会话当前 Workspace 而非冻结值 — FIXED

- 修复：`server/src/agent/tasks/task-service.ts` `dispatchRound` 按**任务冻结的 `workspace_id`** 从当前配置解析 workspace path（不再读父会话当前值）；Workspace 不在配置 → `task_workspace_unavailable` 403 → 任务显式 failed（审计经 task_update SSE），零 spawn，不静默转授。`resolveTaskWorkspaceRoot` 签名改为 `(workspacePath, outputDir)`（围栏语义不变）。
- 测试：`server/tests/agent-tasks.test.ts` `R2-02 describe` 三场景——排队中切 W2（派发仍用冻结 W1、W2 零创建）；blocked 后切 Discuss（resume 仍用冻结 W1 完成）；冻结 Workspace 移除（resume → failed(task_workspace_unavailable)、零新 spawn）。
- 结果：✅ 27/27。

### R2-03 [Major] blocked→旧 dispatch 未清理时 resume 丢调度 — FIXED

- 修复：`server/src/agent/tasks/task-service.ts` `kickDispatch` 的 finally：删除旧 dispatch 条目后**原子复查**该 task 是否 queued（resume 发生在清理窗口）→ 补派发；同步置位防重入、非 queued 即停（不会循环）。
- 测试：`server/tests/agent-tasks.test.ts` `R2-03 describe`——可控延迟 terminate（FakeTaskRpc `terminateDelay` 门）复现「blocked SSE→resume（零新 spawn、queued 被挡）→释放」：恰好一次新 spawn（rpcs=2）且终态 done。修复前该时序任务永远 queued（vitest 全量实测复现）。
- 结果：✅ 27/27（3 次连续复跑稳定）。

### R2-04 [Major] kb_delete_doc 路径别名绕过认领 — FIXED

- 修复：`server/src/agent/agent-tool-service.ts` `toolKbDeleteDoc` 在认领与触盘之前补 `validateStdDocPath(docPath)`（与 kb_write_doc 同一合法规范路径门：拒绝 `./`/`..` 段、反斜杠、绝对路径、非 .md、隐藏段、深度>6）。
- 测试：`server/tests/agent-internal-auth.test.ts` `R2-04 用例`——双 worker 真实工具链（buildServer 内部 API + 真实 PathClaims）：u1 认领写入 `topic/a.md`；u2 以 `topic/./a.md`、`topic\a.md`、`topic/../topic/a.md` 删除 → 400 invalid_request 且原文件字节不变、认领账本零新增别名键；规范路径他单元删除 → 409 kb_path_owned_by_other_unit；持有者规范路径删除照常成功。
- 结果：✅ `tests/agent-internal-auth.test.ts` 11/11。

### R2-05 [Major] 插件管理不算 task 活跃 + frozenSnapshot 混入当前原生资源 — FIXED

- 修复（三道防线）：
  1. `server/src/index.ts`：PiPluginService `running` 门纳入 `(tasks.service?.hasPendingWork(localMapStore) ?? false)`——queued/running/blocked 任一存在即 `plugin_busy` 拒绝 install/update/remove/toggle。`TaskService.hasPendingWork` 消费新查询 `LocalMapStore.hasActiveAgentTasks`（`server/src/modules/local-map-store.ts`）。
  2. `server/src/agent/agent-process-pool.ts`：`retireIdle` 只回收 `kind === 'session'` 且非 busy 的进程（task/build 进程由各自生命周期管理，不因插件管理被误杀）；另 `TaskService` 轮运行期间对 `task:<id>` 显式 `setBusy(true/false)`（`task-service.ts` dispatchRound register/finally 成对）。
  3. `server/src/agent/app-plugin-store.ts`：`frozenSnapshot` 读取快照文件内的 `nativeRevision` 与当前 `nativeResources().revision` 比对——不一致（插件在任务冻结后被增删改）→ 抛 `plugin_snapshot_stale`（任务显式 failed，诚实阻断），**不再把当前最新 native 资源装进旧 revision 快照**；快照文件缺失仍按既有语义返回 null 降级；未注入 nativeResources 的实例（纯文本插件形态）不比对。
- 测试：
  - `server/tests/agent-tasks.test.ts` `R2-05 describe`：`hasPendingWork`（queued/running/blocked→true，终态→false）；blocked 后 native 资源变更 → resume 显式 failed(plugin_snapshot_stale)、零新 spawn（真实 AppPluginStore + 可变 nativeResources + 与生产同构的快照门）。
  - `server/tests/app-plugins.test.ts` `R2-05 describe`：frozenSnapshot 版本一致返回快照 / 变化抛 stale / 未知 revision 仍 null。
  - `server/tests/agent-process-pool.test.ts` `R2-05 describe`：retireIdle 回收空闲会话、不回收 busy 会话与 task/build 进程。
- 结果：✅ 三文件全绿（21/21、27/27 等，见 §4 汇总）。

### R2-06 [Major] vision 限额前全量读入 Buffer — FIXED

- 修复：`server/src/agent/vision/vision-describer.ts`：
  - `describeMany` 重写为有界流水：逐项 `statSync` 尺寸（超限单图**不读即拒**）→ 读取→哈希→查缓存（命中即释放字节，不占配额）→ 仅配额内未缓存图保留 bytes 进入并发描述队列；**配额满后剩余文件不再 stat/读取**，直接标 `limit`。在途字节上限 = quota × maxImageBytes，不随全工作集无界增长；读取后保留超限复核（stat/读取竞态兜底）。
  - `describeOne` 同口径 stat 先行。
- 测试：`server/tests/vision-describer.test.ts` `R2-06 两用例`——10 张未缓存图 + quota=3：`fs.readFileSync` spy 断言图片文件读取 ≤3、described=3、limit=7、远端调用=3；maxImageBytes=8 的超限图（describeOne/describeMany）stat 直接拒绝、零读取零触网。
- 结果：✅ `tests/vision-describer.test.ts` 11/11。

## 2. 修复中实测复现并一并修掉的连带缺陷（均在写面内）

1. **任务 dispatch 拆除期 SqliteError 循环放大（vitest 全量 100% CPU 挂死）**：R2-03 补派发的 finally 复查在测试拆除（`afterAll` 未 await `closeAll` 即 `rmSync` 临时根）后撞上已删除的 store，`finish→updateAgentTask` 抛 SqliteError 逃逸出 dispatch promise 链，被微任务循环放大（CDP 抓栈实证：`SqliteError←updateAgentTask←finish←dispatchRound`）。修复：`task-service.ts` 三处（kickDispatch finally / dispatchRound catch / acquire 失败落库）全部 best-effort 包裹不再抛出；`agent-tasks.test.ts` afterAll 改为先 `await pool.closeAll()` 再删临时根。修复前全量文件挂死、修复后 3 次连跑稳定（27/27）。
2. **同毫秒任务 id 乱序闪断（既有用例「取消排队中任务」queuePosition 1≠2 随机失败）**：任务 id `t_<ms36>_<random>` 在同毫秒提交时按随机后缀排序，`queuePosition` 的 `created_at|id` 键乱序。修复：id 内嵌进程级单调序号（`task-service.ts` `taskSequence`），同毫秒按提交序。根因属既有缺陷，非本次 8 项之一，但不修无法满足「全量全绿」验收。

## 3. 行为变化与注意点（面向审核/后续）

- app_command `source.push` 现在在批准前与批准后各执行一次内部 push/preview（各一次 lark metas+revision 读取）；plan blocked 不再产生批准请求（400 快速失败）；批准期间计划变化 → 409 approval_plan_expired。
- `ApprovalRequestDto` 新增 `runId`（additive，前端批准卡可展示但不依赖）。
- 跨轮迟到工具请求（toolCallId 属于旧轮）在产生批准前被拒（409 stale_tool_request）。绑定依赖 pi 下发的 toolCallId（转发扩展始终携带）；空 toolCallId 或未接线的调用面（测试/非会话场景）不启用该校验。
- R2-06 下，配额满后的剩余项不再做尺寸/格式分类（统一 `limit`；超限/缺文件项在配额未满时仍按 `too_large`/`missing_file` 分类）。
- `frozenSnapshot` native 版本失配抛 `plugin_snapshot_stale`（任务 failed）；配合 running 门（有 pending task 时插件管理被拒），失配只应出现在重启后/外部改动等旁路场景。
- diting 遗留观察（未在本批范围）：raw_read_image 取消不传 signal、SyncEngine getPendingLocalEditState fail-open、CLI 写授权便捷入口、Windows 大小写不敏感卷路径别名。

## 4. 验证汇总（真实命令与结果）

| 验证 | 命令（cwd） | 结果 |
|---|---|---|
| server 全量 | `cd server && npm test` | ✅ 90 files / 1207 tests 全绿（13s） |
| server 类型 | `cd server && npm run typecheck` | ✅ 0 错误 |
| 根全量 | `npm test`（root） | ✅ 27 files / 237 tests |
| 根类型（含 server 三段） | `npm run typecheck`（root） | ✅ EXIT=0 |
| Lint | `npm run lint`（root） | ✅ 0 errors（3 个既有前端 warning，与本次改动无关） |
| 稳定性复跑 | agent-tasks 单文件 ×3 | ✅ 27/27 ×3（原挂死路径） |

- ABI：全程系统 Node（better-sqlite3 ABI 137）验证，未触发 Electron ABI 切换。
- 未验证/盲区：未做真实 Electron 打包与真机浏览器交互（本批全部为 server 侧逻辑）；T3b-07R 的绑定依赖 pi 实际下发的 toolCallId 事件流，测试中以受控 RPC double 发同构事件（run/timing 状态为真实 SessionService 流转）；index.ts 组合接线（running 门 + toolCallRun）经类型检查与代码走查确认，未做 buildServer 级端到端注入。

## 5. 改动文件清单与回滚

源码（14）：`server/src/agent/tasks/task-service.ts`、`tasks/task-tools.ts`、`tools/app-command-family.ts`、`approvals/approval-service.ts`、`agent-tool-service.ts`、`session-service.ts`、`agent-process-pool.ts`、`app-plugin-store.ts`、`vision/vision-describer.ts`、`routes/agent-internal.ts`、`routes/agent.ts`、`ops/command-table.ts`、`modules/local-map-store.ts`、`index.ts`。
测试（7）：`server/tests/agent-tasks.test.ts`、`app-command-family.test.ts`、`source-push.test.ts`、`agent-internal-auth.test.ts`、`agent-process-pool.test.ts`、`app-plugins.test.ts`、`vision-describer.test.ts`。

回滚：`git checkout -- <上述 21 个文件>`（全部为未提交工作区改动；无迁移/无新文件/无配置变更，无其他收尾动作）。排障期间的临时脚本与 bisect 备份均已清理，仓库内无残留（`git status` 仅列本清单 + 上游评审报告 untracked）。
