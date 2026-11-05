# P3 实施过程记录

> 以下保留各轮执行时的状态，旧段的「未实施/尚不可验收」不代表最终状态。F01 已在末尾续轮实现并通过独立复审；最终集成、验证及保留项见 [final-report.md](./final-report.md)。

## 输入与交付

- 上游设计：`/Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/kb-build-gate-simplify/p2-design.md`；门禁盘点：同目录 `p1-gate-inventory.md`；项目约束：worktree `CLAUDE.md`。
- 工作树：`/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/kb-gate-simplify`，分支 `amagi/kb-gate-simplify`。
- 主树并行修复线已同步并提交 `aa69abd4807c6b03e984cf6aaa0c7dcf58b88230`（5 文件、+182/-6）。同步后未再提交；补丁基线是该提交，**不包含同步提交本身**。
- 本轮补丁：`/tmp/kb-gate-simplify.patch`（`git diff aa69abd4807c6b03e984cf6aaa0c7dcf58b88230`，33 文件）；新增文件以 intent-to-add 纳入，无实际内容暂存。`git diff --check` 退出 0。
- 续轮手工合入主树 `agent-tool-service.ts` 的 `previousDocBody` 回调和 `review-declaration-scope.test.ts` 的 `collectReviewReports` 断言；编译核实发现回调另依赖主树同一并行线的 `object-migration-reconciliation.ts` 接口和 `object-migration-reconciliation.test.ts` 的对应期望，也最小同步了这两处。上述四处均包含在 aa69abd 后的补丁中，但主树已有；合并前应剔除/识别已应用的并行线 hunks，避免重复。
- 五个同步文件已用 `git show` 只读复核：`agent-tool-service.ts`、`build-runtime/adapter.ts`、`build-runtime/process-residual.ts`、`kb/review-authority.ts`、`tests/review-declaration-scope.test.ts`；这些是声明作用域审查依赖等并行修复，本补丁不应把同步提交再次应用到已经拥有它们的主树。

## 切片与验收状态

| 切片 | 产物与实际结果 | 状态 |
|---|---|---|
| S0 | `standardKb.strictGates` 缺省 false；新构建冻结策略，检查点和运行时派发配置传递；缺失/无效旧检查点回退 strict。新增真实恢复测试：移除检查点 gatePolicy、当前配置切 standard，恢复仍严格阻断。 | 已实现并有针对性测试 |
| S1 | `validateStaging` 和 `prepareKnowledgePublish` 接策略；新增 `gate-attribution.ts`，增量且有明确改动面时对能证明 CURRENT 已有且涉及对象/来源均属未变承接面的结构验证问题降级；成功发布的 staging 和知识门禁 warnings 写 report。 | **部分**：覆盖目标已经缺失时缺少 target 的可证明路径，仍保守阻断；编译器生成的 stale 文本与 graph 不同，尚不能借旧 graph 问题匹配而降级；尚缺真实服务发布链的范围对照测试。阶段记忆仅缓存确定性错误子集，缺同输入不重跑/变更后重试的真实发布链测试。 |
| S2 | 写声明校验并落盘后，服务端在内存保存证据指纹；标准模式比对指纹、当前冻结源及资源 hash 后可复用；strict、未命中、旧恢复/基线承接均全量验证。 | 受限实现；不提供历史/跨构建凭据无条件快路径。存在服务端标记、声明篡改、源变化、strict 全量校验的测试；尚无真实构建全链性能对比。 |
| S3 | 续轮已获准实施，但本轮未完成，`review-authority.ts` / `build-actors.ts` 的回执失效语义仍为严格精确绑定。 | 未实施；见下文建议。 |
| S4 | 标准模式写入唯一同名相对 Markdown 链接时修复、保留锚点并在返回值披露；代码块/行内代码等不改；覆盖启发式与审查 pass 的重要 unresolved 改为警告，strict 保留阻断。 | 已接线并有单元/工具测试；未对全部失败边界提供成对服务级用例。 |
| S5 | 派发范围标准模式给 audit 建议；角色、模型、工作目录、能力围栏仍冻结；`build_request_publish.skipped` 校验工作集、理由和重复，写入 finishInfo。构建产物包含扩展。 | 已接线；需补完整 strict/standard 成对及恢复后 skipped 场景。 |
| S6 | 改写 Leader flow、精简恢复提示并更新 author/reviewer/SKILL。 | 已接线；原生 amagi 派发是否由应用进程池准入（U1）未核实，提示词保留建议分批，不声称自动排队。旧构建提示词 revision 仍可能失效，S3 延后时不可假设回执无效化已放宽。 |

