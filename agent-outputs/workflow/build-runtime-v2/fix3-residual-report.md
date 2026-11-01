# build-runtime-v2 合并修复 R3：R2-F10-01/02 residual

**状态：已完成并验证（含 Leader 反馈追加轮：PID 冲突不变量）；未提交 Git。静场 full 与最终 R2 增量复审留 Leader。**

上游输入：`r2-review-report.md`（R2 full Gate，F10 partial + 2 Major）、`fix2-integration-report.md`（R2 集成记录）。按任务书修 R2-F10-01/02，按**完整证据分区**实现，非仅两个反例的最小补丁。

## 一、写面与纪律

- 改动文件（全部在本 worktree，未提交）：
  1. `server/src/agent/build-runtime/process-residual.ts`（归属分区 + 内层扫描契约 + 缺口传播）
  2. `server/tests/build-runtime-process-residual.test.ts`（既有用例更新 + 新增分区/降级用例）
  3. `server/tests/build-runtime-scan-recovery.test.ts`（**新增**，真实 OS 反例转正）
- **adapter.ts 零改动**：归属分区在 `reconcileResidualProcesses` 内由 `leaderPids` 登记集语义完成；adapter 既有的 binding+账本登记集组装、账本/epoch 目录 degraded fail-closed 门（`reconcileBuildRootResiduals`）与 shutdown 消费链（`scanDiskResidualFacts` → `resolveKbShutdownQuiescence`）原样复用，unconfirmed 自然贯穿——这正是"沿既有机制接通真实链路"。任务书允许的"必要归属传参"经核实**不必要**，未引入新参数面。
- 未改 amagi 上游、`kb-build-service.ts`、`index.ts`、`kb-build-service-shutdown.test.ts`（兄弟独占，字节未动）；无 defaultKill 回归，生产对历史发现/仅数字 PID 目标仍零信号（`ctx.kill` 仍只能注入）。
- 测试全部使用临时目录/临时 `FEISHU_SYNC_HOME`；真实 OS 用例只向**自己持有的 ChildProcess 句柄**发信号（`reapOwned`），未知/历史 PID 零信号。

## 二、R2-F10-01 修复：锚点归属分区（anchor 读取成功 ≠ 已匹配构建归属）

`reconcileResidualProcesses` 新增显式分区（模块头注释同步登记纪律）：

| 证据分区 | 行为 |
|---|---|
| 登记集非空（binding/账本可得）+ 锚点 leaderPid 匹配 | run 进个体对账（exited/not-ours/unconfirmed/回收资格照旧，信号仍逐个 birth-token fresh 复核） |
| 登记集非空 + 锚点 leaderPid **不匹配** | **逐 run 如实 unconfirmed**（"归属不明（登记缺失或外来写入），不纳入对账与信号集合"）——绝不既充当 v2-store「已覆盖」又被无声丢弃，绝不进可信号集合；零信号 |
| 登记集为空（binding 不可得且账本无 Leader 条目） | build home 是构建私有目录，锚点即本构建可见运行事实：**全部 run 进入逐个体对账**（真实探测 root），绝不因过滤后空集合直接 confirmed；信号资格仍只由出生令牌+注入出口决定 |
| v2-store 覆盖判定 | `anchoredTaskIds` 只由**已分区对账的 run** 构成：仅被不匹配锚点"覆盖"的活跃任务仍报 anchorless 缺口（双未确认） |

空登记集选择"全量逐个体对账"而非一刀切 unknown 的依据：任务书明文"私有 build home 的所有可见运行事实**要么真正逐个对账、要么明确未确认**"两种终态皆合法；兄弟独占正例（dead-anchor、无账本/binding、root 已死 → quiesced=true，不可修改）只有在逐个体探测口径下才能成立——且修复后它经**真实 ps 个体探测**通过（root 不在表 → exited），不再是 R2 审核指出的"filter 空"假绿。UNBOUND_ANCHOR 反例（同现场但 root 存活）则如实 unconfirmed（归属可证+生产无出口 → 零信号）。

任务书核对清单逐项：多 run（同一锚点文件 matched+unmatched 分区用例）、多 Leader（登记集含双方/仅一方两态用例）、旧 epoch（`listBuildHomeDirs` 与 adapter 登记集跨 epoch 同源，既有用例回归）、terminal vs active v2-store（terminal 无缺口、active 无匹配覆盖报缺口，既有+新用例）、其它构建归属（登记集非空时不匹配=归属不明 unknown）、empty vs missing vs malformed（空目录=无事实 confirmed、缺失=ENOENT 契约、malformed=untrusted/degraded，各有用例）。

### 二·B、追加轮（Leader 反馈）：PID 冲突不变量（byPid 静默去重消除可见事实）

**反馈缺口**：原 byPid 按 rootPid 只保留首个声称（anchor 有令牌时静默覆盖 ledger）。可构造同一私有 home 两个合法 run 共享 rootPid（旧 run oldToken、当前 run liveToken，leaderPids 均匹配）：旧份被保留、fresh 令牌匹配新份却与旧份比对 → 旧份 not-ours、新份被丢弃、两个 v2-store task 均被 covered → 整体假 confirmed 而第二个根活着。

