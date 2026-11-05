# P1 · 标准库构建门禁与编排约束证据化盘点

- 任务：证据化盘点（只读，不改代码），为后续「门禁简化 + flow 提示词自主编排」设计提供依据。
- 调查范围：`server/src/kb/`、`server/src/agent/{build-runtime,tools,prompts,roles,tasks}`、设计文档、`~/.feishu-sync/`（DB 副本 + `.builds/` 事件流）、`agent-outputs/` 历史报告。
- 代码基线：HEAD `a74f43f`（工作树另有主上未提交改动：`kb-build-service.ts`、`agent-tool-service.ts`、`build-runtime-tools.test.ts`，属 incremental-build-performance 修复线，本文按当前磁盘内容取证并单独标注）。
- 运行证据基线：`~/.feishu-sync/feishu-sync.db` 快照（拷贝至 `/tmp/feishu-sync-kb-analysis.db`）+ `~/.feishu-sync/standard-kb/.builds/`（37 次构建，2026-10-31 ~ 11-04）。
- 字段约定：位置为 file:line（当前工作树）；频次证据无则写「无证据」；分类为**初步分类**（A=安全硬不变量 / B=质量可降级或交模型自修 / C=冗余重复或过度工程可删），最终裁决留给下游。

---

## 1. 构建端到端流程（宿主强制 ⚙ / 模型自主 🤖）

### 1.1 顶层状态机

`queued → preflight → running → validating → publishing → published`；旁路 `failed / cancelled / interrupted`（不移动 CURRENT）。定义在 `kb-build-service.ts:5-13` 模块头与 `runPipeline`（kb-build-service.ts:2185）。

### 1.2 pi-amagi 模式（当前唯一默认，config `orchestrationMode: 'pi-amagi'`；types/agent-knowledge.ts:93-97、:257）

1. **准入** ⚙ 全局单构建 + admission 租约（kb-build-service.ts:969 `acquireAdmission`；R2-LC-01 关闭封印）。
2. **preflight（快照/冻结段，全部宿主强制）** ⚙
   - 插件快照冻结 → 读 CURRENT 基线 → 恢复时基准不一致即 `kb_resume_stale`（kb-build-service.ts:2227）。
   - 发布产物排除（防自我喂养 `published_doc_in_sources`，kb-build-service.ts:2244-2253）。
   - `RawSourceSnapshot.scan` + mediaHash/白板文字哈希 enrich（kb-build-service.ts:2256-2261）。
   - 恢复快照完整性 `verifyBuildSnapshotIntact` + 快照哈希比对 → `source_changed_during_build`（kb-build-service.ts:2287-2290）。
   - 治理决定快照冻结落 staging（`governance-freeze.json`，kb-build-service.ts:2343-2346、3416）。
   - 变更集 `computeChangeset`（本地字节比较；kb-build-service.ts:8023）→ 增量影响闭包（种子=源变化∪决定变化∪迁移，沿 restates/depends_on/exception_to 入边扩到固定点；kb-build-service.ts:8055 起）→ 无变更直接 `no_changes` 结束（kb-build-service.ts:2459-2472）。
   - 增量复制基线 docs 到 staging + 仅引用已删源文档默认删除 + 基线对象登记装载 `seedBaselineKnowledge`（kb-build-service.ts:3232）。
3. **图片预描述** ⚙/🤖 vision 通道（失败不阻断，标 unavailable + 警告；kb-build-service.ts:2637-2660）。
4. **Leader 监督运行段**（`runLeaderSupervisedPhase`，kb-build-service.ts:1433；宿主=build-runtime-host.ts:899 `runLeaderPhase`，监督状态机=build-leader-supervisor.ts）
   - ⚙ 宿主：能力探测 fail-closed、amagi 版本化包安装校验、BuildRunSpec 冻结（模型/角色/准入池/agentDirConfigHash/workflowRevision）、Leader/child 双代次令牌、派发守卫注入（dispatch-guard.ts）、无进展超时（180min，仅按 lastActivityAt 判定；kb-build-service.ts:2796-2810）、idle 宽限 3min → 一次收口提示 → `leader_idle` 中断（build-leader-supervisor.ts:110-112、728-751）。
   - 🤖 Leader（pi 进程，系统提示=leader-protocol.md + 质量基线）：读 `build_manifest`（分页 12/页）→ 拆主题 → `task_submit`（≤4/轮，handle 交付）→ 每写作任务立即 `build_assign_output` 精确路径 → 收到完成通知即派独立审查（任务书必须字面 `coverage.docPaths=["…"]`）→ 聚合阻断问题派定向修订 → 全部通过后查 `identityGaps` 登记迁移 → `build_request_publish` 申请发布当前精确候选。
   - 🤖 子任务（luban 写 / diting 审 / baize 调研，amagi 派生进程）：经 MCP 桥接 `raw_read`（回执 readReceiptId）/`kb_write_doc`/`kb_edit_doc`/`kb_submit_review`/`build_handoff_submit` 等；v2 不用 `kb_unit_done`/`kb_finish`。
   - ⚙ 写路径工具级门禁即时生效（见 §2 表 G2 段）：路径分配、声明/证据/覆盖校验、乐观并发、幂等。
   - ⚙ 阶段发布：每次 checkpoint 后 `publishProgressiveIfReady`（kb-build-service.ts:1631）——单篇有独立通过回执 + 对象 reviewStatus=passed 即尝试晋级 CURRENT；每次晋级跑完整知识门禁（prepareKnowledgePublish → runKnowledgeGates），失败记「阶段发布暂缓」。
   - ⚙ 发布窗口：Leader `build_request_publish` → `executeLeaderPublishRequestInner`（kb-build-service.ts:1866）→ 毒化检查 → validateStaging → 快照复核 → canPublish → v2 权威复审（missingScopedPassReviewPaths + collectAuthorityValidatedReports）→ publishRelease（preCommitLease 租约 + CURRENT 原子 rename）→ publishLock 单发结算。
