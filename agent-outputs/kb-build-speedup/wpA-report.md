# WP-A 报告：构建并发准入与派发调度（kb-build-speedup R1/R2）

上游输入：`agent-outputs/kb-build-speedup/diagnosis.md`（R1/R2 实测诊断）。
上游证据（只读）：`~/.feishu-sync/agent/builds/b_20261105233621_7161f7/`。

## 变更文件

| 文件 | 改动 |
|---|---|
| `server/src/kb/build-runtime-host.ts` | A1：`assembleSpec` 同模型时 writer=reviewer=max（旧 `floor(max/2)`）。A2：`composeDispatchInflightSnapshot`（导出纯函数）+ `writeDispatchInflightSnapshot`（原子写 `<epochRoot>/dispatch-inflight.json`，seq 按代次隔离单调递增）；supervisor 回调 `dispatchStateChanged` 注入 + `startLeader` 后初始快照。 |
| `server/src/agent/build-runtime/contracts.ts` | A1：`validateBuildRunSpec` poolSum 按**去重池键**求和（`byModel` 前置，同池多角色不重复累加）；同池容量一致、缺池禁止回落校验保持。 |
| `server/src/agent/build-runtime/dispatch-guard.ts` | A2：schemaVersion 2→3；新增可选 `dispatch` 段（`inflightStatePath`/`rolePoolKeys`/`poolCapacities`/`staleMs`）与 `DispatchInflightSnapshot` 类型；`checkDispatchAdmission` 确定性准入（新写作 ≤ 容量、积压时 ≤ 容量−1；审查/review resume 优先）；进程内 unacked 补偿记账（同轮连发，seq 锚定重置）；`resetDispatchGuardAdmissionState` 测试隔离导出。 |
| `server/src/agent/build-runtime/adapter.ts` | `buildGuardConfigInput` 渲染 `dispatch` 段（池映射与 `amagi.json concurrency.models` 同源：`modelSpecPoolKey` 为键）；路径 `<epochRoot>/dispatch-inflight.json`。 |
| `server/src/agent/pi-extension/feishu-sync-agent.js` | tool_call 钩子在 task_submit/task_resume 前读在途快照（`readDispatchInflightSnapshot`：缺失/损坏/buildId·generation 不匹配/超 256KB → null=fail-open），经 `options.inflight` 交守卫。 |
| `server/src/kb/build-actors.ts` | 仅新增 `dispatchBacklogSignal()`（待审/待修订计数，A2 槽保留信号）。**注意：该文件同时含并行 WP-B 的改动（续接链继承、错误消息、openBlockingIssues），非本任务产物。** |
| `server/src/kb/build-leader-supervisor.ts` | cb 新增可选 `dispatchStateChanged`（task_created/task_resumed/task_state/task_activity/换代后触发）；公开 `dispatchInflightActors()`（与空闲判定同口径，evaluateIdle 复用）。 |
| `server/src/agent/skills/knowledge-build/leader-protocol.md` | 仅第 3/4/5 步：第 3 步「建议分批派发」→ 确定性准入规则（池容量冻结、`dispatch_inflight_write_exhausted` 等完成通知、积压时新写作 ≤ 容量−1、修订/审查永远优先）；第 4 步补「审查优先于新写作，不让路」；第 5 步定向复核改为**优先 `task_resume` 续接原审查者**（见下）。第 7 步未动（另一 luban 负责）。 |
| 测试 | `build-runtime-contracts.test.ts`（A1 去重 poolSum，max=1/2/3/6 同/异模型）；`build-runtime-agent-dir-config.test.ts`（同模型 max=6 渲染 `concurrency.models[key]=6`）；`build-runtime-dispatch-guard.test.ts`（schemaVersion 3 + 准入 7 组用例）；`build-runtime-dispatch-inflight.test.ts`（新文件：assembleSpec 池容量、快照组装/落盘、backlog 信号）；`build-runtime-extension.test.ts`（fixture v3 + A2c 快照接缝：满载拒/缺失 fail-open/代次陈旧 fail-open/审查优先）。 |

## 设计决策与理由

**A1**：同模型时 writer/reviewer/research 共享一个 amagi 池（`agent-dir-config` 以 `modelSpecPoolKey` 为键），容量必须给满 `max`；均分只会让单池取小值（实测 6→3）。异模型保持「reviewer=min(2,max−1)、writer=余量、总和≤max」。校验侧 poolSum 改为去重池键求和——修复了同模型 max=1 时 `{writer:1,reviewer:1}` 被误判 2>1 拒绝启动的隐藏缺陷。`capability-probe` 只把 admissionPools 拼进 detail 文案，无需改。

