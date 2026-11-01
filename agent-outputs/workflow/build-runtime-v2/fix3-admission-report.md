# fix3：R2-LC-01 服务关闭准入完整接缝（admission seam）

**结论：完成。** shutdown 现在在任何 await/快照之前同步封印新写者准入；createBuild / resumeBuild / releaseConfirm（manual publish）首部即拒（503 `kb_shutdown_in_progress`），跨 readiness/锁等 await 的在途请求在最终入列/启动/落盘前重核同一租约；在途准入纳入 shutdown 有界等待与未收口报告（`quiesced`/`timedOut` 覆盖准入写者）。未提交 Git；改动仅本切片三文件；静场全量与最终 R2 增量复审留 Leader 统一执行。

## 一、上游输入

- `agent-outputs/workflow/build-runtime-v2/r2-review-report.md`（§3 R2-LC-01 反例：readiness 在途 → shutdown quiesced=true → 继续落库/启动流水线；定位 kb-build-service.ts:705–741,872–913 与 index.ts:810–908 消费链）
- `agent-outputs/workflow/build-runtime-v2/fix2-integration-report.md`（ENOTEMPTY 收口链与 quiesced 消费边界）
- 复现脚本：`r2-review-evidence/shutdown-admission-probe.mts`（已转为正式用例，见 §五）

## 二、实现（写面：kb-build-service.ts + index.ts 两处消费者）

### 准入租约生命周期（kb-build-service.ts）

- `acquireAdmission(operation)`：公开新写者入口首部同步获取；已封印即抛 `kb_shutdown_in_progress`(503)。返回 `{validate, release}`——validate 即"同一失效租约"的重核点；finally 释放并出登记。
- **封印先于一切**：`shutdown()` 第一个语句（任何 await/快照前）`admissionSealed = true`（单向，open→closed；并发 shutdown 共用同一封印事实，幂等重入无害，见重复 shutdown 用例）。
- **重核点位置**（validate → 入列/启动/落盘之间无 await，单线程同步段保证封印不可能插入其间）：
  - createBuild：readiness 重查 running 之后、`createKbBuild`/`active.set`/`launchPipeline` 之前；
  - resumeBuild：readiness 重查 running 之后、置 queued/`active.set`/`launchPipeline` 之前；
  - releaseConfirm：占位 publishing 之前（封印后状态不占位）+ **指针提交点**（`releaseConfirmInner` 的 `releaseLease`，与取消/DB 状态核验同一 CURRENT rename 紧前契约）。
- **结构**：三个公开方法改为薄包装（acquire → try/finally release → `*Admitted` 私有方法承载原方法体），原方法体零缩进改动，diff 最小可审。
- **报告覆盖**：`KbShutdownReport` 新增 `unsettledAdmissions`（`KbShutdownAdmissionFact{operation, startedAt}`）；`resolveKbShutdownQuiescence` 纯判定把它计入 `timedOut` 与 `quiesced`（任一未清空即 false）。index.ts 两处 warn（`startServer.close` 与 `shutdownServices`）增加「准入未返回」披露。
- **总等待有界（诚实超时）**：`timeoutMs` 现在覆盖在途准入等待与流水线等待的**同一 deadline**（原来是仅流水线段的局部时限）；超时如实返回 `unsettledAdmissions`/`unsettled`/`timedOut`，不假装收敛，也不无据扩张到全仓其它服务。
- **CURRENT 已提交的收尾不被打断**：租约只在指针提交前核验；已切 CURRENT 的发布仍按 F11 契约安全收敛 DB/状态（计入在途准入等待，不回滚）——由既有 publish-cancel 用例（CURRENT 已切后收尾 DB 异常收敛 published）继续守护，本轮未改语义。
- **不新增调度器/并发框架**：全部为现有方法内的同步标志 + Map 登记 + 轮询等待。

### 入口覆盖清单（实际 route/ops 消费面，不只 createBuild）

