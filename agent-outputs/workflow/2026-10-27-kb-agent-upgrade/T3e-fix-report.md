# T3e 修复报告：diting R3 终验 4 项（3 Major + 1 Minor）

上游输入：`T3b-r3-diting-review.md` §②（R3-01～R3-04 定位/触发/证据/最小修复方向）。
本报告：逐项 → 修复 → 测试锚点 → 验证。所有验证为真实执行（命令 + cwd + 退出码）。

## R3-01 [Major] force 推送被非 force preview 的 blocked 语义截断

**修复**（preview 表达本次执行语义；时间门可 force 越过、权限/内容 blocker 不可越过）：

- `server/src/sources/feishu-write-service.ts`：`preview(objToken, options?: { force? })`——`force=true` 时 `cloud_time_unreadable` 时间门降为 warning、保留 append/overwrite 计划（与 `pushLocked` 的 force 契约一致）；`write_disabled`/`write_scope_missing`/`no_changes` 等权限/内容 blocker 在时间门之前赋值，不受 force 影响，仍 blocked。非 force 行为逐字节不变（`&& !force` 仅放宽分支）。
- `server/src/routes/feishu.ts`：`POST /api/sources/:objToken/push/preview` 解析可选 body `{force}`（缺省/非 JSON 体 → false，向后兼容）；`source.push-preview` CLI 命令无 body，语义不变。
- `server/src/ops/command-table.ts`：`source.push` 的 `OpsConfirmPlan.previewSpecs` 在 `args.force === true` 时携带 `body:{force:true}`（与实际执行同参）→ force + metas 不可读时 preview 返回 append 计划，`deriveConfirm` 派生 OVERWRITE_CLOUD 批准卡照常产生；权限/内容 blocked 时 `deriveConfirm` 仍统一拒绝（未放宽）。

**测试锚点**：

- `tests/source-push.test.ts` §F `R3-01：metas 不可读…非 force：blocked 无批准卡；force：OVERWRITE_CLOUD 批准卡并可执行`——真实 feishuRoutes 全链：`getDocumentMetas` 抛错 → 非 force `source_push_blocked` 400、零批准卡、零写入；force → 批准卡 `confirmValue=OVERWRITE_CLOUD` → 批准 → append 真实执行。
- `tests/source-push.test.ts` §F `R3-01 对照：权限类 blocker 不可被 force 越过`——写 scope 缺失 + force 仍 `source_push_blocked`、零写入、行保持 dirty。
- `tests/ops-command-table.test.ts` `T3e-R3-01：…previewSpecs 与实际执行同参`——previewSpecs body 断言 + deriveConfirm 对 blocked 权限类拒绝 / force+append → OVERWRITE_CLOUD。

## R3-02 [Major] 批准后异步 plan 复核重开停止窗口

**修复**（复核紧前再查本轮可执行 + 取消传播到复核链）：

- `server/src/agent/tools/app-command-family.ts`：提取 `assertRoundExecutable()`（aborting/idle → `approval_cancelled`；runId 不一致 → `approval_round_expired`），批准后与**异步复核 preview 完成后、派发 mutation 紧前**各查一次（同一判定两处使用，原批准后两段重复检查收拢为该函数）；新增 `raceAbortSignal()`——复核 preview 与会话停止信号 `AbortSignal` 竞速，停止触发立即按停止处理（底层 preview 只读、结果弃置），不等它返回。
- `server/src/agent/session-service.ts`：新增 `abortSignal(sessionId)`（一次性停止信号源，触发自清理）；`abort()` 停止请求即 `fireAbortSignals`；会话删除时随会话状态一并丢弃。**信号仅在显式停止时触发**；换轮/运行结束由复核点 runId/runState 检查兜住（correctness 不依赖信号时序）。
- `server/src/index.ts`：接线 `sessionAbortSignal: (sid) => sessionService.abortSignal(sid)`。

**测试锚点**（`tests/source-push.test.ts` §G，真实 SessionService + 真实 feishu 路由 + 真实 ApprovalService，`getDocumentMetas` 第 2 次调用（批准后复核 preview）门控挂起）：

- `停止：…abort 立即拒绝；释放挂起 preview 后仍零写入`——批准后 preview 挂起 → `sessions.abort` → 立即 `approval_cancelled`（不等 preview）；释放挂起 preview 后被弃置链路**不补发写入**，行保持 dirty。
- `换轮：run1 结束 + run2 开始 → 释放复核 preview → approval_round_expired，零写入`——复核点 runId 检查路径。
- `对照（不停止）：复核 preview 释放后计划未变 → 正常执行 append`——同链路不停止则照常写入。
- 批准卡 `dto.runId === run1.runId`（权威轮次绑定回归锚点）。

## R3-03 [Major] 读成功/写失败时 queued 无界重派