## U2 证据写入路径审计与安全边界

1. `agent-tool-service.ts` 的 `buildKnowledgeDeclaration` 新增证据先解析冻结资源、`resolveSelector`、`verifyEvidence`，通过才生成 `evidenceIdMap`；`writeDocCore` 正文和声明落盘成功后仅按该 map 将对应证据内容 hash 记到 `BuildRunState.verifiedEvidence`。`kb_edit_doc` 的 selector updates / claims add 汇合进同一条声明链。失败时不会登记标记，测试覆盖。
2. `kb-build-service.ts` 的 `seedBaselineKnowledge` 整批复制 baseline evidence；text/CSV 只在核验成功时重绑，其他旧声明可能原样保留。因此不能把草稿内可见字段当成写时可信凭据；基线复制不生成标记。
3. `progressive-knowledge-draft.ts` 选择新篇 live 声明及旧篇 immutable baseline；`progressive-source-snapshot.ts` 对继承 text/CSV/image 生成阶段回执并进行复核，但它不是本轮写时凭据签发处，不授予快路径。阶段临时草稿可能修改 readReceiptId，指纹不同即全量。
4. `build-checkpoint.ts` 同代保存草稿/回执并核 hash，恢复只恢复受校验的文件；进程内 `verifiedEvidence` **不写检查点**，恢复后不继承凭据，一律全量。`placeholder-draft-recovery.ts` 修复来源头和 review 状态，不签发标记；其他通过 `saveKnowledgeDraft` 保存的路径本身也不签发标记。
5. `verified-evidence.ts` 的 key 覆盖 evidenceId、对象、claim、sourceRef、selector、quoteHash、role、nature、readReceiptId。门禁仍 `readVerified` 校验冻结源，并核资源 id、sourceSnapshotHash、resourceHash；任何 key/资源不匹配回退原有 `verifyEvidence`。这是针对未经本构建写时校验路径的 fail-closed 限定，不是所有承接证据均已验证的宣称。
6. 测试还暴露基线缺陷：首次发布未指定 `draftEvidenceScopePaths` 时，空集合被误判为“所有图片都承接”，但没有基准 release，三项图片证据失败。`kb-build-service.ts` 现把未指定范围视作非 published 草稿；`evidence-resources.test.ts` 的原有图片与预算测试通过，证据不得缺失的阻断未降低。

## S3 后续建议（未实施）

应先基于同步后的 `review-authority.ts` 中 `scopedKnowledgeDeclarationHash` / declaration-scope 机制设计标准模式主体摘要：只排除可机械复核的证据/覆盖字段，正文语义、对象身份与断言仍纳入；旧回执及 strict 模式走现有精确依赖。同步修改 `build-actors.ts` 的失效判定、报告归属与阶段发布 `passReports`；覆盖只改 evidence/coverage、改正文、变更工作流、旧回执及跨文档依赖的回归。由于修改审查权威，合入前需独立安全审核；不能先忽略无效回执来冒充完成。

## 改动清单

- 配置/策略：`server/src/types/agent-knowledge.ts`、`server/src/modules/config-manager.ts`、`server/src/kb/gate-policy.ts`、`server/src/kb/knowledge-schema.ts`、`server/src/kb/knowledge-validator.ts`。
- 构建/派发：`server/src/kb/kb-build-service.ts`、`server/src/kb/build-checkpoint.ts`、`server/src/kb/build-runtime-host.ts`、`server/src/agent/build-runtime/{adapter,contracts,dispatch-guard}.ts`、`server/src/agent/{agent-tool-service,tool-specs}.ts`。
- 新增：`server/src/kb/link-repair.ts`、`server/src/kb/verified-evidence.ts`、`server/src/kb/gate-attribution.ts`；并行线依赖：`server/src/kb/object-migration-reconciliation.ts`；技能：`server/src/agent/skills/knowledge-build/{SKILL,leader-protocol,author-protocol,reviewer-protocol}.md`。
- 测试：`server/tests/{gate-policy,link-repair,build-runtime-dispatch-guard,build-runtime-tools,config-manager,kb-build-parallel,kb-build-resume,kb-knowledge-tools,kb-version,knowledge-publish}.test.ts`。
- `knowledge-publish` 既有人工审核 warning 测试补明确草稿范围；`kb-build-parallel` 和 `kb-version` 原阻断断言显式配置 strict，前者增加 standard 对照。没有删除测试或新增 skip。