| 新写者入口 | 消费链 | 处置 |
|---|---|---|
| `POST /api/kb/builds`（route kb.ts:467）→ createBuild；CLI `kb.build`（ops/command-table.ts:386）与 app_command 同走该 HTTP 面 | 首部拒绝 + 落库前重核 |
| `POST /api/kb/builds/:id/resume`（kb.ts:485）→ resumeBuild | 首部拒绝 + 置 queued 前重核 |
| `POST /api/kb/builds/:id/release-confirm`（kb.ts:579）→ releaseConfirm | 首部拒绝 + 占位前重核 + 指针提交点重核 |
| `executeLeaderPublishRequest`（流水线内发布执行器，publishExecutor 回调） | **不加准入**（裁决依据：仅在 runLeaderSupervisedPhase 内可达且要求 active entry，归属已登记的 pipelineRuns——shutdown 取消并等待其收口；封印后迟到回调由 `entry.cancelRequested` 在发布前/提交点双重拦下，见对照用例）。加租约反而会打断取消链自身。 |
| `cancelBuild` / `shutdown` / `reconcileOnStartup` | 不封印（关闭链与恢复链自身必须可执行；无死锁，见用例） |

其余写知识文件的路径（runPipeline 内部 finish 发布）全部经 pipelineRuns 跟踪；`publishRelease` 的四个调用点中三处在流水线内、一处在 releaseConfirmInner，均已覆盖。

## 三、既有契约不变

- CURRENT/DB 失败收敛（F11）、authorityLease 提交点核验、发布锁结算（publishLock/publishRequest）、快照/账本 quiescence 判定（fix2 修正轮）全部未动；`resolveKbShutdownQuiescence` 的 `unsettledAdmissions` 为可选入参，旧调用/旧用例零破坏（sibling 11 用例原样通过）。
- queued/not-started 严格阻断、生产历史 PID 零终止信号、amagi 上游、agent-tool-service/adapter/process-residual、child-policy/dispatch-guard/publishRelease 内核：均未触碰。

## 四、测试（新增 `server/tests/kb-build-shutdown-admission.test.ts`，14 用例；未改任何兄弟测试）

复现脚本转正式用例（probe 语义逐条对齐，真实 createBuild/shutdown/readiness 暂停，无准入/pipeline 方法替换）：

1. **create 跨 readiness 正例**：封印 → readiness 返回 ready → 重核拒绝；`quiesced=true`（准入在有界等待内被拒收编）、无新行（CREATE_ROW_AFTER_SHUTDOWN 不再发生）、无 active。
2. **create 超时如实 unknown 保留**：gate 不放 → `quiesced=false`/`timedOut`/`unsettledAdmissions=[新建构建]`；事后放行也不落库（报告快照之后写者仍未越过关闭边界）。
3. **对照正例**：未封印时准入正常（行创建、dto queued/preflight、active 登记；流水线在最小 fixture 上尽快失败由 onError 吸收，不冒充成功）。
4. **resume 跨 readiness**：真实 BuildCheckpointStore 检查点 → 封印后重核拒绝：不置 queued、不登记 active。
5. **releaseConfirm 跨 await**：真实 AgentToolService 审查链 fixture（复用 build-runtime-publish-cancel 模式：kb_write_doc + kb_submit_review 默认回执 + assembleCandidateRelease + 检查点落盘）→ 发布主体执行中封印 → 指针提交点拒绝：CURRENT 未切、回落 awaiting_release（不假 published）、release 目录无未提交副本。
6. **封印后首部拒绝**：create/resume/release-confirm 三入口 503，不触碰后续依赖。
7. **重复 shutdown 共用封印**、**cancelBuild 封印后仍可执行**（无死锁）。
8. **迟到发布回调对照**：shutdown 取消活动构建后，流水线内发布执行器被既有取消链拒绝（accepted:false，CURRENT 不动）。
9. **发布锁排队（Leader 调整 #1）**：窗口已结算（publishLock.revision）+ 终止 confirmed 的活动构建 → shutdown（quiesced=true）→ 迟到/排队发布回调无条件 `publish_window_settled` 拒绝，无新写/无启动。
10. **已过 CURRENT 正例（Leader 调整 #1）**：确认发布真实提交指针（安全 DB/状态收尾、不回滚）→ shutdown → 二次确认与 createBuild 全部首部拒绝，CURRENT/产物保持不变。
11. **纯判定**：`unsettledAdmissions` 单独/与流水线并存/清空三态的 quiesced/timedOut 语义。