**A2 挂点证据**：现有 `dispatch-guard` 是纯函数（`FrozenDispatchConfig`+args），在 Leader pi 进程的转发扩展 tool_call 钩子内执行；在途状态只存在于 amagi 内部队列与 server 侧 supervisor 的 `state.actors`（事件泵异步消费），**守卫无任何通道看到在途**——因此新增最小状态通道：host 原子写 `<epochRoot>/dispatch-inflight.json`，扩展派发前读后传守卫。要点：
- **fail-open**：快照缺失/损坏/代次不匹配/超过 `staleMs`（默认 15min）→ 跳过准入。在途准入是吞吐优化而非安全边界（安全边界=amagi 池容量+守卫权限冻结）；staleMs 防 host 停更导致永久误拒（监督器空闲收口兜底）。
- **同轮连发补偿**：事件流滞后于同轮多 submit，守卫按 buildId 记「自上次快照 seq 后放行数」，seq 前进即重置；误差瞬态且只低估（偶发超放由 amagi 排队兜底）。resume 放行不记账（原任务模型未知，记错池会误伤审查优先级）。
- **规则**：新写作（submit writer/research）要求池在途+1≤容量，且存在待审/待修订文档（`dispatchBacklogSignal`：本代次有写入回执未被有效审查覆盖=待审；有效 needs_revision/fail 且其后无新写入=待修订）时上限 −1，为审查/修订保留 ≥1 槽；无积压可占满。submit reviewer 与一切 task_resume 为优先类，只受池容量硬上限（resume 池归属派发侧不可知：任一池有空槽即放行，全池满才拒）。
- **capacity=1 / 恢复正确性**：在途过滤与空闲判定同口径（epoch+generation+`ACTIVE_EXEC_STATES`，`dispatchInflightActors` 单一实现）；换代/换 epoch 后快照整文件重写（generation 不匹配不继承 seq），旧代次在途不泄漏；resume 续跑经 `restoreTaskCompletionObservations` 回读终态。无死锁：准入只影响派发时机，任务终态即释放槽，快照失效即 fail-open。
- epoch 取值与 `adapter.start/resume` 同源：`state.runtimeEpoch`（rebuild 递增后优先）→ legacy binding → 1。

**A3 复审结论**：`task_resume` 续接**原审查者**规则允许——独立性由 `assertReviewerIndependent`（审查者不得是作者或与其同续接链；续接原审查者的新任务 ancestry 只含审查链，不含作者链）保证；回执有效性由 `dependencyHashes`（正文/声明/来源快照/规则）绑定，续接产生的新回执照常登记，无身份约束。故协议第 5 步写明优先续接原审查者（保留已读源上下文），原会话不可用才另派 diting。

## 测试命令与结果（cwd=server）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误（优于基线：并行期间曾出现兄弟中间态错误，最终快照全绿；任务书基线 3 个 portable-kb 错误在最终快照已不存在） |
| `npx vitest run tests/build-runtime-dispatch-guard.test.ts` | 31 passed |
| `npx vitest run tests/build-runtime-dispatch-inflight.test.ts tests/build-runtime-contracts.test.ts tests/build-runtime-agent-dir-config.test.ts` | 56 passed |
| `npx vitest run tests/build-runtime-extension.test.ts` | 36 passed（含新 A2c 快照接缝） |
| `npx vitest run tests/knowledge-skill-examples.test.ts tests/amagi-task-observations.test.ts tests/build-runtime-capability-probe.test.ts tests/build-runtime-checkpoint.test.ts tests/build-runtime-integration.test.ts tests/build-runtime-adapter.test.ts tests/build-runtime-environment.test.ts tests/build-runtime-child-policy.test.ts tests/build-runtime-integrity.test.ts` | 192 passed |
| `npx vitest run tests/build-runtime*.test.ts tests/kb-build*.test.ts` | **829 用例：815 passed + 14 skipped，EXIT=0**（首轮全量有 3 个 5000ms 负载超时，逐一单独复跑均通过，属并发 flaky 非回归） |

未调用真实模型；测试全部临时目录，未读写真实 `~/.feishu-sync`。

## 边界披露（供 Leader 裁决）

