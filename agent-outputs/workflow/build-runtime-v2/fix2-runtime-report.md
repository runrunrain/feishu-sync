# fix2-runtime-report：F09-R1 / F10-R1·R2·R3 修复与 ENOTEMPTY quiescence 归因

> 本报告保留各轮迭代历史，旧§八的M1→C0顺序/defaultKill能力表述已由§十–十二替代；最终集成另含Leader的整体扫描失败、账本schema与pre-spawn意图修正，以`fix2-integration-report.md`及实际代码为准，不把旧轮描述当最终能力证明。

状态：修复批 R2（基线 = 主树 dirty-snapshot 25cc0b4 + 统一修复 + 用户 WIP，本 worktree `amagi/build-v2-r2-runtime`，未提交）。未复用旧 worktree 代码；未采纳被拒的 046 queued 放宽补丁（queued/not-started 无锚点维持 unconfirmed 阻断，`scanV2StoreIntents` 判定语义未放宽）。未改 amagi 上游（验证统一用冻结副本 `/tmp/feishu-build-v2-r2/amagi-pi-2.21.31`，steer 调整 #2/#3，hash 9485dd95…与原受信缓存一致，未为版本漂移改 pin）；未新增应用派发器；全部测试用临时 FEISHU_SYNC_HOME/临时目录，未用生产资料/真实凭据。

本轮含 Leader 运行中调整（steer #1–#5）落实，见 §八。

## 〇、改动清单（方法面最小 patch，无整文件覆盖）

| 文件 | 改动 |
|---|---|
| `server/src/agent/build-runtime/process-residual.ts` | F10-R1：根 pid 不在进程表时按锚点 pgid 扫描存活同组成员 → 逐个 unconfirmed（零信号），整体因此 unconfirmed；全部组员已退才保持 exited/confirmed。F10-R2：`snapshotGroupMembersWithBirth` 增加根归属**枚举前/后双端 fresh 复核**，任一端失败 → memberPlan 整份作废（unavailable 如实上报）；`reapIndividual` 复用同一 reverify。新增 `listBuildHomeDirs`（epochs/e*/home + legacy home 枚举，供跨 epoch 对账）。模块头补充 R1/R2 纪律说明。 |
| `server/src/agent/build-runtime/adapter.ts` | 新增 `reconcileBuildResiduals({buildId, binding}, opts)`：构建级跨 epoch 对账（全部 epoch home + legacy home；归属集 = 账本全部 leader 条目 + binding pid；无任何旧运行事实返回 null）。`resume` 守卫与 `cancel` 终止对账改走构建级（换目录不能绕过旧 epoch 残留）。保留原 `reconcileResiduals(binding)`（单 epoch，契约接口不变）。 |
| `server/src/kb/build-leader-supervisor.ts` | F09-R1：`evaluateIdle` 活跃集合增加 generation 过滤（与前端 `isHistoricalRuntimeTask` 同口径：epoch 或 generation 不匹配 = 历史；revoked 既有过滤保留；actors 列表保留历史）。F10-R3：`prepareResume` 对一切非 fresh 恢复**总是**先新鲜对账（不再只在记录 unconfirmed 时重试）：termination 缺失/null 也对账；已 confirmed 重新证明；仍 unconfirmed → `kb_termination_unconfirmed` 阻断（session 与 rebuild 一致），拒绝发生在换代/推进 epoch 之前。 |
| `server/src/kb/build-runtime-host.ts` | 监督器 `reconcileResiduals` 回调改走 `adapter.reconcileBuildResiduals`（binding 可空——账本/旧 epoch 有事实也要对账）；结果仍写 `state.termination`。 |
| `server/src/kb/kb-build-service.ts` | 新增 `pipelineRuns` 登记（createBuild/resumeBuild 两处 fire-and-forget Promise 入册，收口自删）与 `shutdown(localMapStore, {timeoutMs})`：取消全部活动构建 + 有界等待流水线收口，返回 `{cancelled, unsettled}`（超时不无限阻塞退出，未收口如实上报）。 |
| `server/src/index.ts` | 新增导出 `shutdownServices(app)`：知识构建取消并等 OS 级收口 → pending 批准取消 → 云端轮询器停 → agent 会话池回收 → LAN 网关关。`startServer.close()` 改为 `clearInterval + shutdownServices + HTTP close + CLI 端点撤销`（原顺序语义保留：子进程先于 HTTP、CLI 最后撤）。`buildServer` 暴露 `__kbBuildService`/`__localMapStore`/`__shutdownServices`（裸 buildServer 消费方与生产同一 await 链）。 |
| `server/tests/build-runtime-process-residual.test.ts` | 新增 R1 注入、R1 真实 OS（根 SIGKILL+同组孤儿）、R2 枚举前/枚举后失效、`listBuildHomeDirs` 用例。 |
| `server/tests/build-runtime-integration.test.ts` | 新增 F09-R1（同 epoch 旧代次不挂 idle）、F10-R3（termination null 的 rebuild 也对账+阻断+确认后放行）、F10-R3（陈旧 confirmed 重新证明）。既有对照用例按 F09-R1 新口径更新（同 epoch 需同**当前代次**才计入活跃）。 |
| `server/tests/build-runtime-adapter.test.ts` | 新增 `reconcileBuildResiduals` 跨 epoch 用例（旧 epoch not-ours 不杀 + 新 epoch v2-store 缺口 + 无事实返回 null）。 |
| `server/src/agent/build-runtime/process-identity.ts` | 仅注释修正（steer #1）：头注释不再声称 pgid-invariant 可作缺 birth 的次级回收证明（该降级路径已删）；linux birth 已含 boot_id，单一身份层不另造重复层；contracts/ledger 的 proof 联合保留 `pgid-invariant` 仅为历史持久化记录兼容。 |
| `server/tests/build-runtime-fix-e2e.test.ts`、`build-runtime-e2e.test.ts` | afterAll 改为：先 `__shutdownServices()`（正式服务级关闭链）→ 关 HTTP → 关 fixture → **quiescence 之后**有界 rm 重试（3 次×500ms；再失败保留现场打印 `[kept-home:rm-failed]`，不掩盖活进程）。fix-e2e 另把 `builtApp` 提升为 describe 作用域。 |