## 五、验证证据（cwd=server，vitest --cache=false；临时目录 fixture，未用生产 FEISHU_SYNC_HOME）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx eslint src/kb/kb-build-service.ts src/index.ts tests/kb-build-shutdown-admission.test.ts` | exit 0 |
| `npx vitest run tests/kb-build-shutdown-admission.test.ts` | **14/14 pass** |
| `npx vitest run tests/kb-build-service-shutdown.test.ts tests/build-runtime-publish-cancel.test.ts tests/kb-build.test.ts tests/kb-build-resume.test.ts tests/kb-build-parallel.test.ts` | 5 文件 **109 pass**（sibling 零修改下全绿） |
| `npx vitest run tests/build-runtime-toolfix-regressions.test.ts tests/build-runtime-process-residual.test.ts tests/build-runtime-integration.test.ts tests/build-runtime-adapter.test.ts tests/build-runtime-bridge.test.ts tests/build-runtime-review-authority.test.ts` | 6 文件 **149 pass** |
| `AMAGI_PI_SOURCE_DIR=/tmp/feishu-build-v2-r2/amagi-pi-2.21.31 npx vitest run tests/build-runtime-fix-e2e.test.ts` | **6/6 pass**（真实 pi/amagi 单轮 API，冻结 2.21.31；fixture 模型非真实模型质量） |
| 同上 `tests/build-runtime-e2e.test.ts` | **3/3 pass** |

未运行：静场全量 `npm run check`（按任务书留 Leader 统一执行）；Windows/UNC、真实模型质量不签发结论。

## 六、产物与回滚

- **代码切片 patch**：`/tmp/feishu-build-v2-r3/admission.patch`（804 行；git diff HEAD 相对本 worktree 基线提交 28605c5，含正确 new-file hunk）。自洽性已验证：工作区 `git apply -R --check` 通过；对 HEAD 树隔离临时 index `git apply --cached` 套用成功，新文件 blob `2007aa58…` 与工作区实际文件逐字节一致。工作区保持未提交（新测试文件已 `git add -N` 便于 git diff HEAD 收集，非提交）。
- **回滚**：`git apply -R /tmp/feishu-build-v2-r3/admission.patch`（仅本切片三文件；不 checkout 整文件，不触碰他人现场）。
- 改动面：`server/src/kb/kb-build-service.ts`（+143/−13）、`server/src/index.ts`（+2）、`server/tests/kb-build-shutdown-admission.test.ts`（新增 482 行，14 用例）。

### Leader 调整 #1（steer）逐项对照

- open→closing→closed 单向：封印永不解封（重启即新实例）✅（重复 shutdown 用例）；
- 同步失效租约先于任何 await/快照、并发 shutdown 共用收口：shutdown 首语句置位 ✅；
- 可能写入/启动操作首个 await 前计入 inFlight、最终入列/spawn/CURRENT 前同租约同步复核：三入口首部 acquire+登记，validate→落盘同步段 ✅；
- CURRENT 已提交仍安全 DB/状态收尾、不回滚且计入等待：租约仅指针提交前核验，F11 收敛链未动，在途 releaseConfirm 计入准入等待 ✅（已过 CURRENT 正例）；
- 发布锁排队也核关闭：锁已结算即无条件拒绝，与封印无关地永久关闭新发布申请 ✅（发布锁排队用例）；
- 超时保留集合如实 unknown 不清零：超时快照进入 unsettledAdmissions，quiesced=false ✅（超时用例）；
- 覆盖 create/resume/rebuild/retry/auto 续跑/manual publish/迟到回调：rebuild/resumeStrategy 在 resumeBuild 内同租约，D5 重试在同一 releaseLease 闭包重核，auto 续跑/启动对账（reconcileOnStartup）只标记不启动流水线，迟到回调两用例 ✅；
- quiesced = 准入永久关 + 在途不可能写 + OS 对账：三段合一判定 ✅。

## 七、边界与剩余

- `admissionSealed` 无解封路径（服务关闭是终局；重启是新实例）——服务常驻复用场景不适用本语义，如未来出现需要"关闭后重开"的嵌入方，需显式新契约。
- 在途准入等待为 50ms 轮询（与流水线等待 200ms 轮询同风格）；最坏路径下总等待 = timeoutMs（含取消链自身耗时），未做长尾基准（与既有 shutdown 同边界，不据此报缺陷）。
- fix-e2e/e2e 的真实链在本环境依赖 PATH pi 与 `AMAGI_PI_SOURCE_DIR` 指向冻结 2.21.31 源目录（存在性已核实并实际执行通过）；其它环境缺失时该套件显式 skip，不计通过。
