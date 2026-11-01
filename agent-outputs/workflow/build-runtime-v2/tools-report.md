# build-v2-tools 实现报告（成果权限与知识工具闭环）

> 状态：**已完成**（worktree `.amagi-worktrees/build-v2-tools`，分支 amagi/build-v2-tools，未提交，改动留工作区由 Leader 汇总）。
> 设计依据：基于Agent基座与工作流插件的构建重构设计-v2（§3.3/§3.4/§4/§5/§7/§8/§10/§11）。

## 集成者速览（调整 #1：导出接口 / 字段 / 工具名单）

### 1. 新模块 `server/src/kb/build-actors.ts`（成果侧契约，运行时 contracts.ts 可直接复用）

- `BuildActorStore`：构造 `{ buildId, stagingRoot, generation?, extraRoles? }`；持久化在 `staging/<buildId>/build-actors/`（actors/assignments/receipts/reviews/handoffs/issue-lists/publish-requests.json + events.jsonl，内存权威+原子落盘，`persist()`/`load()`）。
- 契约类型（§8 同名）：`ActorBinding{actorId,nativeTaskId,parentTaskId,generation,role,requestedRole,status:pending|confirmed|revoked,…}`、`OutputAssignment{assignmentId,generation,targetKind:'doc'|'family',targets,ownerTaskId,status:active|revoked|superseded,supersedes,…}`、`ArtifactReceipt{artifactId,generation,authorTaskId,kind:write_doc|edit_doc|delete_doc|handoff|review,operationId,idempotencyKey,payloadHash,result,createdAt}`、`ReviewReceipt{reviewId,reviewerTaskId,draftHash,dependencyHashes,ruleVersion,issues,verdict,status:valid|stale,…}`、`RuntimeEventRecord{eventId,source:'leader-rpc'|'tool-service'|'amagi-artifact',nativeEventId,generation,taskId,type,occurredAt,receivedAt,payload}`、`HandoffRecord`、`IssueListRecord`、`PublishRequestRecord`、`BuildActorCheckpointPayload`。
- 关键方法：
  - 身份：`registerTaskCreation({nativeTaskId,parentTaskId?,requestedRole,agent?,occurredAt?,nativeEventId?})`（Leader RPC 创建事件 → confirmed；续接继承分配+撤销父任务资格+父任务 revoked）、`ensurePendingIdentity(nativeTaskId, agent)`（桥接先到 → pending 只读）、`requireConfirmedActor(nativeTaskId, expectedAgent?)`（角色不一致 actor_role_mismatch）、`revokeActor(id, reason)`、`ancestryOf(id)`。
  - 代次：`activeGeneration` / `assertGeneration(gen)`（不符抛 credential_generation_revoked 401）/ `rotateGeneration(newGen, reason)`（撤销旧代次全部身份与分配）。
  - 分配：`assignOutputs({targets,targetKind?,ownerTaskId,supersedes?})`（冲突 409 kb_output_assignment_conflict 带持有者）、`revokeOutputs({assignmentId?|ownerTaskId?})`、`assertOutputAssignment(taskId, docPath)`（kb_output_not_assigned / kb_output_owned_by_other_task）、`activeAssignmentFor(target)`（doc 精确路径 / `family:<familyKey>`）。
  - 幂等：`deriveIdempotencyKey(buildId,generation,nativeTaskId,operationId)`（导出函数）、`replayReceipt(key,payloadHash)`（同键同载荷返回原回执；异载荷 kb_idempotency_conflict 409）、`recordReceipt({authorTaskId,kind,operationId,payloadHash,paths,result})`。
  - 审查：`assertReviewerIndependent(reviewerTaskId, paths)`（作者链/审查者链双向比对，kb_review_not_independent 403）、`recordReview(…)`、`invalidateReviewsForPaths(paths, reason)`、`openBlockingIssues()`（最新问题清单 blocking 计数）。
  - 事件：`appendEvent({source,nativeEventId?,taskId?,type,payload,occurredAt?})`（source|nativeEventId 去重，重复返回原事件）、`eventsSince(cursor?)`（observe 适配层游标读取）。
  - 发布：`beginPublishWindow(draftHash, requestedRevision)` → pending 记录（窗口内写入被拒）、`settlePublishRequest(requestId, status, result)`、`publishing` getter。
  - 检查点：`exportCheckpointPayload()` / `restoreCheckpointPayload(payload)`——**集成者以 additive 可选字段写入 BuildCheckpoint 并在恢复时回灌**（建议字段名 `v2Actors?`；payload 含 actors/assignments/receipts/reviews/handoffs/issueLists/publishRequests/eventCursor）。