## 验证与对照

所有工作树命令 cwd 为工作树根或其 `server/`；日志为本机临时证据。

### 验收反馈后的续轮

- `server: npx tsc --noEmit`、根 `npm run typecheck`、`npm run lint`、`server: npm run build`：均退出 0；lint 仍有原 3 条 hook warning。最后两处小修改之后再执行了 server tsc 与直接相关用例，未重跑根 lint/build。
- §5.3 专项加 `review-declaration-scope.test.ts` 串行：22 文件通过、1 既有跳过，540 用例通过、3 既有跳过（`/tmp/kb-gate-followup-targeted.log`）。随后对变更点再跑 knowledge-publish/kb-build-resume/review-declaration-scope/build-runtime-tools：4 文件、115 用例通过（`/tmp/kb-gate-last-followup.log`）。
- `server: npm test`：退出 1，216 文件通过、9 文件失败、2 跳过；3327 用例通过、10 失败、19 跳过（`/tmp/kb-gate-followup-full.log`）。其中 9 例与先前 aa69abd 隔离基线对照相同；额外 `build-runtime-process-residual` 的 OS 竞态用例在全量中失败，而工作树和隔离基线单文件各 59/59 通过（`/tmp/kb-gate-residual-current.log`、`/tmp/kb-gate-residual-baseline.log`），不能据此认定根因，单独标记波动。此全量运行在最后报告写盘错误分支调整之前。
- 续轮新增旧检查点缺 gatePolicy 恢复 strict 的真实入口测试、standard 超体量成功后 report warning 断言、承接面与变更面的 graph stale 归因测试；最终 source-path 守卫加严后，`knowledge-publish.test.ts` 单独 31/31 通过（`/tmp/kb-gate-attribution-final.log`），server tsc 退出 0。未完成 S3 和阶段记忆真实发布链测试。

- `server: npx tsc --noEmit`：退出 0；根 `npm run typecheck`：退出 0；根 `npm run lint`：退出 0，3 条既有 React hook warnings（NodeTreeView/useSessionAgentStatus/useSyncStatus）。
- `server: npm run build`：退出 0；复制 6 个 workflow skill 文件和 5 个 extension 文件、打包 MCP/CLI，见 `/tmp/kb-gate-build-final.log`。
- 设计 §5.3 列表以 `--maxWorkers=1 --minWorkers=1` 运行：退出 0，21 文件通过、1 既有文件跳过；530 测试通过、3 既有测试跳过（`/tmp/kb-gate-targeted-final.log`）。此运行早于最后新增 2 个测试和 reviewer advisory 微调。
- 随后针对修改点执行 `npx vitest run tests/build-runtime-dispatch-guard.test.ts tests/build-runtime-tools.test.ts tests/kb-build-resume.test.ts tests/knowledge-skill-examples.test.ts --maxWorkers=1 --minWorkers=1`：退出 0，4 文件、105 用例通过（`/tmp/kb-gate-last.log`）；其中 resume 串行单独重跑通过。`knowledge-publish`、evidence 工具等在前一轮 7 文件 202 测试全部通过；图片基线修复后 4 文件 91 用例通过。
- `server: npm test`：退出 1，217 文件通过、8 失败、2 跳过；3324 测试通过、9 失败、19 跳过（`/tmp/kb-gate-full.log`）。使用 `git archive aa69abd...` 创建隔离临时基线 `/tmp/kb-gate-baseline-mJZIR0`，链接本工作树依赖并先 build，再在相同 Node 和 Vitest 下对以上 8 个失败文件运行：**相同 9 个用例失败**、37 通过（`/tmp/kb-gate-commit-baseline.log`）。包括 live 插件、固定版本 Git、capability probe、Electron utility、Discuss、precheck、session timestamp、source-tree；不能据此宣称全量通过。
- 主树只读对照另遇 better-sqlite3 ABI 125/137 不匹配；未重建/改动主树依赖。隔离提交基线使用工作树依赖避免了这一限制。
- 没有主上授权的真实增量库、真实模型调用、前后性能对比或独立安全审查；上述测试不能代替它们。

