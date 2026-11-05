# P2 · 标准库构建门禁简化与 flow 编排设计（设计态）

- 上游输入：`agent-outputs/workflow/kb-build-gate-simplify/p1-gate-inventory.md`（59 条门禁编号 G1#1…G11#59，下文直接引用）；根 `CLAUDE.md`「Agent 标准知识库工作台」两节。
- 代码基线：HEAD `a74f43f`，加上当前工作树未提交改动（`kb-build-service.ts` / `agent-tool-service.ts` / `types/agent-knowledge.ts` / `build-runtime-tools.test.ts` / `knowledge-publish.test.ts`，内容是报告 issue 增加 `severity`、`lastPublicationReport` 拆成 `blockingGroups/warningGroups`）。**本设计依赖这条并行修复线**（S1 的策略层要用 `KbBuildReportIssue.severity`）；实施方要么等它先合入，要么在它之上继续做，不能回退它。
- 交付前复核（同一会话稍后）：并行线还新改了 `object-migration-reconciliation.ts` 与对应测试（迁移候选的共同来源判定）。本设计不修改该文件；G7#37 中迁移降级只在 knowledge-schema 给 issue 打标签，与它不冲突。
- 本文只做设计，没有改代码。文中的 file:function 和行号都按 2026-11 当前磁盘内容回读过（下文"核实"的意思是本轮亲自读过源码）。

---

## 0. 结论摘要

1. **一个开关、一张表、三个收口点**。新增 `standardKb.strictGates?: boolean`，默认 `false`，每次构建创建时冻结。新增模块 `server/src/kb/gate-policy.ts`，里面一张"规则 → 标准模式动作（block/warn/drop）"表。现有门禁生产者不改判定、照常产出 `blocking`，只在三个收口点统一套用这张表：`prepareKnowledgePublish`（知识门禁）、`validateStaging`（确定性校验）、`guardTaskSubmit`（派发守卫）。`strictGates=true` 时整张表被跳过，行为逐字节回到现状。
2. **安全硬不变量一条不动**：路径围栏、staging → 不可变 release → 原子切 CURRENT、指针对账（F11）、源变化阻断（毒化/快照完整性）、原始库写者不变量、凭据/令牌代次、工作区隔离、角色只读边界、证据真实性（写时 `verifyEvidence`）。§1.3 逐条列出保留理由。
3. **发布期不再重复写时已经做过的校验**：
   - G7#44：证据二次全量解引用改为"指纹比对"。快照哈希和资源哈希都一致，就说明字节没变，selector 的结果必然和写时相同，不再查读取回执，也不再重新解析。
   - G4#24：正文纯度在写时已经拒绝，发布期降为 warning。
4. **同一问题不重复拦截**：
   - 阶段发布对 `(path, 正文哈希, 声明作用域哈希, 基准)` 做失败记忆。输入不变就不再重试，原因只登记一次，经 `documentWorkStatus.stageBlockedPaths` 交给 Leader。
   - 最终发布对已阶段发布且未变的文档，只沿用已有判定。
   - 承接面的历史问题只披露，不阻断本轮新文档（"不比 CURRENT 更差"规则）。
5. **质量判断交还模型，宿主改为警告披露**：链接（写时自动修正相对路径，剩下的报 warning）、`important+unresolved` 覆盖项、未解释的对象丢失、证据体量（保留显式配置值和 2GiB 硬上限）、产出体量、高风险人审（治理未启用时不再逐条刷屏）。
6. **审查回执时效放宽**（G6#35/#36）。标准模式下，回执只绑定"审查主体摘要"：规范化正文，加上对象与断言结构，加上关系。只改证据 selector、覆盖去向、空白或文件头、或者 workflow 规则升级，都不会让已通过的审查失效。严格模式保留 F08 的四类精确绑定。
7. **编排交给一段 flow 提示词**。`leader-protocol.md` 从 52 行密集硬规则改写为约 60 行 flow（§3.3 给全文草案）。删掉提示词里"每轮≤4 任务、1500 字、任务书必须字面写出 `coverage.docPaths=[…]`"这类格式约束。派发守卫里的写作范围阈值和审查任务书字面匹配，标准模式下改为"放行 + 审计建议"。宿主保留：角色/模型/权限冻结、`delivery: handle`、输出分配、身份链、空闲收口、无进展超时。
8. **legacy orchestrated / 单进程路径**：仍可通过 `orchestrationMode: 'legacy' | 'claude-native'` 配置到达，所以只保兼容、不扩展、不删除。它们与 pi-amagi 共用 `validateStaging` / `prepareKnowledgePublish` 两个收口点，自动跟着策略表走；G3/G10 不改。

---

## 1. 设计原则与不变量

### 1.1 四条原则（裁决每条门禁时用的判据）

| 原则 | 判据 | 反例边界（遇到时回到严格） |
|---|---|---|
| P-A 宿主只守安全硬不变量，其余在写时即时反馈、让模型自修 | 失败会破坏数据完整性、隔离、原子性或可追溯性 → 阻断；只是"质量不够好" → 写时 409 给模型自修，或发布期 warning | 无法在写时检测、且发布后不可逆的问题（例如已发布 release 的证据缺文件）仍在发布期阻断 |
| P-B 质量判断交给模型（flow + 审查角色）和警告披露 | 判断依赖语义（链接该指向哪篇、覆盖项是否重要、对象是否该迁移）→ 交给审查者/Leader，宿主只披露 | 治理已激活时，人工决定和人审门禁保持阻断（这是用户显式选择的强制点） |
| P-C 发布期不重复写时做过的校验 | 写时已校验、而且校验输入（快照字节、资源字节）可以用哈希证明未变 → 发布期只比哈希 | 哈希不一致时退回完整校验 |
| P-D 同一问题只拦截一次 | 阶段发布和最终发布共用一份"失败记忆"与"作用域判定"。承接面问题不阻断本轮改动面 | 全局结构问题（重复对象、成环、悬空关系、sidecar）不按作用域降级 |

### 1.2 "不比 CURRENT 更差"规则（P-D 的形式化）

增量发布（阶段或最终）只对**可归因于本轮改动面**的问题阻断。改动面 = `draftDocPaths`：
- 阶段发布：`newPaths`；
- 最终发布：`finalDraftEvidenceScopePaths(...)`，现有函数，排除了已阶段发布且未变的文档。

一个问题可归因，指它的定位落在改动面内：`objectId` 的 canonical path 属于改动面，或 `docPath` 属于改动面，或关系边触及改动面对象，或覆盖项的来源/目标触及改动面。定位全部在承接面的问题，降为 warning，作为"承接面历史问题"披露。

先例：`checkHighRiskHumanReview` 已经用 `draftDocPaths` 做了同样的作用域收窄（knowledge-validator.ts，`inCurrentScope`）。这条规则只把它推广到 §2 表中标了"可作用域降级"的规则。全局结构码不降级。

### 1.3 保留的安全硬不变量（标准模式和严格模式都阻断）

| 不变量 | 守护门禁（P1 编号） | 为什么不能交给模型 |
|---|---|---|
| 冻结输入：构建期间来源不可变 | G1#2、G2#18、G5#30、canPublish 快照/基准 | 证据哈希链的前提；源变化后发布会产出无法追溯的 release |
| 路径围栏 / 发布布局 | G2#10、G2#19、G4#23、G4#28 | 路径逃逸、符号链接、空库替换都不可逆 |
| 原子发布 + 指针对账 | G8#48、G8#49、G8#50、F11 收敛 | CLAUDE.md 明列：staging→release→原子切 CURRENT，提交后 DB 异常按指针对账 |
| 原始库写者 / 角色只读 | G2#17、G9#52、G9#55 | 三权分立；模型不能放宽自己的写面 |
| 凭据/令牌代次 | G9#56、G9#54、G8#51 | 取消即停写；旧信封不可复用 |
| 证据真实性（防伪造） | G2#14（写时 `verifyEvidence`，quoteHash 由服务端计算） | 证据是标准库可信度的根；P-C 只去掉发布期的**重复**，写时这道必须保留 |
| 对象身份不静默降级 | G2#12、prepareKnowledgePublish 的 `kb_object_registry_stale` | 防止绕过声明直接改托管文档 |
| 全局知识结构一致 | G7#37 中的结构码（duplicate/canonical/scope/relation/include/presentation，coverage 的 mapped-target 缺失与非法 disposition）、G7#38、G7#43 | 结构损坏会让 MCP/检索读出错误图谱，发布后不可逆 |
| 审查闭环（写-审对偶） | G5#31/#32、G6#36（语义保留，绑定口径放宽）、G7#40 | 独立审查是质量的唯一权威来源；放宽的只是"什么变化算新版本" |
| 治理强制点（治理激活时） | G1#5、G7#41（激活时）、G7#42、G7#47 | 用户显式启用的人工通道 |
| 防止静默丢源 | G4#22（新增可声明 skipped，见 §2）、G4#26 | 增量不丢库；"没有知识"的判断交给模型声明，但必须留下记录 |

