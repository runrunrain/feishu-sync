# 统一审核修复批：知识审查→生产发布闭环（F07/F08/F11/F14）

**状态：完成（含 Leader 反馈三处接缝补强轮；worktree `amagi/build-v2-fix-publish`，未提交，待 Leader 汇总 diff）**

修复对象：`agent-outputs/workflow/build-runtime-v2/review-report.md` 的 F07/F08/F11/F14。
前置阅读：review-report 全文、两份 probe 原始脚本与 log（`/tmp/feishu-build-v2-review/{review-binding-probe,knowledge-publish-probe}.{ts,log}`）、CLAUDE 标准库 CURRENT 契约（F3-R10 指针提交点语义）。

## 一、修复内容与证据

### F07｜默认审查回执被生产候选组装器忽略 — 已修

- **改动**：`kb-build-service.ts assembleCandidateRelease`——v2（pi-amagi）构建的 `acceptance.validReportIds` 由 `BuildActorStore` 权威审查回执驱动（新 helper `server/src/kb/review-authority.ts` 的 `collectAuthorityValidatedReports`），不再依赖 legacy `reviews/all.json` 约定；legacy（units+all）行为不变。回执↔报告文件经 `reportUnitId`/`reportId` 双向绑定（`build-actors.ts ReviewReceipt` 新增两可选字段），多审查者（不同 actorId 文件）各自入选，报告被新审查覆盖时旧回执因 reportId 不匹配自然出局。
- **证据**：`tests/build-runtime-review-authority.test.ts` ①省略 unitId 的 diting 审查（无 all.json）→ `validReportIds` 含报告、canPublish 通过；多 reviewer 用例两回执均入选。
- **版本绑定保留**：报告 draftHash=提交时候选哈希 + 回执 doc:* 逐路径哈希核验（`collectAuthorityValidatedReports`）。

### F08｜原生审查未接对象级审查凭据 — 已修

- **依赖绑定**：`kb_submit_review` v2 分支的 `ReviewReceipt.dependencyHashes` 从仅 `doc:*` 扩展为四类精确哈希：正文（doc:* 逐路径 + draftHash）、对象/证据声明（`knowledge-declaration`=声明语义哈希，剔除审查凭据字段与 calls 账本——**不自失效**）、来源快照（`source-snapshot`）、冻结 workflow 规则（`workflow-rules`=`materializeWorkflowSkill` 的 sha256，即 `leaderRun.spec.workflowRevision`，由 `runLeaderSupervisedPhase` 挂到 `BuildRunState.v2WorkflowRulesHash`——不从模型信任 ruleVersion，规则文本同源重算一致）。
- **对象凭据原子衔接**：`kb_submit_review` pass 且无 blocking → `markObjectsReviewedForAuthorityReceipt`（声明锁单临界区）内重算当前候选哈希/声明哈希/快照哈希/规则哈希，与提交时值全匹配才复用 `markObjectsMachineReviewedLocked` 回写（拆出无锁内核，避免与原方法嵌套死锁）；任何漂移返回 `credentialDeferred` 不标记。**不无条件 mark passed**；复用现有 markObjectsMachineReviewed/知识校验，未新增简化 gate、未降低 kb_review_pending 门禁。
- **发布消费同一权威**：`assembleCandidateRelease` v2 分支按当前值重核回执依赖（metadata-only 声明变化 → 回执不入选 → `review_missing`）；对象 pending 门禁（knowledge-validator）保持不动。
- **证据**（`tests/build-runtime-review-authority.test.ts` 9 用例）：
  - 成功链：真实 objects/claims/evidenceClaims/readReceipt（raw_read 回执）写入 → 默认 review pass → `credentialMarked=1`、对象 `reviewStatus=passed` → assembleCandidateRelease+canPublish 通过 → 真实 `publishRelease` → **CURRENT 切换成功**、release `knowledge.json` 对象 passed；
  - 拒绝链：metadata-only 对象声明变化（正文不变）→ 对象回 pending + 旧回执 stale + review_missing，重审后闭环；来源快照漂移 → review_missing；规则哈希漂移 → review_missing；
  - 约束：needs_revision 不回写；luban 自审被角色工具面拒绝（自审父链限制保留，`assertReviewerIndependent` 在提交路径不变）；
  - 纯函数矩阵：审查凭据字段/calls 不入声明哈希（回写不自失效）；回执缺报告绑定/依赖漂移/报告文件删除均不入选。

