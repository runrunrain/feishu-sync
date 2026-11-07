# WP-B1 报告：阻断问题关闭语义修复（selector-only / 声明-only 修订无法关闭 blocking issue）

任务：kb-build-speedup R3.2 ｜ 构建：feishu-sync（server/ ESM TS + vitest）｜ 日期：2026-11-06

## 1. 事故复盘（真实构建 b_20261105233621_7161f7，证据为只读取证）

时间线（证据：`~/.feishu-sync/standard-kb/.staging/b_20261105233621_7161f7/build-actors/{reviews,publish-requests,issue-lists}.json`）：

| 时刻 (UTC) | 事件 |
|---|---|
| 01:30 | diting 回执 `krev_795028d4c770b4de`（needs_revision）报告 kr_5c8c917e1beff841，blocking 问题 `kri_1_0dcb7c87`（selector columns=[@C,@D,@G] 应为 [@C,@D,@F]） |
| ~01:5x | 作者 draftRevision=2 用 `kb_edit_doc.evidenceSelectorUpdates` 修复（正文不变，仅声明变化） |
| 02:01 | 复核回执 `krev_8eaa94bf0e1d12d1`（pass，报告 kr_139cae2837847b8a，0 问题） |
| 02:21/02:27/02:32 | `build_request_publish` 连续 3 次被拒：`kb_publish_blocked / blocking_issue_open`（pub_14f79c3d5559 / pub_16676ec0fd56 / pub_12dbfafa25e5，均指向 kr_5c8c917e1beff841/kri_1_0dcb7c87） |
| 02:24 | Leader 重登记同一问题（试图触发关闭）；02:26/02:32 两次微复核 pass 均无效 |
| 02:43 | 作者制造一处「忠实性修正」改正文 → 旧回执主体摘要失效 |
| 02:44 | 发布通过（pub_b20649be35ec accepted） |

单点空转 02:07→02:44 ≈ 37 分钟。

### 根因（代码行引用，修复前）

1. **回执保留与问题关闭错位**：标准门禁（`strictGates` 默认非 true → `gatePolicy.strict=false`）下 `kb_edit_doc` 的 F01 主体保留（`agent-tool-service.ts` `v2RecordReceipt` → `invalidateReviewsForPaths(..., retain=receiptSubjectMatches)`，原 2845-2857 行附近）按**主体摘要**判定，而主体摘要**不含证据 selector/覆盖/docs 元数据**（`review-authority.ts` `reviewSubjectDigest`）→ selector-only 修订后旧 needs_revision 回执仍 `status='valid'`。
2. **发布侧同一口径放行旧报告**：`collectAuthorityValidatedReports`（`review-authority.ts`）对带 subject 键的回执只核 source-snapshot + subject → 旧报告 kr_5c8c 一直在 `validReportIds`。
3. **closureBasis 无人写入**：v2 流程 `kb_submit_review` 「revisionResponse/closureBasis 提交时一律不读不存」（`agent-tool-service.ts` 原 4196 行注释），而 `canPublish`（`orchestration-contracts.ts` 436-441 行）对有效报告内 `closureBasis` 为空的 blocking 问题一律 `blocking_issue_open`。
4. **问题清单层同病**：`BuildActorStore.openBlockingIssues()`（`build-actors.ts` 原 899-902 行）只数最新 kil 清单里的 blocking 条目，不看任何复核证据 → Leader 重登记后继续拦截（`build_blocking_issues` 前置门，`agent-tool-service.ts` 原 4971 行）。

净效果：问题关闭实际绑定**正文主体摘要（≈contentHash）**，声明-only 修订不构成候选推进；唯一出路是改正文使旧回执失效——与诊断结论一致。

## 2. 修复设计

原则：关闭依据 = **针对当前候选的独立审查复核结果**（作者自述不关闭、不降级、不绕过独立审查）。「当前候选」口径扩展为**正文哈希 + 该文档声明哈希（对象/证据 selector/覆盖）**——任何改变声明集合的修订都是候选推进；推进后必须有**精确绑定新候选（doc:<path> 与 knowledge-declaration 同范围哈希都匹配当前 staging）的 pass 复核回执**覆盖问题路径才关闭；候选再变化即失去关闭效力（每次发布重新判定，不持久化关闭状态）。

