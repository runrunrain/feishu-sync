# T3b-R3 聚焦终验（quick）

VERDICT: FIX

## 范围、基线与证据口径

- 项目：`/Users/run.mao/workpace/feishu-sync`。仅审核 T3d 声称修复的 10 项及其直接邻接路径，不重新审计仓库。
- 已完整读取上游：`agent-outputs/workflow/2026-10-27-kb-agent-upgrade/T3b-r2-diting-review.md`、`agent-outputs/workflow/2026-10-27-kb-agent-upgrade/T3d-fix-report.md`。比较基线是 R2 报告中的失败行为与最小修复方向；实现及测试以本轮读取的工作区文件为准，未独立重采 Git 快照。
- **本轮为静态路径与测试断言核验，未运行项目测试、shell、构建或真实 Pi/lark 调用。** 当前工具面没有 bash（工具检索也未发现），不能独立复核 T3d 所报 1207/237 全绿、重复运行或退出码；以下不将其当本轮执行结果。未编写正式测试或修复 patch。
- finding 均给出可失败输入/时序和实际源码链；本轮没有动态复现脚本或动态复现结论。FIXED 表示所声明静态范围闭合，不表示生产集成已实跑。

## ① 10 项验证表

下表 `src/`、`tests/` 均相对于 `server/`。

| 项目与声称 | 实现核实 | 测试核实 | 结论 |
|---|---|---|---|
| 1. **R2-01**：内部 resume/cancel 校验调用会话归属 | `src/agent/tasks/task-tools.ts:129–149` 取权威 context.sessionId 传 callerSessionId；`task-service.ts:860–875,894–903` 在 mutation/DTO 返回前校验归属；desktop 不传仍是独立全局入口。 | `tests/agent-tasks.test.ts:571–607` 真正经过 AgentToolService→task 工具族→TaskService；B 调 A 两种 mutation 均断言 403、blocked 未变、spawn 数不增、resume_answers_json 未写；A resume 至 done；desktop 服务调用 cancel 有回归（不是 HTTP 路由实测）。 | **FIXED** |
| 2. **T3b-05R**：真实 plan 派生确认值、批准卡与执行同值、过期 409 | `src/ops/command-table.ts:621–638` 和 `src/agent/tools/app-command-family.ts:206–254` 实际 preview、按 mode/force 派生并覆盖执行确认值；append+allowOverwrite 原反例关闭，mode 改变返回 409。但 preview 的时间不可读 blocked 被无条件套到 force，破坏已有显式强推契约，见 R3-01。 | `tests/source-push.test.ts:1188–1343` 的四态与过期例确实经工具族→真实 feishuRoutes→真实 FeishuWriteService，批准服务亦真实；上游 lark 是隔离 double，并非云端实写。断言批准卡、append/overwrite 方法命中及过期零写真实有效，不再是无条件成功路由。force 例只用健康 metas，遗漏不可读场景。 | **REGRESSED**（原四态闭合，新增 force 邻接回归） |
| 3. **T3b-07R**：toolCallId→runId，跨轮迟到请求零批准 | SessionService 从 tool_execution_start 记录归属，内部 API 透传，index 接线；写级 begin 前查轮次，批准后也查。但执行前校验之后新增异步 preview，停止/换轮可穿过此窗口后仍写，见 R3-02。 | `tests/app-command-family.test.ts:519–628` 使用真实 SessionService.sendMessage/executeRun 流转、复用 RPC double 发工具事件与结束响应；tc_r1 跨至 run2 的 409/pending=0/路由零命中断言有效，同轮批准带 runId 且执行有效。不是 stub runState；但直接调 executeTool，不经过内部 HTTP；测试命令是无 confirmPlan 的 kb.build，未覆盖 source.push 批准后 preview 暂停时的 stop。 | **REGRESSED**（迟到请求反例关闭，但执行窗口重新打开） |
| 4. **R2-02**：冻结 workspaceId 解析三场景 | `src/agent/tasks/task-service.ts:484–508` 按 row.workspace_id 查配置，不再读取父会话当前根；缺失抛 task_workspace_unavailable；继续用受围栏校验的 outputDir 子根。 | `tests/agent-tasks.test.ts:609–682` 三场景均走真实 dispatch：持后台槽排队→父切 W2→释放；blocked 后父切 Discuss；移除 W1 后 resume。分别断言 spawn 根仍 W1、W2 无目录，第二轮根 W1，移除后 failed+零新 spawn。spawner 是 double，未执行真实 ws_write。 | **FIXED** |
| 5. **R2-03**：拆除窗口 resume 补派发一次 | `src/agent/tasks/task-service.ts:417–436` 旧 dispatch 删除后同步复查 queued 再 kick，无 await 插入到复查/登记之间；解决原被 map 挡住后永久 queued 的时序。 | `tests/agent-tasks.test.ts:684–705` 可控 terminate promise 真实阻塞 dispatch finally，在 blocked 落库后 resume；释放前 1 个 RPC，释放后最终 done、共 2 个 RPC、下一 prompt 含用户回答。未通过等待 whenSettled 避开窗口。 | **FIXED**（正常存储链；故障重派另见第9项） |
| 6. **R2-04**：删除先规范路径校验 | `src/agent/agent-tool-service.ts:916–925` validateStdDocPath 在 assertPathClaim/removeFileInside 前，与写入门一致。 | `tests/agent-internal-auth.test.ts:249–326` 真实内部路由+工具服务+PathClaims，共享 buildState 的双 worker；三种别名均 400 且字节不变，别名未认领；规范他人路径 409、持有者成功删除。有效覆盖原反例。 | **FIXED**（不延伸到卷别名） |
| 7. **R2-05**：插件 running 门、session-only retireIdle、native revision 阻断 | `src/index.ts:252–254` 包含 hasPendingWork；`local-map-store.ts:2519–2523` 查询 queued/running/blocked；`agent-process-pool.ts:375–379` 只退空闲 session；TaskService 轮内 busy 成对；`app-plugin-store.ts:147–175` 比较冻结 nativeRevision，失配抛 stale，不注入最新资源。 | `tests/agent-tasks.test.ts:707–750` 查真实活跃查询及 blocked→native 变化→failed/零新 spawn；但失配例的 spawner **重写了生产快照门调用**，不能当真实 spawnProcess 集成证据。`tests/app-plugins.test.ts:89–115` 独立真实 frozenSnapshot 覆盖一致/失配；`agent-process-pool.test.ts:245–269` 真 pool 配 fake process 覆盖回收边界。index 组合 running 门没有新增“实际管理 API 拒绝”集成例；静态接线闭合，保留该验证盲区。 | **FIXED**（静态；组合门未动态验证） |
| 8. **R2-06**：stat 先行、quota 后不读剩余 | `src/agent/vision/vision-describer.ts:199–321` 单图/批量先 stat，配额满跳过剩余 stat/read；只保留 quota 内未缓存 bytes，缓存命中不进入 pending，消除原全工作集保留。 | `tests/vision-describer.test.ts:281–340` 10 张不同 hash、quota=3，spy 过滤图片读取 ≤3，described=3/limit=7/远端=3；超限单图和批量均零图片读取零远端。spy 没有替换读实现，确实计数；未测外部文件在 stat 后扩大的 OS 竞态。 | **FIXED**（稳定文件场景） |
| 9. **连带-1**：dispatch 拆除期 SqliteError 不再循环放大 | catch/best-effort 和 finally 的读失败退出只能覆盖“读也失败”；如果读成功而写失败，queued 不变又自动 kick，仍构成无限异步循环，见 R3-03。 | `tests/agent-tasks.test.ts:76–81` 改成 await pool.closeAll 后删除根，避免原拆除时序；没有定向注入“读成功/写失败”并断言有限重试。正常路径三次绿的上游报告不能证明故障收敛。 | **NOT-FIXED** |
| 10. **连带-2**：同毫秒 id 单调排序 | `src/agent/tasks/task-service.ts:385` 使用未补齐宽度的 base36 序号，而 `:274–279` 仍按字符串比较；z→10 进位时依然逆序，见 R3-04。 | 现有“取消排队中任务”只检查普通两个提交的 queuePosition；本批未找到固定毫秒并跨 base36 位数边界的回归锚点。重复运行不能排除该确定性边界。 | **NOT-FIXED**（Minor，显示次序问题） |