**修复**：个体集合改为 `claimsByPid`（逐 pid 声称列表）——PID 不是运行身份，不能静默挑一份：

- 去重仅限「完全重复」（锚点：同 taskId+同出生令牌；账本：同 launchId）；其余全部保留。
- 单声称 pid：走原有逐个体对账（全部既有行为不变）。
- 多声称 pid（锚点-锚点/账本-锚点/账本-账本）逐声称裁决（顺序无关）：
  - pid 不在进程表 → 各声称的出生均已结束（exited，内核级无活写者）；F10-R1 同组存活成员检查逐声称 pgid 各自做（去重上报，冲突不豁免「根死≠后代全退」）。
  - pid 存活 → 占用者出生令牌至多匹配一份：匹配者=该 run 进程存活 → **冲突个体保守 unconfirmed 且零信号（有注入出口也不杀）**；不匹配者=其声称的出生已结束（exited，pid 现由另一出生占用）；令牌缺失/探测失效 → 不可区分 → unconfirmed 零信号。
  - 绝不因冲突假 confirmed：存活匹配者必产生 unconfirmed 项阻断；绝不只给 note。
- v2-store 覆盖仍按 taskId（多声称各自 taskId 均计入 covered，但 pid 级逐声称裁决已把存活个体浮出）。

**关联字段核对**：锚点身份字段=taskId+rootIdentityToken（+leaderPid/at）；账本=launchId+birthToken（跨 epoch/generation 的两个条目即两份声称，用例覆盖）。不同 epoch/generation/leader/task 维度均不改变「按完整运行身份分别对账」的分区结果。

**正式回归 9 项**（均注入夹具）：旧令牌在前/新令牌在后（反例正形：旧 exited+新存活保守 unconfirmed+整体 unconfirmed+零信号+个体仍活）、反向顺序（分区顺序无关）、跨锚点文件冲突（不同 taskId/leader 均在登记集）、完全重复去重正例（单一身份照常 reaped、无冲突项、confirmed）、账本-账本冲突（同 pid 两个未收口 launch 跨 epoch/generation）、账本-锚点冲突（不再锚点静默覆盖账本）、冲突但 pid 已死正例（双 exited+confirmed，内核级无活写者）、冲突+探测失效（双 unconfirmed）、冲突+无令牌份（不可区分 unconfirmed）。

## 三、R2-F10-02 修复：内层扫描契约（ENOENT ≠ 读取失败）

- `scanLaunchAnchors`：auditsRoot readdir ENOENT → 空且非 degraded（旧版 amagi 合法契约）；**非 ENOENT（ENOTDIR/EACCES/损坏）→ `degraded=true`**。逐 anchor `readFileSync` ENOENT → 合法跳过（该任务是否派发由 v2-store 判定）；**非 ENOENT（含任务目录被文件占位的 ENOTDIR）→ `untrusted=true`**，不再无差别 continue。parse/形状非法/droppedRuns>0 → untrusted（既有，保留）。
- `scanV2StoreIntents`：storeRoot readdir 同上区分 ENOENT / degraded；逐任务 current.json 不可读 → unreadableTasks（既有 fail-closed，保留）。
- **传播链**：`anchors.degraded`、`anchors.untrusted`、`ledger.degraded`（直接调用路径也覆盖）、`v2store.degraded` 各自直接产生 unconfirmed finding → 决定总体 `state` → adapter 归并 → `scanDiskResidualFacts` → `resolveKbShutdownQuiescence`（unconfirmed → quiesced=false → e2e 保 home）。缺口摘要（gapsPrefix）进入**所有**返回路径的 note，含"进程表不可得"早退——不再存在"note 里说不可信、state 却 confirmed"或"声称无派发意图"的路径。

## 四、正例保全（不得因修复误伤）

- 真无事实 confirmed：无 v2-store 无锚点（缺失=ENOENT）与 audits/v2-store 空目录（empty≠有事实）→ confirmed，note「无派发意图」。
- 合法确证退出：登记集空 + root 已死 → 逐个体探测 exited → confirmed（新真实 OS 用例 + 兄弟独占 dead-anchor 正例仍 quiesced=true）；matched + 注入出口 → reaped（非生产默认能力标注保留）。
- 生产零信号：存活 root 归属可证 → unconfirmed 零信号（既有「裁决 #5」用例 + 新 UNBOUND_ANCHOR 真实用例）。
- 既有不匹配=不碰别人的语义升级为"如实 unknown"，对应旧用例已按新语义改写（`t-foreign`：期望 unconfirmed+零信号+个体仍活）。