- 角色工具面：`V2_CHILD_READ_TOOLS`（pending 只读面）、`V2_WRITER_TOOLS`（luban）、`V2_REVIEWER_TOOLS`（diting）、`V2_RESEARCH_TOOLS`（baize）、`V2_CHILD_ALL_TOOLS`（共享 child 凭据白名单=并集）、`resolveV2RoleToolset(role, extra?)`（`{tools, writeTools, canWriteDocs, isReviewer}`）。

### 2. `AgentToolService` 扩展（agent-tool-service.ts）

- `RunContextOptions.orchestration?: OrchestrationV2Options`——**出现即 v2 新模式分支**（不借用 unit/phase，不伪装 final）：
  `{ mode:'pi-amagi', buildId, generation, credential:'leader'|'child', actorStore: BuildActorStore, publishHandler?: V2PublishHandler }`；
  `V2PublishHandler(input:{buildId,generation,candidateHash,requestedRevision,summary}) => Promise<{accepted, result}>`（集成者接原发布校验管线）。
- `BuildRunState.v2?: { actorStore, generation, publishHandler? }`（build 级共享；集成者 running 前初始化；legacy 不设，行为不变）。
- `ToolRequestMeta` 新增 `amagiTaskId?/amagiAgent?`（受信 env 经内部 API 头透传，不采信模型参数）。
- token 签发：leader 用 `allowedToolsOverride:[...V2_LEADER_TOOLS]`；child 用 `allowedToolsOverride: V2_CHILD_ALL_TOOLS`（同一代次共享，具体调用者由身份头区分）。
- `getToolSpecsForToken(token, identity?)`：v2 child 按身份头解析角色下发子集；pending → 只读子集；**无身份头 → 空面**（与调用拒绝一致）。`isReadOnlyTool(name)` 公开（readOnlyHint 判定）。
- 写入链（§4.4，全部在 v2 分支内，旧路径零改动）：凭据代次 → confirmed 身份+角色一致 → 发布窗口拒绝 → 输出分配 → 幂等（operationId；同键同载荷重放原回执，异载荷 409）→ **原校验链执行**（kb_write_doc/kb_edit_doc 复用 writeDocCore：header 校验/来源快照/正文策略/声明解引用/原子写全部不变）→ ArtifactReceipt + 受影响路径审查失效。**整链置于 withKnowledgeDeclarationLock 同一受控锁链**（writeDocCore 新增 `lockHeld`/`recheck` 参数：v2 包装层持锁直入；锁内异步证据装配后、最终落盘前 `assertV2WriteWindow` 重检代次/confirmed/角色/分配/发布窗口——取消或转移后绝不写成功）。
- kb_write_doc 拆分：`toolKbWriteDoc`（v2 包装）+ `writeDocCore`（原主体，行为不变）；v2 下 kb_write_doc/kb_delete_doc/kb_submit_review 的 spec 增加可选 `operationId`（v2 必填，旧模式缺省兼容）。
- kb_submit_review v2 分支：审查角色校验（kb_review_role_forbidden）+ 幂等 + **审查独立性**（对 staging 全部草稿路径的最近作者做链比对）+ ReviewReceipt（draftHash + dependencyHashes{`doc:<path>`:hash}）+ unitId 缺省=actorId（reviews/<actorId>.json，避免同任务覆盖）。
- draft_read details 新增 `editContentHash`/`editParamTotalLines`（局部编辑基准，参数坐标口径）。

### 3. 工具名单

