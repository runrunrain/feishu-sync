# 构建运维（pi-amagi 编排）

面向运维/使用者。覆盖标准知识库构建的运行态目录布局、观测手段、构建度量、常见失败与处置、进程残留对账与恢复、内置 amagi bundle 构建链。设计与契约细节见 [build-orchestration.md](build-orchestration.md)；CLI 命令见 [cli-reference.md](cli-reference.md)。

## 1. 运行态目录布局

一次构建的落盘分布在三个根（`<dataRoot>` 缺省 `~/.feishu-sync`，可被 `FEISHU_SYNC_HOME` 整体改根；`<outputRoot>` 缺省 `<dataRoot>/standard-kb`，由 `standardKb.outputRoot` 配置）：

**构建根** `<dataRoot>/agent/builds/<buildId>/`（进程与派发事实，跨 epoch 共享）

| 路径                                                                     | 内容                                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `process-ledger.json`                                                    | 应用侧进程账本（launchId/pid/epoch/generation/命令指纹/出生令牌/退出与对账结论；append-only，0600 原子写） |
| `epochs/e<N>/{home,work}`                                                | 第 N 个 epoch 的 agentDir（四配置 + amagi 内部库）与工作目录；legacy 布局为 `<buildRoot>/{home,work}`      |
| `epochs/e<N>/dispatch-inflight.json`                                     | 在途任务快照（派发准入输入；seq 单调递增）                                                                 |
| `epochs/e<N>/dispatch-rejections.jsonl`                                  | 派发拒绝审计（code × 时间）                                                                                |
| `epochs/e<N>/home/amagi/data/journal/dispatch.jsonl`                     | amagi 派发 journal（dispatch/session/settle 事件，并发度量来源）                                           |
| `epochs/e<N>/home/amagi/data/process-audits/<taskId>/launch-anchor.json` | 受信原生启动锚点（rootPid/pgid/出生令牌；残留核对输入）                                                    |
| `epochs/e<N>/home/amagi/v2-store/<taskId>/current.json`                  | amagi 任务记录（派发意图，硬崩窗口的残留线索）                                                             |
| `automatic-recovery.json`                                                | 孤立派发自动收回审计（fence + 范围扫描后写）                                                               |

**候选区** `<outputRoot>/.staging/<buildId>/`（成果真相）

| 路径                                    | 内容                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `docs/`                                 | staging 草稿（标准头 `feishu_sync_kb`）                                |
| `knowledge-draft.json`                  | 对象/证据/覆盖声明登记                                                 |
| `build-actors/actors.json` 等 7 个 JSON | 成果账本：身份、输出分配、写入回执、审查回执、交接、问题清单、发布申请 |
| `build-actors/events.jsonl`             | 账本运行事件（追加型日志）                                             |
| `reviews/<unitId>.json`                 | 审查报告文件（与回执双向绑定）                                         |
| `read-receipts.jsonl`                   | 读取回执登记（含阶段发布继承证据的 `krr_stage_*` 重绑）                |

**构建管理** `<outputRoot>/.builds/<buildId>/`

| 路径                    | 内容                                                |
| ----------------------- | --------------------------------------------------- |
| `events.jsonl`          | 构建事件流（SSE 同源）                              |
| `report.json`           | 发布/失败报告（门禁明细）                           |
| `checkpoints/cp_<hex>/` | 原子检查点（含 leaderRun 监督状态；上一代始终可用） |
| `auto-resume.json`      | 自动续跑计数（最多 2 次）                           |

状态行在 SQLite `kb_builds` 表（`~/.feishu-sync/feishu-sync.db`），含 `orchestration_mode`、`metrics_json`、`warnings_json` 等列；表结构见 [data-contract.md](data-contract.md)。

## 2. 观测一次构建