5. **validating** ⚙（非 Leader 路径在主流程；Leader 路径在发布窗口内同函数）确定性校验 `validateStagingDocs`（kb-build-service.ts:7850）。
6. **publishing** ⚙ `prepareKnowledgePublish`（编译 + 门禁，kb-build-service.ts:6835）→ staging→release 副本编译 → CURRENT rename → 失败按指针真相收敛（F11）。

### 1.3 legacy 编排路径（`orchestrated`，审查者显式配置 + 非 Leader 模式才走；kb-build-service.ts:2905）

单元划分（build-units.ts：增量=文档↔源二部图连通分量；full=目录聚类装箱）→ PathClaims 预认领 → 写→审→修订（预算 `maxAutoRevisions`=2）→整合→最终复核→kb_finish→canPublish→发布。三轴状态机（exec/artifact/acceptance 转移表，build-orchestration.ts:70-90）。

### 1.4 单进程回退路径（workerCount=1 且无编排；kb-build-service.ts:2929）

全局批切分 + kb_finish 单轮，与旧行为等价。

---

## 2. 门禁清单表

> 位置行号以当前工作树为准。频次来源：`.builds/*/events.jsonl`（37 构建、287 次发布阻断事件、4977 个阻断问题）、7 份 `report.json`、`agent-outputs/incremental-build-performance/timeline-summary.json`。

### G1 流水线准入与冻结（宿主，preflight/恢复）

| # | 名称 | 位置 | 触发条件 | 失败后果 | 保护对象 | 频次证据 | 分类 |
|---|---|---|---|---|---|---|---|
| 1 | 全局单构建准入 | kb-build-service.ts:969,674 | 已有非终态构建 | 409 kb_build_running | 状态一致性 | DB 37 构建串行（无并发冲突记录） | A |
| 2 | 恢复基准/快照一致 | kb-build-service.ts:2227,2287-2290 | resume 时 baseReleaseId 或快照哈希漂移 | 409 kb_resume_stale / source_changed_during_build | 冻结输入不变量 | 历史案例：恢复误纳 64 未选源致快照不一致（agent-outputs/incremental-build-performance/diagnosis.md「当前构建持续疏通」节） | A |
| 3 | 冻结规格/模型比对 | kb-build-service.ts:2237-2256（BuildOrchestration.restore + frozenRoleMismatches） | 检查点 spec 与当前快照/基准/角色模型参数不一致 | 409 kb_resume_stale | 可追溯性；防恢复期间静默换模型 | 无直接频次；DB 无该错误码 | B |
| 4 | 发布谱系排除 | kb-build-service.ts:2244-2253 | 源在 kb_publications 谱系内 | 排除+警告 published_doc_in_sources | 防自我喂养（设计 P1 §4.1 防线2） | 无触发记录 | A |
| 5 | 治理快照冻结+复核 | kb-build-service.ts:3416（freeze）、7126-7132（发布前复核） | 冻结哈希≠当前 | 409 kb_governance_changed，可恢复重取 | 人工决定不被构建期间篡改 | 无触发记录 | A |
| 6 | 无变更短路 | kb-build-service.ts:2459-2472 | 增量无变更集且无闭包种子 | no_changes 结束（非失败） | 不产空 release | DB 有多条 minutes=1-8 的短构建 | C（合理短路，非负担） |
| 7 | 构建超时 | kb-build-service.ts:2785-2810（Leader 无进展）/2984-2991（整体） | Leader 180min 无活动 / 编排整体超时 | cancelled（timedOut） | 资源回收 | 一次 464min 构建被取消（b_20261031125652） | A |
| 8 | Leader idle 执法 | build-leader-supervisor.ts:110-112,728-751 | 无运行轮次+子任务全收到完成通知+桥接无活动 >3min，nudge 后仍空闲 | interrupted(kb_leader_idle)，可恢复 | 防挂死 | 无 kb_leader_idle 落库记录（DB error_code 仅 kb_interface_failed×1） | B |

### G2 模型写面工具级门禁（agent-tool-service.ts，写入即拒）