- **Leader（V2_LEADER_TOOLS，tool-specs.ts）**：`build_manifest` / `build_assign_output` / `build_revoke_output` / `build_handoff_list` / `build_issues_submit` / `build_issues_list` / `build_checkpoint` / `build_request_publish`。执行器内 `requireV2Leader` 双保险（非 leader 凭据 403）；不含正文/对象写工具与应用 task 族（kb_finish/kb_write_doc/task_submit 等被 assertV2Access 拒绝，已测）。
- **子任务（按角色）**：luban=读+`kb_write_doc`/`kb_edit_doc`/`kb_delete_doc`/`build_handoff_submit`；diting=读+`kb_submit_review`/`build_handoff_submit`；baize=读+`build_handoff_submit`；读=`raw_list`/`raw_read`/`raw_search`/`raw_links`/`draft_list`/`draft_read`/`draft_search`/`kb_read_batch`/`build_issues_list`（+`build_handoff_list`）。
- **新工具**：
  - `kb_read_batch`（§7 批量读取）：多资源一次读取（raw 登记 read-receipt 与 raw_read 同语义；draft 返回参数坐标正文+可选声明）；总量预算 maxLines 1..4000 缺省 1200；nextCursor 续读（剩余队列+已用行数 base64url）；逐资源截断标记。runKinds=['build']（旧模式也可用，白名单末尾追加）。
  - `kb_edit_doc`（§7 局部编辑）：`operationId`（幂等）+ `patches[]`（anchor 三选一：exact_text 唯一匹配/occurrence 消歧、heading_body 章节体、line_range 参数坐标闭区间；顺序应用）+ 可选 `expectedContentHash`（draft_read.editContentHash 口径，不符 kb_edit_conflict 409）+ 可选 title/summary/tags/sourcesAppend/expectedDraftRevision。服务端继承该文档全部声明（objects/claims/presentations/relations/evidenceClaims 平移坐标，clientKey/objectId 稳定；受影响对象经 writeDocCore 重算 payloadHash→revision+1），结构化锚点错误（kb_edit_anchor_not_found/kb_edit_anchor_ambiguous），成功后受影响审查失效。声明 knowledge-draft calls 幂等用稳定键 `edit_<operationId>`（崩溃后与 v2 回执账本两层互补）。

### 4. 桥接与内部 API

- `agent-internal.ts`：GET `/api/agent-internal/tools` 与 POST `/api/agent-internal/tools/:name` 读 `X-Amagi-Task-Id`/`X-Amagi-Agent` 头 → `meta`（中间件三重校验不变）；tools 响应项附 `annotations:{readOnlyHint:true}`（仅读取类，按 `isReadOnlyTool`）。
- `claude-bridge.cjs`：env `AMAGI_TASK_ID`/`AMAGI_AGENT`（存在才发）→ 上述头；`tools/call` 透传 `params._meta['claudecode/toolUseId']` 为 toolCallId（无 _meta 保持 `cc_` 随机回退，Claude 旧用法不变）；tools/list 透传 annotations；**构建变量 `FEISHU_SYNC_BUILD_MCP_URL`/`FEISHU_SYNC_BUILD_MCP_TOKEN` 优先于 `FEISHU_SYNC_AGENT_URL`/`FEISHU_SYNC_AGENT_RUN_TOKEN`**（调整 #4，避免 FEISHU_SYNC_AGENT_* 不可达）。
- `path-claims.ts`：纯新增 `release(path)`/`reassign(path,newOwner)`/`releaseAllBy(owner)`（v2 分配收回/续接转移同步用；持有者语义从构建单元扩展到任务身份，旧方法不动）。

## 实现文件清单

| 文件 | 改动 |
|---|---|
| server/src/kb/build-actors.ts | **新增**：成果权限账本（身份/代次/分配/回执/审查/事件/交接/问题/发布/检查点），候选目录 JSON 持久化 |
| server/src/agent/tool-specs.ts | 新增 11 个 SPEC + `V2_LEADER_TOOLS` 导出；kb_write_doc/kb_delete_doc/kb_submit_review 加可选 operationId |
| server/src/agent/agent-tool-service.ts | orchestration 选项与 v2 前置门；writeDocCore 拆分；kb_write_doc/kb_delete_doc/kb_submit_review v2 写入链；kb_edit_doc/kb_read_batch/9 个 build_* 执行器；声明继承与坐标平移；draft_read editContentHash |
| server/src/routes/agent-internal.ts | 身份头透传 + readOnlyHint annotations |
| server/src/agent/claude-bridge.cjs | AMAGI env 身份头、_meta.toolUseId 透传、annotations 透传、构建变量优先 |
| server/src/kb/path-claims.ts | release/reassign/releaseAllBy（纯新增） |
| server/tests/build-actors.test.ts | **新增** 19 用例 |
| server/tests/build-runtime-tools.test.ts | **新增** 27 用例（含 §4.4 硬验收 race 回归 4 例） |
| server/tests/build-runtime-bridge.test.ts | **新增** 8 用例 |
| server/tests/agent-tool-families.test.ts / kb-knowledge-tools.test.ts | 既有白名单快照断言最小同步（+kb_read_batch、+build-runtime 族；14 行） |

未改：kb-build-service、pi-rpc-process、feishu-sync-agent.js、共享 agent-knowledge 类型（集成者负责）。

## 验证（真实命令与结果）