**steer #1/#4/#5 增量改动（详见 §八）**：组员封存改双夹逼时序（M1→C0→M2→C1 + 根前后端点）；`findAliveLedgerLeaders` 账本存活 Leader 检测（binding 未落盘窗口）；fresh 启动也过对账门；`prepareResume` 模式归一（修复生产 fresh 未定义 resumeMode 误入恢复换代的预存 quirk）。

接口变化（均为 additive，无签名破坏）：
- `PiAmagiBuildRuntime.reconcileBuildResiduals(input, options)` 新方法（未动 `BuildRuntimeAdapter` 契约接口）。
- `KbBuildService.shutdown(localMapStore, options?)` 新方法。
- `shutdownServices(app)` 从 `server/src/index.ts` 导出；`app.__shutdownServices()`/`__kbBuildService`/`__localMapStore` 新暴露（消费方：startServer.close 与裸 buildServer 测试）。
- `startServer().close()` 行为增强：关闭时取消进行中构建并等待收口（最长 120s 有界）。
- F11 authorityLease 原对象透传、F12 workflow integrity、F15 DTO 均未触碰。

## 一、F10-R1：根退出 ≠ 任务后代全退（假 confirmed 修复）

- 根因：旧实现根 pid 不在进程表即 `exited; continue`，完全不枚举同组成员；桥/孙进程仍活时整体可 confirmed（原复审 residual-probe 真实 OS 复现 `outcome.state:"confirmed"`）。
- 修复：exited 分支先按锚点 pgid 在**分类快照**中找存活同组成员（多锚点共享组去重）；有存活成员 → 根 finding 仍 exited（如实）+ 每个成员 unconfirmed（`proof:'none'`，detail 说明根死后无法建立归属时序、不按 PGID 降级杀）→ 整体 unconfirmed 阻断新 Leader；无存活成员 → 维持 exited/confirmed。观察模式（reap:false）同样执行该扫描（纯观察，零信号）。
- 验证：
  - 注入用例：`R1（注入）` —— 成员 5009 unconfirmed、零信号、仍活、整体 unconfirmed（tests 55/55 过）。
  - 真实 OS：`R1（真实 OS）`（同时是原复现脚本场景的常驻用例）。
  - 原隔离脚本适配重放：`/tmp/feishu-build-v2-r2/residual-probe.mts` → `PASS REAL_ROOT_EXITED_SAME_GROUP_ORPHAN {"orphanAlive":true,"state":"unconfirmed","memberVerdict":"unconfirmed"}`（旧实现此处 confirmed）。脚本只杀自己创建的进程。

## 二、F10-R2：根归属失效后仍回收未经归属证明的"组员"（误信号修复）

- 根因：旧实现组员枚举只做成员自身 birth 记录+逐信号 fresh——成员令牌匹配只证明"还是刚发现的那个进程"，不证明属于本次构建；根在分类后换人时，枚举到的是换人后的组成员，memberPlan 仍被无条件消费（原复审注入复现向 5001 发出 SIGTERM）。
- 修复：`snapshotGroupMembersWithBirth` 增加**枚举前/后**根出生令牌 fresh 复核（令牌跨进程生命周期不变，双端点一致 = 枚举窗口内根未换人 → 组归属随根证明成立）；任一端失败（根退出/换人/探测失效）→ 返回 unavailable，memberPlan 整份作废（reapRecordedMembers 把 unavailable 如实转 unconfirmed finding，零信号）。根自身每信号 fresh 与成员逐信号 fresh 保留不变。
- 验证：
  - `R2（注入）枚举前失效`（原复现脚本 ROOT_REUSED_BEFORE_MEMBER_DISCOVERY 场景）：全零信号（旧实现 signals=[{pid:5001,SIGTERM}]）、计划作废 finding 含"枚举前"、成员仍活。
  - `R2（注入）枚举窗口内换人`：后复核失败 → 计划作废（"枚举后"）、全零信号。
  - 既有组员正常回收用例（根稳定时预录+逐信号复核回收 5008/5009）不受影响（仍过）。

## 三、F09-R1：后端 idle 活跃集合与前端统一（generation 过滤）

- 根因：`evaluateIdle` 只过滤 epoch 与 revoked，不过滤 generation；session 续接同 epoch 换代后，旧代次 running actor 的完成通知永不再来，两段空闲收口永远达不到（原复审 resume-probe 实测 `evaluateIdle()=null`）。
- 修复：活跃集合 = `status!=='revoked'` && epoch 匹配 && generation 匹配当前 && execState 活跃——与前端 `isHistoricalRuntimeTask`（epoch 或 generation 不匹配即历史）同口径；actors 列表与 DTO 不动（历史保留）。
- 验证：新增 `F09-R1` 用例（generation 1→2 session 续接后 leader-idle 可达、nudge 恰 1 次、旧 actor 仍在列表）；原隔离脚本适配重放 `resume-probe.mts` → `PASS HISTORICAL_GENERATION_IDLE {"outcome":{"kind":"leader-idle"}}`（旧实现 null）。既有 F09 对照用例按新口径更新（同 epoch 且当前代次仍计入活跃——语义修正而非放宽）。

## 四、F10-R3：一切带旧运行事实的恢复先新鲜对账（换 epoch 不能绕过）