| # | 名称 | 位置 | 触发条件 | 失败后果 | 保护对象 | 频次证据 | 分类 |
|---|---|---|---|---|---|---|---|
| 9 | 路径认领 | path-claims.ts:18-30；调用 agent-tool-service.ts:2626 | 写他单元认领路径 | 409 kb_path_owned_by_other_unit | 并行写冲突 | 无证据（Leader 模式用 build_assign_output 替代） | A（并行路径）/ C（Leader 模式与 G29 重复，两套机制并存） |
| 10 | 路径合法+大小限 | agent-tool-service.ts:2265,2424（MAX_STANDARD_DOC_BYTES，standard-doc-limits.ts） | validateStdDocPath 失败 / 超 1MB | 400 kb_doc_too_large 等 | 发布契约 | 单构建 kb_doc_too_large 无计数（timeline toolErrors 未列）；曾有重试暂存机制（:918-954） | A |
| 11 | 空占位源拒绝 | agent-tool-service.ts:2324 | sources 全为权限占位/空工作簿/未展开引用 | 400 kb_source_empty_placeholder | 不产无证据文档 | 无证据 | B |
| 12 | 纳管文档旧式重写 | agent-tool-service.ts:2385-2401；kb-build-service.ts:6867-6895（发布侧 carriedHash 复核） | 基线 basis=published 文档被无声明重写 | 409 kb_object_registry_stale / kb_evidence_registry_stale / kb_declaration_baseline_drifted | 对象身份不静默降级 v1 | 迁移相关 kb_migration_invalid 61 次发布事件（同族问题） | A（身份）/ B（对纯改错别字场景过严，已有 kb_edit_doc 缓解） |
| 13 | 对象声明校验 | agent-tool-service.ts:3077-3173（scopeKey/canonical/duplicate/merge/not_authorized） | 声明结构非法 | 400 各 kb_* 码 | T1 结构门禁前移 | 无单独计数 | B（写时即拒+可自修，形态合理） |
| 14 | 证据声明写时校验 | agent-tool-service.ts（evidenceClaims → verifyEvidence 同源）；evidence-locator.ts:246-388 | selector 越界/回执伪造/quoteHash 不符 | 400 kb_evidence_unresolved | 证据可追溯 | 单构建工具错误 kb_evidence_unresolved×13 | A |
| 15 | 覆盖清单写时校验 | agent-tool-service.ts:3646-3700 | disposition 非法/mapped 无目标/排除无理由/理由含知识转移措辞 | 400/409 kb_coverage_invalid | 重要项有去向 | **单构建 45 次**（timeline-summary toolErrors，第一大工具错误） | B（质量，但触发频繁见 §6） |
| 16 | 乐观并发+幂等 | agent-tool-service.ts:3031（kb_draft_revision_conflict）、:814-821（idempotency） | draftRevision 不符 / 同调用重放 | 409 冲突不覆盖 | 并行成果不丢 | timeline 中 MCP Validation failed 若干（见 §6） | A |
| 17 | 角色只读边界 | agent-tool-service.ts:2884,2887,2833 | 审查者/规划者调写工具 | 403 kb_review_readonly / kb_plan_readonly | 三权分立 | 无证据 | A |
| 18 | 源读取毒化 | kb-build-service.ts（throwIfPoisoned 多处：1902,3004,3034 等）+ raw_read 时 readVerified 哈希对账 | 构建中源文件被改 | source_changed_during_build，构建终止 | 冻结输入 | 无触发记录（源稳定） | A |
| 19 | PathGuard 路径围栏 | path-guard.ts（resolveInside/assertInside），设计 §7.3 | 越 outputRoot/知识库根访问 | PathGuardError | 路径逃逸 | 无证据 | A |

### G3 收尾义务（模型流程义务，宿主执法）

| # | 名称 | 位置 | 触发条件 | 失败后果 | 保护对象 | 频次证据 | 分类 |
|---|---|---|---|---|---|---|---|
| 20 | kb_unit_done 义务 | kb-build-service.ts:2833（单元轮拒 kb_finish）+ build-unit 上报 | 单元结束未调用 | 校验/编排无法推进 | 单元边界与 skipped 申报 | v2 已不用（leader-protocol.md「v2 子任务不用 kb_unit_done/kb_finish」） | C（对 Leader 模式已废弃，仅 legacy 路径） |
| 21 | kb_finish 义务 | kb-build-service.ts:3016-3019 | 收尾轮两轮提示后仍未调用 | kb_validation_failed | 覆盖完整性锚点 | 无证据 | B |
| 22 | 覆盖检查 | kb-build-service.ts:7996-8010（source_not_covered） | 工作集源未被引用且不在 skipped | validating 失败 | 无静默丢弃 | 无证据（v2 由 G15 覆盖面接管） | B |

### G4 validating 确定性校验（validateStagingDocs，kb-build-service.ts:7850-8022）

| # | 名称 | 位置 | 触发条件 | 失败后果 | 保护对象 | 频次证据 | 分类 |
|---|---|---|---|---|---|---|---|
| 23 | symlink/非md/路径/头 | :7889-7946 | 符号链接、非 .md、路径非法、头缺失、sources 空/越快照 | kb_validation_failed（整体失败） | 发布布局契约 | 无证据 | A |
| 24 | 正文纯度 | :7954-7966（body_contains_change_history / body_contains_source_metadata，body-policy.ts） | 正文含修订记录或来源标识 | 同上 | 正文/变更分离、正文/来源分离（提示词硬边界的服务端执法） | 无直接计数 | B |
| 25 | 受影响文档必须修订 | :7967-7970（affected_doc_not_updated） | requiredRewrites 内文档未重新写入 | 同上 | 变更不静默沿用 | 无直接计数；曾在协议中被误解为「全文重写」致超时（diagnosis.md 实测原因①） | B（语义正确，表述与粒度是摩擦源） |
| 26 | 既有文档保护 | :7979-7995（existing_doc_removed / existing_source_removed） | 未受影响文档被删/丢源 | 同上 | 增量不丢库 | 无证据 | A |
| 27 | 产出体量上限 | :7998-8008（total_too_large：max(有效源×3, 源数×4KiB)） | 产出超预算 | 同上 | 防膨胀/幻觉量产 | 无证据 | B |
| 28 | 空库拒绝 | :8014-8017（full_empty_output） | full 零产出 | 同上 | full 语义 | 无证据 | A |
| 29 | 占位源证据拒绝 | :7858-7886（source_permission_denied/blank_workbook/unresolved_reference；自动补 skipped） | 权限占位/空表/未展开引用作 sources | 逐条 issue + 自动登记跳过 | 证据质量 | 多次警告记录（source_permission_denied 等 warnings） | B |

### G5 发布条件 canPublish（orchestration-contracts.ts:341-470，B案 §7，10 个阻断 reason）