改动 1 — `server/src/kb/review-authority.ts`（kri 层，发布门禁）：
- 新增 `collectCurrentCandidatePassPaths()`：计算「精确绑定当前候选的 valid pass 回执」覆盖的路径集合（校验：回执 valid+pass、报告文件双向绑定 reportId/draftHash/conclusion、scoped 声明哈希匹配当前 `knowledge-draft.json`、`doc:<path>` 匹配当前 staging 正文；报告被覆盖/删除不构成证据）。
- 新增 `blockingIssueTargetPath()`：报告 blocking 问题 → 归属路径（draftLocation 唯一提及优先；单路径回执直接归属；无法唯一归属 fail-closed 不关闭）。
- 新增 `receiptDeclarationMatchesCurrentDraft()`：回执声明依赖是否仍匹配当前同范围声明（document-v2 当前形态；无范围标记的旧回执兼容旧/新两种哈希形态）。
- `collectAuthorityValidatedReports()` 增加取代判定：**标准模式主体绑定**回执若含未关闭 blocking 问题、其声明依赖已漂移（问题指向旧候选）、且每个问题路径都被当前候选 pass 复核覆盖 → 该报告不再入选 `validReportIds`（skipped 记 `blocking_issues_closed_by_current_pass`，进发布日志）。`canPublish` 无需改动即不再报 `blocking_issue_open`。声明未漂移（问题就在当前候选上，含同候选 pass/blocking 分歧）、无 pass 证据、路径无法归属 → 照旧入选拦截。严格模式/无 subject 键旧回执路径行为不变。

改动 2 — `server/src/kb/build-actors.ts`（kil 层，`build_request_publish` 前置门与 checkpoint 状态）：
- `openBlockingIssues()`：最新问题清单中 targetPath 被 `collectCurrentCandidatePassPaths` 覆盖的 blocking 问题按已关闭计 → Leader 在作者修订后**重登记同 issueKey**（事故 02:24 路径）时立即按新规则关闭，不再等「下一份回执」；候选再变化（pass 回执失去当前绑定）自动重新计入。staging 不可读/无 pass 证据时按原语义计数（fail-closed）。

保持不变：F01 主体保留（selector-only 修订仍不要求全文重审，pass 回执继续有效用于覆盖判定）；`missingScopedPassReviewPaths` 覆盖门（writtenPaths 仍需当前版本独立 pass 复核）；严格模式精确规则；`legacyScopedDeclarationMatches` 旧检查点兼容绑定与 document-v2 依赖范围（incremental-build-performance 先前修订）未被触碰。

发布路径接线（未改这两个文件，行为经 `validReportIds` 自然传导）：`executeLeaderPublishRequestInner` / `assembleCandidateRelease` / `releaseConfirmInner`（kb-build-service.ts）与 `toolBuildRequestPublish` 前置门（agent-tool-service.ts）。

## 3. Changed files

| 文件 | 改动 |
|---|---|
| `server/src/kb/review-authority.ts` | 模块头 WP-B1 语义；新增 3 个纯函数（2 导出）；`collectAuthorityValidatedReports` 选取重构 + 取代判定 |
| `server/src/kb/build-actors.ts` | 仅 `openBlockingIssues()` 关闭感知 + 1 行函数导入（同文件的 R3.3 续接链改动为并行任务所写，未触碰） |
| `server/tests/review-blocking-issue-closure.test.ts` | 新增回归测试（15 用例） |

## 4. 测试

命令（cwd=server）与结果：

- `npx vitest run tests/review-blocking-issue-closure.test.ts` → **15/15 通过**
  - 事故主链：selector-only 修订 + 针对新候选的 pass 复核 → `canPublish` 不再 `blocking_issue_open`、`validReportIds` 只剩 pass 报告、skipped 含 `blocking_issues_closed_by_current_pass`、`openBlockingIssues()=0`（无需重登记；重登记同 issueKey 仍 0）。
  - 对照组：无复核（作者自述）→ 仍拦截；复核 needs_revision → 两报告均入选仍拦截；pass 后候选再变（第二次 selector-only 修订）→ 关闭失效重新拦截；同候选 pass/blocking 分歧 → blocking 仍拦截。
  - 纯函数：关闭证据的声明漂移/报告删除/非 pass/回执 stale 四种不成立情形；路径归属 fail-closed。
- 相关既有测试：`review-subject-standard`(10) `review-declaration-scope`(8) `build-actors`(21/22，见下) `build-runtime-review-authority` `build-runtime-tools` `build-runtime-authority-impact` `build-runtime-publish-cancel` `knowledge-publish` `kb-publication{,-fixA,-fixC}` `knowledge-schema` `knowledge-skill-examples` `progressive-knowledge-draft` `knowledge-validator` `mechanical-precheck` → 除下述并行任务项外全部通过。
- `npx eslint src/kb/review-authority.ts src/kb/build-actors.ts tests/review-blocking-issue-closure.test.ts` → 0 问题。