- 根因：`prepareResume` 只在记录到 `unconfirmed` 时重试对账；termination 缺失/null（应用硬崩未落记录）直接放行。session 恢复另有 adapter.resume 兜底，但 rebuild 直接 `adapter.start` 新 epoch——证据缺失反而绕过第二 Leader 门槛（原复审 resume-probe 实测 `reconcileCalls:0, guardAllowed:true`）。且旧实现对账只扫当前 binding 的 epoch 目录，rebuild 换目录即绕过旧 epoch 残留。
- 修复（三层，不只一个 if）：
  1. 监督器：非 fresh 恢复**总是**先调宿主对账（缺失/null/confirmed 一律重新证明；confirmed 不再走快捷通道）；unconfirmed → 阻断（session/rebuild 一致）；拒绝发生在换代/推进 epoch/启动新 Leader 之前。宿主回调不可得但存在 unconfirmed 记录 → fail-closed。
  2. 宿主：回调改 `reconcileBuildResiduals`，binding 可空（binding 未落盘但账本/旧 epoch 目录有事实的窗口也被覆盖）。
  3. 适配层：`reconcileBuildResiduals` 跨全部 epoch home + legacy home 对账（rebuild 换目录不能绕过）；`resume` 守卫与 `cancel` 终止对账均改走构建级。无任何旧运行事实（无 home/账本/binding）返回 null（fresh 构建无据可对，不冒充 confirmed）。
- 验证：
  - `F10-R3 termination 缺失 rebuild`（原复现脚本 CRASH_WITHOUT_TERMINATION_RECORD 场景）：阻断 `kb_termination_unconfirmed`、reconcileCalls=1、epoch/generation 不推进；对账转 confirmed 才放行（epoch 1→2）。
  - `F10-R3 陈旧 confirmed`：记录 confirmed 仍重新对账，未确认即阻断。
  - adapter 跨 epoch 用例：旧 epoch not-ours 个体零信号 + 新 epoch v2-store 缺口同时可见、note 含"跨 2 个 epoch"、无事实构建返回 null。
  - 原隔离脚本适配重放：`resume-probe.mts` → `PASS CRASH_WITHOUT_TERMINATION_RECORD {"code":"kb_termination_unconfirmed","reconcileCalls":1,"generation":1,"runtimeEpoch":1}`。
- 边界（如实）：queued/not-started 无锚点任务维持 unconfirmed 阻断（F10 严格裁决保留）；spawn→锚点同步写入之间的微秒级硬崩窗口个体不可发现，仍按 unconfirmed 上报（原生机制边界，未引入新证明机制）。

## 五、ENOTEMPTY quiescence：归因、时间线与修复

### 写者身份（已闭环的证据链）

1. **消费者核实（上游只读代码）**：pi（@earendil-works/pi-coding-agent，本机 1.4.0 dist）`core/auth-storage.js` 的 `FileAuthStorageBackend.ensureFileExists()` 在**任何** auth 锁使用（`withLock`/`withLockAsync`，含读）前执行 `writeFileSync(authPath, "{}")`——2 字节 `{}`；`createAgentSession` 以 `agentDir/auth.json` 为 authPath（`PI_CODING_AGENT_DIR` 下）。Leader 与每个 amagi 子任务都是 pi 进程，共享构建 epoch home。
2. **失败现场吻合（上游复审取证，未读内容）**：残留恰为 `epochs/e2/home/auth.json` 2 字节（birth/mtime 2026-11-01T07:40:43，构建 b_20261101154022 创建于 07:40:22——rebuild epoch e2 的 pi 进程启动即惰性创建）。
3. **本轮真实 OS 复现（新增）**：`/tmp/feishu-build-v2-r2/auth-writer-probe`——真实 pi RPC 进程 + 临时 agentDir：启动后 `<home>/auth.json` 出现（2 字节 `{}`）；**进程存活期间删除 home 后 3 秒内 auth.json 被重建**（`{}`，birth=mtime 重建时刻）。即：rm 递归删除进行中，任一存活 pi 进程触碰 auth 存储 → 文件重建于已清空目录 → rmdir ENOTEMPTY。日志与现场保留于上述目录。

### 失败时间线（最新 feature-only-native 失败重构）

1. fix-e2e 6 用例本体全部通过；末次 `cancelAndWait` 等到**业务**状态 cancelled（≠ OS 退出完成）。
2. afterAll（旧实现）只关 Hono HTTP 与 fixture 模型服务——裸 `buildServer` 从未走正式服务关闭链（当时该链不存在：`startServer.close()` 也不取消知识构建），没有任何环节等待 Leader/子任务/桥的 OS 级退出。
3. 残留 pi 进程（正常收尾对账判 unconfirmed 的个体，或退出窗口内的进程）在 fixture 关闭后继续尝试模型请求/auth 读 → `ensureFileExists` 在 rmSync 删除期间重建 auth.json → afterAll 第 373 行 ENOTEMPTY。

结论：**双缺口**——(a) 裸 buildServer 测试未走（也不存在）正式 shutdownServices；(b) 生产 `startServer.close()` 同样不取消进行中的知识构建（agentPool 只覆盖 session/background 池，构建 Leader/子任务不在其中）——业务 cancelled/HTTP close 都不是 OS 退出。

### 修复

- `shutdownServices(app)` 唯一 await 链（见 §〇）；`KbBuildService.shutdown` 取消全部活动构建并**等待流水线真收口**（含 Leader 宽限 terminate 等真实管道关闭 + 残留回收对账；有界 120s，超时如实报 unsettled，重启由 `reconcileOnStartup` 对账，不假装收敛）。
- 生产 `startServer.close()`/Electron QuitCoordinator 路径与裸 buildServer 测试共用该链；两个 e2e afterAll 先 `__shutdownServices()` 再关 HTTP/fixture，**取得 quiescence 之后**才做有界 rm 重试（重试仅兜已知写者全部退出后的尾写竞争；再失败保留现场打印，不用重试掩盖活进程——若 shutdown 后仍有进程写盘，说明存在未登记写者，现场交人工）。
- 验证：见 §六 e2e 重跑；auth.json 写者机制由上述真实 OS 探针独立证明。