| # | reason | 位置 | 触发条件 | 失败后果 | 保护对象 | 频次证据 | 分类 |
|---|---|---|---|---|---|---|---|
| 30 | source_snapshot_mismatch / base_release_changed | :410-416 | 候选快照/基准与当前不符 | 409 kb_publish_blocked | 冻结输入（双查：G2#18 已查一次） | 无触发记录 | A（与 G18 重复检查，但发布点是最终防线，见 §3） |
| 31 | missing_report / review_missing / required_review_doc_missing | :423-441 | 验收引用的报告不存在 / 必审哈希无对应版本有效报告 | 409 kb_publish_blocked | 版本绑定审查（旧报告不批新稿） | 发布事件 review_missing 见 §6 | A |
| 32 | blocking_issue_open | :438-441 | 审查 blocking 未关闭（closureBasis 非空才算关） | 409 | 审查闭环 | 见 §6（间接，经由修订轮） | A |
| 33 | program_check_failed / carry_over_unmarked / source_disposition_missing | :444-462 | 程序检查未过 / 沿用未标记 / 材料无去向 | 409 | 范围账目 | 无直接证据 | B |
| 34 | confirm_binding_stale | :465-470 | confirm 模式确认绑定哈希过期 | 409（允许仅此一项停在 awaiting_release） | 确认绑定当前候选 | 无证据 | A |

### G6 v2 审查权威（review-authority.ts，F07/F08；发布侧消费）

| # | 名称 | 位置 | 触发条件 | 失败后果 | 保护对象 | 频次证据 | 分类 |
|---|---|---|---|---|---|---|---|
| 35 | 回执四类依赖绑定 | review-authority.ts:18-27（declaration/source-snapshot/workflow-rules + doc:*）；collectAuthorityValidatedReports :187-248 | 正文/对象声明/来源快照/冻结 workflow 规则任一漂移 | 回执失效 → review_missing 阻断 | 审查凭据不可移植、不可冒充 | 发布事件含「缺少当前版本的独立通过复审」 | A |
| 36 | 每写入路径独立通过复审 | missingScopedPassReviewPaths :250-269 | writtenPaths 中路径无当前哈希的 pass 回执（且非 basePromotionHashes 承接） | 409 kb_publish_blocked(review_missing) | 写-审对偶完整 | 同上；亦见「补独立审查」多次往返 | A（不变量）/ B（对未变承接文档的哈希重绑要求是摩擦点，已多轮修补：krr_seed_*、baseline-carry 回执） |

### G7 知识发布门禁 runKnowledgeGates（knowledge-validator.ts:527-561，A案 §7.4，CURRENT 切换前）

| # | 名称 | 位置 | 触发条件 | 失败后果 | 保护对象 | 频次证据 | 分类 |
|---|---|---|---|---|---|---|---|
| 37 | T1 全库结构检查 | knowledge-schema.ts:636-974（10 码：object_duplicate/canonical_missing/scope_unresolved/relation_invalid/evidence_unresolved/restatement_stale/migration_invalid/presentation_invalid/include_invalid/coverage_invalid） | 结构非法（详见 schema 头注 :612-634） | blocking → kb_publish_blocked | 知识图谱结构一致 | kb_migration_invalid 61 次发布事件、12 条 report；kb_coverage_invalid 125 次/127 条 | A（结构）/ B（coverage 的「重要项有去向」是质量判断，见 §6） |
| 38 | 编译器 issue 透传 | knowledge-validator.ts:531；knowledge-compiler.ts:445-446（join 门禁：include 目标/revision/scope 逐条字节级校验） | exact 片段 join 失败 | blocking | 呈现与正文一致 | 无直接计数 | A（字节级）/ B（targetRevision 逐字节匹配对正常改写敏感 → kb_restatement_stale 族） |
| 39 | 内部链接检查 | knowledge-validator.ts:137-185 | 相对 .md 链接目标/锚点不存在 | kb_link_invalid blocking | 链接可用 | **30 次发布事件、8 条 report**（多为相对路径解析差一级目录） | B（可由模型自修或编译期自动修复相对路径） |
| 40 | 审查凭据 | knowledge-validator.ts:200-249 | candidate 缺失/报告不解析/对象 rejected/stale/pending | kb_review_credential_missing / kb_review_stale / kb_review_pending blocking | 凭据链完整 | 无直接计数 | A |
| 41 | 高风险人审 | knowledge-validator.ts:248-309 | 高风险 claim 无当前 reviewSubjectHash 人工复核（治理激活时） | kb_review_human_missing / kb_review_human_rejected blocking（未激活仅 warning） | 人工复核强制点（A案 §5.1） | **report.json 1844 条（当前实例治理未激活→全部为 warning 披露，不阻断）** | B（该实例从未启用人工治理，1844 条纯噪音警告写满 report） |
| 42 | 业务决定门禁 | knowledge-validator.ts:312-407（decision_invalid/stale + supersedes 边解引用） | 治理激活时状态无有效决定/载荷漂移 | blocking | 状态由人工通道产生 | 无触发（治理未激活） | A |
| 43 | sidecar 哈希一致 | knowledge-validator.ts:409-426 | manifest 声明 hash ≠ 将写盘字节 / 路径逃逸 | kb_sidecar_invalid blocking | manifest 哈希链 | 无触发（宿主自产自校，模型无法影响） | C（防宿主自身 bug 的自检，对模型是零交互成本，但作为门禁冗余） |
| 44 | 证据全量重解引用 | knowledge-validator.ts:436-505（verifyEvidence 二次全量） | 回执不在登记/quoteHash 不符/越界/性质不符 | kb_evidence_unresolved blocking | 不信任声明期结果（A案 §5.3） | **71 次发布事件、345 条 report**；单案 843 条图片装配失败、332 条 readReceiptId 跨构建引用 | A（防伪造）/ C（与 G2#14 写时校验完全重复——同函数二次运行；漂移面仅剩「写后到发布间声明被改」，而该窗口内任何声明变更已使回执失效于 G35） |
| 45 | 证据资源装配 | kb-build-service.ts:6982-7090（workbook/image payload 装配失败、继承图片版本不符、未装配引用） | 工作簿无声明/图片未描述/基线图片哈希不符 | kb_evidence_unresolved blocking | 证据资源真实存在 | 单案 843 条（承接文档图片装配失败，diagnosis.md 已修）；预算超限 24+ 次 | B（装配失败多为宿主侧数据可得性问题，模型自修空间小） |
| 46 | 证据体量预算 | evidence-budget.ts + kb-build-service.ts:7195-7205 | evidence/ 总字节超预算（默认 20MB 起，基线递增） | kb_evidence_unresolved blocking | release 体量可控 | **24+ 次事件**（79MB/40MB 超限等） | B（预算触发后只能收窄引用，与「完整证据」要求相互挤压） |
| 47 | 治理快照复核 | kb-build-service.ts:7126-7132 | 见 G1#5 | kb_governance_changed | 同上 | 无触发 | A |