## ② 本轮修复触碰面问题

### R3-01｜Major｜force 推送被非 force preview 的 blocked 语义截断

- **定位**：`server/src/ops/command-table.ts:621–638`；`server/src/sources/feishu-write-service.ts:249–258,371–388`。
- **触发条件**：正常可 append 的 dirty 源、写权限有效，但 metas 抛错/无可信时间或基线时间不可读；Work 调 `source.push {objToken, force:true}`。
- **实际影响**：新增批准前 preview 返回 blocked(cloud_time_unreadable)，deriveConfirm 在检查 force 之前抛 source_push_blocked，连 OVERWRITE_CLOUD 批准卡都不能产生。旧服务明确允许用户核对后 force+OVERWRITE_CLOUD 跳过该时间门；该能力现从 app_command 不可用。
- **证据**：preview 无 force 输入，时间不可读将原 append/overwrite 变 blocked；deriveConfirm 对所有非 append/overwrite 一律拒绝。执行服务则在 `options.force !== true` 时才读取/比较时间。R2 报告明确保留此显式强推契约；现有四态测试的 force metas 健康，不能覆盖该反例。**静态路径证实，未动态复现**。
- **最小修复方向**：让权威 preview/plan 能表达本次 force 执行语义，区分可由显式强推越过的时间门与权限/内容等不可越过的 blocker；批准仍展示并注入 OVERWRITE_CLOUD，不能笼统允许所有 blocked。由实施者补真实路由的 metas 不可读+force 对照非 force 回归。

### R3-02｜Major｜批准后的异步 plan 复核重新打开停止后写入窗口