## 六、验证记录（cwd=server/ 除注明；真实命令与退出码）

| 验证 | 结果 | 证据 |
|---|---|---|
| `npx tsc --noEmit`（server）；根 `npm run typecheck`（root src + 配置 + server 三段） | 均 EXIT=0 | 根全量 typecheck 本轮重跑 |
| `npx vitest run tests/build-runtime-process-residual.test.ts tests/build-runtime-integration.test.ts tests/build-runtime-adapter.test.ts --cache=false` | 77/77 通过（含新增 R1×2/R2×2/listBuildHomeDirs/F09-R1/F10-R3×2/跨 epoch） | 集成测试一个既有对照用例按 F09-R1 新口径更新（同 epoch 且当前代次才活跃），属语义修正非放宽 |
| 原隔离复现脚本适配重放（导入本 worktree 实现，场景/断言与原复审脚本一致） | residual-probe 2/2 PASS、resume-probe 2/2 PASS（EXIT=0） | `/tmp/feishu-build-v2-r2/{residual,resume}-probe.{mts,log}` |
| auth.json 写者真实 OS 探针（真实 pi RPC 进程 + 临时 agentDir） | 启动即建 2 字节 `{}`；进程存活期间删 home 后 3 秒内重建 | `/tmp/feishu-build-v2-r2/auth-writer-probe/`（rpc.out/rpc.err/home 现场） |
| eslint（改动 11 文件） | EXIT=0 | — |
| fix-e2e 真实链路（真实 pi/amagi/桥 + fixture 模型；冻结 amagi 2.21.31 副本 `/tmp/feishu-build-v2-r2/amagi-pi-2.21.31`） | 连续 3 轮（run2/3/4）各 6/6 通过，EXIT=0；afterAll 均正常删除临时 home（无 kept-home、无 ENOTEMPTY）；run2 F10 主链 8.1s、F09 续接/重建 3.3s | `/tmp/feishu-build-v2-r2/fix-e2e-run{2,3,4}.log`；run1 失败归因见 §七注 |
| build-runtime-e2e + integrity（同冻结源；integrity 另补 PI_PROBE_SOURCE_AMAGI 跑 live 面） | e2e 3/3；integrity 单元 24；integrity 含 live 场景 25/25 通过 | `/tmp/feishu-build-v2-r2/e2e-integrity-run1.log`、`integrity-live-run1.log` |
| server 全量 `npm test --silent` | 2902 通过 / 9 skip / 1 失败——`protected-workspace R01`：本 worktree `server/node_modules` 为 portable **符号链接**，`lstatSync` 判非目录 → `workspace_path_invalid`；主树同路径真实目录 `isDirectory=true`。`path-guard.ts`/该测试均不在本批写面（11 文件 diff 已核对）——worktree 环境伪影非代码回归 | `/tmp/feishu-build-v2-r2/server-full-run1.log`；lstat 双路径对照实盘 |
| 根前端 `npm test --silent` | 77 文件 / 519 用例全过，EXIT=0 | `/tmp/feishu-build-v2-r2/root-test.log` |

## 七、运行记录补遗与未测边界

### 环境与过程注记

- fix-e2e run1 失败归因：误用主树 amagi-pi（工作树 package.json 已漂移 2.21.32，与 pin 2.21.31 不符）→ install 端点 400、后续两用例链式失败。按 Leader 调整 #2 改用冻结副本 `/tmp/feishu-build-v2-r2/amagi-pi-2.21.31` 后 run2/3/4 连续 3 轮 6/6。run1 失败现场 home（kb-fix-e2e-oq7in3）因 keepHomeOnFailure 保留，已按守卫建议 mv 到 `${TMPDIR}/amagi-trash.hhJnUJ/` 留存（未删除）。
- 历史取证目录 `kb-fix-e2e-NluHe2`（增量复审 ENOTEMPTY 现场）与 `kb-fix-e2e-U1U6P2` 保留不动；本轮三次绿运行的临时 home 均在 afterAll 内干净删除（无新增残留）。
- 本轮所有真实链路均 fixture 模型/临时 HOME；未触碰 `~/.feishu-sync`、生产资料或真实凭据；未改 amagi 上游；未提交。

### 未测边界（如实，不冒充通过）

- **Windows 真机/打包/UNC、setsid 逃逸孙进程**：未测（F13 代码层修复不因此升格；R1/R2 的成员归属纪律对未知平台维持 fail-closed，Windows 进程表不可得 → 全部 unconfirmed 零信号，不发不支持平台的任何安全声明）。
- **真实模型质量/性能、A23 六源三路径**：未测（fixture 模型不代质量）；轮次/DTO 语义由单测与既有 UI 验收覆盖。
- **spawn→锚点同步写入间的硬崩窗口**：个体不可发现，维持 unconfirmed（原生机制边界，未引入新证明机制）；queued/not-started 无锚点继续严格阻断（未采纳被拒的 046 放宽补丁）。
- **PGID 回绕复用**：根退出后同 pgid 成员可能属于无关新组（旧组全退后号码释放）——本实现一律 unconfirmed 零信号（保守阻断，宁误报不误杀）；收敛依赖重新对账时的新事实。
- **ENOTEMPTY 稳定性**：连续 3 轮 afterAll 干净（修复前该失败为间歇性单次，无法用有限轮次证明永不再现）；写者机制已由独立探针闭环；若 quiescence 后仍现残留即为未登记写者，现场以 `[kept-home:rm-failed]` 保留交人工。
- **`KbBuildService.shutdown` 超时路径**：无专项单测（逻辑为有界等待 + 如实上报 unsettled；120s 上限内未收口时直接返回清单，不假装收敛）。

