# T3b-R4 聚焦终验：T3e 修复闭合

VERDICT: PASS

## 范围、基线与证据口径

- 仅复审 R3-01～R3-04 及直接修复回归，不扩面。基线为已完整读取的 `agent-outputs/workflow/2026-10-27-kb-agent-upgrade/T3b-r3-diting-review.md`；修复声明来自已完整读取的同目录 `T3e-fix-report.md`。实现以本轮工作区读取内容为准，未采 Git diff/提交快照。
- **本轮独立证据是源码路径与测试有效性的静态核验，不是测试执行。** 工具检索 `bash`、`execute command shell terminal test` 均无执行工具，未运行 shell、npm、构建、真实 Pi 或飞书写入。T3e 报告中的 server 1216 / frontend 237 全绿、typecheck/lint exit 0 属上游执行声明，本轮未独立复跑。PASS 仅适用于下述静态复审范围，不签发生产集成或动态回归通过结论。
- 未写项目测试、修复 patch 或复现脚本；仅新增本报告。

## ① 四项验证表

以下源码及测试路径均相对 `server/`。

| 原编号 | 实现与反例核实 | 测试有效性核实 | 结论 |
|---|---|---|---|
| **R3-01** | `src/ops/command-table.ts:621–646` 将 force 同参传 preview，仍拒绝 blocked，仅可行计划派生 OVERWRITE_CLOUD；`src/routes/feishu.ts:365–373` 透传严格布尔 force；`src/sources/feishu-write-service.ts:206–281` 先定权限/内容计划，再仅在非 force 时将不可读时间变 blocked。force 不会把原本 blocked 的权限/内容计划改成可行计划。 | `tests/source-push.test.ts:1341–1394` 经真实工具族→真实 feishuRoutes→真实写服务，metas 抛错的非 force 无批准/零写，force 获 OVERWRITE_CLOUD 卡并命中 append；scope 缺失+force 仍无批准/零写/dirty。`tests/ops-command-table.test.ts:194–216` 锚定同参及派生规则。内容 blocker 的 force 不可越过另由实现分支静态确认，并非声称新增专门动态用例。 | **FIXED**；原反例关闭 |
| **R3-02** | `src/agent/tools/app-command-family.ts:172–196,250–266,302–319,381–384`：批准后复查；异步 preview 由 raceAbortSignal 竞速；完成后再次 assertRoundExecutable，至 mutation 派发间无新增 await。停止查 aborting/idle，换轮查权威 runId。`src/agent/session-service.ts:644–709` 提供真实停止信号及状态；`src/index.ts:381–387` 生产接线齐全。 | `tests/source-push.test.ts:1398–1650` 使用真实 SessionService、ApprovalService、工具族及 feishu 路由；第二次 metas 门控确保已经进入批准后复核。停止例在释放 preview **之前**等待 approval_cancelled，之后释放仍断言零 append/overwrite、dirty。换轮例通过 RPC prompt 完成→真实 executeRun finally 清除→sendMessage 建 run2，再释放并断言 approval_round_expired、零写、dirty；正常对照释放后确有 append。详见下节。 | **FIXED**；停止与换轮原窗口关闭 |
| **R3-03** | `src/agent/tasks/task-service.ts:432–485,550–575` 在故障收尾持久化失败时置 dispatchFailed，finally 即使真实读到 queued 也不补派发；正常 blocked→resume 不置此标记；`:894–945` 的 cancel/resume 清理标记。 | `tests/agent-tasks.test.ts:745–800` fault injection 不替换 dispatch；真实 store 的读、创建及真实 pool.acquire 保留，仅 updateAgentTask 持续抛错。断言 acquire=1、release=acquire、update=2，等待 150ms 后仍保持该次数；queued 真库状态、特征错误恰好1条及错误总数≤4、恢复真库 cancel 可达。`:685–706` 保留真实清理窗口 resume：释放前1次 spawn，释放后2次并最终 done。 | **FIXED**；故障收敛与正常补派发均静态闭合 |
| **R3-04** | `src/agent/tasks/task-service.ts:83–85,402` 生成序号使用 base36 padStart(4,'0')；`:291–296` 和 `src/modules/local-map-store.ts:2503–2511` 的字典排序在所验 z→10、zz→100 边界恢复数值顺序。 | `tests/agent-tasks.test.ts:802–815` 明确断言 000z<0010、00zz<0100，且逐对检查 0..5000。后续固定时钟集成例经真实提交/列表/queuePosition，但其“跨边界”声称有一处覆盖偏差，见下节；不影响直接覆盖两处原反例的单元断言。 | **FIXED**；指定进位反例关闭 |