### G8 发布执行与恢复（publication/atomic）

| # | 名称 | 位置 | 触发条件 | 失败后果 | 保护对象 | 频次证据 | 分类 |
|---|---|---|---|---|---|---|---|
| 48 | CURRENT 原子切换+租约 | kb-build-service.ts:6754-6800（publishRelease）、:2015-2041（preCommitLease：取消/超时/代次四查） | 指针 rename 紧前任一失败 | 发布中止，CURRENT 不动；rename 后失败按已发布收敛（F11） | 原子发布不变量 | 无指针事故记录 | A |
| 49 | 发布互斥/使用中 | publication-service.ts（publish_in_progress、isReleaseInUse）；releaseConfirmAdmitted 占位 publishing | 并发确认/发布 | 409 | 串行化 | 无证据 | A |
| 50 | 候选精确锁 | kb-build-service.ts:1883-1889（candidate_conflict）、:2029-2035（发布后哈希漂移告警） | 申请 revision ≠ 当前候选 | 拒绝重试 | 发布窗口单发（publishLock） | timeline 显示申请被拒不常见 | A |
| 51 | 残留对账/自动恢复 | build-runtime-host + agent/build-runtime/automatic-recovery.ts、process-residual.ts | Leader 退出未确认/子进程残留 | kb_termination_unconfirmed 阻断新 Leader | 进程真相 | 实测一次卡死整轮（diagnosis.md：2 条无锚点记录等待确认→改自动恢复，93 项专项测试） | B（安全必要，但 UX 上把构建卡在终态确认） |

### G9 Leader 派发与身份（dispatch-guard + build-actors）

| # | 名称 | 位置 | 触发条件 | 失败后果 | 保护对象 | 频次证据 | 分类 |
|---|---|---|---|---|---|---|---|
| 52 | 派发参数守卫 | dispatch-guard.ts:50-99（FrozenDispatchConfig：workDir/reportRoot/禁区/角色模型/mcpTools 冻结）、:338 | task_submit 参数越权/模型不符/禁区 | block + 审计 | 模型无法绕开权限参数 | timeline：权限拒绝 6 次（kb_get_plan 未授权） | A |
| 53 | 写作范围硬门槛 | dispatch-guard.ts:338（dispatch_writer_scope_too_broad） | 任务书坐标累计>350 行、>12 规则章节单任务、未按 100–150 行拆篇 | block（Leader 重派） | 防单轮输出截断（32.8k） | protocol 中成段规则（leader-protocol.md:14-19）；实测多次截断后补此守卫 | B（教训驱动，粒度阈值硬编码偏粗） |
| 54 | 运行时完整性核验 | dispatch-guard.ts:75-80（integrity fail-closed，F12） | 冻结引用（settings/policy/包/四配置）漂移 | 阻断派发 | 防旧代次信封 | 无证据 | A |
| 55 | 身份链+输出分配 | build-actors.ts:18-27（env AMAGI_TASK_ID 受信→ActorBinding→OutputAssignment）；kb-build-service.ts:1937（assignment 冲突） | 未分配路径写入 / 任务未确认 | 拒写 + 冲突返回持有者 | 写资格最小化 | timeline 无该错误计数 | A |
| 56 | 凭据代次 | build-leader-supervisor.ts（revokeCredentials/rotateGeneration）；agent-tool-service（credential_generation_revoked） | 取消/换代后旧令牌使用 | 全拒 | 取消即停写 | 无证据 | A |

### G10 编排状态机预算（legacy orchestrated 路径）

| # | 名称 | 位置 | 触发条件 | 失败后果 | 保护对象 | 频次证据 | 分类 |
|---|---|---|---|---|---|---|---|
| 57 | 三轴状态机 | build-orchestration.ts:70-90 转移表 | 非法转移 | OrchestrationError | exec/artifact/acceptance 分离（B案 §7） | 单测覆盖（build-orchestration.test.ts） | A（legacy） |
| 58 | 修订/接口预算 | orchestration-contracts.ts:182-183；config reviewPolicy.maxAutoRevisions=2/maxInterfaceRetries=2 | blocking 审查问题换稿重审累计超预算 | pending_decision（不静默接受） | 防无限返工循环 | DB 无 pending_decision 落库（leader 模式不走此账本） | B |

### G11 机械预检（提示不门禁）

| # | 名称 | 位置 | 形态 | 保护对象 | 频次证据 | 分类 |
|---|---|---|---|---|---|---|---|
| 59 | 数值/条件词/术语预检 | mechanical-precheck.ts:1-45（纯提示，formatFindingsForPrompt 注入审查提示词；开关 reviewPolicy.mechanicalPrecheck） | findings 不阻断 | 审查注意力引导 | 无证据（配置中未见 mechanicalPrecheck 开启项） | B（本身已是非阻断，符合「提示化」方向） |