## 八、Leader 运行中调整（steer #1–#5）落实

### #1 环境裁决与 R3 收窄检查

- 验证源已统一为冻结副本 `/tmp/feishu-build-v2-r2/amagi-pi-2.21.31`（run1 误用漂移源已纠正并归因）；未改 pin、未改上游。
- R3 未以单 if 命中过窄：`prepareResume` 对**一切模式**（含未定义 resumeMode 归一为 fresh 的生产路径）执行对账门；binding 未落盘窗口由 `findAliveLedgerLeaders`（账本存活 Leader 检测）+ `listBuildHomeDirs`（旧 epoch 目录事实）覆盖，无 binding 也能阻断。
- 关闭竞态先查了生产 close 的既有 await 链：**改动前 `startServer.close()` 不取消任何知识构建**（只做 approvals/pollers/agentPool.closeAll/HTTP——agentPool 只覆盖 session/background 池，构建 Leader/子任务不在其中），故生产链补齐不足推测性重构，而是补齐缺失环节；测试侧只是让裸 buildServer 消费同一链。
- `process-identity.ts` 头注释矛盾已修（见 §〇）。

### #4/#5 组员封存双夹逼时序（advisor 约束采纳）

- 发现仅候选；封存要求（`snapshotGroupMembersWithBirth`）：R0（根 birth fresh）→ M1（ps 候选）→ C0（成员 birth）→ M2（第二张 ps：仍在同组）→ C1（成员 birth 与 C0 一致）→ R1（根 birth fresh 仍匹配）。根身份区间包住成员身份区间再包 membership；任一步失败 → 该成员不封存（`unprovable` 带 reason 如实上报，零信号）；根端点失败 → 整份计划作废。绝不把「ps 里见过」与「后来读到的 birth」两个不同时点拼成归属，也不把多个各自 fresh 但不同时的事实拼接。
- 「根持续稳定但成员 PID 在 ps→birth 间被复用」：新占用者要么不在同组（membership 夹逼失败）要么 birth 不一致（身份夹逼失败）→ 不封存零信号（旧实现会保存新占用者令牌并在 fresh 匹配后误杀）。
- 已封存后根退出不追溯撤销：成员回收仍按其自身 birth 逐信号 fresh 复核（既有纪律）。
- **私有 session 前提（修正轮补强）**：同 PGID 本身不授归属（同组≠同 run）。封存前经 `readProcessGroups` 验证：linux 读真实 SID（/proc stat）要求根 sid===rootPid 且成员 sid===rootPid；darwin 实测 PROC_PIDTBSDINFO 无 SID 字段（word[25]=pgid，实测验证）→ 按"固定启动实现"前提（amagi 2.21.31 pin+内容哈希逐次核验的 detached spawn 语义）+ ps 双快照组长佐证。前提不可验证/不匹配 → 成员不封存（`session-premise-unverified`，零信号）。新增矩阵：根 sid≠rootPid、成员同组异 session、darwin 无 sid 三态。
- launch 准入串行：同 buildId 由 host `sessions` Map（重复 runLeaderPhase 抛 `build_runtime_busy`）+ KbBuildService 单构建串保证；prepareResume 与 startLeader 在同一 run() 内顺序执行。

### #5 能力如实声明（不宣称严格零误杀）

- 生产信号路径 = 个体 pid + 内核出生令牌**逐信号前 fresh 复核**后 `process.kill(pid)`：fresh 复核与 kill 之间存在操作系统级 pid 复用微窗口，无新增 OS helper（按裁决不引入）不可关闭——「reaped」语义为「身份绑定终止 + 退出已观察确认」，**不是严格零误杀声明**；测试中注入的 identity-bound 正例不代麦生产具备原子 capability。
- 仅历史发现/只有数字 PID、无稳定进程引用的目标绝不自动发信号（unconfirmed 阻断）；可终止者限：当前持有的自有 ChildProcess（`rpc.terminate` stdin 关闭/宽限/SIGKILL，Windows taskkill /T /F 仅作用于自有子进程句柄路径，非本批新增、非裸 PID 扫杀）与上述 identity-bound 出口；本批未新增任何裸 `kill(-pid)`/`taskkill` 面，Windows 残留探测维持能力诚实（进程表不可得 → 全 unconfirmed 零信号）。

### 预存 quirk 修复（fresh 未定义 resumeMode 误入恢复换代）

- 实测代码路径：生产 fresh 调用面 `resumeMode` 未定义（host 仅在有 resumeStrategy 时传），旧 `prepareResume` 的 `if (options.resumeMode === 'fresh') return` 对 undefined 不生效 → fresh 生产运行落入恢复换代分支（generation 被 +1、错误标注「恢复换代」撤凭据）。已归一（`const resumeMode = options.resumeMode ?? 'fresh'`），与显式 'fresh' 同语义。
- **DTO 可见变化**：生产首次构建的 `generation` 由 2 变为 1（与单元测试语义、`freshLeaderRunState` 意图一致）；前端无 generation 数值断言，不受影响。

### 回滚方式

全部改动未提交（12 文件 + 1 报告，见 `git status`）。**不要对主树做整文件 checkout**（基线含用户 WIP，整文件回退会伤及用户改动）：应先 `git diff > /tmp/fix2-runtime-r2.patch` 固化本轮 patch，回滚用 `git apply -R /tmp/fix2-runtime-r2.patch` 逆向应用（可按 hunk 取舍）；新增测试与源码同 patch；`/tmp/feishu-build-v2-r2/` 下的探针/日志可整体删除（历史取证目录除外）。

## 九、steer 轮验证补记