任务书可改清单未列以下三个文件，但 A2 的实现链路无法绕开它们（均为加法接线，未改任何既有行为/禁改面）：
1. `server/src/agent/build-runtime/adapter.ts`（+23/−9）：`freezeGuardConfig` 唯一调用点，`dispatch` 段只能在这里注入信封（否则扩展拿不到准入配置）；修复了编辑事故误删的 `verifyWorkflow`（已复原，diff 含）。
2. `server/src/agent/pi-extension/feishu-sync-agent.js`（+30/−5）：task_call 鈦子是**唯一**的派发前拦截点（守卫在此执行）；只新增读快照并传 `options.inflight`，fail-open。
3. `server/src/kb/build-leader-supervisor.ts`（+28/−1）：`state.actors` 是在途状态唯一权威；新增可选回调 `dispatchStateChanged`（不接线零行为变化）与同口径读方法 `dispatchInflightActors`（evaluateIdle 改为复用，行为不变）。
若 Leader 不接受此扩张，回滚这三处即回到「快照写入但无人消费/触发」的 inert 状态，其余改动自洽。

## 回滚说明

- 代码/协议/测试均在上述文件，`git checkout -- <files>`（或对 5 个测试文件中新增用例 revert）即可整体回退；`build-actors.ts`/`build-leader-supervisor.ts` 回滚时注意保留并行 WP-B 的无关改动（本任务在该两文件分别只加 `dispatchBacklogSignal` 与 `dispatchStateChanged`/`dispatchInflightActors`）。
- 运行态残留：仅 `<epochRoot>/dispatch-inflight.json` 快照文件（数据目录内、随构建目录清理），无 DB 迁移、无配置面变更。
- schemaVersion 2→3：信封由宿主逐次启动生成，无跨版本持久化，回滚即回到 v2 生成/消费，无兼容残留。

## 复审修复（R3，2026-11-06 二轮）

**问题**（review.md R3，附录已复现）：准入判定与记账耦合——`checkDispatchAdmission` 在后续校验（模型冻结/taskFile/范围等）之前就累加 unacked；一次被拒的派发（如错 model）在快照 seq 不前进（无真实任务创建）时永久虚占额度，空池误报 `dispatch_inflight_write_exhausted`，需等无关事件推进 seq 或快照 staleMs（15min）才恢复。

**修复**（`dispatch-guard.ts`）：
1. **判定与预留分离**：`checkDispatchAdmission` 改纯判定，返回 `admitPool`；新增 `reserveUnackedSlot`，仅在 `guardTaskSubmit` **全部校验通过、即将放行**时调用。任何拒绝路径（角色/模型/taskFile/写作范围/审查范围）不记账。resume 维持不预留（原任务模型未知）。
2. **有界补偿 TTL**：预留条目带 `reservedAt`（守卫注入时间源 `options.now`），超过 `DISPATCH_UNACKED_TTL_MS=60s`（自该池最后一次预留起算）自动过期不计——覆盖「原生派发后续失败/dryRun 等守卫不可观测」场景，误扣不会持续到 staleMs。保留 seq 前进即重置语义（host 确认后立即精确化）。TTL 早于事件流时只低估不高估，偶发超放由 amagi 队列兑底。

**回归**（`build-runtime-dispatch-guard.test.ts`，31→34 用例）：R3 反例（错 model 被拒后修正重试放行，capacity=1）、多次参数失败不耗尽额度、合法放行后连发仍计入（既有用例）、TTL 过期释放（options.now 推进 61s）。

**验证**：`npx tsc --noEmit` 0 错误；`npx eslint`（dispatch-guard/build-runtime-host/测试/feishu-sync-agent.js）0 问题；`npx vitest run` dispatch-guard(34) + extension(36) + dispatch-inflight(12) + contracts(31) + agent-dir-config(14) = **126 passed，EXIT=0**。leader-protocol 第 3–5 步语义未变，无需修改。

## 未覆盖 / 风险（含 R3 修复后）

1. **快照事件滞后竞态**（已缓解未根除）：同轮连发时 unacked 补偿只低估不高估；极端情况下偶发超放 1–2 个任务由 amagi 队列排队兜底（退化为准入前行为），不破坏权限面。
2. **resume 池归属不可知**：resume 只按「存在空槽」放行，个别池偶发超载同样由 amagi 排队兜底。
3. **task_control 取消的收口**：host 无 task_control 事件转换，被取消任务的槽靠 amagi 完成通知释放；若通知缺失则由 `staleMs`(15min) fail-open 兜底（该场景下准入短暂失效，无死锁）。
4. **e2e 实测未跑**（`build-runtime-e2e/amagi-live` 需真实 pi/amagi 环境，本环境 skip）：准入全链路（host 写→扩展读→守卫拒→Leader 行为）由单测+接缝测试覆盖，未做真实 Leader 进程联测；建议下次真实构建观察 `dispatch-inflight.json` 与 `dispatch_inflight_*` 审计事件。
5. `dispatchBacklogSignal` 是粗粒度信号（偏差只影响最后一槽的保留时机，不影响审查/修订放行，收敛性由回执/审查推进保证）。