### F11｜发布取消/超时与 CURRENT 真相分叉 — 已修

- **提交点租约**：`publishRelease` 新增 `preCommitLease?: () => void`，在 `publishReleaseInner` 的 CURRENT tmp 写之前（真正指针提交点紧前）调用；`executeLeaderPublishRequest` 传入闭包（`entry.cancelRequested` + 代次核验，不假设 token 删除自动换代）。抛错 → 发布中止、CURRENT 未切、release 目录由外层 catch 清理。
- **已切后收敛（auto）**：①`executeLeaderPublishRequest` catch 首查 `publishAlreadyCommitted`（CURRENT 指针==本次 releaseId）：已切 → 落 publishLock/settlePublishWindow/检查点/published、返回 `accepted:true status=published`（附 warning），不落 accepted:false/failed、不回滚删除 current；②`runPipeline` 监督终局处理重排：`publishLock.revision` 非空（CURRENT 已提交）优先于 `cancelRequested` 收敛 published——取消竞态不再把已发布构建落成 cancelled/“未发布任何变更”；awaiting_release（revision=null，CURRENT 未切）仍可正常取消。
- **同类面（manual）**：`releaseConfirm` catch 同样先核 CURRENT 指针——已切不回落 awaiting_release，按指针收敛 published。
- **证据**（`tests/build-runtime-publish-cancel.test.ts` 5 用例，真实 `executeLeaderPublishRequest`/`publishRelease`/`releaseConfirm` 入口）：prepare 中取消（lease 拦下 → CURRENT 不切+目录清理）；发布前取消拒绝；成功链对照（CURRENT 切换+publishLock.revision）；auto 提交后收尾 DB 异常 → 按指针收敛 published+收敛重试落库；manual 确认发布提交后 DB 异常 → 不回落 awaiting_release。

### F14｜冻结 skill MCP 示例与真实契约不一致 — 已修