| 验证 | 结果 | 证据 |
|---|---|---|
| `npx tsc --noEmit`（server，steer 改动后） | EXIT=0 | — |
| 定向三文件（process-residual / integration / adapter） | 82/82 通过（新增：R2 membership/identity 夹逼×2、findAliveLedgerLeaders、fresh 对账门、账本存活 Leader 守卫） | — |
| 原隔离脚本适配重放（steer 改动后） | residual 2/2 PASS（修复脚本陈旧 pid 文件读取后重跑；本轮泄漏的一个探针子进程已按 pgid 精确清理）、resume 2/2 PASS | `/tmp/feishu-build-v2-r2/{residual,resume}-probe.log` |
| fix-e2e + e2e 真实链路（steer 改动后，冻结源） | 9/9 通过（run5），afterAll 干净 | `/tmp/feishu-build-v2-r2/fix-e2e-run5.log` |
| eslint（steer 改动文件） | EXIT=0 | — |
| server 全量（steer 改动后，两次） | run2：2905 过/9 skip/3 败；run3：2906 过/9 skip/2 败。恒定败 1 = protected-workspace R01（worktree 符号链接环境伪影，非代码回归）；其余为满套件并行负载下的 5s 超时（run2 的 adapter observe、run3 的 kb-version——两文件均不在本批写面，且各自单独重跑全绿；run1 预 steer 满套件同条件过，属间歇性负载 flake） | `/tmp/feishu-build-v2-r2/server-full-run{2,3}.log`；单独重跑：adapter 27/27、e2e 3/3 |

### 满套件 run2 的 kept-home 取证补充

- run2 中 build-runtime-e2e 失败（'running' 未到 published，负载超时）按测试既有 keepHomeOnFailure 机制保留 `kb-e2e-v2-JDcCxQ`（失败现场，非清理 bug）。
- 另有 `kb-fix-e2e-zRbTX8`：fix-e2e 6/6 通过、afterAll rm **成功**（无 kept-home 打印），但树内唯一残留文件为 `agent/builds/<id>/epochs/e2/home/auth.json`（mtime 09:34:29，晚于其余内容）——即本轮满套件重负载下该次运行的终止对账走了 unconfirmed 出口（测试双出口允许），**未被回收的存活子任务**在 rm 之后经 pi `FileAuthStorageBackend.ensureParentDir()+ensureFileExists()` 重建了该路径（写者机制 §五的活体复现，跨 rm 窗口的迟到写）。**【修正轮订正】**当时据此写下的「rm 成功 → ENOTEMPTY 失败模式已关闭/稀疏目录无害」是**过度结论**：rm 能成功只说明该窗口内目录树恰好删空，**不等于写者已退出**——同一行取证（rm 成功后 auth.json 被重建）恰恰证明当时仍有一个**活写者**在删除现场继续写盘，只是它的迟到写落在了已被删除的稀疏路径上、未与 rm 的 readdir 窗口相撞。换句话说：rm 成功是运气窗口，不是收口证据；换一次时序就会复现 ENOTEMPTY。该取证因此应保留为「**为什么不能在未确认收口时删 home**」的证据，而非「ENOTEMPTY 已无害」的证据。收口缺口的真正闭环见 §十二：shutdown 把持久/内存 termination-unconfirmed 纳入 unsettled 判定，quiesced=true 才允许清理。目录保留作取证。

## 十、Leader 反馈修正轮（3 项反例）落实

### 反例 1：defaultKill 残留 → 生产零信号真正落实

- 删除 `process-residual.ts` 的 `defaultKill`（生产 `process.kill` 出口）；`ReapContext.kill`/`ResidualDeps.kill` 改为**可选注入**并改写文档（测试模拟出口或自有 ChildProcess 句柄桥接；生产不注入）。
- 回收路径能力门控：`reapIndividual` 无出口直接 unconfirmed（零信号）；根与封存组员在无出口时各自如实上报 unconfirmed（detail 明示"生产无稳定自有引用：不向历史发现/仅数字 PID 目标自动发信号"）。报告此前的"仅历史 PID 绝不自动 signal"声明自此与代码一致。
- 正例改用**真实 own handle**：fix-e2e 真实 OS 用例改为两段——①生产形态（无注入）：归属可证存活 → unconfirmed 零信号、个体仍活；②桥接自有 `ChildProcess.kill`（出口内校验目标 pid 为本测试自有句柄）→ reaped；注入出口的 reaped 结论 detail 明注"非生产默认能力"。单元矩阵新增"生产零信号"与"注入出口正例"两条。
- 恢复门控有界重试（默认 15s/每 2s）：生产零信号后存活残留靠自然退出收敛，重试仅等收敛、仍 unconfirmed 即拒绝（不弱化证明）；睡眠不 unref（修正轮发现 unref 会让等待方进程提前退出）。

### 反例 2：探针失效 ≠ 不是本 run；旧事实不可读 ≠ 无旧事实

- `findAliveLedgerLeaders`：fresh **undefined（探针失效）→ unprovable 保守阻断**（新增用例）；仅 fresh 可得且与账本令牌**不匹配**才判 pid 复用不计。
- `listBuildHomeDirs` → `{homes, degraded}`：epochs/legacy 目录读取失败（非 ENOENT：权限/同名文件占位等）→ degraded。
- `adapter.reconcileBuildResiduals`：账本 degraded（`readProcessLedger` 损坏标记）或目录 degraded → 直接返回 **fail-closed unconfirmed**（"旧运行事实不可读：不能证明无残留，阻断新 Leader"），不再当没旧事实。新增目录占位 degraded 用例。
- ps 不可得路径维持既有 fail-closed（全个体 unconfirmed）。

### 反例 3：私有 session 前提（同 PGID 本身不授归属）

