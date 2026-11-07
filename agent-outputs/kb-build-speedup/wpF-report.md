# WP-F：pi-amagi 编排模式下构建度量（kb_builds.metrics_json）缺口

## 1. 问题与方案

`orchestration_mode='pi-amagi'` 的构建终态只写入旧 legacy 聚合的**空壳** metrics_json（实测 218 字节全 0：units.total=0 / phases=[] / queueWaits=0 …），无法量化耗时/并发/返工。原因：`entry.metrics` 采集挂点只存在于 legacy 编排/单进程流水，Leader 监督路径不经过。

方案：pi-amagi 终态在原有 metrics_json 上**additive 追加 `orchestration` 段**，数据全部来自服务端权威落盘记录（不解析模型会话 JSONL，不回填已 published 的老构建）：

- 纯聚合：`server/src/kb/build-metrics.ts` 新增 `aggregateLeaderOrchestrationMetrics`（保持模块"纯函数、无 IO"契约）。
- 磁盘读取：`server/src/kb/kb-build-service.ts` 新增导出函数 `collectLeaderOrchestrationMetricsFromDisk`（服务终态收口与报告脚本共用同一函数，口径不漂移）。
- 缺口补采：`server/src/kb/build-runtime-host.ts` 在 `convertLeaderRecord` 的 tool_execution_end 失败分支**只加不改**地追加 `<epochRoot>/dispatch-rejections.jsonl`（派发拒绝此前只进 Leader 进程 stderr 内存尾部，无任何持久化权威记录）。

## 2. 数据来源映射表

| 度量字段 | 权威来源（文件） | 推导方式 |
|---|---|---|
| wallClockMs | kb_builds.started_at / finished_at | 差值；finished_at 为空（interrupted 未收口）按采集时刻并记 note |
| docsPublished / sourcesTotal | kb_builds.docs_written / source_total | 直读行值 |
| authorDispatches / reviewDispatches / researchDispatches | `<outputRoot>/.staging/<buildId>/build-actors/actors.json` | 按 role 计数（luban/diting/baize；含 task_resume 续接产生的新身份，与"71 submit+23 resume"口径一致）；未识别角色记 note |
| revisionRounds（轮数分布/首审结论/firstPassRate） | 同上 `reviews.json` | 按 scopePaths 归组每篇文档；每篇最早回执为首审；无 scopePaths 的旧回执不计入并记 note |
| publishRejections | 同上 `publish-requests.json` | status=rejected 按 result.reason 计数（缺 reason 计 unknown） |
| dispatchRejections | `<epochRoot>/dispatch-rejections.jsonl`（WP-F 起新增） | 按 code 计数；文件不存在（旧构建）**省略键**，不编造 |
| pool.peakInflight / avgInflight（运行并发） | `<epochRoot>/home/amagi/data/journal/dispatch.jsonl`（amagi dispatch 审计 journal） | session 起跑→同任务下一次 settle 区间的时间加权扫描 = 真实运行中会话数；journal 缺失回退账本 actor_confirmed→handoff_submitted 近似（derivation='actor-events' 并记 note）；均无 → null/'none' |
| pool.submittedPeakInflight / submittedAvgInflight（在途含排队） | 同上 journal | dispatch→最终 settle 区间 = 未完成任务在途数（R2 排队深度直接度量）；仅 journal 可得，缺省省略键 |
| firstDraftToPublish（p50/p90/max） | 账本 `receipts.json` + `events.jsonl` publish_settled（回退 accepted 申请 settledAt，再回退 published 行 finished_at） | 每篇首个 write_doc/edit_doc 回执时刻→发布结算时刻；nearest-rank 分位；未到达发布则省略并记 note |
| reviewerSameModelAsWriter（既有字段补值） | 内存 `entry.leaderRun.spec.models`（冻结 BuildRunSpec，如 `zhipuai/glm-5.3:high`） | 解析 provider/model 后走既有 `sameProviderModel`；解析不了保持 null |

epoch 根：`<dataRoot>/agent/builds/<buildId>/epochs/e*` 升序合并；无 epochs 目录回退旧布局 buildRoot。多 epoch（rebuild 恢复）跨目录合并。

## 3. 字段语义（KbBuildMetrics.orchestration，全部 additive 可选）