---

## 3. 宿主强制编排 vs「一段 flow 提示词」的约束点与多余往返

### 3.1 宿主强制编排约束点清单

| 约束点 | 位置 | 机制 | 对模型的直接约束 |
|---|---|---|---|
| Leader 监督状态机 | build-leader-supervisor.ts:96-112,728-751 | 轮次事件泵 + idle 宽限执法 | 首个 agent_end≠结束；空闲 3min 被 nudge，再空闲强制中断；发布终局只认工具回执 |
| 派发守卫 | dispatch-guard.ts:50-99,338 | tool_call 钩子改参/阻断，配置冻结注入 | 每轮 task_submit ≤4、写作范围坐标硬门槛、模型/角色/工具白名单不可覆盖 |
| 身份与输出分配 | build-actors.ts:18-27；leader-protocol.md §派发纪律3 | env 身份链 + build_assign_output 全路径分配 | 只能写已分配的完整 .md 路径；目标被持有即冲突 |
| 审查权威绑定 | review-authority.ts:18-27,187-269 | 四类依赖哈希 + 每写入路径独立 pass 回执 | 任何正文/声明/快照/规则变化使回执失效，需重审 |
| 冻结链 | kb-build-service.ts:2237-2256（spec）、materializeWorkflowSkill:1230-1284（skill 内容寻址 + workflowRevision 哈希）、build-runtime-host.ts（agentDirConfigHash/amagi contentHash） | 恢复时任一冻结值漂移拒绝续接 | 质量规则、模型、运行包、协议六文件全部内容寻址冻结 |
| 检查点+自动恢复 | build-checkpoint.ts；automatic-recovery.ts | 每次写/审查/交接触发持久化；退出未确认阻断 | 中断后必须对账才能续接 |
| 发布窗口 | kb-build-service.ts:1878-1889,1990-2041 | publishLock 单发 + preCommitLease 四查 | 同一候选只能申请一次；校验期间新写被拒 |
| 阶段发布 | kb-build-service.ts:1631-1852 | checkpoint 后自动逐篇尝试晋级 CURRENT | 单篇未过门禁不影响他篇，但每篇全量跑知识门禁 |
| 无进展超时 | kb-build-service.ts:2785-2810 | 180min 无 lastActivityAt 即取消 | 长源分篇不足导致的静默等待会被斩断 |
| 修订/接口预算 | orchestration-contracts.ts:182-183（legacy 路径） | blocking 换稿累计 2 轮上限 | 超预算停 pending_decision 等人 |

### 3.2 与「注入一段 flow 工作流提示词让模型自主编排」相比的多余往返

事实对照（每条附证据锚点）：

1. **发布门禁失败 → 必须回到 Leader → 重新派子任务修复 → 重新派审 → 重新申请发布**。发布失败返回给 Leader 的是 rejected + 分组原因（kb-build-service.ts:7304-7326），Leader 须为每个受影响路径派定向修订/补审（leader-protocol.md §结束）。一次 `kb_coverage_invalid`（如 cov-y6qo-draft-materials 一条覆盖项措辞问题）就要求：Leader 读原因 → task_submit 修订 → 子进程冷启动 → 重读草稿与源 → kb_edit_doc → 新审查任务 → 通过回执 → 再申请发布。**同一问题在阶段发布与最终发布两个时点各拦一次**（392 次阶段暂缓 + 287 次发布阻断中大量同码重复）。
2. **写时已拒、发布重跑同校验**：G2#14（写时 verifyEvidence）与 G7#44（发布 verifyEvidence 全量重解引用）是同一函数的两遍执行；G4 确定性校验在 validating、releaseConfirm、Leader 发布窗口三处各跑一遍（kb-build-service.ts:3036、6412、1903）。写时校验已让模型在同一会话内自修（409 即时反馈、形态良好）；发布期重跑对「写后未改的声明」只重复成本。
3. **审查凭据的哈希级时效**：F08 四类依赖绑定使「正文任何字节变化 → 审查作废」（review-authority.ts:10-14 头注）。整合改写、锚点平移、甚至 metadata-only 声明变化都会使已通过的审查失效，需重新派审——在 100+ 篇文档的库上放大为批量补审（事件「缺少当前版本的独立通过复审：\<路径\>」多次出现）。
4. **冻结链完整性 vs 迭代速度**：恢复构建要求 spec/模型/协议/运行包四层哈希全部一致（kb-build-service.ts:2237-2256 + 修复案例 diagnosis.md「冻结包缺排队补丁导致 kb_termination_unconfirmed 卡整轮」）。任何一层升级（包括应用自身发版换 amagi 包）都使旧会话不可续接，只能成果级重建（新 Leader 全量重对账）。
5. **模型自主性被协议文本硬编码约束的部分**：分篇阈值（100–150 行/350 行累计/12 章节）、每轮 4 个任务、任务书 1500 字、审查任务书必须字面含 `coverage.docPaths=["…"]`（leader-protocol.md:14-19、dispatch-guard.ts:338 执法）。这些本可由模型按材料自行判断的编排决策被固化为守卫；守卫按文本模式匹配任务书，模型措辞稍有偏差即被 block 后重写任务书（多一轮往返）。
6. **正面事实（已具备 flow 化条件的部分）**：写面工具门禁全部即时返回结构化原因（409+code），模型单会话可自修；机械预检本就是「提示不门禁」形态（mechanical-precheck.ts:5-7）；阶段发布已把「整库过门禁」拆成逐篇过门禁；`kb_edit_doc`（agent-tool-service.ts:965 起）已提供声明继承的定向修订通道。这些是「门禁下沉到写时 + 模型自修 + 宿主只守安全不变量」路线的既有雏形。