- **定位**：`server/src/agent/tools/app-command-family.ts:234–254,322–335`。
- **触发条件**：同轮合法 source.push 获批，运行状态及 runId 检查通过；第二次 push/preview 等待 lark metas/revision 时用户停止（或该轮结束并启动下一轮）；preview 最后返回相同 mode。
- **实际影响**：runSpecs 在 await 返回后只比较 planKey，随后使用 desktop token 发真实 push；没有再次检查 aborting/idle/runId，也无取消 signal。因此已停止轮仍可发云端写入，甚至在新轮期间执行旧批准。
- **证据**：调用顺序为 `runState/runId 检查 → return runSpecs() → await executeSpecs(preview) → executeSpecs(push)`；executeSpecs 本身不消费会话停止/轮次。批准已从 pending settled，cancelForSession 无法撤销这段 continuation。新增跨轮测试用 kb.build，没有第二次 preview；真实 source.push 测试没接 SessionService，二者不能互相补足此时序。**静态时序证实，未动态复现**。
- **最小修复方向**：提取同一授权轮有效性检查，在异步 preview 完成后、真正派发 mutation 紧前重新检查停止状态和轮次；将取消传播到可取消的复核链。实施者补真实 SessionService+真实 source 路由、延迟第二次 preview→stop/换轮→释放，断言零写入。

### R3-03｜Major｜读成功/写失败时 queued 仍被无界重新派发

- **定位**：`server/src/agent/tasks/task-service.ts:417–436,511–519,548–559,618–642`。
- **触发条件**：任务仍 queued，存储允许 getAgentTask，但 updateAgentTask 持续失败（例如 SQLite 写故障/只读状态）；进程池仍可立即授槽。
- **实际影响**：设置 running 写失败→catch 内 finish(failed) 写也失败→错误被吞后返回→finally 读到 queued→立即 kickDispatch。同一任务不停 acquire/release、读写与日志，形成无退避微任务循环，仍可放大 CPU/日志并阻塞服务；没有 spawn 也不等于没有循环。
- **证据**：新增 catch 并未改变 queued 或设置“本轮调度失败，禁止补派发”的内存标志；finally 仅凭 status===queued 无条件再 kick。finish 本身也是读取后 update，两个写失败不会自然收敛。读也失败会被 finally catch 截住，但不覆盖此条件。**静态路径证实，未注入真实 SQLite 故障**。
- **最小修复方向**：只为确实发生的 blocked→resume 清理竞态补派发，或在调度/落库失败时停止自动重派，保证故障有限收敛；不要依赖再次读库一定失败。实施者补读成功写失败的 fault injection，断言 dispatch/日志次数有界及无残留槽位。

### R3-04｜Minor｜单调数字的变长 base36 字符串并不单调

- **定位**：`server/src/agent/tasks/task-service.ts:274–279,385`；`server/src/modules/local-map-store.ts:2501–2511`。
- **触发条件**：同一毫秒、同一会话两个排队任务的进程级 taskSequence 分别到 35、36（或以后其他位数进位）。不要求单会话同时积累 36 个活跃任务，序号是进程全局的。
- **实际影响**：先提交 id 为 `t_<ms>_z_…`，后提交为 `t_<ms>_10_…`；相同 created_at 下字符串 `10` 小于 `z`，后者 queuePosition=1、先者=2，列表同样逆序。实际池 FIFO 未被这段代码改变，故限 Minor，不夸大为任务执行乱序。
- **证据**：序号虽数值递增，写入 id 前仅 toString(36)，没有固定宽度；DTO 及 SQL 仍按字符串键排序。**静态确定性反例，未执行项目入口**。
- **最小修复方向**：使用排序保持的固定宽度序号或独立数值排序键；实施者固定时钟并覆盖 z→10、zz→100 进位边界。

## ③ 结论、盲区与现场

- **6 FIXED / 2 REGRESSED / 2 NOT-FIXED**；本轮记录 **3 Major + 1 Minor**。R2 原归属、根授权、resume 丢派发、路径别名、插件资源身份、vision 原全量 Buffer 反例均已静态关闭；不能据此整体放行。
- 修复报告所称“真实路由四态”和“真实 SessionService 流时序”确有实质，不是上轮无条件成功路由或手动 running stub；但两组测试没有组合覆盖新增异步 preview 与会话停止的交叉窗口。插件管理组合门和故障收敛也缺独立集成/故障断言。
- 仅核验测试内容及实现可达性，未独立执行任何测试；真实 Pi→RPC 事件/HTTP 排序、真实云端、打包及平台行为未验证。不签发动态验收通过结论。
- R2 遗留观察（raw_read_image signal、同步 DB fail-open、CLI 写授权入口、Windows 卷别名）按任务约束原样保留，未扩大审核；R3-03 是本轮明确授权的 **task dispatch 故障循环**，不是重报同步引擎 DB 遗留项。
- 本轮仅新增本报告，无源码、项目测试、应用状态或 Git 修改；无需项目回滚，撤销本轮产物仅移除本报告（不处理其他工作区改动）。metadata 由 harness 托管。

VERDICT: FIX