## 五、验证（真实执行；cwd=server；临时 FEISHU_SYNC_HOME）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0（追加轮后复跑 0） |
| `npx eslint`（改动文件） | exit 0（追加轮后复跑 0） |
| `tests/build-runtime-process-residual.test.ts` | **56/56**（分区/降级 12 项 + 追加轮 PID 冲突 9 项） |
| `tests/build-runtime-scan-recovery.test.ts`（新增） | **4/4**（真实 OS：UNBOUND_ANCHOR / SHUTDOWN_UNBOUND / ENOTDIR×3 场景 / 空登记集 dead-root 真探测正例） |
| `tests/kb-build-service-shutdown.test.ts`（兄弟独占，未改） | **13/13**（dead-anchor 正例仍 quiesced=true） |
| `tests/build-runtime-adapter.test.ts` | **28/28**（跨 epoch、账本存活 Leader 阻断不回归） |
| `tests/build-runtime-integration.test.ts` + `tests/build-runtime-toolfix-regressions.test.ts` | **60/60** |
| `tests/build-runtime-fix-e2e.test.ts`（冻结 amagi-pi 2.21.31 源 + pi 1.4.0，`AMAGI_PI_SOURCE_DIR` 单轮真实 API） | **6/6**（Leader 硬 SIGKILL 回收、同会话续接/成果级重建、not-ours、自有句柄桥接回收） |
| child-policy / publish-cancel / review-authority / knowledge-skill-examples / bridge | **83 pass + 3 gated skip**（R2 同口径定向面；追加轮复跑同样通过） |
| 合计（追加轮后终态） | **15 文件 250 pass / 3 gated skip**（skip 为显式资源门控，未计通过；追加轮全量重跑） |

## 六、产物与回滚

- 增量 patch（同名累计，追加轮已更新）：`/tmp/feishu-build-v2-r3/residual.patch`（920 行，sha256 `9925e10323e84e96b9228cfc8e3a02e777d2f8113cdd4f6c4354cab4e7cd8322`；首轮版本 594 行/`c17959f6…` 已被覆盖）。含 3 段 diff：2 修改 + 1 **new file mode** 段（`@@` 头完整，非上次轮的缺头形态）。
- patch 三向验证：当前 worktree `git apply -R --check` 自洽通过；干净 HEAD clone 前向 `git apply --check` + 实际 apply 通过且新测试文件（180 行）被真实创建。生成用临时 `GIT_INDEX_FILE`，未触碰真实 index。
- 回滚：`git apply -R /tmp/feishu-build-v2-r3/residual.patch`（不整文件 checkout，不伤兄弟/用户现场）。
- 本报告：`agent-outputs/workflow/build-runtime-v2/fix3-residual-report.md`。

## 七、未覆盖与边界

- 静场 full（`npm run check` 全量）与最终 R2 唯一增量复审由 Leader 统一执行；Windows 真机/UNC、setsid 逃逸后代仍不在本轮范围（与 R2 审核边界一致）。
- 未验证 `reconcileResiduals` binding 级方法单独路径的行为变化（其 leaderPids 含 binding pid，等价登记集非空分支，已被 adapter/integration 用例覆盖）。
- 根目录 `npm test`（前端）未跑：本切片零前端改动；harness 结算将自动确认。

## ACHIEVEMENT:

- R2-F10-01（锚点归属不明既 covered 又丢弃）→ 归属分区：登记集非空不匹配 run 逐个 unconfirmed、绝不进信号集合；v2-store 覆盖只认已对账 run；登记集空时全量逐个体对账，不允许 filter 空假 confirmed → 单元用例全过 → **完成**
- R2-F10-01 追加轮（PID 冲突：byPid 静默去重消除同 pid 多份运行身份）→ claimsByPid 逐声称裁决（完全重复才去重；存活匹配者保守零信号；不匹配者出生已结束；缺令牌/探失效不可区分 unconfirmed；冲突不豁免 F10-R1）→ 9 项冲突回归全过（含旧前/新后、反向顺序、完全重复去重正例、账本-账本/账本-锚点、关联字段 epoch/generation/leader/task）→ **完成**
- R2-F10-02（内层扫描失败吞成不存在）→ 两 scanner 显式 ENOENT/degraded 契约 + 逐 anchor 读取区分 + untrusted/degraded 全部产生 unconfirmed finding 并贯穿总体 state 与 shutdown 消费链（含进程表早退 note）→ 单元 + 真实 ENOTDIR 用例全过 → **完成**
- 真实 OS 反例转正（UNBOUND_ANCHOR/SHUTDOWN_UNBOUND/内层 ENOTDIR）→ `build-runtime-scan-recovery.test.ts` 4/4，只杀自有句柄、未知零信号 → **完成**
- 正例保全（确证退出经真实个体探测、真无事实 confirmed、生产零信号、完全重复去重后照常回收）→ 兄弟独占 dead-anchor 13/13 + 裁决 #5 用例全过 → **完成**
- 验证 → server tsc=0、eslint=0、定向 15 文件 **250 pass/3 gated skip**（追加轮全量重跑，含冻结 2.21.31 单轮真实 API 6/6）；静场 full 留 Leader → **完成（边界如实）**
- 纪律 → 写面仍 3 文件、未提交、临时 HOME、同名累计 patch 三向验证（逆向自洽 + 干净 HEAD 前向 apply 创建新文件）→ **遵守**