## 重点抽查：是否真实穿过被测边界

### R3-02 换轮：有效，非 stub runState

- `makeRecheckEnv` 只用受控 RPC double、内存 SessionStoreApi 和模型 revision 预登记来隔离外部 Pi；没有重写 runState/currentRunId/runOfToolCall/abortSignal。
- `SessionService.sendMessage → executeRun` 实际写入 runs（`session-service.ts:362–392`），RPC `tool_execution_start` 的真实 listener 记录 toolCallId→runId（`:423–439`），prompt 完成后真实 finally 删除 runs（`:503–509`）。测试先等 currentRunId=null，再实际 sendMessage 建立 run2，期间 preview 未释放。
- 换轮用例预期 `approval_round_expired` 而非通用取消，可区分“run2 活跃且旧 runId 不符”与仅 idle 阻断。两次 preview 的第二次 metas 挂起和真实路由调用均实际构造在测试链中。没有通过 stub 状态绕过异步复核边界。
- 隔离边界：直接调用 executeTool，不经过内部 HTTP 鉴权；路由 app.request 是进程内 Hono；真实 Pi RPC/网络及云端未测试。该边界不抹去本轮要求的 SessionService+source 路由交叉时序证据。

### R3-03 故障注入：断言足够强，非仅“未 spawn”

- Proxy 将其他方法绑定至真实 LocalMapStore，保证“读成功、写失败”；updateAttempts=2 对应置 running 和 finish(failed)，因此确实命中被修复的 catch→finally 链。
- acquire spy 转调 realAcquire 并包装真实 slot.release，分别计数尝试与归还；并非伪造成功槽位。断言 acquire=1 排除重复调度，release=1 排除预留槽位泄漏，日志精确/上限断言排除刷屏；150ms 延迟后的检查排除只观察首轮瞬态。
- 旧路径会无退避重派甚至阻塞定时器；本例在旧实现下可能表现为超时而非到达次数断言，这仍能检出缺陷。未进行本轮 mutation testing，也未注入真实磁盘/SQLite OS 故障；其证据是可控方法级故障穿过真实调度链。
- blocked→resume 回归用可控 terminate promise 挂住真实 dispatch finally，而不是先 whenSettled 避开窗口；因此仍验证修复不得牺牲的补派发路径。

## ② 新发现问题与证据保留

**无新增阻断 finding；四个原编号均关闭，未发现与本轮修复有因果关系的需求回归。**

验证覆盖备注（不列需求缺陷、不影响本轮静态结论）：

1. `tests/agent-tasks.test.ts:835–848` 的固定时钟集成例存在 off-by-one：probe=p，补齐 boundary−1−p 次后，首个保留任务已是 boundary（测试也明确期待 0010/0100），随后两个任务也在进位之后；被取消的 boundary−1 不参与排序断言。因此不能把该例称为“真实提交跨边界排序已验证”。两处边界仍由直接调用**生产使用的** taskSeqSegment 的显式单元断言覆盖；该单元测试能检出原实现。若强化证据，最小方向是让保留的三个任务从 boundary−1 开始。本轮不自行改测试。
2. 4 位 padStart 是最小宽度，不是无限增长排序契约：达到 36^4 时会进入五位；T3e 已披露容量边界。本轮只验任务指定的 z→10、zz→100，不将其扩为新一轮全生命周期 ID 设计审计。
3. T3e 已披露已完成复核的未触发停止信号留到 abort/删除才清理；本轮不扩成内存治理审核。

R2/R3 原遗留观察（raw_read_image signal、同步 DB fail-open、CLI 写授权入口、Windows 卷别名及其他前轮盲区）照旧保留，未重审、未宣称关闭。

## ③ 结论与现场

- **4 FIXED / 0 NOT-FIXED / 0 REGRESSED**。就本轮限定的源码路径与测试有效性审核，T3e 闭合 R3 四项。
- 验证可信度：源码与测试断言已独立读取；项目测试执行结果仅来自 T3e 报告，未独立复跑。无构建、浏览器/Electron、真实云端或真实 Pi 端到端证据；不将“未发现”表述为全仓无缺陷。
- 现场：仅写本报告，无源码/正式测试/应用数据/Git 状态操作。撤销本轮产物仅需移除本报告，不触碰其他工作区改动；metadata 由 harness 托管。

VERDICT: PASS