## 未闭合、风险与回滚

- **不应将本补丁作为全规格完成品合入**：S1 作用域归因只覆盖可证明的部分历史 graph stale；S3 本续轮获准但尚未实施；阶段失败记忆的重复/失效真实链路测试、所有门禁 strict/standard 成对用例和真实增量验收均未完成。现有保守阻断可能仍导致历史问题阻塞构建。
- 指纹不持久化，恢复后性能退化为原全量；这是安全选择。`stageBlockedPaths` 仅反映受支持的确定性失败，整候选变化即失效，未承诺所有阻断均会记忆。
- 来源变化、证据缺失、审查凭据、路径和权限等安全硬门禁不得由后续范围归因或缓存跳过；任何归因必须证明同一问题存在于 CURRENT 且不属于当前变更范围。
- 回滚：配置 `standardKb.strictGates: true` 只影响新构建；若需要完整代码回退，应由获授权接手者对 **aa69abd 之后** 的上述文件逐项反向应用补丁，并单独处理 intent-to-add 索引项；不得回滚同步提交或覆盖并行改动。提示词、阶段记忆及 additive skipped 不随 strict 开关还原。

## P4 修复（部分完成，仍不可验收）

上游：本报告、`p2-design.md` §2.3–2.4、`p4-review.md`。工作树与补丁基线仍为上述路径和 `aa69abd`。本轮仅另改 `server/src/kb/kb-build-service.ts` 的阶段失败码集合和 `server/tests/link-repair.test.ts`；未改主树代码、未提交。

- **F01 未完成**：标准模式仍沿用精确回执及无条件写后失效；没有引入主体摘要、凭据重挂、报告选择或恢复分支。写后在声明锁内涉及回执有效性和对象凭据一致性，若仅跳过失效或跳过 workflow 比对会造成不安全的部分放宽；本轮保留旧行为，没有伪称完成。标准/严格模式 evidence-only、coverage-only、正文变化、workflow 变化的成对真实工具链测试均未补。
- **F02 裁决**：Leader 明确决定不扩展；保留 `gate-attribution.ts` 保守阻断，不修改该实现。历史问题可能仍阻断，见 P4 审核。
- **F03 部分完成**：阶段发布的确定性失败集合补入 `kb_restatement_stale`，沿用现有检查点持久化与整候选缓存键；尚未新增该分支真实服务链测试。最终发布没有与阶段共享记录，缓存键仍不是要求的路径级依赖；同输入不重跑、路径修复重试、无关篇继续阶段发布均未通过新测试证明。保留整候选键的原因是 `kb_restatement_stale` 的判断还读取其他对象 revision（`knowledge-schema.ts`），`kb_link_invalid` 也依赖其他路径是否存在，直接换为仅本路径正文与声明哈希可能在他篇修复后继续缓存过期阻断；最终发布的分组仅保留 code 与示例文本，不能凭它安全地逐路径归因。后续需保留可证明的跨路径依赖或仅对已证明局部的码使用路径键，并在分组前保留结构化定位。
- **F04 测试完成**：`server/tests/link-repair.test.ts` 原已有参数化的两个反例；本轮改成两个独立命名测试，缩进块同时覆盖四空格与 tab，另覆盖跨行 code span。未修改链接修复实现。

### 本轮实际验证