---

## 4. 提示词文件清单与要点

### 4.1 内置 prompts（server/src/agent/prompts/，随构建注入）

| 文件 | 行数 | 注入对象 | 要点 |
|---|---|---|---|
| standard-kb-build.md | 105 | 构建者系统提示（legacy 单进程/并行/编排写轮） | 工具用法、路径约定、硬性边界（不补事实/冲突并列/skipped 申报）、正文与变更分离、正文与来源分离、知识对象协议（六类对象/claims/riskCategory/锚点）、证据登记（readReceiptId 必须真实回执）、覆盖清单义务 |
| standard-kb-plan.md | 35 | 规划者（plannerEnabled，当前 config=false） | 只读+kb_submit_plan 唯一出口；不增并发不跳审查不决定发布 |
| standard-kb-review.md | 48 | 审查者 | 七维度审查（事实数值/条件例外/遗漏/冲突/术语/原意/声明一致）、blocking 必须带双位置、uncheckedScope 强制申报、conclusion 四值 |
| standard-kb-style.md | 60 | 追加到 build 系统提示 | 定义句开节、表格装规则/散文装机制、箭头因果、无支撑格言清除 |

### 4.2 knowledge-build skill 包（server/src/agent/skills/knowledge-build/，pi-amagi 模式冻结注入）

| 文件 | 行数 | 注入对象 | 要点 |
|---|---|---|---|
| SKILL.md | 38 | 所有子任务入口 | 构建/审查/调研总则 |
| leader-protocol.md | 52 | Leader 系统提示（不依赖模型 read，宿主直注 kb-build-service.ts:1182-1230） | 派发纪律（manifest 分页/单篇任务/立即 assign_output/完成即派审）、长源分篇硬门槛、聚合修订、identityGaps→迁移→build_request_publish、空闲收口、恢复对账 |
| author-protocol.md | 26 | luban（写作） | 写作与交接（build_handoff_submit） |
| reviewer-protocol.md | 29 | diting（审查） | 只记差异、kb_submit_review 回执 |
| achievement-protocol.md | 29 | 全部 | 成果交接协议 |
| mcp-examples.md | 153 | 按角色切片注入 | 桥接工具调用示例（曾被合并单块导致协议示例校验失败，已拆开——diagnosis.md 已修复⑥） |

- 冻结方式：`materializeWorkflowSkill`（kb-build-service.ts:1230-1284）把六协议+buildRules+styleGuide+reviewPrompt 物化为 build 专用 home 下按角色内容寻址的 SKILL.md；内容哈希=workflowRevision，进入审查依赖（F08）与恢复比对。
- Leader 初始输入另由 `buildLeaderInput`（kb-build-service.ts:1339）组装（材料概要+恢复信息+质量基线章节）。

---

## 5. 相关测试文件清单（锁定哪些门禁）

| 测试 | 锁定门禁 |
|---|---|
| knowledge-schema.test.ts | G7#37 T1 结构检查 10 码 |
| knowledge-publish.test.ts | G7 runKnowledgeGates 全链（含高风险人审 warning/blocking 切换——已知 1 项与现行策略相关的既有失败，见 diagnosis.md「验证与边界」） |
| knowledge-governance.test.ts | G7#41/42 决定与人审门禁 |
| knowledge-compiler（经 knowledge-publish/knowledge-seam.test.ts） | G7#38 join 编译门禁 |
| evidence-budget.test.ts / evidence-resources.test.ts | G7#45/46 证据装配与体量预算 |
| baseline-resource-carry.test.ts / progressive-knowledge-draft.test.ts / progressive-source-snapshot.test.ts | 基线承接回执与阶段发布（G6#36 哈希重绑语义） |
| build-runtime-review-authority.test.ts | G6#35/36 F07/F08 权威绑定 |
| kb-knowledge-tools.test.ts | G2 写面工具门禁（声明/证据/覆盖/并发/幂等） |
| kb-path-claims.test.ts / kb-build-units.test.ts / kb-pack-batches.test.ts | G2#9 路径认领、单元划分 |
| build-orchestration.test.ts | G10 三轴状态机/预算/迟到回执 |
| kb-build.test.ts / kb-build-resume.test.ts / kb-selected-build.test.ts / kb-build-parallel.test.ts / build-pipeline.test.ts / frozen-pipeline.test.ts | G1 流水线/恢复/冻结、G4 validating |
| kb-publication*.test.ts / publish-render.test.ts / publish-anchor-degrade.test.ts | G8 发布执行与渲染（反向发布） |
| build-runtime-dispatch-guard.test.ts | G9#52/53 派发守卫 |
| build-runtime-publish-cancel.test.ts / build-runtime-e2e*.test.ts / build-runtime-integration.test.ts | 发布取消竞态、端到端（G8#48） |
| build-runtime-automatic-recovery.test.ts / build-runtime-process-residual.test.ts / build-runtime-scan-recovery.test.ts | G8#51 残留对账与自动恢复 |
| kb-mechanical-precheck.test.ts / kb-precheck-integration.test.ts | G11 机械预检 |
| path-guard.test.ts / protected-workspace.test.ts | G2#19 路径围栏 |
| object-migration-reconciliation.test.ts | G7#37 kb_migration_invalid 迁移对账 |
| kb-source-images.test.ts / media-gap.test.ts / blank-csv-coverage.test.ts | 媒体哈希/空白 CSV 覆盖（G4#29、快照 mediaHash） |
| build-fidelity-eval.test.ts（配 docs/design/build-fidelity-eval.md） | 构建保真度评估口径 |
| kb-build-size.test.ts | G4#27 体量上限 |
| knowledge-skill-examples.test.ts | 冻结协议示例契约（mcp-examples 切片） |