- **改动**（`server/src/agent/skills/knowledge-build/`）：`mcp-examples.md` 全部示例重写为真实契约——server 名 `feishu-kb-bridge`（`BUILD_MCP_SERVER_NAME`）；`raw_read` 用真实参数 `offset/limit`（原 startLine/endLine 不存在）；`kb_write_doc` 补必填 `title`；`kb_submit_review` 改 `operationId/coverage.sourceRefs/checkedDimensions/conclusion` + issues 真实字段（draftLocation/sourceLocation/severity）；新增 `build_handoff_submit`/`build_manifest`/`build_assign_output`/`build_request_publish` 示例。`achievement-protocol.md` 交接字段 `artifacts→artifactRefs`、`needsFromLeader→nextInfo`，并点名 `build_handoff_submit` 工具。其余四份（SKILL/leader/author/reviewer protocol）经 grep 无错误 MCP 参数，不动。
- **契约检查**：`tests/knowledge-skill-examples.test.ts` 解析六份资产全部 ```json 块，按真实 tool-specs 校验 server 名/工具注册/required/enum/additionalProperties，≥7 个示例全过；并断言 write 带 title、review 用 conclusion/coverage、交接用 artifactRefs/nextInfo。

## 二、验证汇总（cwd=server，真实执行）

| 批次 | 结果 |
|---|---|
| `npx tsc --noEmit` | EXIT 0 |
| `npx eslint`（全部 7 个改动/新增文件） | 0 error |
| 新增测试 3 文件 | **17/17** 通过（review-authority 9 + publish-cancel 5 + skill-examples 3） |
| 回归 6 文件（build-runtime-tools/build-actors/kb-knowledge-tools/knowledge-publish/build-runtime-persisted-mode/build-scheduling-supplement） | **143/143** 通过 |
| `build-runtime-e2e.test.ts` | 3 skipped（既有门槛：需 PATH 中 pi + 显式 AMAGI_PI_SOURCE_DIR，非本批引入） |

**probe 复现说明**：两份 probe 为状态耦合的审核取证脚本（依赖前序 probe 遗留的 staging/actors 中间态，无注册 writer 等前置），不可独立重放；原 log 已完成缺陷理解与定位，修复验证由上述测试以**真实链超集**替代（成功链覆盖 probe 场景：真实 objects/claims/readReceipt + 默认 review → prepareKnowledgePublish → CURRENT，原 `kb_review_pending` 阻断不再出现）。worktree 侧验证脚本与 log 留存于 `/tmp/feishu-fixpublish-verify/`。

## 三、公共接口与兼容

- **新增**：`server/src/kb/review-authority.ts`（`knowledgeDeclarationHash`/`resolveCurrentReviewDependencies`/`collectAuthorityValidatedReports`/`reviewDependenciesMatch` + 三个依赖键常量）；`ReviewReceipt.reportUnitId?/reportId?`（可选，旧回执缺字段时发布核验按 `receipt_missing_report_binding` 拒绝——fail-closed）；`publishRelease.preCommitLease?`（可选回调）；`BuildRunState.v2WorkflowRulesHash?`（集成者设置；null 时不核规则键，doc/声明/快照仍强制）。
- **〔调整 #1 接口报告〕workflowRevision 注入点**：工具侧（kb_submit_review 回执绑定）经 `BuildRunState.v2WorkflowRulesHash`（新可选字段，string | null）；当前由 kb-build-service `runLeaderSupervisedPhase` 在 buildLeaderInput 后同步 3 行赋值（`leaderInput.workflowRevision`，即 materializeWorkflowSkill sha256，与 `leaderRun.spec.workflowRevision` 同源重算），未改 host/adapter 生命周期。发布侧核验（assembleCandidateRelease）**优先读权威 spec** `entry.leaderRun.spec.workflowRevision`，state 字段仅为工具侧镜像——若 4245961b 决定改由 host 注入，发布侧不需变动；不从模型信任 ruleVersion，ruleVersion（'kb-review/1'）仍为报告结构版本。
- **不变**：legacy 编排审查链（units+all 组装、`submitReviewResult`→`markObjectsMachineReviewed`）行为不变；`canPublish` 纯函数未改；knowledge-validator pending 门禁未动；`tool-specs.ts` 未改（真实 schema 本就正确）。
- **已知语义影响**：①F14 改动冻结 skill 内容 → `workflowRevision` 变化，旧检查点的 pi-amagi 会话恢复会因规则漂移被拒（既有 fail-closed 语义，预期内）；②旧代次（无 reportUnitId 绑定的）回执在新发布核验下不再入选——需重新审查后发布（fail-closed）。
- **标准 CURRENT 契约**：`standard-kb-store.ts` 未改——lease hook 放在 `publishReleaseInner` 的 rename 调用点（kb-build-service 内），store 层无集中提交点，无需侵入。

## 四、未覆盖与移交（如实）

- e2e 真实 pi 链 3 用例本机 skip（无 pi CLI/AMAGI_PI_SOURCE_DIR 显式开启）；Leader 复核后如需可在具备环境处复跑 `server/tests/build-runtime-e2e.test.ts`（其 fixture 硬写 `unitId='all'` 与默认路径均由回执驱动统一覆盖，逻辑上兼容——本批回归中 build-runtime-tools 的 v2 审查/发布窗口用例全绿）。
- 1772 收敛重排的监督竞态路径（outcome=cancelled + publishLock.revision 已设）由单元级 publishLock 输入断言 + 代码顺序保证，未做真实 pi 进程级注入。
- F09/F10/F12/F13/F15 及 F01–F06 归并行修复批（27b5d076/65a04158/4245961b），本批未触碰其写面。
- 审查回执的 `ruleVersion` 字符串（'kb-review/1'，结构版本）与规则内容哈希（workflow-rules 键）职责分离，前者未动。

## 五、Leader 反馈补强轮（三处接缝）

### 1）auto 提交点租约补全（timeout + 真实 ctx 租约，缺证明拒绝）

- `toolBuildRequestPublish`（工具层）构造 **authorityLease 闭包**随 V2PublishHandler input 传递：内部经 `isContextLive`（contexts Map 引用比对 + `revokedAt` 标记双检）核验本次工具调用的 Leader ctx 仍有效——服务端闭包，不经模型 JSON，不携带 token/secret，不落盘不进 checkpoint；`wrapPublishExecutor` 原样透传（已核实不改 host）。
- `executeLeaderPublishRequest` 的 preCommitLease 现核四项：①`authorityLease.validate()`（**缺 lease 视为无证明拒绝**：run_token_invalid，CURRENT 不切）；②`entry.cancelRequested`；③`entry.timedOut`（overall timeout 置位即使未置 cancelRequested 也拦截）；④代次。
- 〔接口报告·通知 424〕**V2PublishHandler input 新增可选字段 `authorityLease?: { validate: () => void }`**。现链 wrapPublishExecutor 透传 request 对象，424 无需改动；若后续重构 request 形状，须保留该字段透传。与 27/b18 的 revokedAt 对接：isContextLive 已兼容「从 Map 删除」与「标记 revokedAt」两种撤租实现。

### 2）manual releaseConfirm 同一提交点语义 + 精确归属

- `releaseConfirmInner` 两处 publishRelease 均传 **preCommitLease=releaseLease**：核 DB 行状态（无内存 entry，DB 是权威；cancelBuild 对 awaiting_release 必落 cancelled——互斥保证无并发流水线残留），状态非 `publishing` → 提交点拒绝（CURRENT 不切）。
- **精确归属**：`publishAlreadyCommitted(outputRoot, releaseId, buildId?)` 增加双验证（CURRENT==本次 release 且 manifest.buildId==本 build）；Inner 收尾落库异常时按本次 release 精确收敛；外层 catch 同样要求 manifest.buildId==本 build 且 committedNow!=base——**他 build 指针已变但本 build 提交前失败时不假 published**（回落 awaiting_release/保持 cancelled 如实）。

### 3）规则哈希 fail-closed + manual 冷启动同一 v2 权威

- `reviewDependenciesMatch`：v2 权威规则哈希缺失（null）→ 恒 false（回执必须携带 workflow-rules 键且与冻结值精确匹配）；`markObjectsReviewedForAuthorityReceipt` 同样 null 拒绝（`workflow_rules_changed_since_review`，不 mark passed）。legacy 不受影响（不经此函数）。
- `releaseConfirmInner`（pi-amagi 检查点）：从 **staging 账本**（BuildActorStore.load）+ 检查点 `leaderRun.spec.workflowRevision` 恢复权威，`collectAuthorityValidatedReports` 重新核验候选引用的每份报告当前仍有效（依赖漂移 → kb_publish_blocked）；**不退回 legacy 文件池**。

### 补强轮新增测试（`build-runtime-publish-cancel.test.ts` 12 用例 / `build-runtime-review-authority.test.ts` 10 用例）

| 反馈点 | 用例与结果 |
|---|---|
| 超时 | entry.timedOut → 提交点拒绝、CURRENT 不切 ✓ |
| 撤 ctx | authorityLease.validate 抛 run_token_invalid → 拒绝、CURRENT 不切 ✓ |
| 缺证明 | 无 authorityLease → run_token_invalid 拒绝（fail-closed）✓ |
| manual 成功链 | 真实 objects 默认 review → **跨 service 实例冷启动** releaseConfirm → published + CURRENT 切换 + knowledge.json 对象 machine passed ✓ |
| manual 规则漂移 | 检查点 workflowRevision ≠ 回执绑定 → kb_publish_blocked（不退回文件池）✓ |
| manual prepare 取消 | 占位后 DB 行 cancelled → 提交点拒绝、CURRENT 不切、状态如实 cancelled ✓ |
| 不同 build 指针 | 他 build 已切指针 → 本 build base_release_changed 拒绝、不假 published、他 build CURRENT 不受影响 ✓ |
| 规则哈希 null | 回写拒绝（credentialDeferred）+ 发布核验 review_missing（fail-closed）✓ |

验证汇总（补强轮后全量重跑）：tsc=0、eslint=0、**9 文件 168/168**（新增 3 文件 25 用例 + 回归 6 文件 143 用例）；既有 17 例全部保留且通过。

## 六、回滚方式

`git checkout -- server/src/agent/agent-tool-service.ts server/src/kb/build-actors.ts server/src/kb/kb-build-service.ts server/src/agent/skills/knowledge-build/ && rm server/src/kb/review-authority.ts server/tests/{build-runtime-review-authority,build-runtime-publish-cancel,knowledge-skill-examples}.test.ts`（工作树内未提交改动，按路径精确还原；不动其他并行改动）。