---

## 2. 逐条门禁裁决表

动作含义：**保留**＝两种模式都阻断；**降级**＝标准模式下进报告/日志为 warning，严格模式下阻断；**删除**＝标准模式下不产生 issue（严格模式保留原行为）；**写时化/自动修复**＝把检测移到写入工具，能机械修正就直接修正并在工具结果里告知。

### 2.1 重点条目（任务书点名）

| P1# | 门禁 | 裁决 | 理由 | 改动落点 |
|---|---|---|---|---|
| **G7#44** | 证据发布期全量重解引用 | **改为指纹比对**（严格模式维持全量） | 写时 `buildKnowledgeDeclaration` 已经对同一冻结快照执行 `resolveSelector`+`verifyEvidence`（agent-tool-service.ts 约 3443-3466，核实），quoteHash 由服务端算。发布期如果 `sourceSnapshotHash` 和 `resourceHash` 都等于当前资源，selector 解析就是确定性重放，没有新信息。真实失败的主因有两个：跨构建的 `readReceiptId` 不在本构建登记（单案 332 条），以及承接文档的图片装配。它们都是"重复校验的契约裂缝"，不是伪造。 | `knowledge-validator.ts:checkEvidence` 新增 `input.evidenceCheck: 'full' \| 'fingerprint'`（缺省 `'full'`，纯函数保持严格）。fingerprint 分支：①来源不在快照 → 阻断（rule `evidence_source_missing`）；②`readVerified` 抛错 → 原样传播/阻断；③资源存在、sourceId 一致、两个哈希都相等 → 通过，**不查回执、不重解**；④哈希不等 → 走完整 `verifyEvidence`，但 `receipts` 传入 `undefined` 语义（见下方注）。新草稿的 `nature` 检查保留。服务端在 `kb-build-service.ts:prepareKnowledgePublish` 按策略传值。**前置审计（S2 必做）**：grep 所有写入 `draft.evidence` 的路径（已知 `buildKnowledgeDeclaration` 3487-3489、`kb_edit_doc` 的 `evidenceClaimsAdd/evidenceSelectorUpdates` 5076 起、`seedBaselineKnowledge` 3280 承接自不可变 release），确认每条新增或修改证据都经过写时 `verifyEvidence`，否则 fingerprint 分支对该来源回退 full |
| **G7#46** | 证据体量预算 | **降级**，但两种情况仍阻断：①配置了显式 `evidenceBudgetBytes`（用户的明确意图）；②超过 `EVIDENCE_BUDGET_MAX_BYTES`（2GiB 绝对上限） | 预算是 release 体量策略，不是正确性问题。超限后模型只能收窄引用，和"完整证据"要求互相挤压（24+ 次事件）。体量保护由绝对上限兜底 | `prepareKnowledgePublish` 预算分支给 issue 打 `rule: 'evidence_budget_exceeded'`，在显式配置或超绝对上限时打 `rule: 'evidence_budget_hard'`；策略表：前者 warn，后者 block |
| **G7#39** | 内部链接检查 | **写时自动修复 + 发布期降级** | 实测 30 次事件，多数是相对路径差一级目录（P1 §6.2），纯机械问题。链接该指向哪篇是语义判断，宿主只能修"唯一同名"这种确定情况 | ①写时：`agent-tool-service.ts:writeDocCore` 与 `kb_edit_doc` 的正文落盘前（必须在 `computePayloadHash` **之前**，否则 payloadHash 与正文不一致），新增 `repairRelativeMdLinks(markdown, docPath, knownPaths)`。`knownPaths` = staging 文档 ∪ 基线文档 ∪ 本构建 `build_assign_output` 已分配的目标（覆盖"目标稍后才写"的情况）。目标不存在、但 `knownPaths` 中恰有一个同名文件时，改写为正确的相对路径；结果写入工具返回 `details.linkRepairs`。②发布期：`checkInternalLinks` 给 issue 补 `docPath` 字段，rule `link_target_missing` / `link_anchor_missing` → 标准模式 warn。**不在编译产物里改写**：release 文档就是编译产物，事后改字节会让对象 payloadHash 与正文不一致 |
| **G7#41** | 高风险人审 | **治理未启用时删除**（只写一行汇总日志）；治理启用时保留 | 本实例从未启用治理，1844 条全是 warning 噪音，挤占 report 和 `lastPublicationReport` 的分组 | `knowledge-validator.ts:checkHighRiskHumanReview`：`governance` 缺省时 issue 打 `rule: 'human_review_unconfigured'`。策略表：标准模式 drop，并由 `prepareKnowledgePublish` 汇总为 `emitLog(info, '高风险断言 N 项（治理未启用，不要求人审）')`；严格模式保持 warning 原样 |
| **G7#37** coverage | T1 覆盖清单 | **拆分**：结构类保留（非法 disposition、mapped 无目标、mapped 目标不存在）；`important+unresolved` → **降级**；"排除无理由""知识转移措辞"现状已是 warning，不变 | 结构类是图谱一致性（悬空映射）。`important+unresolved` 是作者自己承认的已知缺口，属质量判断：审查者能看到，发布披露即可。降级前的历史事件（cov-y6qo 跨 17 篇重复拦截）已由 knowledge-schema.ts:963 的 warning 化处理（核实） | `knowledge-schema.ts:validateKnowledgeGraph` 覆盖段（约 925-965）只给 issue 加 `rule` 标签：`coverage_important_unresolved`（降级）、`coverage_target_missing`（保留，且**可作用域降级**：来源和目标都在承接面时 warn）。函数本身的 severity 不改，纯函数单测不受影响 |
| **G7#37** migration | 未解释的对象丢失 | **降级**（迁移成环、重复登记、merge 后继数非 1 等结构码保留） | 对象丢失时，如果有覆盖项指向它，会经 `coverage_target_missing` 结构阻断（知识丢失仍有防线）；有关系指向它，会经 `kb_relation_invalid` 阻断。剩下的只是"旧 objectId 的身份连续性"，是语义判断（`objectMigrationGaps` 头注明确写着"suggestions never become migrations automatically"，核实），交给 Leader 按 identityGaps 选择性登记。61 次发布事件是第三大阻断源 | `knowledge-schema.ts` 迁移段的"未解释的对象丢失"issue 加 `rule: 'migration_unexplained_loss'` → 标准模式 warn；report 与发布日志写明丢失对象 ID，供后续构建或人工补登记 |
| **G4#24** | 正文纯度（修订记录/来源标识） | **降级**（只在 validating 阶段；写时拒绝保留） | `writeDocCore` 已对 markdown/summary 执行 `hasEditorialHistory`/`hasSourceMetadata`（agent-tool-service.ts:2301/2327，核实）。validating 再跑一遍，新写文档拿不到新信息，承接文档却可能因为启发式版本变化被误伤 | `validateStagingDocs` 的 `body_contains_change_history` / `body_contains_source_metadata`：策略表 warn |
| **G4#25** | 受影响文档必须修订 | **保留**（只改提示语义：明确"定向修订即可"） | 承接文档引用的源已经变化，若不触碰，证据快照哈希不再匹配，release 证据就会失效（`verifyEvidence` 对 `sourceSnapshotHash` 不符直接失败，核实 evidence-locator.ts:442）。所以至少要对证据做一次 rebase 写入，这是正确性要求。"免写只审"的方案需要宿主自动 rebase 证据，列为 §5 的后续候选，不进本轮 | 不改判定；在 flow 提示词说明 `kb_edit_doc` 最小修订 |
| **G4#27** | 产出体量上限（validating + 编译后两处） | **降级**（两处同步） | 防膨胀/幻觉量产属于质量判断，审查者对照来源能发现。无真实触发证据。单文件 1MB（G2#10）保留为硬限 | `validateStagingDocs` 的 `total_too_large` 与 `knowledge-compiler.ts` 展开后的 `total_too_large`（约 823-829，核实）：策略表 warn |
| **G5#33** | program_check_failed / carry_over_unmarked / source_disposition_missing | **保留**（不改） | 这三个字段由宿主在 `assembleCandidateRelease` 中自行组装，模型无法影响，交互成本为零。属于宿主自检断言，删掉不会减少任何模型往返 | 无 |
| **G6#35/#36** | 审查回执四类依赖绑定 / 每路径独立通过 | **放宽绑定口径**：标准模式下回执只绑定"审查主体摘要"；"每个写入路径都要有独立通过审查"这一不变量保留 | F08 设计下，任何字节或声明变化（含 metadata-only、selector 平移、workflow 规则升级）都会让回执失效（review-authority.ts 头注，核实）。整合改写和锚点平移因此放大成批量补审。审查者协议本来就是"正文对照来源、只在有疑点时展开声明"（reviewer-protocol.md，核实），证据 selector 和覆盖去向的正确性由写时机械校验保证，不靠审查 | 见 §2.3 算法。落点：`review-authority.ts`（新增 `reviewSubjectDigest`、`collectAuthorityValidatedReports`/`missingScopedPassReviewPaths` 按策略比对）；`build-actors.ts:invalidateReviewsForPaths`（主体不变则不失效）、`invalidateReviewsForWorkflowRevision`（标准模式不调用）；`agent-tool-service.ts:toolKbSubmitReview`（回执多写 `subject:<path>`）与 `v2RecordReceipt`（写后重算主体）；`kb-build-service.ts:repairWorkflowReviewCredentials`（标准模式短路） |
| **G9#53** | 写作范围硬门槛 | **降级为放行 + 审计建议**（严格模式阻断） | 阈值（350 行、220 CSV 行、400 单元格、12 锚点、"通读全文"措辞）都靠正则匹配任务书文本。Leader 措辞稍有偏差就被 block 后重写，多一轮往返。真正的风险（32.8k 输出截断）有完成通知里的 `settlement=incomplete` 信号，而且截断后的拆窄恢复已写进 flow，属于可恢复错误 | `dispatch-guard.ts:guardTaskSubmit`：`config.strictGates !== false` 时维持 block；为 `false` 时 `writerScopeIssue` 结果写入 `audit.changes`（`advisory: …`），decision 改为 allow。`FrozenDispatchConfig` 增加可选 `strictGates?: boolean`（**缺省视为严格**，旧信封和现有单测不变），由 `adapter.ts:buildGuardConfigInput` 从 `BuildRunSpec.strictGates` 填入 |
| 审查任务书字面格式（G9#52 子项 `reviewerScopeIssue`） | 审查任务书必须字面写出 `coverage.docPaths=["…"]` | **标准模式删除**（严格模式保留） | `kb_submit_review` 本身已校验 `coverage.docPaths` 非空、路径存在、`sourceRefs` 恰好匹配（agent-tool-service.ts 4138-4165，核实）。按任务书文本做模式匹配是重复执法。单篇审查的好处（声明作用域哈希不被他篇牵连）在 §2.3 下也不再必需，降为提示词建议 | 同上，`reviewerScopeIssue` 在非严格时不执行；"taskFile 派发审查"的拒绝一并取消（taskFile 已有 workDir 围栏，G9#52 的 #3 项保留） |
| **G3 legacy 收尾义务**（#20/#21） | kb_unit_done / kb_finish | **保留，legacy 专属，不扩展** | Leader 模式不用（leader-protocol 明示）。legacy 路径仍可配置到达。`validateStagingDocs` 的 `kb_finish_missing` 在 Leader 路径由 `executeLeaderPublishRequestInner` 预填 `finishInfo` 满足（核实 1900 行附近） | 无 |
| **G4#22** | 工作集源必须被引用或 skipped | **保留阻断，新增 Leader 声明通道** | Leader 工具面没有任何声明 skipped 的入口（`V2_LEADER_TOOLS` 只有 9 个，`build_request_publish` 只有 `requestedRevision/summary`，核实 tool-specs.ts:914/1252），只有占位源会被自动跳过。工作集里确实不含知识的来源（会议记录、变更日志）只能硬塞进某篇文档的 sources。改法是让模型声明，宿主记录 | `tool-specs.ts` 中 `build_request_publish` 增加可选 `skipped: [{objToken, reason}]`（reason 1..500，objToken 必须属于工作集）；`toolBuildRequestPublish` 透传，`executeLeaderPublishRequestInner` 合并进 `buildState.finishInfo.skipped`（已有字段，随 manifest `skippedSources` 落盘）。additive，两种模式通用 |
| **G1#3** | 冻结规格/模型比对 | **保留**（不改） | 核实结论：`frozenRoleMismatches` 只作用于 legacy `checkpoint.orchestration`（pi-amagi 模式不创建 `entry.orchestration`，kb-build-service.ts 约 2315 `!resume && !leaderMode`）和 legacy 角色派发（约 5794）。pi-amagi 恢复缺省就是成果级重建，会采用当前冻结面（build-runtime-host.ts 1013-1016：`resumeStrategy !== 'session'`）。P1 §3.2-4 说的"冻结链让旧会话不可续接"，实际代价是**规则升级后审查回执集体失效**，在 G6 放宽（workflow-rules 不再作为有效性依赖）后消除 | 无（成本经 G6 消除） |
| **G8#51** | 残留对账/自动恢复 | **保留**（不改） | 进程真相属于安全范畴，而且已经改成自动恢复（P1：93 项专项测试）。无法确认终止时宁可阻断新 Leader，避免双写 | 无 |
| **G10#58** | 修订/接口预算（legacy） | **保留，legacy 专属** | Leader 模式不走这本账（DB 无 `pending_decision`）。flow 中由模型自行判断何时停止修订并报告 | 无 |