## 5. 并行任务干扰说明（非本任务回归）

- `server/src/kb/build-actors.ts:490` tsc 错误与 `build-actors.test.ts` 的「R3.3 实测场景…同链转交继承」失败：均为并行 luban（R3.3/WP-B3，kb_output 分配续接链）在同一文件/测试的**未提交中间态**（git diff 归因：该 hunk 注释标 R3.3，含 `ancestryOf` 闭包类型缺陷与未完成语义）；本任务未触碰该 hunk。
- 终态 tsc 恰 3 错，逐条归因（均与本任务符号无关，本任务 hunks 0 错）：`agent-tool-service.ts(4697)` 与 `kb-build-service.ts(1951)` 的 `PublishReadinessPreview` 赋值错误（并行任务的「publish 预览」写面）；`build-actors.ts(490)`（上述 R3.3 hunk）。基线所述 portable-kb-service 3 错误在当前工作树已不存在（兄弟修复）。

## 6. 回滚说明

改动集中在 2 个源文件（无数据迁移、无持久化 schema 变化、无接口签名变化）：
- `git checkout -- server/src/kb/review-authority.ts server/src/kb/build-actors.ts` 并删除 `server/tests/review-blocking-issue-closure.test.ts` 即完全回滚（注意与并行任务在同文件的 hunks 区分，勿整文件回滚他人改动；建议按 hunk 选择性 revert）。
- 无运行时状态需要清理：关闭判定每次实时计算，不写任何关闭状态。

## 7. 兼容性风险（旧检查点/旧回执）

- 无 schema/持久化变更；旧检查点恢复后行为由现存回执 + 当前 staging 实时推导。
- 无 subject 键的旧回执（严格路径/旧构建）：`subjectBound=false`，取代判定完全不触及，行为与修复前一致（声明漂移本来就会 dependency_stale）。
- 带 subject 键但无 declaration-scope 标记的旧回执：漂移判定兼容旧/新两种 scoped 哈希形态，语义等同「声明未实际变化则不取代」。
- 残留风险 1：多路径范围回执中 draftLocation 不含路径信息的问题 → fail-closed 不关闭（保持拦截，Leader 需按路径重述或单路径复核；行为与修复前一致，不会误放行）。
- 残留风险 2：发布确认（confirm 模式）等待期间候选再变 → 旧关闭失效、旧阻断报告重新入选，发布被 `确认时审查回执已失效` / `blocking_issue_open` 拦截——这是有意的 fail-closed。
- 不放宽项：独立审查（`assertReviewerIndependent`）、证据校验、`missingScopedPassReviewPaths` 当前版本 pass 覆盖、canPublish 其余条件、思考强度配置全部未动。

## 8. 复审修复（diting review.md R1/R2，2026-11-06 第二轮）

独立审查对首轮实现提出两个 Major（反例脚本见 review.md 附录），均已修复；原则不变：不削弱质量门，结构化证明不足时 fail-closed。

### R1：pass 复核必须「覆盖」问题范围，声明精确绑定≠复核范围

- 反例：声明漂移后，新 pass 回执 checkedDimensions=['排版']、uncheckedScope=['a.md 的证据列位未检查']——独立者明确未核该问题，却能关闭它。
- 修复（review-authority.ts）：`collectCurrentCandidatePassPaths` 重构为逐问题判定的 `passReviewClosureForIssues(issues)`；新增 `passReportExcludesIssue`：pass 报告的 uncheckedScope 提及问题 targetPath 或其 draftLocation、或为无法归属到其它已知审阅路径的泛化排除（未提及任何已知路径）→ 该回执不能关闭此问题；checkedDimensions 为空（什么都没核）同样不构成关闭证据。仅当 uncheckedScope 条目明确归属到审阅范围内**其它**路径且不涉及本问题时才视为可判定的不涉及。
- kri 层（collectAuthorityValidatedReports 取代判定）改为逐问题闭合并用同一证据函数；事故主链（uncheckedScope 为空的完整 pass 复核）不受影响。

### R2：问题清单不得把已有 pass 当永久豁免；只有「起源于前一候选」的 blocking 才可被 pass 关闭