- **UI/进度**：构建详情消费 `LeaderRunProgressDto`（`server/src/kb/build-leader-supervisor.ts` `progress()`）——Leader 会话/pid/恢复能力、各子任务角色与执行态（含 epoch/generation 戳）、轮次计数、空闲状态、发布申请、终止对账摘要、成果计数（acceptedDocumentCount/openBlockingCount/activeAssignments）。
- **派发健康**：读 `<epochRoot>/dispatch-inflight.json`（在途与积压信号）与 `dispatch-rejections.jsonl`（准入拒绝序列）。频繁的 `dispatch_inflight_write_exhausted` 说明 Leader 派发节奏快于完成速度，属正常吞吐反馈；`dispatch_inflight_pool_saturated` 表示审查派发达所属池容量，或续接（task_resume）时全部准入池已满。
- **成果账本**：`build-actors/` 下各 JSON 即权限与成果真相；`events.jsonl` 按时间回放身份确认、分配、回执、审查、发布窗口事件。
- **审计**：应用侧审计文件族见 [security-model.md](security-model.md)。
- **端到端探针**：`server/scripts/probe-build-runtime.ts` 用真实 pi + amagi + 桥（模型换本地 fixture）验证运行能力项，退出码 0/2/3；用法 `npx tsx scripts/probe-build-runtime.ts --piCli <pi 绝对路径> --sourceAmagi <amagi-pi 包根>`，可选 `--report <md>`、`--real-model`、`--keep`。

## 3. 构建度量

`kb_builds.metrics_json` 在构建收口时写入，pi-amagi 构建含 `orchestration` 段（`server/src/kb/build-metrics.ts` `aggregateLeaderOrchestrationMetrics`；采集失败降级 null 不阻断终态）。字段语义：

| 字段                                                           | 语义                                                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallClockMs`                                                  | started_at → finished_at；未收口终态按采集时刻计（notes 注明）                                                                                                              |
| `docsPublished` / `sourcesTotal`                               | 产出文档数 / 工作集源数                                                                                                                                                     |
| `authorDispatches` / `reviewDispatches` / `researchDispatches` | 按角色（luban/diting/baize）的派发计数（含 resume 身份）；来源不可得为 null 不冒充 0                                                                                        |
| `revisionRounds`                                               | 每篇审查轮数：`docsReviewed`/`totalReviews`/`roundsMedian`/`roundsMax`；`firstVerdicts`（pass/needs_revision/insufficient_material/fail 计数）与 `firstPassRate` 首审通过率 |
| `publishRejections`                                            | 发布拒绝原因 × 次数                                                                                                                                                         |
| `dispatchRejections`                                           | 派发拒绝码 × 次数（WP-F 之前的构建无此审计文件，省略键）                                                                                                                    |
| `pool`                                                         | 运行并发 `peakInflight`/`avgInflight`（口径 `derivation`：journal-session 优先，回退 actor-events 近似）；`submittedPeakInflight`/`submittedAvgInflight` 派发在途含排队     |
| `firstDraftToPublish`                                          | 每篇首稿→发布结算耗时分布（count/p50Ms/p90Ms/maxMs）                                                                                                                        |
| `notes`                                                        | 口径说明：哪些来源缺失/损坏、哪些字段因此不可推导                                                                                                                           |

另有 legacy 段（`units`/`phases`/`queueWaits`/`review`/`precheck` 等）与 `warnings_json` 风险告警（`oversized_unit`/`reviewer_same_model`/`pool_capacity_high`，均不阻断）。

构建度量也展示在应用内构建详情页：标准库页右侧「进度」侧栏（构建进度面板）在构建收口后追加只读「构建度量」区，同一份 `metrics_json`/`warnings_json` 数据；字段缺失或不可推导时如实显示「—/采集不可得」，无 orchestration 段显示降级说明。

**只读报告脚本** `server/scripts/build-metrics-report.ts`：读 `kb_builds` 与权威落盘记录，复用生产端同一聚合函数现场重算，不写任何文件。用法：

```bash
cd server
npx tsx scripts/build-metrics-report.ts <buildId> [--home <FEISHU_SYNC_HOME>]
```

退出码 0=报告输出（允许数据缺口）、1=用法错误或构建不存在。直接查 SQLite 用 `sqlite3 -readonly`。真实输出示例（v0.4.24，构建 `b_20261107061134_8b2173`）：

```
构建 b_20261107061134_8b2173
  状态            published（pi-amagi）
  时间            2026-11-07T06:11:34.366Z → 2026-11-07T07:05:54.449Z
  源/产出         sources=138，docs_written=13，docs_deleted=0
  metrics_json    无 orchestration 段（旧采集或非 pi-amagi）