### 2.2 其余条目（逐条，简表）

| P1# | 裁决 | 理由 / 落点 |
|---|---|---|
| G1#1 全局单构建准入 | 保留 | 状态一致性（A） |
| G1#2 恢复基准/快照一致 | 保留 | 冻结输入（A） |
| G1#4 发布谱系排除 | 保留 | 防自我喂养；只排除并给警告，本来就不阻断 |
| G1#5 治理快照冻结 | 保留 | 治理强制点（A） |
| G1#6 无变更短路 | 保留 | 合理短路，不构成负担 |
| G1#7 构建/无进展超时 | 保留 | 资源回收；180min 只按 lastActivityAt 判定，不打断正常进展 |
| G1#8 Leader idle 执法 | 保留阈值；**收口提示加信息**（可选） | 无 `kb_leader_idle` 落库记录，不是阻塞源。可选：`build-leader-supervisor.ts:evaluateIdle` 的提示文本附上 `pendingIndependentReviewPaths / stageBlockedPaths` 计数，让模型知道下一步做什么（提示只陈述现状，原则不变） |
| G2#9 路径认领 | 保留 | 并行路径（legacy）；Leader 模式由 G9#55 承担 |
| G2#10 路径合法/大小限 | 保留 | 发布契约（A） |
| G2#11 空占位源拒绝 | 保留 | 写时即拒，模型可以自修 |
| G2#12 纳管文档旧式重写 | 保留 | 对象身份（A）；`kb_edit_doc` 已缓解 |
| G2#13 对象声明校验 | 保留 | 写时即拒，形态合理 |
| G2#14 证据写时校验 | 保留 | 证据真实性的唯一权威（§1.3） |
| G2#15 覆盖清单写时校验 | **部分降级**：结构类保留（非法 disposition、mapped 无目标、目标未注册、排除无理由）；"理由含知识转移措辞"的 409 改为接受，并在工具结果里给 `warnings` | 正则启发式属于质量判断，发布期本来就是 warning（knowledge-schema.ts 约 962，核实），写时 409 不一致。落点：`buildKnowledgeDeclaration` 约 3681、`kb_edit_doc` 覆盖更新约 5229 的 `excluded_nonknowledge` 分支（目标对象仍由他篇承接的结构性保护不变）。注：45 次工具错误的子类分布无证据（§6 U5），本项能消除多少未知 |
| G2#16 乐观并发+幂等 | 保留 | A |
| G2#17 角色只读 | 保留 | A |
| G2#18 源读取毒化 | 保留 | A |
| G2#19 PathGuard | 保留 | A |
| G4#23 symlink/非md/路径/头/sources | 保留 | A |
| G4#26 既有文档保护 | 保留 | 增量不丢库 |
| G4#28 空库拒绝 | 保留 | A |
| G4#29 占位源证据拒绝 | 保留 | 已自动登记跳过，并有 `placeholder_source_removed` 自动修复（kb-build-service.ts 约 1500） |
| G5#30 源快照/基准 | 保留 | 最终防线，代价很低 |
| G5#31 报告存在/必审 | 保留 | 版本绑定审查 |
| G5#32 blocking_issue_open | 保留 | 审查闭环 |
| G5#34 confirm 绑定 | 保留 | 用户确认绑定当前候选 |
| G7#38 编译 join issue | 保留 | exact 片段字节级一致是呈现正确性；`kb_restatement_stale` 标为**可作用域降级**（owner 对象在承接面时 warn） |
| G7#40 审查凭据 | 保留 | 凭据链完整；标准模式下由 §2.3 的"凭据重挂"保证不被纯 selector 修改打回 pending |
| G7#42 业务决定门禁 | 保留 | 治理强制点 |
| G7#43 sidecar 哈希 | 保留 | 宿主自检，零模型成本；去掉也不会减少任何往返 |
| G7#45 证据资源装配 | 保留 | release 证据文件缺失不可逆；承接图片已改为从不可变 release 读取（已修） |
| G7#47 治理快照复核 | 保留 | 同 G1#5 |
| G8#48/#49/#50 | 保留 | 原子发布与发布窗口（A） |
| G9#52 派发参数守卫（角色/模型/workspace/scope/禁区/delivery） | 保留 | 权限参数不能由模型改写（A） |
| G9#54 运行时完整性 | 保留 | A |
| G9#55 身份链+输出分配 | 保留 | 写资格最小化 |
| G9#56 凭据代次 | 保留 | A |
| G10#57 三轴状态机 | 保留（legacy） | — |
| G11#59 机械预检 | 保留 | 本来就是"提示不门禁" |