- `server/`: `npx tsc --noEmit` 退出 0；要求的 13 个 vitest 文件使用 `--maxWorkers=1 --minWorkers=1`，退出 0，13 文件、256 例通过（`/tmp/kb-gate-p4-targeted.log`）。这不构成 F01 或 F03 缺失场景的证据。
- `server/`: `npm test` 退出 1，218 文件通过、7 失败、2 跳过；3334 例通过、8 失败、19 跳过（`/tmp/kb-gate-p4-full.log`）。逐例对照上轮 aa69abd 隔离基线 `/tmp/kb-gate-commit-baseline.log`：本轮 8 个失败名称均在既有 9 例中；基线的 session-history-cache 失败本轮未出现。未发现新增失败，但全量未通过。
- `server/`: `npm run build` 退出 0，日志 `/tmp/kb-gate-p4-build.log`；根目录 `npm run typecheck && npm run lint` 退出 0，lint 为原有 3 条 React Hook 警告。
- 根目录 `git diff --check aa69abd` 退出 0；新增文件已 `git add -N`，`git diff aa69abd` 已输出 `/tmp/kb-gate-simplify.patch`。该补丁包括 P3 的全部 worktree 改动，不只是本轮两处。

### 未闭合与回滚

F01 和 F03 的上述缺口、独立安全审核及真实增量库验证仍未完成；本轮结果是部分交接，不满足完整任务验收。回退本轮改动只需从阶段失败集合移除 `kb_restatement_stale`，并将两条链接测试恢复为原参数化用例；不要回滚 P3 其他改动或同步提交。

## F01 实施（标准模式审查主体）

上游：`p2-design.md` §2.3、`p4-review.md` F01。工作树同上，基线 `aa69abd`，未提交，未改主树。仅在 `gatePolicy.strict === false` 时生效；严格模式和旧检查点（没有策略字段，视为 strict）的回执保持原字节。

### 设计落点

- **主体摘要** `reviewSubjectDigest(draft, path, content)`，位于 `server/src/kb/review-authority.ts`。摘要用 sha256 计算以下内容的 stableStringify：
  - 规范化正文：CRLF→LF，去 std 头，去每行行尾空白和首部空行，3 个以上连续空行压成 2 个，去末尾换行。
  - std 头的 `sources`，排序去重。比 §2.3 多纳入这一项：新增来源属于审查未覆盖的输入，保守起见计入。
  - 本路径非 tombstone 对象的语义字段：objectId/type/title/aliases/domainIds/familyKey/variantKey/scopeKey/scopeText/businessStatus，以及 claims `{claimKey, riskCategory}`。scopeText 等字段对应设计风险 R2，保守纳入。
  - 触及这些对象的关系 `{type, from, to, scopeKey, decisionRef, validFrom, validUntil}` 和呈现 `{kind, owner, target, fragmentKey, summaryBasis}`。
  - **排除**：evidence、coverage、docs 元数据、clientKeys/evidenceKeys、payloadHash/reviewSubjectHash、canonical 与 claim 的 bodyRange、revision、审查凭据、edgeId/presentationId、targetRevision，以及 workflow 规则。
- **回执写入**（`agent-tool-service.ts`，`toolKbSubmitReview` 与 `reviewSubjectDependencies`）：标准模式下为每个 scopePath 记录 `subject:<path>`。写入前用同一次读到的正文和声明校验：正文 contentHash 等于 `doc:*`，作用域声明哈希等于回执声明哈希。任一不一致（并发写窗口）就不记 subject 键，这张回执退回精确规则。
- **写后失效**（`v2RecordReceipt` 与 `BuildActorStore.invalidateReviewsForPaths(..., retain)`）：kb_write_doc/kb_edit_doc 写后，只保留 `subject:<path>` 等于当前摘要的回执。delete_doc、严格模式和无 subject 键的回执照旧失效。
- **凭据重挂**（`reattachSubjectReviewCredentialsLocked`）：在调用方已持有的声明锁内执行。对每个路径取最新一张保留的 pass 回执，条件是无 blocking 问题、来源快照一致、主体一致。用它的 reportId 回写本路径上已被重置且未被拒绝的对象的 machine 凭据。`computeReviewSubjectHash` 未改。
- **有效报告选择**：`collectAuthorityValidatedReports` 与 `missingScopedPassReviewPaths` 新增可选 `subjectOf`，由 `standardReviewSubjectResolver` 按冻结策略提供。带完整 subject 键的回执核验报告文件绑定、来源快照和 `subject:*`，跳过 declaration/doc:*/workflow-rules 的比对，失效原因记为 `subject_stale`。没有 subject 键或键不全的回执走原有精确规则。已接入的调用方：
  - Leader 状态 `buildDocumentWorkStatus`；
  - 阶段发布 `publishProgressiveIfReady`（passReports 同源）；
  - 候选组装 `assembleCandidateRelease`；
  - 最终发布 `review_missing`；
  - 手动确认的复核。