- 反例：a.md 已有当前候选完整 pass，Leader 随后新登记同路径 blocking（新 issueKey）→ openBlockingIssues() 返回 0，前置门吞掉新问题。
- 修复：
  - `IssueListRecord.issues[]` 新增 additive 字段 `originBinding`（首次登记该 issueKey 时 targetPath 的正文哈希 + 该文档范围声明哈希；仅标准门禁由 build_issues_submit 记录，严格模式不记录）；
  - `recordIssueList` 重登记同 issueKey 时**继承首次**登记的 originBinding（不刷新起源）；
  - `openBlockingIssues()` 只对「originBinding 可证明已漂移，或旧清单 fromReviewId 指向回执的路径依赖可证明已漂移」的 blocking 尝试 pass 关闭，关闭证据同 R1 口径；无起始候选证据（旧清单无字段且 fromReviewId 不可判定）fail-closed 保持开放；
  - 严格模式清单不记录 originBinding → 结构上保持既有计数策略（全部计入）；
  - 事故「重登记以触发关闭」路径：重登记继承首次（漂移前）起始候选 + 当前 pass 覆盖 → 仍立即关闭（新增直连 store 测试覆盖）。

### 复审轮 changed files（增量）

| 文件 | 增量改动 |
|---|---|
| `server/src/kb/review-authority.ts` | `passReviewClosureForIssues`（逐问题关闭证据 + R1 范围排除）、`currentPathCandidateBinding`、`reviewReceiptPathOriginDrifted`；取代判定逐问题化 |
| `server/src/kb/build-actors.ts` | `originBinding` 字段 + 继承；`openBlockingIssues` 起始候选漂移门 |
| `server/src/agent/agent-tool-service.ts` | 仅 toolBuildIssuesSubmit：标准门禁登记时计算 originBinding（严格模式不记录）+ 1 行导入 |
| `server/tests/review-blocking-issue-closure.test.ts` | 新增 R1 反例（uncheckedScope 提及/泛化/空维度 → 不关闭；其它路径可判定 → 仍关闭）、R2 反例（同候选新 blocking 计数=1；严格模式保持计数；起始漂移+重登记继承 → 关闭） |

### 复审轮验证

- `npx vitest run tests/review-blocking-issue-closure.test.ts` → **25/25**（含原事故主链全部保留通过）；
- `npx vitest run tests/review-subject-standard.test.ts tests/review-declaration-scope.test.ts tests/build-actors.test.ts tests/build-runtime-review-authority.test.ts tests/build-runtime-tools.test.ts tests/build-runtime-authority-impact.test.ts tests/build-runtime-publish-cancel.test.ts tests/build-runtime-contracts.test.ts` → **167/167**；
- `npx tsc --noEmit` → **0 错误**（含并行任务已收敛的当前工作树）；`npx eslint`（改动文件）→ 0 问题。

### 复审轮兼容性增量

- `originBinding` 为 additive 可选字段：旧检查点/旧清单缺省 → fail-closed 不关闭（同既有计数语义）；检查点 JSON 往返自动携带；无迁移。
- 直接调 `recordIssueList` 的旧调用方（测试/旧路径）不携带 originBinding → 不关闭，行为与首轮修复前一致。
- 回滚：同 §6，按 hunk 选择性 revert 本节所列增量即可。

## 9. 二轮复审修复（diting review-2.md R1-A/R2-A，2026-11-06 第三轮）

### R1-A：混合句/否定限定的 uncheckedScope 被「提及其它路径」误判为不涉及

- 反例：pass 的 uncheckedScope=['除 b.md 外，全部文档的证据列位均未检查']——`mentionsOther`（提及 b.md）被当作「仅排除其它路径」，a.md 的问题被错误关闭。
- 修复（review-authority.ts `passReportExcludesIssue`）：排除判定改为保守 fail-closed——仅当条目**不含任何泛化/全称/否定限定词**（中文：全部/所有/其余/均/整体/证据/列位；英文词边界：all/others/except/every/entire/evidence/columns；否定限定正则：除…（以外/之外/外））**且明确归属到其它已知路径**时才视为可证明的不涉及；关键词在**剔除已知路径名后的剩余文本**上判定（other.md 之类的路径名不触发英文关键词）。混合句、否定限定句一律视为涉及本问题。

### R2-A：严格模式 fromReviewId 兼容分支仍可自动关闭清单 blocking