---

## 6. 真实阻塞 Top 原因排行（运行证据）

### 6.1 数据源与口径

- `~/.feishu-sync/feishu-sync.db` kb_builds（拷贝查询）：37 构建 = published 15 / cancelled 20 / failed 1（kb_interface_failed）/ running 1；全部 incremental；发布成功均值 139.6 分钟/次，最长 429 分钟（b_20261103110710，30 篇）。
- `.builds/*/events.jsonl` 全量扫描：发布门禁阻断事件 287 次（阶段暂缓 392 次事件中含部分非门禁原因），合计宣称「4977 个阻断问题」。
- 7 份 report.json（blocking+warning 混合落盘，无 severity 字段——本身是排障摩擦点，见 6.4）。
- `agent-outputs/incremental-build-performance/timeline-summary.json`（单构建 b_20261104133247 工具面统计：1,839,531 output tokens、2,851,338 thinking chars、66 成果）。

### 6.2 发布门禁阻断排行（按事件次数；events.jsonl 全量）

| 排名 | 门禁码 | 事件次数 | 典型样例（节选） | 初评 |
|---|---|---|---|---|
| 1 | kb_coverage_invalid | 125 | 「覆盖项仍属知识且由其他文档承接，不能标成非知识排除：cov-y6qo-draft-materials」同一覆盖项在 17 个不同文档的阶段发布中重复拦截；「高风险 unresolved 阻止发布」 | 单条覆盖项措辞问题 × 全库逐篇重跑 = 放大器；当前代码已在发布侧降 warning（knowledge-schema.ts:963）、写时 409（agent-tool-service.ts:3681）——历史事件是降级前口径 |
| 2 | kb_evidence_unresolved | 71 | 证据预算超限（79286398>40245473 等案例 ≥24 次）；readReceiptId 不在登记（krr_stage_* 跨阶段/跨构建引用，单案 332 条）；图片装配失败（单案 843 条承接文档图片） | 三种子成因性质不同：预算=策略、回执跨引用=契约裂缝（已修 krr_seed/baseline-carry）、装配=宿主数据面 |
| 3 | kb_migration_invalid | 61 | 「未解释的对象丢失：\<objectId\> 不在本 release 且无迁移映射」（M1实装/经济体模拟器多篇） | 增量改写致旧对象换名时，Leader 须走 identityGaps→build_register_migrations；旧对象无逐条证据时迁移被拒（diagnosis.md 已修：用文档头来源记录） |
| 4 | kb_link_invalid | 30 | 「内部链接目标文档不存在：数据化战斗/数据化战斗总览.md → 实体部队数据结构.md（解析为 数据化战斗/实体部队数据结构.md）」 | 相对路径差一级目录，纯机械可自修/可编译期修复 |
| 5 | （canPublish）review_missing 族 | 见 §3.2-3 | 「缺少当前版本的独立通过复审：\<路径\>」 | 写-审对偶的时效性摩擦 |

### 6.3 report.json 落盘排行（7 份，blocking+warning 混合）

kb_review_human_missing 1844（本实例治理未激活 → 按 knowledge-validator.ts:298-309 全部为 warning 披露，不阻断，但写满报告）＞ kb_evidence_unresolved 345 ＞ kb_coverage_invalid 127 ＞ kb_migration_invalid 12 ＞ kb_link_invalid 8。

### 6.4 单构建工具面错误（timeline-summary：b_20261104133247）

kb_coverage_invalid×45、kb_evidence_unresolved×13、MCP 参数 Validation failed（raw_search×26、build_handoff_submit×8、raw_read×2 等）、桥接权限拒绝×6（kb_get_plan 未在授权名单）。工具调用总量 1265 次（raw_read 266 / draft_read 316 / kb_write_doc 118 / raw_csv_cells 114…）。

### 6.5 过程冗长的构成性证据

- 20/37 构建以 cancelled 终结（多为分钟级放弃重启，b_20261102051249-065024 连续 5 次 1-7 分钟取消），形成「卡门禁→取消→重试」循环。
- 单篇文档 7.5KB 成稿处理约 20 分钟（重造声明→覆盖对象丢失→逐个取回 15 个旧对象→多次重交大 JSON；diagnosis.md 实测原因①-④）。
- 已落地缓解（本工作树未提交改动 + 最近提交 a74f43f/9ffde17）：requiredRewrites 语义纠正为定向修订、证据按资源粒度继承、发布错误按类归组、识图版本误判修复。

---

## 7. 未覆盖与待核验项

- 「A 案/B 案/重构 v2」三份设计文档原文未在 docs/ 中找到（代码注释多处引用；docs/design/ 仅基线 agent-knowledge-design.md、kb-agent-upgrade-design.md、build-fidelity-eval.md）。门禁的原始设计动机只能从代码头注还原，若需对照原设计取舍需主上提供。
- legacy orchestrated / 单进程路径的运行频次：当前实例全部走 pi-amagi（DB orchestrationMode=pi-amagi），G10/G3-legacy 段无真实运行证据。
- `~/.feishu-sync/agent/audit/`、`agent/builds/<id>/` 明细（逐任务交接与问题清单）未逐一展开；频次统计以 events.jsonl 与 timeline-summary 为准。
- vitest 全量未运行（只读任务，不在授权范围）；测试清单按文件名与代码引用映射，未逐用例核对。
- kb_review_human_missing 的 1844 条 warning 假设依据 governanceActive 判定（kb-build-service.ts:7289-7291 治理空快照不传 governance）；若个别构建曾激活治理，个别条目可能是 blocking，report.json 本身不区分 severity，无法回溯区分。
