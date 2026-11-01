# F09/F10/F15 后端统一修复报告（build-v2-fix-runtime 批；含 Leader 拒收复审修正轮 + UI 实测 v2-store 误报修正轮）

工作树：`.amagi-worktrees/build-v2-fix-runtime`（分支 `amagi/build-v2-fix-runtime`，基线 25cc0b4，未提交）。
输入：review-report.md（F09/F10/F15 原文）、runtime-fix-guidance.md（Advisor 方向基线）、d21 续批 e2e（integration 树，作为参考输入非结论）、Leader 拒收反馈三项 + 运行中调整 #1、UI 真实验收误报反馈（ui-real-api-acceptance.md §七）。

## 〇-b、UI 实测 v2-store 误报修正轮（合主后；仅 Runtime 面，最小 patch）

**现象**（ui-real-api-acceptance.md §七）：`b_20261101144714_39f7a0` 正常 published、进程零残留，但收尾对账报 `unconfirmedPids=[0,0,0,0]`（「v2-store 4 活跃无锚点」）。
**根因**（用本轮真实数据 `/tmp/feishu-build-v2-ui/sync-home` 核实）：被标的 4 个任务是 `execution=queued, processState=not-started, settlement=pending, 无 startedAt/backendRunId` 的**准入排队任务**——Leader 收尾终止后永久留在排队态，从未 spawn，无进程实体存在过。旧扫描把一切"活跃执行且无锚点"都当残留候选，误将排队记录当作 spawn→锚点窗口缺口。
**权威依据**（amagi 源码已核实）：task-kernel 在 task_submit 即创建 queued/not-started 记录；task-run 中 spawn → **同步锚点** → started 观察提交（alive+backendRunId+startedAt 三者同时落盘，锚点先于此）。即：已提交过 started 的任务必有锚点；queued/not-started/无 startedAt/无 backendRunId = 权威意义上从未 spawn（amagi 自身对账也按无运行实体处理）。
**修复**（仅 process-residual.ts）：`scanV2StoreIntents` 增加 never-started 判别——`queued + not-started + startedAt≡undefined + backendRunId≡undefined` → 排除出残留候选（计入 `queuedNeverStartedTasks`，note 如实备注"N 个 queued/未启动任务从未 spawn（无进程实体，不计残留）"）；**矛盾记录（not-started 却有 startedAt/backendRunId）仍按证据不全 unconfirmed**；其余活跃无锚点（running/alive 等）维持 unconfirmed 不放宽。另修一处运行时缺陷：store 缺失早退分支补齐新字段（避免 undefined.length 崩溃）。
**验证**：①按真实数据形态复现用例（4 queued + 2 error/exited + 1 stale running/alive 带锚点）→ confirmed + 备注，零信号；②矛盾记录/running-alive-无锚点仍 unconfirmed；③**对本轮真实数据集直接复验**：同一份误报数据现在 `state=confirmed`，note 含"4 个 queued/未启动任务从未 spawn"，3 个锚点个体 exited；④回归 229/229、fix-e2e 6/6、旧 e2e 3/3、tsc/eslint 干净。

**实际 boundaries（向 Leader 如实报告，不假称全部可证）**：
1. spawn() 与同步锚点追加之间存在微秒级硬崩窗口——此时孤儿无已提交 backendRunId，amagi 自身对账同样不可见（无运行实体），应用侧无法从 store 发现；属 amagi 原生机制边界，非本次扫描缺陷（本次修复对齐 amagi 权威语义，不引入新证明机制）。
2. 旧版 amagi（无锚点）下 started 已提交的任务（running/alive 无锚点）仍不可证明 → 维持 unconfirmed 阻断（不放宽）。
3. queued 排队记录本身是 amagi 任务状态层遗留（非进程残留），构建检查点不会因它们阻断；如需清理这些孤儿排队任务属 amagi 侧任务管理面（本批不涉）。

## 〇、Leader 反馈修正轮（同批完成；F09/F15 保持未动）