—— 现场重算（权威落盘记录，与终态写入同函数）——
  墙钟 wallClockMs          54m20s（3260083 ms）
  产出/工作集               docs=13 / sources=138
  派发（含 resume 身份）    作者(luban)=22，审查(diting)=22，调研(baize)=0
  审查轮数                  文档=13，回执=22，每篇中位数=2，最大=3
  首审结论                  pass=5 / needs_revision=8 / insufficient=0 / fail=0 → 首审通过率 38.5%
  发布拒绝                  无
  派发拒绝                  不可得（dispatch-rejections.jsonl 缺失/损坏；WP-F 之前的构建无此审计文件）
  模型池运行并发            peak=6，avg=3.98（口径：journal-session）
  派发在途（含排队）        peak=6，avg=3.99
  首稿→发布                 13 篇，p50=27m27s，p90=45m47s，max=47m15s
  口径说明
    - dispatch-rejections.jsonl缺失，派发拒绝不可推导（WP-F 之前的构建无此审计文件）

—— 来源 ——
  kb_builds        ~/.feishu-sync/feishu-sync.db
  build-actors     ~/.feishu-sync/standard-kb/.staging/b_20261107061134_8b2173/build-actors
  epochs           ~/.feishu-sync/agent/builds/b_20261107061134_8b2173/epochs