```ts
{
  wallClockMs: number;                       // 含 preflight 与发布
  docsPublished: number; sourcesTotal: number;
  authorDispatches: number | null;           // null = actors.json 不可得（R5-02）
  reviewDispatches: number | null; researchDispatches: number | null;
  revisionRounds: {                          // null = reviews.json 不可得（R5-02）
    docsReviewed; totalReviews; roundsMedian; roundsMax;
    firstVerdicts: { pass; needs_revision; insufficient_material; fail };
    firstPassRate;                           // 首审 pass 文档占比（无审查 null）
  } | null;
  publishRejections: Record<code, count> | null;  // null = publish-requests.json 不可得；{} = 真实无拒绝
  dispatchRejections?: Record<code, count>;  // 文件可读才带键；{} = 真实无拒绝
  pool: {
    peakInflight; avgInflight;               // 运行并发（journal-session 精确）
    derivation: 'journal-session'|'actor-events'|'none';
    submittedPeakInflight?; submittedAvgInflight?;  // 在途含排队
  };
  firstDraftToPublish?: { count; p50Ms; p90Ms; maxMs };  // receipts 可读且已发布才带键（空 = count 0）
  notes?: string[];                          // 数据缺口（含各文件缺失/损坏）如实列出
}
```

向后兼容：`parseMetrics` 只 JSON.parse；`toDto` 把 metrics 透传进 `KbBuildDto.metrics`（前端当前无渲染点，grep 全仓仅 kb-build-service/build-metrics/types 引用）；旧 metrics_json 无 orchestration 键，形状不变。

## 4. 写入点

- **位置**：`kb-build-service.ts` `runPipeline` 的 `finally` 收口块（published/failed/cancelled/interrupted/awaiting_release 全部终态路径都会经过；published 的老构建不回填——只有跑完流水线的构建才写）。
- **失败隔离（三层 try/catch）**：① `collectBuildMetrics` 内层 try/catch → null；② `collectLeaderOrchestrationMetricsFromDisk` 所有读取（EXISTS/parse/REaddir）逐一守卫，损坏文件按缺源降级、全缺返回 null（省略 orchestration 键而不是写空壳）；③ 外层 try/catch 捕获 `updateKbBuild` 写库失败 → `emitLog warn`「度量列写入失败（不影响构建终态）」。终态 status 落库发生在 try/catch 各分支、先于 finally，结构上不可能被度量写入破坏。
- **新增审计**：`build-runtime-host.ts` `convertLeaderRecord` tool_execution_end 的 `isError && stash` 分支 → 追加 `<epochRoot>/dispatch-rejections.jsonl`（0700 目录，逐行 JSON：at/tool/agent/code/message≤300）。写失败静默（缺口由 notes 暴露）。既有成功登记/未解析分支零改动。

## 5. 测试（server/tests/build-metrics-pi-amagi.test.ts，19 用例；R5-02 后含三态回归，详见 §10）

- 纯聚合：完整来源全字段断言（peak/avg 扫描、nearest-rank p50/p90、首审率 0.3333、notes 逐条）；全空 → null；dispatchRejectionCodes=null → 键省略；无区间 → pool null/'none' + submitted 键省略；finished_at 空 → 墙钟按采集时刻+note；未发布 → firstDraftToPublish 省略+note；无审查 → 轮数/首审率 null 而非编造 0。
- 磁盘读取：journal 存在 → journal-session 区间（peak 2/avg 1.49、submitted 2/1.5）+ 账本聚合 + 拒绝审计计数；journal 缺失 → actor-events 近似+note；现场全缺 → null；损坏 JSON/JSONL 不抛错降级。
- `BuildRuntimeHost.parseDispatchRejectionCode`：全角/半角尾括号码、`code:` 前缀、`[code]` 前缀、不可识别 → unknown。
- toDto：含 orchestration 的 metrics_json 原样透传；无列时无 metrics 键。

验证证据：`cd server && npx tsc --noEmit` = 0；`npx eslint`（5 个改动文件）= 0；`npx vitest run tests/build-metrics.test.ts tests/build-metrics-pi-amagi.test.ts tests/kb-precheck-integration.test.ts tests/build-runtime-tools.test.ts` = 99 passed；**全量 `npm test`（server）= 3599 passed / 1 failed，唯一失败即基线允许的 `tests/bundled-amagi.test.ts`**（amagi 私有 bundle 版本环境态 2.22.0≠2.21.36，与本 WP 改动无关，未触碰 amagi-package/bundled 资产）；根目录 `npm test` = 570 passed。