F10 三项拒收点全部按反馈修正（process-residual.ts 重写）：
1. **每个信号前 fresh 证明（含首个 SIGTERM）**：分类用整批令牌快照仅作分诊；`reapIndividual` 现为「首信号前 fresh 重采令牌比对（失败=零信号）→ TERM → 宽限 → fresh 复核 → KILL → 退出确认」。多体回收中快照陈旧与 PID 复用均在首信号前被拦；新增回归「身份在初次采样后/首 TERM 前改变 → 零信号」。
2. **删除根个体 pgid 降级**：`pgid===rootPid + node 可执行名` 不是本次启动身份（旧锚点 PID/PGID 可被无关 detached Node 复用）——根个体只认出生令牌（锚点/账本），无令牌 → unconfirmed 不发信号；令牌不匹配 → not-ours 绝不发信号。**组员改为预录制**：在根个体仍可证明存活时枚举同 pgid 成员并记录其自身出生令牌（无法记录的成员如实上报 unconfirmed），根回收后每个成员信号前按其自身令牌 fresh 复核（成员 PID 复用 → 不杀）；绝不在根死后仅凭同 pgid 补刀。不再为负载下 e2e confirmed 放宽证明——e2e 改为任务定义双出口（回收收敛 或 明确未确认阻断/重试清障），均不弱化证明。
3. **v2-store 派发意图扫描**：`<home>/amagi/v2-store/*/current.json` 活跃任务（queued/running/blocked/answering 且 processState 未退出）若无锚点覆盖（spawn→锚点写入窗口硬崩/旧版 amagi/锚点截断）→ 个体不可发现即不可证明 → **unconfirmed，不把证据缺失当无残留**；任务状态不可读同样 unconfirmed；无 v2-store 且无锚点 = 无派发意图（任务记录先于 spawn）→ confirmed（无任务即无子进程可残留，有据）。新增 4 个意图缺口用例。

**取消竞态修复（复现实测发现，F10 语义面）**：cancelBuild 的 abort 在 supervisor 池排队/授槽窗口到达时，原实现把池 AbortError 裸抛 → 流水线误报 `kb_build_failed:等待进程槽位已被取消`（endedReason=error）；现 run() 对 signal 已断的任何主体抛错按取消收口（outcome=cancelled、endedReason=cancelled），非取消异常原样上抛不伪装。附单测（池排队 AbortError → cancelled、不启动 Leader）。e2e 曾 1/6 概率复现，修复后连续 4 轮 6/6。

**调整 #1（DTO 接缝，同轮处理）**：`LeaderRunProgressDto` 新增（供前端 getData 消费，两处构造同口径）：
- `runtimeEpoch: number | null`（顶层）+ `tasks[].runtimeEpoch/generation`——历史任务按 epoch 过滤，历史 running 不当当前并发；
- `processTermination: { state: 'confirmed'|'unconfirmed'; at; note; unconfirmedPids: number[] } | null`（安全摘要，无个体细节）；
- `termination` 新增枚举值 `'termination-unconfirmed'`——unconfirmed 优先于 finished（cancelling 仅取消进行中显示），UI 不再把未确认回收当 finished；
- F15 rounds：两处构造均 `rounds ?? null`（旧 state 无 rounds → null，不用私有计数默认 0/0，历史不可重建不假累计）。

**P补修透传确认**：`wrapPublishExecutor` 本批零改动、整对象透传（`(request) => executor(request)`），`authorityLease` 等新增请求字段合入即生效，未做任何字段收窄。

## 一、修复总览（按 finding 逐项）

### F09｜成果级 rebuild 仍打开原 Leader 会话及同一内部 agentDir → **已修复（真实 e2e 验证）**

三身份分离（contracts.ts）：
- `generation`：业务写租约（原有，不动语义）；
- `runtimeEpoch`：Pi 会话/amagi 内部库边界。目录分层 `planBuildDirectories(dataRoot, buildId, epoch)`：epoch≥1 → `<buildRoot>/epochs/e<N>/{home,work,home/sessions}`；缺省 → legacy 布局（旧检查点 binding 恢复兼容，实测保留）；
- `launchId`：每次进程启动唯一（`l_<hex>`），进程账本关联键。

行为（adapter start/resume + supervisor prepareResume）：
- **fresh** epoch=1；**rebuild** epoch 递增（legacy 状态 rebuild → 1）；**session** 恢复 epoch 不变。
- 会话 id **epoch 唯一**：`build-<buildId>-e<N>`。Pi `--session-id` 语义"存在即打开"——rebuild 换 epoch 即新 id，**不再可能打开旧会话**（原 `build-${buildId}` 固定 id 缺陷根除）；仅 session 恢复显式传原 id。
- rebuild 的新 epoch home 为**空目录**（writeAgentDirConfig 全新写入）：不复制旧 amagi 内部库（v2-store/process-audits/sessions）与对话；应用成果/问题经 actorStore（staging 文件权威）+ rebuildResume briefing 导入——即可验证应用成果通道，未新增导入机制。
- session 恢复前置：冻结面比对（原有）+ 第二 Leader 守卫（**先于一切回收动作**，防误杀活 Leader 的子任务）+ F10 残留对账守卫（旧 Leader 已死才回收其孤儿）。
- **旧 actors 是历史**：`LeaderActorRecord.runtimeEpoch` 戳 + `evaluateIdle` 按 epoch 过滤（旧 epoch running 任务不再挂住新代次空闲收口；unit 测试覆盖"rebuild 后旧 running 不阻断 idle、session 同 epoch running 仍阻断"）。DTO actors 保留作历史展示。
- "root 现已持久 orchestration_mode 及 checkpoint 模式"：本批未动该判定；epoch 全部来自检查点持久（`LeaderRunCheckpointState.runtimeEpoch` additive），不用当前 config 猜历史。