### 2.3 审查主体摘要（G6 放宽的精确算法）

**定义**：`reviewSubjectDigest(stagingRoot, draft, docPath)` = sha256(stableStringify({
- `body`：`normalizeBody(stripStdHeader(docContent))`。规范化规则：CRLF→LF；每行去掉行尾空白；连续 3 个以上空行压成 2 个；去掉末尾换行；
- `objects`：本路径上非 tombstone 的对象按 objectId 排序，每项取 `{objectId, type, title, scopeKey, familyKey, variantKey, claims:[{claimKey, riskCategory}]}`。**不含** payloadHash、reviewSubjectHash、canonical.bodyRange、revision/locationRevision、审查凭据字段；
- `relations`：触及上述对象的关系 `{type, fromObjectId, toObjectId, decisionRef}`，排序后纳入；
- `presentations`：owner 或 target 属于上述对象的呈现 `{kind, ownerObjectId, targetObjectId}`。
}))

**不纳入**：evidence（selector/回执/哈希，写时机械校验）、coverage（写时结构校验，发布结构门禁兜底）、`docs[path]` 元数据、clientKeys/evidenceKeys、workflow 规则哈希。全局 `source-snapshot` 依赖保留：构建内它是常量，代价为零。

**规则（仅标准模式）**：
1. `toolKbSubmitReview` 记录回执时，在 `dependencyHashes` 中为每个 scopePath 加一项 `subject:<path>`（additive，旧键照写，严格模式与审计都还能用）。
2. `v2RecordReceipt(invalidateReviews)`：写入后对每个受影响路径重算 digest。只有与回执中 `subject:<path>` 不等的回执才 `invalidateReviewsForPaths` 标 stale。回执缺 `subject:` 键（旧回执）时按现状失效。
3. `collectAuthorityValidatedReports`：回执携带 `subject:` 键时，只校验 report 文件绑定、`source-snapshot`，以及每个 scopePath 的 `subject:` 是否等于当前 digest；跳过 declaration、`doc:*`、`workflow-rules` 三项比对。不带 `subject:` 的旧回执走原有精确规则。
4. `missingScopedPassReviewPaths`：覆盖判定改为"`subject:<path>` 等于当前 digest"。`basePromotionHashes` 的承接判定不变（精确哈希等于已阶段发布字节）。
5. **凭据重挂**：写入后若回执仍有效，但对象因 reviewSubjectHash 变化（例如证据改动）被 `buildKnowledgeDeclaration` 置回 pending（agent-tool-service.ts 3722-3732 只在 payloadHash 和 reviewSubjectHash 都不变时继承，核实），则在同一声明锁内调用现有 `markObjectsReviewedForAuthorityReceipt` 的同一逻辑，用该回执的 reportId 重新回写 machine 凭据。这样 G7#40 `kb_review_pending` 与阶段发布的 `objects.every(reviewStatus==='passed' && reviewerId===report.reportId)` 都还能成立。**不改** `computeReviewSubjectHash`：治理人审绑定它（A 案 §5.1），不能动。
6. `repairWorkflowReviewCredentials` / `invalidateReviewsForWorkflowRevision`：标准模式下不撤销回执（规则升级不使内容审查失效），只写一行 info 日志记录新旧 revision。

**可证伪预测**：标准模式下，只改 `evidenceSelectorUpdates` 或 `coverageUpdates` 的 `kb_edit_doc` 之后，`documentWorkStatus.pendingIndependentReviewPaths` 不包含该路径，阶段发布可以直接晋级；改动正文任何非空白字符或断言结构，则该路径重新出现在待审列表。

**已知代价**：作者在审查通过后替换成"能解析、但不支持该断言"的证据，标准模式不会触发重审。接受这一点的理由：证据仍然真实可解引用；审查者协议本来就不逐条核对证据；全称断言另有 selector 完整范围要求，作者协议和审查协议都写了。严格模式保留原 F08 语义。

### 2.4 阶段发布失败记忆与 `stageBlockedPaths`

- 现状（核实）：每个 checkpoint 都触发 `scheduleProgressivePublish` → `publishProgressiveIfReady`，失败只写一条 `阶段发布暂缓` 日志，没有任何记忆。同一篇、同样输入，会在下一次任意写入或审查事件时重跑完整编译加全库门禁。392 次暂缓事件，以及"同一覆盖项在 17 篇文档的阶段发布里重复拦截"，都来自这里。
- 设计：`BuildRunState.progressiveBlocked: Map<path, {key, groups, at}>`，`key = sha256(path, docContentHash, scopedKnowledgeDeclarationHash(draft,[path],sources), baseReleaseId, gatePolicyVersion)`。
  - `publishProgressiveIfReady` 在计算 `newPaths` 后，滤掉 key 未变的已阻断路径（不再重跑）；
  - 失败时（`kb_publish_blocked` / `kb_progressive_validation_failed`），把分组原因（复用 `prepareKnowledgePublish` 已有的 `details.groups`）写入记忆，并 `emitBuild('build_progressive_blocked', …)`；
  - 晋级成功或 key 变化时删除记忆；
  - 最终发布失败时，对失败可归因的路径同样写入记忆，阶段发布不再拿同一输入重试；
  - 记忆随检查点持久化（additive 字段；缺失等于空）。