- 新增 `process-identity.readProcessGroups`（只读）：linux /proc stat 读真实 pgid/sid；darwin libproc PROC_PIDTBSDINFO 实测仅 pgid（word[25]，双重进程实测验证；**无 SID 字段**）；其他平台/探测失败 → 空 Map（不伪验证）。
- `snapshotGroupMembersWithBirth` 封存前验证前提：SID 证据可得（linux）→ 根 sid===rootPid 且成员 sid===rootPid 才可封存；SID 不可得（darwin）→ 依赖"固定启动实现"前提（amagi 2.21.31 pin + 内容哈希逐次核验的 detached spawn 语义）+ ps 双快照（M1/M2）组长佐证；前提失败 → 全部/该成员不封存（`session-premise-unverified` 零信号）。代码注释明确"同组≠同 run"。
- 新增零信号矩阵：根 sid≠rootPid（整组不封存）、成员同组异 session（该成员不封存）、darwin 无 sid 固定前提（可封存，注入出口回收正例）。

### 保留项

- R3 fresh/resume 状态串行与 shutdown 改动保留；本轮按指示未重复多轮全量：定向 88/88 + 原隔离脚本重放 + 单轮真实 API（fix-e2e+e2e 9/9）+ tsc/eslint 0；静场 full 由 Leader 统一执行。冻结 2.21.31 pin 不变。

### 本轮验证补记

| 验证 | 结果 | 证据 |
|---|---|---|
| 定向三文件（residual/integration/adapter） | 88/88（新增：生产零信号、注入正例、session 前提×3、探针失效 unprovable、目录 degraded、listBuildHomeDirs 新形状） | 本轮 |
| 原隔离脚本重放（最终代码） | residual 2/2 PASS；resume PASS（CRASH 场景 reconcileCalls=9——15s 窗口有界重试后仍阻断，epoch/generation 不推进；脚本断言按新语义更新） | `/tmp/feishu-build-v2-r2/{residual,resume}-probe.log` |
| 单轮真实 API（冻结源） | fix-e2e 6/6 + e2e 3/3 = 9/9，afterAll 干净；含新两段式 own-handle 正例（生产零信号 + 句柄桥接回收） | `/tmp/feishu-build-v2-r2/fix-e2e-run6.log` |
| `npx tsc --noEmit`（server）+ eslint（改动文件） | 均 EXIT=0 | — |

## ACHIEVEMENT:

| 验收 | 证据 | 状态 |
|---|---|---|
| F09-R1 后端 idle 统一当前 generation+epoch（保留历史） | `evaluateIdle` 过滤 + 单测 + 原脚本重放 `PASS HISTORICAL_GENERATION_IDLE`（旧实现 null 挂住） | 完成 |
| F10-R1 根死不宣布同组后代全死（零信号、不假 confirmed） | 注入用例 + 真实 OS 用例 + 原脚本重放 `PASS REAL_ROOT_EXITED_SAME_GROUP_ORPHAN {state:"unconfirmed"}`（旧 confirmed） | 完成 |
| F10-R2 组员归属时序（根端点夹逼 + 成员身份/membership 双夹逼） | 注入用例×4（枚举前/中失效、ps→birth 复用、C0→C1 换人）+ 原脚本 `PASS ROOT_REUSED_BEFORE_MEMBER_DISCOVERY {signals:[]}`（旧实现误发 SIGTERM） | 完成 |
| F10-R3 一切旧运行事实先新鲜对账（跨 epoch、binding 可空、fresh 同门控、账本存活 Leader 检测） | supervisor/adapter 单测 + fresh 门用例 + 原脚本 `PASS CRASH_WITHOUT_TERMINATION_RECORD`（旧 0 次对账放行；新语义有界重试后阻断） | 完成 |
| ENOTEMPTY 归因+修复（写者=pi auth-storage 惰性写/删后重建；生产与测试同一 shutdownServices await 链） | 三层证据（上游代码/2 字节现场/真实 OS 删后重建 + run2 迟到写活体取证）+ fix-e2e 多轮 afterAll 干净 | 完成 |
| 裁决 #5 修正（defaultKill 删除、生产零信号、own-handle 正例、不虚报能力） | 代码 diff（defaultKill 无引用）+ 生产零信号矩阵 + fix-e2e 两段式正例 + reaped 结论明注非生产默认 | 完成（修正轮闭环） |
| 裁决 #2 修正（探针失效≠not-ours；degraded 旧事实 fail-closed） | findAliveLedgerLeaders fresh-undefined 用例 + 目录/账本 degraded 单测 + adapter fail-closed 分支 | 完成 |
| 裁决 #3 修正（私有 session 前提；同组≠同 run） | readProcessGroups（darwin 无 sid 实测）+ 前提验证代码 + sid 不匹配/异 session/无 sid 三态矩阵 | 完成 |
| 时序对齐修正轮（R0→M0→C0→M1→M2→C1→R1；M0 仅候选不作连续证明） | §十一：显式顺序断言用例 + M0-only 反例 + 定向 90/90 | 完成 |
| ENOTEMPTY 收口缺口闭环（pipelineRuns≠quiescence） | §十二：KbShutdownReport/quiesced + 专项 11 例 + 单轮真实 API 9/9（真实拦截保 home）+ §九过度结论订正 | 完成 |
| 纪律（未改 amagi 上游/未触禁改面/未提交/冻结 2.21.31/queued 严格阻断保留） | git status 12 文件 + 报告 §〇/§八/§十 | 遵守 |

未闭合/边界（如实）：Windows 真机、setsid 孙进程、真实模型质量与 A23 仍未验证；生产零信号后硬崩残留依赖自然退出收敛（恢复门控 15s 有界重试，超时阻断交人工/重试）；静场 full 由 Leader 统一执行。

## 十一、Leader 时序对齐修正轮（R0→M0→C0→M1→M2→C1→R1）