- `cd server && npx tsc --noEmit` → EXIT=0；根 `npx tsc --noEmit -p tsconfig.json` → EXIT=0。
- `cd server && npx vitest run tests/build-actors.test.ts tests/build-runtime-tools.test.ts tests/build-runtime-bridge.test.ts` → **54/54 通过**（含 §4.4 硬验收 race 回归 4 例）。
- 回归：`tests/kb-knowledge-tools + agent-tool-families + agent-internal-auth` → 75/75；`tests/kb-build* + build-pipeline + build-orchestration` → 133/133；`tests/agent-tasks + app-command-family + agent-approvals-routes` → 59/59。
- `npx eslint`（改动 ts 文件）→ 0 问题；根 `npm test`（前端 492）→ 全过。
- 关键行为证据：pending 只读（actor_pending 403）；未分配写入 409 kb_output_not_assigned；分配冲突 409 带持有者；续接继承（旧任务 revoked、新任务可写）；同键同载荷重放 idempotentReplay、异载荷 kb_idempotency_conflict；作者自审/续接链审 403 kb_review_not_independent；修订后 ReviewReceipt stale；发布窗口内写入 409 build_publishing；blocking 问题阻止发布；无 handler → 501 build_publish_not_wired；代次轮换后全部 401；Leader 调正文工具/task 族 403；kb_edit_doc 声明继承（objectId 稳定、坐标平移、受影响对象重算）；expectedContentHash 漂移 409；锚点未命中/歧义结构化错误；桥接身份头/_meta toolUseId/annotations/构建变量优先（子进程真实 stdio JSON-RPC 验证）。
- **§4.4 硬验收（Leader steer #6，实际 race 回归）**：v2 写入链（kb_write_doc/kb_edit_doc）的「身份预检→分配→幂等→最终提交→回执记账」整体置于 withKnowledgeDeclarationLock 同一受控锁链；writeDocCore 在锁内、异步证据装配后、最终落盘前执行 `assertV2WriteWindow`（代次+confirmed+角色+分配+发布窗口重检）。实测：①占声明锁→revokeActor→释放→旧写拒（actor_revoked），文件字节与 knowledge-draft revision 均不变、无新回执；②占锁→分配转移→释放→旧写拒（kb_output_owned_by_other_task）、文件未创建，新持有者正常写入；③相同 operationId 两个并发调用：恰一条回执、revision 只 +1、其一返回 idempotentReplay；④回执持久化丢失（崩溃重启语义：receipts.json 清空+新 store 从盘恢复）后重放：稳定键 `v2_<task>_<op>` 命中 knowledge-draft calls 账本，draftRevision 不重复推进。

## 未覆盖 / 风险（如实）

1. **发布校验管线本体**：`build_request_publish` 提供候选锁定（staging 全量哈希）、代次校验、blocking 问题门禁与 publishHandler 注入点；**完整校验（对象身份/来源覆盖/引用目标/审查绑定）由集成者接原管线**——未注入 handler 时明确返回 501 build_publish_not_wired（不做假发布）。
2. amagi `task_resume` 是否真产生新 nativeTaskId（vs 沿用原 ID）未实测——续接继承逻辑按设计 §4.2 两种情况都处理（新 ID 走 parentTaskId 继承；自动续跑沿用原 ID 权限不变），接入试验（§13.2）时需验证。
3. mcp.json/agentDir 生成、派发参数守卫（task_submit scope 改写）属集成者与扩展侧任务；本任务只交付工具服务面与桥接。
4. `kb_edit_doc` 对 diting F06「托管文档（published 基线复制）」场景：draftEditCoordinates 要求草稿首行为 `# 标题`；托管文档若为发布坐标直通格式会得到明确错误提示改用 kb_write_doc（不静默降级），未写专门测试。
5. kb_delete_doc/kb_submit_review 全同步执行（无 await 窗口），预检与执行在同一事件循环段内原子完成，未单独包锁；其竞态面为零（设计上无异步准备段）。

## 回滚方式

改动全部未提交：`git checkout -- server/src/agent/agent-tool-service.ts server/src/agent/tool-specs.ts server/src/agent/claude-bridge.cjs server/src/kb/path-claims.ts server/src/routes/agent-internal.ts server/tests/agent-tool-families.test.ts server/tests/kb-knowledge-tools.test.ts` + 删除 4 个新文件（build-actors.ts 与三个测试）。旧模式行为回归由上述 267 个回归用例保证。

## 建议下一步（供 Leader 参考）

- 接入试验按设计 §13.2：先 1 Leader + 2 并行写作 + 1 独立审查 + 候选提交，验证 task_resume 的 nativeTaskId 行为与桥接身份链实测。
- 集成者接线 publishHandler 时建议同样在候选锁定后执行（build_request_publish 已开窗口拒绝并发写入）。