- 反例：严格模式下清单带 fromReviewId（指向真实 needs_revision 报告）+ selector-only 修订 + 完整新 pass → `openBlockingIssues()` 归零，违反「严格保持既有计数」。
- 修复：
  - `IssueListRecord` 新增 additive 字段 `gatePolicy: 'standard' | 'strict'`，由 `build_issues_submit` 按登记时 `state.gatePolicy` 显式写入；
  - `openBlockingIssues()` 显式检查策略标记：**仅 'standard' 清单允许 pass 自动关闭**；'strict' 清单一律保持既有计数（含 fromReviewId 回退）；无标记的旧清单/直连登记同样 fail-closed 不关闭；
  - fromReviewId 漂移回退仅在 standard 标记清单内可达（originBinding 缺失时的兼容路径）。

### 二轮 changed files（增量）

| 文件 | 增量改动 |
|---|---|
| `server/src/kb/review-authority.ts` | `GENERIC_EXCLUSION_TEXT`/`NEGATION_SCOPED_TEXT` 保守关键词 + 剩余文本判定 |
| `server/src/kb/build-actors.ts` | `IssueListRecord.gatePolicy` 标记；`openBlockingIssues` 策略门 |
| `server/src/agent/agent-tool-service.ts` | 仅 toolBuildIssuesSubmit：登记时写入 gatePolicy 标记 |
| `server/tests/review-blocking-issue-closure.test.ts` | R1-A 混合句/否定限定句（提及其它路径仍不关闭）；R2-A 严格+fromReviewId 反例（计数=1）、标准模式 fromReviewId 回退对照（关闭）、严格标记/无标记直连用例 |

### 二轮验证

- `npx vitest run tests/review-blocking-issue-closure.test.ts` → **30/30**（事故主链与首轮反例全部保留通过）；
- `npx vitest run tests/review-subject-standard.test.ts tests/review-declaration-scope.test.ts tests/build-actors.test.ts tests/build-runtime-{review-authority,tools,authority-impact,publish-cancel,contracts}.test.ts` → **167/167**；
- `npx tsc --noEmit` → 0 错误；`npx eslint`（改动文件）→ 0 问题。

### 二轮兼容性增量

- `gatePolicy` 为 additive 可选清单级字段：旧清单缺省 → fail-closed 不关闭（比首轮更保守，同时满足首轮「旧清单取 fail-closed」的裁定）；检查点 JSON 往返自动携带；无迁移。
- 回滚：按 hunk 选择性 revert 本节增量。

### 终轮修订（review-3.md R1-B：放弃关键词/路径名启发式，改为完全 fail-closed 的结构口径）

- 反例：`Nothing but b.md was checked` / `Everything besides b.md was not checked`——自然语言同义表达总能绕过有限关键词枚举，`mentionsOther`（提及其它路径）被误当作「仅排除其它路径」。
- 修复（review-authority.ts）：删除 `GENERIC_EXCLUSION_TEXT`/`NEGATION_SCOPED_TEXT` 关键词常量、路径名剔除与 mentionsOther 分支；`passReportExcludesIssue` 简化为纯结构判定——**uncheckedScope 去除空白与零宽字符（含 NBSP/BOM/U+200B-200D/U+2060）后只要仍有任一非空条目，就一律视为可能涉及本问题，不构成关闭证据；只有 uncheckedScope 为空或全空白且 checkedDimensions 非空才可作为完整复核关闭**。判定提升到回执级（与具体问题无关），代码更精简。
- **口径变化的取舍**：不再尝试用自然语言分析证明「未核范围不涉及本问题」——代价是复核者若在 uncheckedScope 写了与该问题无关的泛述，也会使该问题无法被自动关闭，需要 Leader 另行派发一份 uncheckedScope 为空的完整复核才能关闭。这是有意的 fail-closed：未核范围的语义无法被结构化证明，任何启发式都会留下同义表达绕过面。已在 reviewer-protocol.md 定向复核条目同步一句话提示复核者：凡问题范围已复核，不要在 uncheckedScope 写无关泛述——非空会使该阻断问题无法被自动关闭。
- 协议文件：reviewer-protocol.md 仅在「定向复核范围」条目末尾追加一句（knowledge-skill-examples 冻结断言为 contains 语义，不受影响，实测通过）。

**终轮验证**：`review-blocking-issue-closure` **32/32**（新增 review-3 两条英文句、中英混合句、零宽字符句 → 不关闭；纯空白 → 可关闭；原「明确其它路径可判定不涉及→仍关闭」用例改为「非空一律不关闭」；事故主链完整保留）；`review-subject-standard`/`review-declaration-scope`/`build-actors`/`knowledge-skill-examples` 与 `build-runtime-{review-authority,tools,authority-impact,publish-cancel,contracts}` 全部通过（合计 206 项）；`npx tsc --noEmit` 0 错误；eslint 改动文件 0 问题。