- **时序差异修正**：`snapshotGroupMembersWithBirth` 由上一轮的 R0→M1(发现)→C0→M2→C1→R1 改为裁决采纳的 **R0→M0(仅候选)→C0→M1→M2→C1→R1**：首张发现表改名 M0、只产生候选 pid（发现不授归属，不把 M0 反向当身份连续证明）；C0 之后取**两张** membership 快照 M1/M2，候选须在两张中都同组（同组/私有 session 前提同时核验）——membership 证据整体落在身份区间 [C0, C1] 内；C1 与 C0 一致、R1 根端点复核。组身份探测（readProcessGroups）在 M2 后、C1 前执行。任一缺席（含「M0 见过、M1 缺席、M2 又现」的 M0-only 形态）→ `membership-sandwich-failed` 不封存零信号。
- 新增用例：①**显式顺序断言**（事件序 R0<M0(ps2)<C0<M1(ps3)<M2(ps4)<groups<C1<R1，且 M1/M2 之外无第三张 membership 表；封存+注入出口回收正例同用例覆盖）；②**M0-only 连续反例**（M0 在/M1 缺席/M2 又现 → 零信号、成员 unconfirmed、根照常回收）。
- 既有夹逼反例（ps→birth 复用、C0→C1 换人、根枚举前/后失效）按新时序自然适配（其 ps/probe 计数语义不变），全部仍绿。
- 其余修正（生产零信号、session 前提、degraded fail-closed、有界重试）与兄弟文件未动；主树 child-policy SDK 别名补丁不回拷（本 worktree 不含该文件改动）。
- 验证：定向三文件 **90/90**（`tests/build-runtime-process-residual.test.ts` 36 例含新增 2 例）；server tsc=0、eslint=0；真实 API/静场 full 由 Leader 统一执行。
- 累计 patch 已更新：`/tmp/feishu-build-v2-r2/fix2-runtime-r2.patch`（回滚仍用 `git apply -R`）。

## 十二、ENOTEMPTY 收口缺口闭环（Leader 裁决：pipelineRuns 清空 ≠ quiescence）

**缺口**（§九取证的直接推论）：unconfirmed 活子任务在 rm 成功后仍会重建 auth.json——`KbBuildService.shutdown` 只看 `pipelineRuns` 会把「流水线完成」误当 OS 收口，两个 e2e afterAll 便会在**活写者仍在写盘**时删 home。

- **`KbBuildService.shutdown` 收口判定重做**：新增 `KbShutdownReport`（`cancelled/unsettled/timedOut/unconfirmedTerminations/quiesced`）。取消+有界等待流水线后，把两类终止事实纳入判定：**内存**（active 条目的 `leaderRun.termination`；null=有 Leader 无对账结果也不能当已收口；cancelled/流水线完成本身不算 OS 退出）与**持久**（`scanDiskResidualFacts`：枚举 `<dataRoot>/agent/builds/*` 逐构建跑只读 `reconcileBuildRootResiduals`——锚点/账本跨 epoch 新鲜对账，覆盖 active 条目已过 60s 保留期的构建）。内存 unconfirmed 仅被**同构建磁盘新鲜对账 confirmed** 下调（OS 级证据覆盖旧内存结论）；磁盘 unconfirmed/unavailable/扫描整体失败一律保守保留。判定核心抽为纯函数 `resolveKbShutdownQuiescence`（专项测试直接覆盖）。
- **`reconcileBuildRootResiduals`（adapter 导出，无状态只读核心）**：实例方法 `reconcileBuildResiduals` 的判定链原样抽出（degraded fail-closed、账本存活 Leader 阻断、跨 epoch 锚点对账），binding 回写留在实例包装层——判定语义零变化（定向 101/101 回归）。
- **`shutdownServices(app)` 暴露报告**：返回 `KbShutdownReport | null`；`startServer.close` 仍**不删任何 home**，未收口时如实 warn（含 buildId/source/note 摘要），不发裸 PID 信号、不削弱严格阻断。
- **e2e afterAll（两文件）**：只有 `quiesced===true` 才进入原 rm 逻辑；未收口或报告不可得 → 保留 home 并打印 `[kept-home:shutdown-unsettled] <home> <原因摘要>`，不以重试/rm 冒充退出。
- **专项测试**（新文件 `tests/kb-build-service-shutdown.test.ts` 11 例）：①流水线已完但终止 unconfirmed → quiesced=false（含「有 Leader 无对账结果」变体）；②持久对账 confirmed 才允许清理（cancelled 但 OS 已确认不算未收口；内存 unconfirmed 被磁盘 confirmed 下调）；③shutdown 超时 → unsettled/timedOut 如实返回；另覆盖 disk-reconcile/unavailable/整体失败 fail-closed、无 Leader 构建不参与、真实磁盘 degraded/空根/死锚点三态。
- **单轮真实 API 验证**（冻结 2.21.31）：fix-e2e 6/6 + e2e 3/3 = 9/9；**收口报告在真实运行中真实拦截**——e2e afterAll 扫描时点 happy-path 构建的 pi 个体仍在自然退出窗口（磁盘对账 unconfirmed）→ 保 home 并标记 `终止未确认=b_…(disk-reconcile)`（此刻复查：全部锚点 pid 已退出、lsof 无打开文件——正是「当时不可删、现已收敛」的时序证据；目录已按守卫流程移入 amagi-trash 留存）。旧代码在同一时序会直接 rm——即本缺口要堵的「rm 冒充退出」。
- 验证补记：定向四文件 101/101、shutdown 专项 11/11、tsc=0、eslint=0；增量 patch 相对本轮启动快照 `/tmp/feishu-build-v2-r2/fix2-runtime-r3-incremental.patch`（未整文件覆盖/未重交累计 patch；主树已含上轮合并与 Leader whitespace 修正，上下文以本轮轮始快照为准，冲突时以本 patch hunks 裁决）。