## 6. 真实构建实测（只读；报告脚本与终态写入同函数）

`npx tsx scripts/build-metrics-report.ts b_20261107061134_8b2173`（任务书指定构建，R1 修复后）：

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
  派发拒绝                  无审计记录文件（WP-F 之前的构建，未推导）
  模型池运行并发            peak=6，avg=3.98（口径：journal-session）
  派发在途（含排队）        peak=6，avg=3.99
  首稿→发布                 13 篇，p50=27m27s，p90=45m47s，max=47m15s

—— 来源 ——
  kb_builds        /Users/run.mao/.feishu-sync/feishu-sync.db
  build-actors     /Users/run.mao/.feishu-sync/standard-kb/.staging/b_20261107061134_8b2173/build-actors
  epochs           /Users/run.mao/.feishu-sync/agent/builds/b_20261107061134_8b2173/epochs
```

对照 b_20261105233621_7161f7（R1 修复前，diagnosis 主样本）：运行并发 peak=3 / avg=2.54（=被腰斩的池容量 3），**在途（含排队）peak=24 / avg=13.21**（R2 排队积压直接量化），首审通过率 50%，发布拒绝 kb_publish_blocked×3 + kb_validation_failed×1（=diagnosis 的 4 次晚发现拒绝）。两组数字与 diagnosis 第 1/2 节现象互相印证，度量目标（提速前后可对比）达成。

## 7. 未覆盖项 / 边界

- **dispatchRejections 对历史构建不可得**：拒绝事件此前无持久化（仅 Leader stderr 内存尾部）；WP-F 起的新构建起生效，旧构建如实省略键（报告输出“不可得（dispatch-rejections.jsonl 缺失…）”）。
- confirm 发布模式下 awaiting_release 停驻时 finally 写入的是无发布结算的度量（firstDraftToPublish 省略）；用户确认后真正 published 不再补写（不回填原则）。
- running 并发的 actor-events 回退口径含排队间隙（derivation 与 notes 显式标注）；journal 存在时无此偏差。
- submitted 在途区间 = dispatch→最终 settle，含待修订间隙（任务未闭环期间持续计为在途，语义即"未完成任务数"）。
- metrics_json.orchestration 前端暂无渲染点（本次未改 UI）；报告脚本为人读出口。

## 8. 回滚

改动全部 additive、无既有行为改写（唯一既有行为变化：leader 模式 `reviewerSameModelAsWriter` 从恒 null 变为可判定值——仅诊断字段）：

1. 终态写入：还原 `kb-build-service.ts` finally 块为原 `collectBuildMetrics` 单调用（约 -20 行）+ 删除文件尾部 `collectLeaderOrchestrationMetricsFromDisk` 及 4 个私有读取 helper。
2. 聚合：删除 `build-metrics.ts` 中 WP-F 段（aggregateLeaderOrchestrationMetrics/LeaderOrchestrationSources/percentile/median/sweep）。
3. 类型：删除 `agent-knowledge.ts` 的 `KbBuildMetricsOrchestration` 与 `KbBuildMetrics.orchestration?` 字段（additive，删后旧库行不受影响；已写入的新行 parseMetrics 仍返回对象，多出的键被 toDto 透传但不影响任何消费者）。
4. 拒绝审计：删除 `build-runtime-host.ts` 的 `appendDispatchRejection`/`parseDispatchRejectionCode` 与 convertLeaderRecord 内 12 行挂钩。
5. 删除 `server/scripts/build-metrics-report.ts`、`server/tests/build-metrics-pi-amagi.test.ts`。
6. 磁盘残留（新构建产生的 dispatch-rejections.jsonl）为独立追加日志，可原样保留或随 staging 清理策略（cleanupOldStaging 保留最新 3 个）自然淘汰。

## 9. 改动文件清单

| 文件 | 改动 |
|---|---|
| server/src/types/agent-knowledge.ts | +KbBuildMetricsOrchestration；KbBuildMetrics +orchestration?（R5-02：派发计数/revisionRounds/publishRejections 可空） |
| server/src/kb/build-metrics.ts | +aggregateLeaderOrchestrationMetrics（纯函数；R5-02 三态源） |
| server/src/kb/kb-build-service.ts | finally 收口接 orchestration；collectBuildMetrics leader 同源判定；+collectLeaderOrchestrationMetricsFromDisk 导出（R5-02 三态读取） |
| server/src/kb/build-runtime-host.ts | +派发拒绝审计（convertLeaderRecord 失败分支，只加不改） |
| server/scripts/build-metrics-report.ts | 新增只读报告脚本（npx tsx，参数 buildId，sqlite readonly；R5-02 缺口显示“不可得（原因）”） |
| server/tests/build-metrics-pi-amagi.test.ts | 新增 19 用例（含 R5-02 回归） |

## 10. R5-02 修复（独立审查 review-5 反馈）

**问题**：采集层 `readJsonArraySafe(...) ?? []` / `readJsonlSafe(...) ?? []` 把“文件缺失/损坏”与“真实空数组”塌缩成同一个 0——反例：仅 actors.json 存在、reviews.json 缺失或损坏时，输出 totalReviews=0 / publishRejections={} 且无任何 notes，把“不可得”冒充成“真实没有”。

**修复**（三态贯穿采集→聚合→展示）：

1. **读取层**（kb-build-service.ts）：新增 `readJsonArraySource` / `readJsonlSource` 返回 `{status:'ok',records}` | `{status:'missing'|'corrupt',file}`。JSON 数组非数组/解析失败 → corrupt；JSONL 逐行解析（追加日志语义，单行损坏跳过），存在非空行但全部不可解析 → corrupt，空文件 = ok 空。journal 读取同改造；跨 epoch 合并时任一可读即 ok，否则升级为 corrupt。
2. **聚合层**（build-metrics.ts）：输入改为 `LeaderSource<T>` 三态（`sourceOk` 判别）。actors 不可得 → 三个派发计数全 null；reviews 不可得 → revisionRounds 整段 null；publish-requests 不可得 → publishRejections null；dispatch-rejections 不可得 → 键省略；receipts 不可得且已发布 → firstDraftToPublish 省略。每个缺口都产出指名文件与影响的 note（“reviews.json损坏，审查轮数与首审通过率不可推导”等）。**只有文件真实存在且解析成功的空数组才输出 0/{}**（空 running/submitted 区间 = 真实零并发 peak 0）。另补：journal 可读但无 session 事件而有派发记录 → 运行并发接缺口处理（不是 0 并发）。“全部来源不可得 → null”语义保持。
3. **类型**（agent-knowledge.ts）：authorDispatches/reviewDispatches/researchDispatches/revisionRounds/publishRejections 均可空，注释写明 null 语义与 R5-02。
4. **报告脚本**：缺口显示“不可得（reviews.json 缺失/损坏，见口径说明）”、“不可得（dispatch-rejections.jsonl 缺失/损坏；WP-F 之前的构建无此审计文件）”；count 0 的分位显示“—”；真实空发布拒绝仍显示“无”（背后是可读空集）。

**回归覆盖**（tests/build-metrics-pi-amagi.test.ts 新增/改造，共 19 用例）：纯函数侧——仅 actors 可读（其余 missing）→ 派发计数有值 + reviews/publish 段 null + notes 指名 5 个缺口文件；corrupt 与 missing 分开注明；真实空数组对照（0/{}、count 0、peak 0）与不可得严格区分；全缺 → null 保持。磁盘侧——仅 actors.json 存在、reviews.json 损坏（其余正常）、publish-requests.json 缺失（发布结算回退链不受影响）、真实空文件（=0/无）四个场景。

**验证**：`npx tsc --noEmit`=0；`npx eslint`（4 改动文件）=0；`vitest run tests/build-metrics.test.ts tests/build-metrics-pi-amagi.test.ts tests/kb-precheck-integration.test.ts` = 44 passed；全量 `npm test`（server）= 3610+ passed / 唯一失败即基线允许的 `tests/bundled-amagi.test.ts`（某中间轮次另见 2 个零测试失败的文件级 flake，重跑未复现——共享树兄弟任务写入中间态，非本改动回归）；真实构建报告实测输出（R5-02 后）：

```
  派发拒绝                  不可得（dispatch-rejections.jsonl 缺失/损坏；WP-F 之前的构建无此审计文件）
  …
  口径说明
    - dispatch-rejections.jsonl缺失，派发拒绝不可推导（WP-F 之前的构建无此审计文件）
```

回滚：与本修复相关部分含在 §8 步骤 2/3 内（聚合三态与类型可空）；单独回退本修复可恢复 `?? []` 采集与旧 notes，但会重新引入“不可得冒充 0”，不建议。