- 暴露：`agent-tool-service.ts:buildDocumentWorkStatus` 增加 `stageBlockedPaths: Array<{path, groups:[{code, count, examples≤2}]}>`（只列 blocking 组），`build_manifest` 与 `build_checkpoint(status)` 同时返回。Leader 的 flow 据此派定向修订，不再需要读日志或等最终发布才看到原因。
- 严格模式同样启用记忆：这是纯效率改动，不改变任何判定。

### 2.5 策略表（`server/src/kb/gate-policy.ts`，新增）

```ts
export type GateAction = 'block' | 'warn' | 'drop';
export interface GatePolicy { strict: boolean; version: 1 }
// 规则 ID 优先，缺省回落 code；未登记 = block（失败封闭：新门禁默认阻断）。
const STANDARD: Record<string, { action: GateAction; scopeDemotable?: true }> = {
  body_contains_change_history: { action: 'warn' },
  body_contains_source_metadata: { action: 'warn' },
  total_too_large: { action: 'warn' },
  link_target_missing: { action: 'warn' },
  link_anchor_missing: { action: 'warn' },
  human_review_unconfigured: { action: 'drop' },
  coverage_important_unresolved: { action: 'warn' },
  coverage_target_missing: { action: 'block', scopeDemotable: true },
  migration_unexplained_loss: { action: 'warn' },
  evidence_budget_exceeded: { action: 'warn' },
  evidence_budget_hard: { action: 'block' },
  kb_restatement_stale: { action: 'block', scopeDemotable: true },
};
export function applyGatePolicy<T extends { code: string; rule?: string; severity?: string }>(
  issues: T[], policy: GatePolicy, attributable?: (issue: T) => boolean,
): { blocking: T[]; warnings: T[]; dropped: number }
```

- `ValidationIssue`（knowledge-schema.ts）与 `KbBuildReportIssue`（types/agent-knowledge.ts）各加 additive 可选字段 `rule?: string`、`docPath?: string`。生产者只打标签，不改 severity，纯函数的现有单测语义不变。
- `strict=true`：原样返回（severity=blocking 的进 blocking），不看表。
- 被降级的 issue 写入 report 时带 `severity:'warning'` 和 `demotedFrom:'blocking'`，排障时一眼能分清（衔接并行修复线的 `warningGroups`）。
- 三个收口点：
  ① `prepareKnowledgePublish`：`[...evidenceBlocking, ...gates.blocking]` 与 compiled issues 合流后套用，`attributable` 由 `draftDocPaths` 与 §1.2 规则构造；
  ② `validateStaging`（6722）与阶段发布中直接调用 `validateStagingDocs` 的那一处（约 1799），统一改为调用一个 `validateStagingWithPolicy` helper；
  ③ dispatch guard（不走表，用 `strictGates` 布尔判断）。

### 2.6 配置与冻结

- `types/agent-knowledge.ts:StandardKbConfig` 加 `strictGates?: boolean`（注释：缺省 false = 标准门禁；true = 恢复全部历史阻断，用于审计或回归对照）。
- `modules/config-manager.ts` 的归一（约 414 附近）与严格校验（约 606 附近）：非布尔值视为缺省或报 `out_of_range`，与现有 additive 字段同一模式。
- 冻结：构建创建时解析为 `GatePolicy`，写入 `BuildRunState.gatePolicy` 与检查点（additive；旧检查点缺失时按**严格**处理，保证历史构建恢复后语义不变）；同时写入 `BuildRunSpec.strictGates`，供 `buildGuardConfigInput` 使用。成果级重建时 spec 取自构建冻结值，**不取当前配置**，避免一个构建中途换策略。
- 前端设置项：不在本轮范围（CLAUDE.md 要求前端改动必须真机交互验证）。`config.json` 手改即可生效；需要 UI 时另开切片。

---

## 3. 构建流程重构：flow 驱动

### 3.1 宿主状态机/守卫：删什么、留什么

| 约束 | 现位置 | 处理 |
|---|---|---|
| 每轮 ≤4 个 task_submit、任务书 ≤1500 字 | 只在 leader-protocol.md 文本中（grep 代码无执行点，核实） | **删除提示词约束**。真实并发上限由进程池准入（`agent.maxConcurrentProcesses`，后台 ≤M−1）承担（见 §6 U1） |
| 写作范围阈值（100–150/220/350 行、400 单元格、12 锚点） | dispatch-guard.ts:writerScopeIssue + 提示词 | 标准模式改为审计建议；提示词保留一句经验值（"一次回复能读完并提交"），不再写成硬门槛 |
| 审查任务书字面 `coverage.docPaths=[…]` | dispatch-guard.ts:reviewerScopeIssue + 提示词 | 标准模式删除；工具层校验保留 |
| `delivery: handle` 自动纠正 | guardTaskSubmit | 保留（身份登记的前提；已是改参而非阻断） |
| 角色/模型/scope/workspace/禁区冻结 | guardTaskSubmit 1-5 | 保留 |
| 每篇 `build_assign_output` 精确路径 | build-actors 身份链 | 保留（写资格最小化）；在 §2.1 链接修复中被复用为 knownPaths |
| Leader 空闲宽限 3min → 一次提示 → `leader_idle` | build-leader-supervisor.ts:evaluateIdle | 保留（可恢复中断，防挂死）；可选：提示文本加状态计数 |
| 无进展 180min 超时 | kb-build-service.ts 约 2785-2810 | 保留 |
| 阶段发布自动触发 | scheduleProgressivePublish | 保留，加失败记忆（§2.4） |
| 发布窗口单发锁、candidate 精确锁 | executeLeaderPublishRequestInner | 保留 |
| 问题清单最新版 blocking>0 拒绝发布申请 | agent-tool-service.ts:toolBuildRequestPublish → `openBlockingIssues` | 保留（这是 Leader 自己登记的门槛）；flow 中说明"问题解决后提交更新后的清单" |

### 3.2 宿主与模型的分工（新）

```
宿主（硬）                              模型（flow）
───────────────────────────────────    ─────────────────────────────────────
冻结来源/基准/角色/策略                   盘点 build_manifest → 拆主题
写时即时校验（声明/证据/覆盖/并发/围栏）     派写 + 分配输出 → 派审
写时链接自动修正                          读回执/stageBlockedPaths → 定向修订
审查回执登记（主体摘要绑定）               判断：迁移登记、skipped、何时停止修订
阶段发布（自动）+ 失败记忆                 申请最终发布 / 报告无法完成
最终发布：结构门禁 + 策略表 + 原子切换
```

### 3.3 新 `leader-protocol.md` 全文草案

> 约束：文件中不放 JSON 代码块（`knowledge-skill-examples.test.ts` 会对协议文件中的工具调用示例做 schema 校验；Leader 的直连示例在 `mcp-examples.md` 的 Leader 段，那里不动）。措辞不依赖门禁模式，标准和严格两种模式都以工具返回为准。