**修复**（调度/落库失败停止该任务自动重派，有限收敛）：

- `server/src/agent/tasks/task-service.ts`：新增内存 `dispatchFailed` 禁 kick 集合——`dispatchRound` 两个 catch 中 `finish` 落库也失败时（即读成功/写持续失败、行仍读作 queued）置标记；`kickDispatch` finally 的 R2-03 补派发复查加 `!dispatchFailed.has(taskId)` 守卫，命中即不再自动重派。blocked→resume 清理竞态补派发不受影响（成功轮不置标记）；`resume()`（显式作答，唯一显式恢复入口）与 `cancel()`（终态）清除标记。

**测试锚点**：

- `tests/agent-tasks.test.ts` `R3-03：读成功/写失败的派发有限收敛（fault injection）`——Proxy 包装真实 LocalMapStore：读走真库、`updateAgentTask` 持续抛错；`pool.acquire` 计数 dispatch 尝试。断言：`acquired===1`（旧缺陷无界增长）、`released===acquired`（槽位成对归还）、`updateAttempts===2`（置 running + finish 各一次）、150ms 后计数稳定、行保持 queued、`dispatch failure persist failed` 日志恰好 1 条且总错误日志 ≤4、真实库取消收尾可达。
- 回归：`R2-03：blocked 清理窗口内 resume 不丢调度`（tests/agent-tasks.test.ts）原样通过（全量套件内）。

## R3-04 [Minor] base36 变长字符串排序不单调

**修复**（序号定宽 4 位，id 本身恢复字典序单调，SQL/DTO 排序键无需改结构）：

- `server/src/agent/tasks/task-service.ts`：导出 `taskSeqSegment(n)`（`toString(36).padStart(4,'0')`），任务 id 序号段改用之——`t_<ms36>_<000z|0010…>_<hex>`；`queuePosition` 的 `${created_at}|${id}` 键与 SQL `ORDER BY created_at ASC, id ASC` 随 id 定宽自然恢复同毫秒单调（36^4≈168 万次提交前无二次进位边界）。

**测试锚点**：

- `tests/agent-tasks.test.ts` `taskSeqSegment：z→10、zz→100 进位边界字典序单调`——`000z<0010`、`00zz<0100` 显式断言 + 0..5000 全程字典序=数值序。
- `固定时钟提交跨 z→10 边界：id 字典序 = 提交序，排队次序与 queuePosition 正确`——`vi.useFakeTimers()` 冻结时钟、池满排队；探测进程序号后补齐到边界，断言：id 匹配定宽格式、`[...ids].sort()===ids`（旧实现 `000z>0010` 逆序）、`listBySession` 顺序=提交序、queuePosition=[1,2,3]。

## 验证（真实执行记录）

| 命令 | cwd | 结果 |
|---|---|---|
| `npm test`（server 全量） | `server/` | exit 0：90 文件 / **1216 测试全绿**（1207 基线 + 9 新增） |
| `npm run typecheck`（根：src+配置+server 三段） | 仓库根 | exit 0 |
| `npm test`（根，前端全量） | 仓库根 | exit 0：27 文件 / **237 测试全绿** |
| `npx eslint <本轮 10 个改动文件>` | `server/` | exit 0 |

## 改动面与回滚

改动文件（写面内，均为本批目标文件）：
`server/src/sources/feishu-write-service.ts`、`server/src/routes/feishu.ts`、`server/src/ops/command-table.ts`、`server/src/agent/session-service.ts`、`server/src/agent/tools/app-command-family.ts`、`server/src/index.ts`、`server/src/agent/tasks/task-service.ts`、`server/tests/{source-push,agent-tasks,ops-command-table}.test.ts`。

回滚方式：`git checkout -- <上述文件>`（共享树 feat/agent-knowledge-workbench；这些文件同时含 T3b/T3d 批次改动，按本报告 hunk 反向摘除，勿整文件回退——未授权整文件丢弃他人/前批未提交工作）。

## 未覆盖项 / 剩余风险

- R3-02 信号源语义：`abortSignal` 仅在显式停止（abort）时触发；「运行结束/换轮」的零写入由复核点 runState/runId 检查保证（换轮用例已覆盖）。生产真实 pi RPC→HTTP 时序未实跑（用受控 RPC double 模拟权威事件，与 T3b-07R 同模式）。
- 未触发（已消费）的停止信号在会话 abort/删除前常驻内存（每 confirmPlan 批准一个，量级极小；abort/删除时清理）。
- R3-04 进位边界 zz→100 以 `taskSeqSegment` 单元断言覆盖（集成用例覆盖 z→10；zz→100 需 1296 次真实提交，未在集成层重复）。
- 本轮为 R3 清单收敛修复，未触 R2 遗留观察（raw_read_image signal、同步 DB fail-open 等，按任务约束原样保留）。