```

## 4. 常见失败/拒绝码与处置

发布阻断码全集定义在 `server/src/kb/orchestration-contracts.ts` `PUBLISH_BLOCK_REASONS`；staging 校验与工具错误分散在 `kb-build-service.ts`/`knowledge-schema.ts`/`build-actors.ts`。

| 码                                                                               | 含义                                                                                                                               | 处置                                                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `source_not_covered`                                                             | 工作集源既未被文档引用也未列入 skipped                                                                                             | 派写作补来源声明，或经 `build_request_publish.skipped` 写明理由；在途写作先等收口（看 `inFlightWorksetSourceCount`） |
| `blocking_issue_open`                                                            | 审查报告存在未关闭的阻断问题                                                                                                       | 派定向修订；关闭须完整独立 pass 复核（`uncheckedScope` 空）。作者自述不构成关闭                                      |
| `review_missing`                                                                 | 必审内容缺当前版本的有效独立通过审查                                                                                               | 对每篇写回执的文档派 diting 独立审查；沿用文档确认 carriedHash 未变                                                  |
| `missing_report` / `required_review_doc_missing`                                 | 验收引用的报告文件不存在 / 必审对象不在候选清单                                                                                    | 报告被覆盖或删除 → 重新审查；改写文档重新进必审范围                                                                  |
| `source_snapshot_mismatch` / `base_release_changed`                              | 源快照或基准 release 在构建期间变化                                                                                                | 重新构建（构建冻结面被外部打破，不可原地修）                                                                         |
| `confirm_binding_stale`                                                          | confirm 模式下确认绑定的候选已变化                                                                                                 | 重新走发布确认流程                                                                                                   |
| `carry_over_unmarked` / `source_disposition_missing`                             | 沿用文档缺审查标记 / 源去向缺失                                                                                                    | 按报告明细补标记或覆盖声明                                                                                           |
| `full_empty_output`                                                              | full 构建零产出                                                                                                                    | 检查模型配置与工作集；full 不允许全 skip 发布空库                                                                    |
| `kb_evidence_unresolved`                                                         | 证据引用悬空：来源不在快照/资源缺失/高风险 claim 无证据/继承证据与冻结版本不符                                                     | 按错误列出的资源与行范围补读（raw_read/raw_csv_find）后原样重试；跨构建旧回执不可猜，按当前源重读                    |
| `kb_coverage_invalid`                                                            | 覆盖声明缺陷：重要项无去向、mapped 对象不存在、排除无理由                                                                          | 修正 `coverageUpdates` 的 disposition/targetKeys                                                                     |
| `kb_link_invalid` / `kb_migration_invalid` / `kb_restatement_stale` 等声明结构码 | 见 `knowledge-schema.ts` 检查项映射                                                                                                | 按字段定位修正；这些是确定性校验，重试不改变结果                                                                     |
| `kb_publish_blocked`（含 `source_changed_during_build`）                         | 发布门未过 / 源在构建期间被改                                                                                                      | 读 `<outputRoot>/.builds/<id>/report.json` 的 details 逐项处理；源被改须重新构建                                     |
| `dispatch_inflight_write_exhausted`                                              | 新写作（writer/research 的 task_submit）在所属模型池达上限：无积压时上限为池容量，存在待审/待修订时为容量 −1（保留槽给审查与修订） | 不是故障：等已有任务完成通知再派；修订与审查派发不受限                                                               |
| `dispatch_inflight_pool_saturated`                                               | 独立审查（reviewer 的 task_submit）达所属池容量；或 task_resume 时全部准入池满                                                     | 等待池出现空槽；池长期满且无在途时检查 dispatch-inflight.json 是否陈旧（stale 15 分钟后 fail-open 自愈）             |
| `kb_output_owned_by_other_task` / `kb_output_assignment_conflict`                | 写入目标由他任务持有                                                                                                               | 错误自带处置参数：先 `build_revoke_output` 再分配，或 task_resume 续接持有者同链任务                                 |
| `kb_revision_resume_required`                                                    | 同篇阻断修订换作者须说明原因                                                                                                       | 提供 `revisionFallback`（session_unavailable/resume_failed/scope_changed + 具体原因）                                |
| `kb_termination_unconfirmed`                                                     | 残留自动核验/清理尚未收敛                                                                                                          | 稍后重试即可（15s 内每 2s 自动重试）；持续出现见 §5                                                                  |
| `kb_leader_alive`                                                                | 旧 Leader 进程仍在运行                                                                                                             | 先取消旧构建或等其退出，不得并行两个 Leader                                                                          |
| `kb_resume_runtime_changed`                                                      | 会话恢复冻结比对失败（skill/Pi 版本/amagi 哈希/agentDir 哈希漂移）                                                                 | 改用成果级恢复（rebuild）或重新构建                                                                                  |
| `credential_generation_revoked`（401）                                           | 旧代次凭据已撤销                                                                                                                   | 取消/恢复换代后的旧任务写入一律拒绝；用续接链上的新任务                                                              |
| `build_runtime_unavailable`（503）                                               | Pi 运行时未就绪/探测失败/包缺失                                                                                                    | 在设置中安装或修复 Pi 运行时与 amagi-pi（§6）；探测 fail-closed 不降级 legacy                                        |
| `build_publishing`（409）                                                        | 发布校验进行中                                                                                                                     | 等待当前申请结算，勿并发申请                                                                                         |

## 5. 进程残留对账与中断恢复

- **终止对账**：任何 Leader 终局（含发布成功）都做终止对账并持久化到检查点。个体结论：`exited`（已证明退出）/`reaped`（核对身份后回收）/`not-ours`（pid 被无关进程复用，绝不发信号）/`abandoned`（已撤权并自动清理专属范围的未完成派发，不声称物理退出或成功）/`unconfirmed`（无法证明，暂不启动新 Leader）。
- **证明纪律**：根个体回收只认内核出生令牌（darwin `darwin:<sec>:<usec>`、linux `linux:<boot>:<start>`，与 amagi 启动锚点同格式）；无令牌不降级为 pgid/可执行名放行；每个信号前 fresh 复核身份。生产对历史发现/仅数字 PID 无稳定引用，默认零信号，依赖自然退出收敛。
- **自动恢复**：可恢复的孤立派发（v2-store 有记录、无锚点覆盖、无 backendRunId）经「撤旧代次凭据 → 构建专属进程范围扫描（PI_CODING_AGENT_DIR 标签 + cwd 范围）清理并二次复核」后标记 abandoned，审计写 `<buildRoot>/automatic-recovery.json`；保留原生任务记录，不伪造退出或成功。
- **中断续跑**：Leader 运行中断后服务自动按检查点成果级恢复（rebuild），10s/30s 各一次、最多 2 次（`<outputRoot>/.builds/<id>/auto-resume.json` 计数）；超限保留检查点与问题清单，由用户手动续跑。
- **持续 unconfirmed**：查 `process-ledger.json` 与进度 DTO 的 `processTermination.unconfirmedPids`；确认 pid 已退出后对账会自动收敛；账本损坏（degraded）时如实保留阻断，不伪称已清理。
- 应用关闭收尾有界等待在途流水线收口；超时未收口的构建下次启动标记 interrupted，不假装已收敛。

## 6. 内置 amagi bundle 构建链

应用随包内置私有 amagi-pi 离线分发（离线安装，全部运行安装走既有 Pi 包安装器）：

- **构建脚本** `server/scripts/lib/bundled-amagi.mjs`（`bundleAmagi`，随 `npm run build:all` 经 `build-agent-assets.mjs` 调用）：从 npm 发布允许清单（`npm pack --dry-run` 文件清单）打包，绝不整仓拷贝。流程：源码逐文件哈希 → 按精确 lock 隔离安装生产依赖（不带宿主 Pi/peer/dev 包）→ 应用 2.21.31 background-continue 补丁 → 冻结树内容哈希 → zip（DEFLATE9、固定时间戳）→ 写 `server/bundled/amagi-pi/manifest.json` + `package.zip`，复制到 `server/dist/agent/bundled-amagi/`。
- **版本钉与缓存键**：manifest 当前为 2.21.36（sourceCommit `48df74b0`、487 文件、内容哈希 `a5883cc0…`、zip sha256 `a1391f69…`）；重打包缓存键 = `bundlerVersion + sourceHash`（源文件哈希 + lock 哈希 + 补丁哈希），一致则跳过重建；2.21.36 强制要求补丁（缺失即构建失败，提示 `AMAGI_PI_SOURCE_DIR`）。
- **运行时使用**（`server/src/agent/bundled-amagi.ts`）：解包校验（zip sha256、文件数/字节数、内容哈希、路径安全、无 symlink）后经 `installAmagiPackage` 物化到 `<dataRoot>/agent/runtime-packages/amagi-pi@<版本>+<contentHash>` 缓存目录（install-record.json 记录来源），同键并发去重。
- **来源优先级**（`build-runtime-host.ts` `preferredAmagi`）：Pi home（全局 `~/.pi/agent` 与应用 pi-home）已配置且版本 ≥ 内置 bundle 的候选优先；否则用内置 bundle；再否则回退官方 Git 获取链（repo `https://github.com/runrunrain/amagi-pi.git`、固定 commit `929000ec…`，拒绝 tag/latest）。运行中构建保留自己的冻结包不升级；升级只发生在新构建边界。
- **升级办法**：维护者本机放新版 amagi-pi 源码（或设 `AMAGI_PI_SOURCE_DIR` 指向），`npm run build:all` 重新打包（bundle 会重算并更新 manifest）；运行侧用户在 Pi home 配置更新版本的包，下次构建自动优选。补丁随版本演进：`requiredLocalPatch` 只对 2.21.36 生效，版本变更后需同步评估补丁去留。`AMAGI_PI_USE_BUNDLED=1` 强制使用已检入 bundle（跳过本地源）。
- Windows 兼容注意：0.4.0 曾因换行差异导致内置包校验失败，bundle 校验均为字节级，重新打包即可修复。

## 7. 相关入口

- 构建状态端点 `GET /api/kb/build-runtime`（运行时事实、amagi 候选、探测报告）与 `POST /api/kb/build-runtime/install`。
- CLI 命令面（`kb.build`、`kb.status` 等 40 条命令表）见 [cli-reference.md](cli-reference.md)；使用手册见 [agent-knowledge.md](agent-knowledge.md)；通用排障见 [troubleshooting.md](troubleshooting.md)。