```markdown
# Leader 工作流（应用注入系统提示）

你是本次标准知识库构建的 Leader。目标：把本轮工作集的变化整理成经过独立审查的标准文档，并让应用发布当前候选。你负责编排：拆主题、派发子任务、分配输出、聚合问题、申请发布。正文、对象与证据都由子任务经应用桥接提交，你没有正文写工具。

## 应用替你守住的
来源冻结、路径围栏、输出分配、角色/模型/权限冻结、写入即时校验（声明、证据、覆盖、并发）、审查回执登记、阶段发布与原子发布。这些不必写进任务书，也无法绕开。工具返回的错误码是可修正的反馈：按原因修正后重试，不要换路径、删除重建或降低问题等级来规避。

## 工具
- amagi：`task_submit`、`task_query`、`task_control`、`task_resume`、`amagi_resource`。派发一律 `delivery: handle`；等待成果用完成通知或 `task_query`。
- 应用：`build_manifest`、`build_assign_output`、`build_revoke_output`、`build_checkpoint`、`build_handoff_list`、`build_issues_submit`、`build_issues_list`、`build_register_migrations`、`build_request_publish`。
- 角色只用构建角色表：写作 luban、审查 diting、调研 baize。不要覆盖冻结模型，也不要放宽子任务权限。

## Flow
1. **盘点**。`build_manifest` 读工作集（每页最多 12 个来源，按 `nextCursor` 读到 `null`；读到首页就可以开始派发）。看 `documentWorkStatus`：
   - `carriedPublishedPaths`、`promotedUnchangedPaths` 已是正式文档，不重写也不重审；
   - `unpublishedDraftPaths`、`pendingRequiredRewrites`、`pendingIndependentReviewPaths`、`stageBlockedPaths` 是待办；
   - `entries[].sourceAvailability` 为权限占位、未展开引用或空白工作簿的来源，不派写作，也不挂进 sources，应用会自动登记跳过。
2. **拆主题**。一篇目标文档对应一个写作任务。用 `sourceShape` 估量阅读量：作者要能在一次回复内读完本篇材料并提交。规则密集的长源按独立主题拆成多篇（经验值：每篇约 100–150 行规则正文）；纯明细表让作者用 `csvTableImports` 由服务端导入，不必拆碎。重建同一主题时沿用 `existingDocPaths`。公共定义可以共读，共享对象的修改只交给一个任务。
3. **派写**。`task_submit` 给 luban，之后立即 `build_assign_output`，分配同一个完整 `.md` 路径（不支持目录或通配符）。任务书只写目标路径、来源 token、章节或 CSV 坐标、完成条件。`requiredRewrites` 中的文档要求对照变化用 `kb_edit_doc` 定向修订，不要求全文重写。多个任务可以同时派，应用按准入排队。
4. **派审**。某篇写作取得应用写入回执后，立即派 diting 独立审查该篇：给出路径与来源 token，每个审查任务建议只审一篇。不必等同一来源的其他篇。
5. **收敛**。读审查回执、`stageBlockedPaths` 与发布报告中的 `blockingGroups`，只针对阻断问题派定向修订：用 `kb_edit_doc` 的 patches、evidenceSelectorUpdates、coverageUpdates、objectMerges，按问题位置修改，然后复审受影响的篇。`warningGroups` 只是披露，不要为它扩大改写。审查通过的篇章由应用自动阶段发布。作者声称已修复不能关闭问题，以复核结论为准。
6. **身份**。`build_manifest.identityGaps` 列出本轮消失的旧对象。核对正文与共同来源后，语义上确有去向的用 `build_register_migrations` 登记（merge、split、remove，写明实际理由）；不确定的不要为了凑数合并。是否阻断以发布返回为准。确属遗漏的知识，派写作补回并复审。
7. **发布**。工作集的真实变化都已覆盖、问题清单最新一版没有 blocking 时，调用 `build_request_publish` 申请当前候选（revision 以工具返回为准）。工作集中确认不含可整理知识的来源，用 `skipped` 写明理由。返回 rejected 时，只处理其中的阻断原因；候选、声明、迁移与审查都没有变化时，不要重复申请。
8. **结束**。无法完成时，用 `build_issues_submit` 记录原因后结束。你的某一轮结束、amagi 任务结束，都不等于构建结束。

## 异常
- **输出截断**：完成通知显示 `execution=done`，但 `settlement=incomplete`、没有交接，且输出接近模型上限，按截断处理。先 `draft_read` 看目标草稿：已写入就续接补交接；未写入就把原范围拆窄后重派，不要按原范围 `task_resume`，只改"输出 ≤8k"之类的措辞不算拆分。
- **交接受阻**（缺材料、归属冲突、需要裁定）：调整拆分或分配后重派，不要代写正文。
- **派发被拒**（`dispatch_*`）：按返回原因调整参数后重派。
- **空闲**：没有运行中的轮次、子任务都已收到完成通知时，应用会提示一次。请申请发布或报告无法完成；再次空闲会中断本次运行（可恢复，候选与问题清单都保留）。

## 恢复
- 恢复信息由应用注入。先用 `build_checkpoint(action=status)` 对账，再按 `documentWorkStatus` 继续。`build_handoff_list` 分页读，只展开仍需处理的 taskId。
- 成果级重建会换新的工作目录：旧的 `agent-outputs/...` 路径不可继承，不要填进 `contextRefs` 或 `inputs`；需要的结论重新调研，或把已核实的短结论写进任务书。
- 不重写已接受且未受影响的草稿；不要因为恢复后 revision=0、`krr_seed_*` 或旧回执失效，就重新派审正式文档。
```

### 3.4 author / reviewer 协议配套精简要点

**author-protocol.md**（保留"工作流 1–7 + 边界"结构，内容精简）：
- 删掉与 Leader 任务书重复的分篇阈值说明，保留"一个任务一篇、读完就提交、截断风险下优先提交可审查的完整本篇"。
- 新增一句："正文里的相对 `.md` 链接由应用在写入时校验；目标唯一可确定时会自动修正，并在工具结果的 `linkRepairs` 中告知。无法确定的链接会作为警告披露，不阻断提交。"
- 覆盖：把"不要把仍有知识内容的覆盖项批量改成 excluded_nonknowledge"并入一句"覆盖去向如实填写；工具返回的 warnings 是提示，结构错误才会被拒"。
- 保留：`kb_edit_doc` 优先、`retryOf` 重试、`raw_csv_find`、全称断言的 selector 完整范围、`csvTableImports`、`build_handoff_submit` 交接、最终回复只给交接编号。
- 删除对 `kb_unit_done/kb_finish` 的反复提醒（只留一句"不属于本角色"）。

**reviewer-protocol.md**：
- 审查重心写明："你审的是正文与来源是否一致（事实、数值、条件、遗漏、冲突、术语、原意）。证据 selector 的可解析性和覆盖结构由应用机械校验。"
- 新增一句："只改证据坐标或覆盖去向的修订不会让你的通过回执失效；改了正文或断言结构才需要复审。以 `pendingIndependentReviewPaths` 为准。"
- `kb_review_coverage_blocked` 一段改为模式中性的写法："若工具拒绝 pass 并给出覆盖原因，改交 needs_revision 并写明覆盖项。"
- 保留：全称断言核对、图片/CSV 证据核对方法、`declarationClaimKey` 筛选读取、只记差异、作者不能关闭问题。

**SKILL.md**：核心规则 1 删去"不设固定全量阅读阶段"之外的重复描述。"修订与收敛"一节改为"修订只携带阻断问题；警告只作披露"。

**`kb-build-service.ts:buildLeaderInput` 恢复提示**（1393-1397 及并行线新增的一行）：合并为 3 句，指向 `build_checkpoint(status)`、`documentWorkStatus.pendingIndependentReviewPaths / stageBlockedPaths`、`blockingGroups`，去掉与 flow 重复的长句。

---

## 4. legacy orchestrated / 单进程路径

- 事实（核实）：`resolveOrchestrationMode` 仍接受 `'legacy' | 'claude-native'`（types/agent-knowledge.ts:93-97）；`frozenRoleMismatches` 的 claude-code 基座分支只服务 legacy；历史检查点可能带 `orchestration` 字段。DB 里 37 次构建都是 pi-amagi（P1 §1.4/§7），legacy 路径没有运行证据，但仍可配置到达。
- 建议：**只保兼容，不扩展，不删除**。
  - 最小改动：legacy 与 pi-amagi 共用 `validateStaging` 和 `prepareKnowledgePublish`，策略表会自动作用于它们，不需要为 legacy 单独写代码。G3（kb_unit_done/kb_finish）、G10（三轴状态机/修订预算）、G2#9 路径认领保持原样。
  - 不删除的理由：①删除会影响 `build-orchestration.test.ts`、`kb-build-parallel.test.ts`、`kb-pack-batches.test.ts`、`kb-build-units.test.ts` 等测试，以及 claude-native 用户的配置入口，扩大风险面；②本任务的收益（减少阻断往返）不依赖删除；③可逆性：删除是单向门，保留是双向门。
  - 后续候选（不在本轮）：先观察一个发版周期内 legacy/claude-native 的真实使用；没有使用时，另开任务评估删除，同时迁移对应测试。