- **恢复分支**（`repairWorkflowReviewCredentials`）：标准模式下，带 subject 键的回执不因 workflow revision 变化撤销，只写一行 info 日志；旧回执和严格模式照旧撤销。

### 测试

新增 `server/tests/review-subject-standard.test.ts`，共 10 例，走真实工具链：raw_read → kb_write_doc → kb_submit_review → kb_edit_doc → Leader `build_checkpoint status`，再接 collect/missing 和 `assembleCandidateRelease + canPublish`。

- 标准模式：
  - 只改 evidenceSelectorUpdates：回执仍 valid，对象凭据重挂为同一 reportId，`pendingIndependentReviewPaths=[]`，missing=[]，候选可发布。
  - 只改 coverageUpdates（importance）：同样无需补审。
  - 只加行尾空白：回执仍 valid。
  - 改正文非空白字符（2→3）：回执 stale，路径重新待审，候选为 `review_missing`。
  - claim 的 riskCategory 变化：即使绕过写后失效，发布侧也会判为 `subject_stale`。
  - workflow 规则升级：collect 仍入选，恢复修复返回 []，回执与凭据保留。
- 旧回执（删除 subject 键）：workflow 漂移即出局；selector 修改后 stale 并需补审。
- strict=true 与无策略各 1 例：不记 subject 键；改证据和改正文都 stale 且需补审，候选不可发布。另有 1 例 strict 下 workflow 升级撤销并返回待审路径。
- 1 例规范化纯函数测试。
- 变异检查：临时去掉凭据重挂调用后，selector 用例失败；之后已恢复。

### 验证

- `server: npx tsc --noEmit`：退出 0。
- 要求的 9 个文件加新文件，串行运行（`--maxWorkers=1 --minWorkers=1`）：10 个文件、235 例全部通过（`/tmp/kb-gate-f01-targeted.log`）。
- `server: npm test`：退出 1，218 个文件通过、8 个失败；3343 例通过、9 例失败（`/tmp/kb-gate-f01-full.log`）。
  - 其中 8 例与 P4 全量（`/tmp/kb-gate-p4-full.log`）的失败名称一致。
  - 另 1 例 `kb-lan-manager` 的 “SIGTERM escalates to SIGKILL” 是进程时序用例，P3 首轮全量 `/tmp/kb-gate-full.log` 也出现过。本轮单文件重跑 9/9 通过，与审查权威代码无导入关系，判为负载下波动。
- `server: npm run build`：退出 0（`/tmp/kb-gate-f01-build.log`）。
- 改动文件 eslint：退出 0。`git diff --check aa69abd`：退出 0。
- 新文件已 `git add -N`，`git diff aa69abd > /tmp/kb-gate-simplify.patch` 已重新生成（2679 行，含 P3/P4 全部改动）。

### 未闭合与风险

- 阶段发布 `publishProgressiveIfReady` 的 passReports 与 collect 同源，并已接入 subjectOf；但没有单独做“selector 修改后阶段晋级”的服务级测试。候选组装和 Leader 状态已有真实链测试。
- 已接受的代价（设计 §2.3）：作者在审查通过后换成能解析、但不支持该断言的证据，标准模式不会触发重审。claim/canonical 的 bodyRange 不入摘要：正文不变时把断言重新指向别处不会触发重审，这一点按设计接受。
- 修改的是审查权威语义，合入前需要独立安全复核（diting）。
- 回滚：反向应用上述 4 个源文件中带 F01 注释的区段，并删除新测试文件。也可以设置 `standardKb.strictGates: true`，只对新构建生效；已带 subject 键的回执在严格模式下会被忽略。