### F10｜异常 Leader 后无子进程残留核对/回收，终止失败结果丢失 → **已修复（真实进程 e2e 验证）**

新增三个模块（`server/src/agent/build-runtime/`）：
1. **process-identity.ts**：OS 身份探测。①birth-token：darwin `/usr/bin/python3`+libproc（与 amagi 2.21.31 `DARWIN_BIRTH_PROBE` 同源同格式 `darwin:sec:usec`，可直接比对锚点令牌）、linux `/proc/<pid>/stat` starttime+boot_id（`linux:boot:start`）；双采样一致才采信；负载下空结果短退避重试（≤3 次）。②平台不支持（win32/python3 缺失）→ 空结果如实报告（能力诚实，不伪造）。
2. **process-ledger.ts**：应用进程账本 `<buildRoot>/process-ledger.json`（0600、tmp+rename、跨 epoch 共享）。只记 pid/时间/epoch/generation/launchId/argv 指纹/cwd/**Leader 出生令牌**（非阻塞启动后补写）——**生命周期对账记录，不是任务状态调度器；不含密钥/整份 env**（测试断言序列化无 token/env 字段）。
3. **process-residual.ts**：残留核对与回收。

判定矩阵（每个体独立、fail-closed；**只认出生令牌，无 pgid 降级**）：
- 发现：受信原生启动锚点（按 leaderPid 归属过滤）+ 账本未收口 Leader 条目（凭账本出生令牌精确对账，应用重启句柄丢失补偿）+ v2-store 意图缺口扫描（见上）。
- 证明：birth-token（不匹配 = pid 复用 → not-ours 绝不发信号；不可得 = unconfirmed 不发信号，不降级）；**每个信号（含首 TERM）前 fresh 重采比对**；组员预录自身令牌并逐信号复核。
- 回收（仅 reap，个体级信号，无组级 kill/递归 taskkill）：首信号前 fresh 证明（失败=零信号）→ SIGTERM → 3s → fresh 复核 → SIGKILL → 退出确认；任何环节失去证明立即停手 unconfirmed。

贯穿修复（supervisor/host/adapter）：
- adapter.cancel：**不吞 terminate 异常**（错误进终止记录并强制 unconfirmed）；**不清进程句柄**（退出事实/对账仍可读；句柄随下次 launch 替换）；每次 cancel 都执行残留对账（含应用重启后 state 为空的路径——binding 自描述 + 磁盘账本即可对账）。
- **CancelResult.termination 结构化贯穿持久化**：requestCancel 异常路径也留 unconfirmed 记录（原 catch 后丢结果缺陷）；run() finally 对**非取消终局**（发布成功/leader-failed/idle 等）同样捕获 cancelLeader 结果写入 `state.termination`（原直接丢弃缺陷）；随检查点落盘。
- **未确认残留阻断第二 Leader**：`prepareResume` 遇 `state.termination/binding.termination` unconfirmed → 先重试对账（host 注入 `reconcileResiduals` 回调）→ 仍 unconfirmed → `kb_termination_unconfirmed`(409) 拒绝 **session 与 rebuild 双通道**（换 epoch 也不能绕过；unit 断言被拒时 epoch 不推进）。
- 正常 stdin 关闭 10s 宽限（leaderTerminateGraceMs）保留不动。

### F15 后端｜终局轮次计数 0/0 → **已修复（DTO nullable 契约变更，报 Leader）**

- supervisor `roundsStarted/Ended` 恢复自 `state.rounds`（跨恢复累计）、每轮事件写回 `state.rounds`（随检查点持久化）。
- `leaderProgressOfState`（kb-build-service.ts:1220 一处改动）：`rounds: leaderRun.rounds ?? null`——**旧检查点缺字段 → null（未知），不再伪造 0/0**。
- **DTO 新契约（前端 F15 由 Leader 处理，本批未改前端）**：`LeaderRunProgressDto.rounds` 由 `{started:number; ended:number}` 收宽为 `{started:number; ended:number} | null`；null=未知（旧检查点/无监督态），前端按 steer #2 显示未知而非 0，终局并发语义由前端改"末次观测并发"。字段名保持 `{started, ended}`，未另起 settled 名（steer #2）。
- `isValidLeaderRunCheckpoint` additive 校验（runtimeEpoch≥1、rounds 形状、termination 枚举；缺省字段按 legacy/未知解释不伪造）。

## 二、改动清单与写面边界

修改：`adapter.ts`（start/resume/cancel/launch/binding；**buildGuardConfigInput 未动**——65a04158 面；**wrapPublishExecutor 未动且保持整对象透传**——P补修 authorityLease 合入即生效）、`contracts.ts`、`agent-dir-config.ts`（仅 planBuildDirectories/BuildDirectories epoch 化；禁区推导从 workDir 派生、epoch 布局自动正确，未改 buildForbiddenZones）、`build-runtime-host.ts`（epoch 传递 + reconcileResiduals 回调）、`build-leader-supervisor.ts`（终止对账守卫/轮次持久化/DTO 摘要/取消竞态收口）、`build-checkpoint.ts`（additive 校验）、`types/agent-knowledge.ts`（持久类型 + DTO 接缝）、`kb-build-service.ts`（仅 leaderProgressOfState：F15 rounds nullable + processTermination/epoch/termination 映射 DTO 接缝；发布方法未动——22c29fc4 面）。
新增：`process-identity.ts`、`process-ledger.ts`、`process-residual.ts`、测试 `build-runtime-process-residual.test.ts`(19)、`build-runtime-fix-e2e.test.ts`(6)；扩展 `build-runtime-adapter.test.ts`(+3)、`build-runtime-integration.test.ts`(+6)。
`pi-rpc-process.ts`/`agent-process-pool.ts` 零改动（生命周期缺陷均在消费方；诊断期间临时探针已全部移除，diff 干净）。

**新签名/目录规划（供 Leader 协调并行合并）**：
- `BuildRuntimeAdapter.start(spec, options?: { runtimeEpoch?: number })`；新增 `reconcileResiduals(binding, { reap?, includeLeaders? }): Promise<TerminationOutcome>`
- `RuntimeBinding` + `runtimeEpoch?/launchId/sessionDir/leaderStartedAt/termination?`
- `CancelResult.termination?: TerminationOutcome`；`LeaderRunCheckpointState` + `runtimeEpoch?/rounds?/termination?`；`LeaderActorRecord.runtimeEpoch?`
- `LeaderSupervisorCallbacks.reconcileResiduals?`（可选回调）
- 目录：`<dataRoot>/agent/builds/<buildId>/epochs/e<N>/...`、`<buildRoot>/process-ledger.json`
- 65a04158 接口提示：spec 渲染哈希不含路径，epoch 目录不影响 `agentDirConfigHash`；guard 的 forbiddenZones 从 workDir 推导 epoch home 配置面，无需感知 epoch。

## 三、验证证据（全部真实执行；cwd=server，除非注明；含修正轮复验）

| 验证 | 命令/入口 | 结果 |
|---|---|---|
| typecheck | `npx tsc --noEmit` | EXIT=0 |
| eslint（改动/新增文件） | `npx eslint <files>` | 无输出 EXIT=0 |
| 残留对账单元（注入；**含拒收点四类新用例**） | `vitest run tests/build-runtime-process-residual.test.ts` | **19/19**（无令牌同 PID/PGID 无关 Node 不杀、成员 PID 复用不杀、身份首 TERM 前改变零信号、顽固个体 TERM 后复核、v2-store 四场景） |
| supervisor/host/adapter/checkpoint 回归 | `vitest run tests/build-runtime-{adapter,integration,checkpoint,persisted-mode,agent-dir-config,contracts,pi-rpc-process,environment,process-residual}.test.ts tests/{kb-knowledge-tools,agent-tasks}.test.ts` | **226/226**（integration 含终止阻断/双通道、epoch 递增与 idle 过滤、轮次持久化、DTO 接缝、取消竞态收口） |
| **真实 e2e（修正后）** | `AMAGI_PI_SOURCE_DIR=… vitest run tests/build-runtime-fix-e2e.test.ts` | **连续 4 轮 6/6**（曾复现取消竞态 1/6 → 修复后稳定） |
| 旧 e2e 回归 | `vitest run tests/build-runtime-e2e.test.ts`（同 env） | 3/3 |
| 根前端测试（harness 基线） | `npm test`（root） | 全绿 |

**必测项对照**：
1. **真实 Leader+长驻 child/桥 → 硬 SIGKILL**：等锚点出现且 rootPid 存活后 `kill -9` → build `failed`（不假 finished，首检查点 endedReason=leader-failed）、检查点 `termination` 按双出口验证：confirmed（≥1 个体 reaped、proof=birth-token）**或** unconfirmed（恢复尝试被 `kb_termination_unconfirmed` 阻断；若重试对账清障则恢复放行后取消收敛——均为合法终态，不弱化证明强凑绿）；锚点个体全部退出、`ps` 零 bridge 残留、旧 Leader pid ESRCH；/leader DTO 的 `processTermination/termination/runtimeEpoch/rounds` 同步断言。
2. **PID 复用模拟不发终止信号**：真实 OS（无注入）spawn `sleep` + 锚点令牌不匹配 → `not-ours`、零信号、victim 存活；真实令牌匹配 → 首信号前 fresh 复核通过后 TERM→复核→KILL `reaped`；另有注入版矩阵（含首 TERM 前换人零信号、成员复用不杀）。
3. **同会话真续接 vs 成果级全新内部库**：session 恢复同 epoch1/同 sessionId/新 pid 存活；rebuild → sessionId `build-<id>-e2`、`epochs/e2/home` 新配置、e2 内部库无旧任务锚点、e1 历史原样保留、检查点 binding 指向 e2、旧 epoch actors 留档不计活跃。
4. **异常退出不假 finished、旧 actor 不挂 idle**：见 1 + integration 单测（旧 epoch running 不阻断 idle / 同 epoch running 仍阻断 / 取消竞态按 cancelled 收口不误报 failed）。

## 四、残余风险与如实边界

- **Windows 未测**（无机）：process-identity 在 win32 显式返回不可用 → 残留全部 unconfirmed（fail-closed，不发信号不假装退出）；无已知必败路径（无裸 taskkill 新增；PiRpcProcess 对自有子进程的既有 taskkill 不变）。Windows 稳定 handle/Job 方案按 guidance 属"若必须更重平台 helper 先带证据报 Leader"——本批未引入任何新原生依赖/编译器。
- **setsid 逃逸孙进程**（离开进程组）不在锚点/组员回收面：按 fail-closed（不可证明即 unconfirmed 阻断）；amagi 自身 ProcessAuditor/reconcile 兜底其任务面。
- **出生探测负载敏感**：python3/libproc 探针重载下偶发不可得（双采样+重试已缓解）；按拒收反馈修正后不再降级证明——探测失效时如实 unconfirmed 并阻断，恢复尝试重试对账可清障（e2e 双出口覆盖）。
- 既有未改面：skill 文件（legacy `<buildRoot>/home/skills/`）不随 epoch 分层且不在模型禁区（启动/恢复有 hash 校验兜底，运行中被篡改影响子任务读校验——**既有暴露，非本批引入**，报告供裁决）；`materializeWorkflowSkill` 在 kb-build-service（非本批写面），如需迁 epoch 化请另行派发。
- F15 前端（rounds null 显示、终局并发口径）归 Leader；本批仅后端契约收宽。
- A23/Windows 实机/完整取消-恢复 UI 链等 review-report 盲区未因本批关闭。

## 五、建议下一步

1. Leader 复核 diff 后统一提交（含 65a04158/22c29fc4/27b5d076 并行面合并协调，特别是 `RuntimeBinding`/`LeaderRunCheckpointState` additive 字段）。
2. 前端按 nullable rounds 契约处理 F15 显示。
3. 独立增量复审按 F09/F10/F15 后端逐项核验（本报告第三节证据可复核：e2e 命令可带 `AMAGI_PI_SOURCE_DIR` 复跑）。

## 六、Leader 集成裁决（优先于§〇-b的补丁建议）

- 0469e24a的queued/not-started排除补丁**未采纳**，接受轴rejected，主树/可提交snapshot仍为d78严格版。理由：其边界已承认spawn→锚点/started提交前硬崩可留下同形态，无PID不证明从未spawn。正常收尾可保守unconfirmed；不能因为ps空就改confirmed。
- 主树新增queued+not-started+空startedAt/backendRunId也必须unconfirmed/零信号的反例。正常发布不等于进程已核验，UI明确警示，恢复先对账且未确认不放行。
- Integrity追加把实际workflowSkill文件path/hash纳入启动/每次派发/续接冻结核验；不迁epoch存储，不宣称OS沙箱。
- 最新纯feature原生重跑34用例本体均过，但afterAll删除临时home抛ENOTEMPTY，suite exit1；已交7fa31cae唯一增量审核归因，不把它写成全绿。详fix-integration-report.md与feature-only-native.log。