---

## 5. 实施切片、顺序与测试

### 5.1 切片

| 切片 | 内容 | 主要文件 | 依赖 | 风险 |
|---|---|---|---|---|
| **S0 地基** | `gate-policy.ts` + `StandardKbConfig.strictGates` + ConfigManager 归一/校验 + `BuildRunState.gatePolicy` 冻结与检查点持久化 + `BuildRunSpec.strictGates` + `FrozenDispatchConfig.strictGates`；`ValidationIssue/KbBuildReportIssue` 加 `rule/docPath/demotedFrom` | types/agent-knowledge.ts、kb/knowledge-schema.ts（类型）、kb/gate-policy.ts、modules/config-manager.ts、kb/kb-build-service.ts（创建/恢复）、kb/build-checkpoint.ts、kb/build-runtime-host.ts、agent/build-runtime/adapter.ts、dispatch-guard.ts（类型） | 并行修复线（severity）先落地 | 低 |
| **S1 发布期策略** | 生产者打 rule 标签（schema 覆盖/迁移段、validator 链接/人审、预算、compiler total）；三个收口点套表；§1.2 作用域降级；人审汇总日志；§2.4 阶段失败记忆 + `stageBlockedPaths` | kb/knowledge-schema.ts、kb/knowledge-validator.ts、kb/knowledge-compiler.ts、kb/kb-build-service.ts（prepareKnowledgePublish / validateStaging / publishProgressiveIfReady / executeLeaderPublishRequestInner）、agent/agent-tool-service.ts（buildDocumentWorkStatus） | S0 | 中 |
| **S2 证据指纹** | `checkEvidence` fingerprint 分支；**先完成证据写入路径审计**（§2.1 G7#44 落点） | kb/knowledge-validator.ts、kb/kb-build-service.ts | S0；与 S1 同文件，建议由同一执行者串行完成 | 中 |
| **S3 审查主体** | §2.3 第 1–6 条 | kb/review-authority.ts、kb/build-actors.ts、agent/agent-tool-service.ts（toolKbSubmitReview / v2RecordReceipt / 凭据重挂）、kb/kb-build-service.ts（repairWorkflowReviewCredentials / publishProgressiveIfReady 的 passReports 判定） | S0 | **高**（改动审查权威语义，建议集成后由 diting 独立复核一次） |
| **S4 写时化** | 链接自动修正（writeDocCore/kb_edit_doc，在 payloadHash 之前）；覆盖启发式 409→warnings；审查 pass 遇 important+unresolved 在标准模式下改为 warnings | agent/agent-tool-service.ts、新增 kb/link-repair.ts（纯函数） | S0 | 中 |
| **S5 派发与声明** | dispatch guard 标准模式改为建议；`build_request_publish.skipped` | agent/build-runtime/dispatch-guard.ts、agent/tool-specs.ts、agent/agent-tool-service.ts（toolBuildRequestPublish）、kb/kb-build-service.ts（executeLeaderPublishRequestInner） | S0 | 低。注意 dispatch-guard 打包进扩展（`build-agent-assets.mjs`），要重新 build 才会生效 |
| **S6 提示词** | leader/author/reviewer/SKILL 改写；buildLeaderInput 恢复提示精简；可选的 idle 提示加计数 | agent/skills/knowledge-build/*.md、kb/kb-build-service.ts、kb/build-leader-supervisor.ts | S1（stageBlockedPaths）、S5（skipped）的字段名定稿后 | 低（改动 workflowRevision，新构建生效；旧构建在 S3 标准模式下不撤销回执） |

**并行建议**：S0 先做；之后分三条线——线 A：S1→S2（同文件 kb-build-service/knowledge-validator）；线 B：S3；线 C：S4→S5。线 B 和线 C 都改 `agent-tool-service.ts`，但函数不重叠（B：toolKbSubmitReview/v2RecordReceipt；C：writeDocCore/buildKnowledgeDeclaration/kb_edit_doc/toolBuildRequestPublish）。可以由同一执行者串行完成，也可以在合并时按函数解决冲突，不需要 worktree。S6 最后做。

### 5.2 测试清单（随行为改，不靠删测试过关）

规则：纯函数（`validateKnowledgeGraph`、`runKnowledgeGates`、`checkEvidence`、`guardTaskSubmit`、`collectAuthorityValidatedReports`）缺省行为**保持严格**，现有断言不动；服务层测试凡是在断言"阻断"的，在测试 config 中显式写 `strictGates: true` 保住原意，并**新增**一条标准模式对照用例断言 warning 或放行。

| 测试文件 | 改动 |
|---|---|
| **新增** `tests/gate-policy.test.ts` | 表内每条规则 × 两种模式；未登记规则 = block；作用域降级的可归因与不可归因各一例 |
| **新增** `tests/link-repair.test.ts` | 唯一同名修正 / 多个候选不修 / 锚点保留 / 代码围栏内不处理 / 非 .md 与绝对链接不处理 |
| `knowledge-publish.test.ts` | 链接（4 处）与人审（2 处）的服务级断言改为显式 strict；新增标准模式：链接→warning 并发布成功、人审→无逐条 issue 加一行汇总日志、预算超出→warning（显式配置时仍阻断）、作用域降级 |
| `knowledge-schema.test.ts` | 不改断言；新增对 `rule` 标签的断言（coverage_important_unresolved / coverage_target_missing / migration_unexplained_loss） |
| `knowledge-governance.test.ts` | 治理激活时保持 blocking（不改）；治理未激活的 warning 断言区分 strict（warning）与 standard（drop） |
| `evidence-budget.test.ts` | 不改（纯额度计算）；`evidence-resources.test.ts` 的超预算用例改 strict 并补一条 standard 对照 |
| **新增/扩展** 证据指纹用例（放入 `knowledge-publish.test.ts` 或新建 `evidence-fingerprint.test.ts`） | 跨构建 readReceiptId + 哈希一致 → 标准模式通过、严格模式阻断；源字节变化 → 两种模式都阻断 |
| `build-runtime-review-authority.test.ts` | 现有 F08 用例改 strict；新增：只改 evidence/coverage 时回执仍有效、改正文非空白字符时失效、旧回执（无 subject 键）走精确规则、workflow revision 变化在标准模式不失效 |
| `build-actors.test.ts` | `invalidateReviewsForPaths` 在主体不变时不标 stale；`workflow_rules_changed` 用例改 strict |
| `build-runtime-tools.test.ts` | `kb_review_coverage_blocked`（1 处）与 `kb_migration_invalid`（5 处）按模式拆分；新增 `stageBlockedPaths` 暴露、`build_request_publish.skipped` 合并进 finishInfo、跨工作集 objToken 被拒 |
| `kb-knowledge-tools.test.ts` | 覆盖启发式：strict 409 / standard 接受并给 warnings；链接修复写入 `details.linkRepairs`，且 payloadHash 按修复后正文计算 |
| `build-runtime-dispatch-guard.test.ts` | 现有 `dispatch_*_scope_too_broad` 用例使用缺省（缺省=严格）保持；新增 `strictGates:false`：放行 + `audit.changes` 含 advisory |
| `kb-build-size.test.ts` / `kb-build.test.ts` / `kb-build-parallel.test.ts` / `kb-build-resume.test.ts` / `kb-version.test.ts` | `total_too_large`、`body_contains_*` 的阻断断言改 strict 并加 standard 对照；`source_not_covered` 保持（两种模式都阻断） |
| `progressive-knowledge-draft.test.ts` / `baseline-resource-carry.test.ts` | 新增：同一失败输入第二次不重跑（可用编译调用计数或 emitLog 次数观测）；key 变化后重试；作用域降级不让承接面问题阻断新篇 |
| `kb-build-resume.test.ts` | 旧检查点无 `gatePolicy` → 严格；新检查点冻结值优先于当前配置 |
| `config-manager.test.ts` | `strictGates` 归一/校验 |
| `knowledge-skill-examples.test.ts` | S6 后须仍然通过（协议文件中的示例都满足 schema；Leader 直连示例段不动） |

### 5.3 验证命令（cwd = `server/`）

```bash
cd server && npx tsc --noEmit
npx vitest run tests/gate-policy.test.ts tests/link-repair.test.ts tests/knowledge-publish.test.ts \
  tests/knowledge-schema.test.ts tests/knowledge-governance.test.ts tests/evidence-resources.test.ts \
  tests/build-runtime-review-authority.test.ts tests/build-actors.test.ts tests/build-runtime-tools.test.ts \
  tests/kb-knowledge-tools.test.ts tests/build-runtime-dispatch-guard.test.ts tests/kb-build-size.test.ts \
  tests/kb-build.test.ts tests/kb-build-parallel.test.ts tests/kb-build-resume.test.ts tests/kb-version.test.ts \
  tests/progressive-knowledge-draft.test.ts tests/baseline-resource-carry.test.ts tests/config-manager.test.ts \
  tests/knowledge-skill-examples.test.ts tests/build-runtime-e2e.test.ts tests/build-runtime-integration.test.ts
npm run build          # S5/S6：dispatch-guard 进扩展包，协议进 dist/agent/skills
npm test               # 跨切片集成后做一次全量（改动横跨审查权威与发布门禁，属高风险阶段）
```

ABI 提示（CLAUDE.md）：如果刚跑过桌面构建，先执行 `cd server && npm rebuild better-sqlite3`。

### 5.4 总验收（可观察）

1. 两种模式在现有测试上都通过：strict 断言全部保留，standard 对照用例新增。
2. 真实增量构建（主上环境，用临时 `FEISHU_SYNC_HOME` 拷贝一份真实库，或在主上授权下用真库）按 `events.jsonl` 计数，预期：
   - `阶段发布暂缓` 对同一 (path, hash) ≤1 次；
   - 发布阻断中 `kb_link_invalid / kb_review_human_missing / 预算 / readReceiptId 跨构建` 四类为 0；
   - report.json 中 `kb_review_human_missing` 为 0 条，日志 1 行；
   - 只改证据的修订后不出现"缺少当前版本的独立通过复审"。
   - 这些是可证伪预测。若仍出现，说明对应生产者没打 rule 标签，或收口点漏掉了。
3. `strictGates: true` 跑同一构建，阻断行为与改动前一致（回归对照）。

---

## 6. 风险、回滚与未知项

### 6.1 降级点的可恢复性

| 降级点 | `strictGates=true` 能否恢复 | 说明 |
|---|---|---|
| §2.5 表中所有 warn/drop | 能 | 表被跳过 |
| 作用域降级（§1.2） | 能 | 同上 |
| 证据指纹（G7#44） | 能 | strict 时传 `'full'` |
| 审查主体绑定（G6） | 能（新回执同时写了旧键） | strict 时走精确比对；旧回执不受影响 |
| 派发守卫建议化 | 能 | `FrozenDispatchConfig.strictGates` |
| 写时链接修正 | 能（strict 时不修正，只做发布期检查） | 已修正的历史正文不会回退，但修正只针对唯一同名目标，正确性可验证 |
| 覆盖启发式 409→warning | 能 | strict 时仍 409 |
| 阶段失败记忆 | 不随开关变化（两种模式都启用） | 纯效率改动，不改变判定；回滚只能 revert 代码 |
| `build_request_publish.skipped` | 不随开关变化 | additive 参数；不用就等于现状 |
| 提示词改写（S6） | 不随开关变化 | revert md 文件；workflowRevision 变化只影响新构建 |

**单一开关的结论**：采用一个 `standardKb.strictGates`（默认 false），不拆成多个开关。理由：①降级点有 12 类，多个开关会让组合空间无法测试；②所有降级都属于同一种语义（"质量交给模型"对"宿主强制"），用户的选择本来就是二元的；③每构建冻结，所以能精确复现某次构建的门禁语义。只有一个例外：显式 `evidenceBudgetBytes` 本来就是独立的用户意图，继续按"显式即阻断"处理，不额外开新开关。

### 6.2 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| R1 某条证据写入路径绕过了写时 verifyEvidence，指纹检查会漏掉 | 伪造或错误证据进 release | S2 前置审计；对审计出的路径回退 full；严格模式可对照 |
| R2 审查主体摘要漏了语义字段（例如对象 scopeText 变化不触发复审） | 审查过的语义被改却不复审 | §2.3 只排除已证明是机械校验的字段；字段清单经 diting 复核；单测覆盖"改断言结构必然失效" |
| R3 链接自动修正改错目标 | 正文链接指向错误文档 | 只修"knownPaths 中唯一同名"的情况；结果在工具返回里可见，审查者能看到；有多个候选就不修 |
| R4 作用域降级放过了本轮实际引入的问题 | 承接面结构损坏 | 只对 `scopeDemotable` 规则生效（覆盖目标缺失、restatement_stale）；全局结构码不降级 |
| R5 进程池并不限制 amagi 子任务，去掉"≤4/轮"后出现突发 | 资源占用、模型 429 | 见 U1；必要时在 dispatch guard 增加"活跃子任务数 ≥ 池容量即排队提示"，作为宿主侧限流（不用提示词约束） |
| R6 并行修复线未合入就开始 S1 | 冲突或回退他人改动 | §0 前置条件；只在其改动之上继续 |

### 6.3 回滚

- 配置级：`config.json` 中 `standardKb.strictGates: true`，新构建立即回到全部历史阻断（进行中的构建保持冻结值）。
- 代码级：每个切片一个提交，按 S6→S1 逆序 `git revert`。S0 的配置字段和检查点字段都是 additive，回退后旧代码会忽略未知字段。新回执里多出的 `subject:` 键被旧代码忽略（旧代码只看 `doc:*` 和三个聚合键）。

### 6.4 未知项

| 编号 | 未知 | 影响 | 判别办法 |
|---|---|---|---|
| U1 | amagi 子任务是否经应用进程池 `acquire('background')` 准入 | 决定能否只靠宿主限流、删掉提示词里的 ≤4/轮 | 读 `agent-process-pool.ts` 的调用方与 amagi 派生链路；或在测试构建中观察并发子进程数 |
| U2 | `kb_edit_doc` 的 `evidenceSelectorUpdates/evidenceClaimsAdd` 是否都走 `verifyEvidence` | R1 | S2 前置审计 |
| U3 | 凭据重挂（§2.3-5）与 `markObjectsReviewedForAuthorityReceipt` 的锁和幂等是否可以直接复用 | S3 实现复杂度 | 读 3781 起的实现 |
| U4 | 45 次 `kb_coverage_invalid` 工具错误的子类分布 | G2#15 降级的实际收益 | 在 `.builds/*/events.jsonl` 中按 message 归类 |
| U5 | "免写只审 + 证据自动 rebase"（G4#25 后续候选）的收益 | 增量构建中"源变了但本篇引用段没变"的写作任务能否省掉 | 统计 requiredRewrites 中修订只有 selector 平移的比例；不在本轮实施 |
| U6 | A 案、B 案、v2 的设计原文缺失（P1 §7） | 部分门禁的原始动机只能从代码头注还原 | 主上若能提供原文，可复核 §2 中的"保留"项 |

---

## 7. 自检

- 必读输入：P1 全文已读；CLAUDE.md 工作台两节在上下文里；代码按 §2 落点逐一回读（kb-build-service 中的 prepareKnowledgePublish / validateStagingDocs / publishProgressiveIfReady / executeLeaderPublishRequestInner / 恢复段；knowledge-validator；knowledge-schema 迁移与覆盖段；review-authority 全文；orchestration-contracts canPublish；dispatch-guard 写作/审查范围段；build-leader-supervisor evaluateIdle；agent-tool-service 证据、覆盖、审查、发布、工作状态段；build-actors 失效段；evidence-budget；knowledge-compiler 体量段；四份协议 md）。
- 写面：只写了本 artifact，没有改代码。工作区里并行线和其他会话的改动只读，没有动过。
- 结论边界：频次和收益预测引自 P1 运行证据；§5.4 的预测需要在真实构建中验证，本轮没有运行任何构建或测试。
