# 构建编排 v2（pi-amagi）设计与契约

面向开发/维护者。本文描述标准知识库构建在 `orchestrationMode=pi-amagi`（现行默认）下的运行时结构、权限模型与关键不变量。运维视角的目录布局、观测与故障处置见 [build-operations.md](build-operations.md)；使用入口见 [agent-knowledge.md](agent-knowledge.md)。

- 模式判定：`server/src/types/agent-knowledge.ts` `resolveOrchestrationMode()`——新构建缺省 `pi-amagi`；配置接口只接受 `pi-amagi`（`KB_ORCHESTRATION_MODES`），`legacy`/`claude-native` 仅存在于历史构建与检查点，`claude-native` 显式请求直接拒绝（`server/src/kb/kb-build-service.ts` `build_mode_unavailable`）。
- 一次构建 = 一个 Leader 会话 + amagi 多角色子任务。应用不调度子任务，只做冻结、登记身份、校验候选与发布。

## 1. 角色与职责

| 角色      | amagi agent                | 职责                                             | 工具面                                                                                                                                                         |
| --------- | -------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leader    | （pi 会话，非 amagi 角色） | 拆主题、派发子任务、分配输出、聚合问题、申请发布 | `AMAGI_TASK_TOOLS`（task_submit/task_query/task_control/task_resume/amagi_resource）+ `V2_LEADER_TOOLS`（9 个 build_* 工具，`server/src/agent/tool-specs.ts`） |
| 写作/修订 | luban                      | 提交正文、对象、证据、覆盖声明；结束交交接记录   | 通用读面 + `kb_write_doc`/`kb_edit_doc`/`kb_delete_doc`/`build_handoff_submit`                                                                                 |
| 独立审查  | diting                     | 绑定候选版本的审查回执；复核阻断问题             | 通用读面 + `kb_submit_review`/`build_handoff_submit`，无正文写工具                                                                                             |
| 材料调研  | baize                      | 只读取证，不提交正文                             | 通用读面 + `build_handoff_submit`                                                                                                                              |

角色映射 `DEFAULT_ROLE_AGENTS` 与工具面常量在 `server/src/agent/build-runtime/contracts.ts` 与 `server/src/kb/build-actors.ts`（`V2_CHILD_READ_TOOLS`、`V2_WRITER_TOOLS` 等；与 tool-specs 名单的一致性由 `server/tests/build-runtime-tools.test.ts` 保证）。应用侧职责：来源冻结、路径围栏、输出分配登记、角色/模型/权限冻结、写入即时校验、审查回执登记、阶段发布与原子发布。

协作协议文件（`server/src/agent/skills/knowledge-build/`）：

| 文件                      | 注入对象        | 内容                                                              |
| ------------------------- | --------------- | ----------------------------------------------------------------- |
| `SKILL.md`                | skill 入口      | 全员核心规则、修订收敛、结束判定                                  |
| `leader-protocol.md`      | Leader 系统提示 | Flow 八步（盘点→拆主题→派写→派审→收敛→身份→发布→结束）与异常/恢复 |
| `author-protocol.md`      | luban 系统提示  | 写作工作流、局部修改优先、自查清单、raw_read/csv 坐标用法         |
| `reviewer-protocol.md`    | diting 系统提示 | 审查范围绑定、全称断言复核、uncheckedScope 纪律                   |
| `achievement-protocol.md` | 三类子任务      | 幂等提交语义与交接记录字段                                        |
| `mcp-examples.md`         | 子任务          | MCP 桥调用示例（工具参数直出，不查 schema）                       |

skill 内容哈希 = `workflowRevision`（冻结进 BuildRunSpec 并绑定审查回执的 `workflow-rules` 依赖）。

## 2. 运行时模块地图

运行层 `server/src/agent/build-runtime/`：

| 模块                    | 职责                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts.ts`          | 跨模块契约唯一规范：BuildRunSpec/RuntimeBinding/RuntimeEvent/CancelResult/TerminationOutcome、角色常量、`validateBuildRunSpec` 纯校验 |
| `adapter.ts`            | `PiAmagiBuildRuntime`：probe/start/observe/resume/cancel/reconcileResiduals 的运行适配层，持有 PiRpcProcess                           |
| `agent-dir-config.ts`   | agentDir 四配置渲染（settings/amagi/models/mcp）+ `planBuildDirectories` 目录规划 + `computeAgentDirConfigHash`                       |
| `amagi-package.ts`      | 版本化 amagi-pi 安装/复核：内容全量哈希（预算 30k 文件/512MiB，symlink 拒绝）、Git 官方获取链、install-record.json                    |
| `amagi-discovery.ts`    | Pi home 已配置 amagi 候选只读发现（list 模式 SDK，不 resolve 不写盘）                                                                 |
| `capability-probe.ts`   | 静态能力探测（pi 版本范围、包结构、禁区、密钥布尔），任何 fail 拒绝启用                                                               |
| `child-policy.ts`       | 应用自有子任务工具面防御扩展（内容寻址 `child-policy-<hash12>.js`）：剔除 codemode/toolcall_continue/递归目录工具，read/write 根约束  |
| `dispatch-guard.ts`     | task_submit/task_resume 派发参数守卫（纯函数，零依赖，被 Leader 进程内转发扩展装载）                                                  |
| `environment.ts`        | Leader 子进程环境白名单构造（`buildLeaderEnv`），凭据只按 provider 转交                                                               |
| `process-identity.ts`   | 内核出生令牌探测（darwin libproc / linux /proc；双采样一致性）                                                                        |
| `process-ledger.ts`     | 应用侧进程账本（`<buildRoot>/process-ledger.json`，append-only 生命周期记录）                                                         |
| `process-residual.ts`   | 残留核对与回收：受信启动锚点 + 账本 + v2-store 派发意图三方来源，出生令牌交叉核验                                                     |
| `automatic-recovery.ts` | 孤立派发自动收回：撤凭据→构建专属进程范围扫描清理→abandoned 结论                                                                      |
| `runtime-integrity.ts`  | 派发前运行期完整性重核验（F12）：冻结 settings/policy/包/skill 每次派发前触盘比对                                                     |

kb 侧 `server/src/kb/`：

| 模块                         | 职责                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `build-runtime-host.ts`      | 生产宿主唯一接线点：运行时事实解析、包安装、BuildRunSpec 组装、双令牌签发、事件泵、发布回调；`BuildRuntimeStatusDto` 供 UI |
| `build-leader-supervisor.ts` | 纯监督状态机：轮次/空闲/取消/恢复守卫/发布终局（见 §6）                                                                    |
| `build-actors.ts`            | 成果侧权限账本 BuildActorStore（候选目录 JSON 落盘，不建 DB 表）                                                           |
| `review-authority.ts`        | 审查权威绑定与有效报告选取（§4）                                                                                           |
| `publish-readiness.ts`       | 发布门「早发现」只读预览（§5）                                                                                             |
| `build-metrics.ts`           | 度量纯函数聚合（legacy 段 + orchestration 段）                                                                             |
| `gate-policy.ts`             | 发布 issue 的 block/warn/drop 策略（strict 与 standard 两档）                                                              |
| `orchestration-contracts.ts` | `canPublish` 发布条件纯函数与 `PUBLISH_BLOCK_REASONS`                                                                      |
| `kb-build-service.ts`        | 业务服务：构建入口、发布管线、检查点、恢复、度量采集                                                                       |
| `build-checkpoint.ts`        | 原子检查点存取（`<outputRoot>/.builds/<id>/checkpoints/cp_*`）                                                             |

## 3. 运行隔离与身份

每次构建获得专用 agentDir 与工作目录（`server/src/agent/build-runtime/agent-dir-config.ts` `planBuildDirectories`）：

```
<dataRoot>/agent/builds/<buildId>/            ← buildRoot（进程账本在此，跨 epoch 共享）
└── epochs/e<N>/                              ← epoch 根（legacy 布局无 epochs/，直接 buildRoot）
    ├── home/                                 ← PI_CODING_AGENT_DIR（四配置 + amagi 内部库）
    ├── work/                                 ← Leader 与子任务工作目录（唯一写面 agent-outputs/**）
    └── dispatch-inflight.json / dispatch-rejections.jsonl
```

三层身份分离（`contracts.ts` `RuntimeBinding`）：**generation**（业务凭据租约，恢复换代递增）、**runtimeEpoch**（Pi 会话/amagi 内部库边界，fresh=1、成果级 rebuild +1、会话续接不变；每个 epoch 全新 home 与 amagi v2-store，不复用旧会话）、**launchId**（单次进程启动，账本关联键）。检查点缺 epoch 字段的旧记录按 legacy 布局解释。

进程宿主形态：standalone 形态下业务 server 直接运行在 Node 进程内；Electron 桌面形态下整个业务 server（含构建编排的全部进程派生）运行在 utilityProcess 子进程（`electron/server-process.ts` 启动 `dist-electron/server-process-entry.cjs`，HTTP/SQLite/agent 工作均不占 Electron UI 线程），Leader 与子任务由该子进程逐级 spawn。进程池、账本与残留扫描按环境标签（`PI_CODING_AGENT_DIR`）与 cwd 范围归属，不依赖进程层级。

冻结面（`BuildRunSpec`，`validateBuildRunSpec` 强校验）：

- 三角色模型必填且在 `modelDescriptors` 声明（未冻结模型的子任务会拿到无凭据 provider）；同池（同模型）多角色合并计容量，池容量合计 ≤ `maxConcurrentAgents`（1..6）。
- `workflowRevision`（skill 哈希）、`amagiPackage.contentHash`、`agentDirConfigHash`（四配置规范 JSON，不含密钥值）、`piVersion` 四项构成会话恢复比对集（`build-leader-supervisor.ts` `runtimeFreezeMismatches`），任一漂移拒绝原会话续接。
- Leader 环境经白名单构造（`environment.ts`）：`FEISHU_SYNC_*` 不在 amagi 子任务透传白名单，桥接凭据经 mcp.json `envRefs` 引用交付；`PI_*` 全量透传所以禁止凭据类变量进入该命名空间（`envAuditIssues` 自检）。

## 4. 身份、分配、回执与审查权威（BuildActorStore）

`server/src/kb/build-actors.ts`，持久化在 `<outputRoot>/.staging/<buildId>/build-actors/*.json|jsonl`：

- **身份链**：桥接从 env 读 `AMAGI_TASK_ID`/`AMAGI_AGENT`（受信，不采信模型参数）→ 先到者建 pending（只能读）→ Leader RPC 创建事件确认身份。续接（task_resume/自动续跑）经 parentTaskId 按作者链继承分配并撤销链上旧任务写资格（`registerTaskCreation`）。
- **输出分配**：同一目标（doc 路径或 `family:<familyKey>`）同一时刻只有一个有效分配。冲突返回 `kb_output_assignment_conflict`（409，错误自带 revoke→assign 处置参数）；未分配写 `kb_output_not_assigned`；他人持有写 `kb_output_owned_by_other_task`。同篇阻断审查修订优先 `task_resume` 原作者链，显式改派须填 `revisionFallback`（`session_unavailable`/`resume_failed`/`scope_changed`），否则 `kb_revision_resume_required`。
- **幂等回执**：幂等键 = sha256(buildId + generation + nativeTaskId + operationId)；同键同载荷返回原回执，同键异载荷 `kb_idempotency_conflict`。
- **审查独立性**：审查者不得是受审路径作者，也不得与其同处续接链（双向拒，`kb_review_not_independent` 403）。

审查权威（`server/src/kb/review-authority.ts`）：

- 回执 `dependencyHashes` 绑定四类依赖：`doc:<path>`（正文）、`knowledge-declaration`（对象/证据/覆盖声明；有范围时另记 `declaration-scope: document-v2` 标记当前文档范围哈希形态）、`source-snapshot`（来源快照）、`workflow-rules`（冻结规则哈希）；标准门禁（`gatePolicy.strict=false`）另记 `subject:<path>` 审查主体摘要——selector/覆盖/声明-only 修订不改正文时回执按主体比较保留（F01）。声明语义哈希剔除对象审查凭据字段与 calls 账本，回写凭据不自失效。
- 有效报告选取（`collectAuthorityValidatedReports`，F07）：回执 valid + 报告文件双向绑定（`reportUnitId`/`reportId`/`draftHash`）+ 聚合依赖与当前值精确匹配 + `doc:*` 逐路径哈希一致。任一漂移 → 回执不覆盖当前候选 → `review_missing` 阻断发布。`workflowRulesHash` 缺失时 fail-closed。

**阻断问题关闭规则**（WP-B1 + 复审 R1/R2）：

- 问题清单（`build_issues_submit` → `issue-lists.json`）登记时记录 `originBinding`（目标路径当时的正文+声明哈希）；重登记同 `issueKey` 继承**首次**绑定，重登记不能刷新起源。
- 只有 `gatePolicy='standard'` 的清单允许 pass 复核自动关闭；`strict` 与无标记清单 fail-closed 保持计数。
- 关闭证据 = 「精确绑定当前候选（doc:<path> 正文 + 同范围声明哈希）且 `uncheckedScope` 为空（去除空白/零宽后无任何非空条目）且 `checkedDimensions` 非空的完整独立 pass 复核」。`uncheckedScope` 非空 = 可能涉及该问题 = 不构成关闭证据——这是完全 fail-closed 的结构口径，不做自然语言排除判定。候选再变化即失去关闭效力，每次发布重新判定、不持久化关闭状态。
- 作者自述、needs_revision 复核、未构成完整复核的 pass、候选再变化后的旧 pass 均不构成关闭。

## 5. 派发链路与准入

派发路径：Leader 模型 → amagi task_submit/task_resume → **Leader 进程内转发扩展**（`server/dist/agent/pi-extension/feishu-sync-agent.js`，tool_call 钩子，模型无法绕开）→ 装载 `dispatch-guard` 编译产物 → 修正参数或阻止。

`dispatch-guard.ts`（schemaVersion 3）对每次派发：

1. 角色白名单（`dispatch_role_not_allowed`）；
2. A2 在途准入（见下）；
3. 模型覆盖冻结（`dispatch_model_not_frozen`）；
4. taskFile 位置约束（`dispatch_task_file_outside_workdir`）；strict 模式下写作/审查任务书范围检查（`dispatch_writer_scope_too_broad`/`dispatch_reviewer_scope_too_broad`：写作章节坐标跨度、CSV 单元格量、审查任务必须 `coverage.docPaths` 唯一路径）；
5. `delivery` 强制 `handle`（先登记身份再等结果）；
6. workspace 固定 `cwd=workDir, mode=existing`；scope.shell 强制 deny；写面收敛到 `agent-outputs/**`；deny 覆写为冻结禁区（原始库、标准库、agentDir 配置面等）；scope.mcp 冻结为角色精确工具名；
7. F12 完整性重核验：每次真实派发前 `verifyRuntimeIntegrity` 触盘比对四配置、child-policy 内容哈希、amagi 包全量哈希、workflow skill 字节哈希（含三个角色文件清单）——任一漂移拒绝派发。

**A2 在途准入**（确定性吞吐控制，安全边界仍是 amagi 池容量与权限冻结）：

- 宿主把在途快照原子写入 `<epochRoot>/dispatch-inflight.json`（buildId/generation/seq 单调递增/inflight 角色与状态/待审待修订计数），派发前由扩展读后交守卫。
- 规则：新写作（task_submit writer/research）池在途 +1 ≤ 池容量，且存在待审/待修订文档时最多占容量 −1（保留槽给审查与修订）；独立审查（reviewer submit）与一切 task_resume 是优先类，只受池满约束。
- 快照缺失/损坏/buildId·generation 不匹配/超过 `staleMs`（默认 15 分钟，`DISPATCH_INFLIGHT_STALE_MS`）→ fail-open（只退化为 amagi 排队，不放宽权限）。
- 放行与记账分离：全部校验通过才预留未入账槽，预留 TTL 60 秒（`DISPATCH_UNACKED_TTL_MS`）自动过期；快照 seq 前进即重置。
- 拒绝码：`dispatch_inflight_write_exhausted`（新写作 task_submit 在所属模型池达上限——无积压时上限为池容量，有待审/待修订时为容量 −1，等完成通知再派）、`dispatch_inflight_pool_saturated`（独立审查派发达所属池容量；task_resume 时全部准入池满）。拒绝事件追加 `<epochRoot>/dispatch-rejections.jsonl` 供终态度量。
- 同池容量 = 同模型（去 thinking 后缀）多角色合并为一个池，容量须一致；池容量合计 ≤ `maxConcurrentAgents`。

## 6. 监督、发布与恢复

`build-leader-supervisor.ts` 监督状态机：

- 首个 `agent_end` ≠ 构建结束（自触发轮次继续监督）；空闲（无运行轮次 + 已知子任务全部完成通知 + 桥接无活动）超过宽限（默认 3 分钟）先发一次收口提示，再次空闲按 `leader_idle` 中断。旧 epoch/旧代次任务不参与活跃判定。
- 发布终局只认真实工具回执：Leader 经 `build_request_publish` 触发应用发布校验管线 → 宿主转 `publish_completed` 事件。accepted → `publish-accepted` 终局（publication.status = published / awaiting_release）；rejected → 监督继续，Leader 修订后重试。
- 发布窗口（`build-actors.ts` `beginPublishWindow`）：校验期间到达的新写入被 `build_publishing`（409）拒绝；窗口随结算关闭。
- 取消顺序：撤代次凭据（写入立即停止）→ 关闭 Leader stdin 宽限终止（默认 10s）→ 残留核实。终止对账结果（`TerminationOutcome`）随检查点持久化；`unconfirmed` 阻断第二个 Leader，换 epoch 也不能绕过。
- 恢复三态（必须显式）：`fresh`（无恢复语义，但带旧运行事实时仍先取新鲜残留对账）；`session`（原 leaderSessionId 同 agentDir 续接，先过四项冻结比对）；`rebuild`（成果级重建：epoch+1、全新 agentDir/会话/amagi 内部库、凭应用回执重组，不依赖会话记忆）。恢复守卫：旧 Leader 存活 → `kb_leader_alive`（409）；残留对账 unconfirmed 在 15s 期限内每 2s 重试，仍不确认 → `kb_termination_unconfirmed`（409）；不支持会话续接 → `kb_resume_unsupported`；冻结漂移 → `kb_resume_runtime_changed`。
- 中断自动续跑（`kb-build-service.ts` `scheduleAutoResume`）：可恢复中断后 10s/30s 自动从检查点 rebuild，最多 2 次。

**publish-readiness**（`publish-readiness.ts`，只读预览，与发布门共用 `uncoveredWorksetTokens` 纯函数——预览 = 发布时拒绝）：

| 字段                                                                       | 语义                                                                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `uncoveredWorksetSources`                                                  | 真遗漏：`processed_not_referenced`（覆盖项已处置却无 sources 引用，须补声明或 skipped）/ `unassigned`（无任何在途写作分配负责） |
| `inFlightWorksetSourceCount`                                               | 仍在写作中的未覆盖源（不提示，只计数）                                                                                          |
| `openBlockingIssues`                                                       | 未解决阻断问题数                                                                                                                |
| `identityGapCount` / `pendingIndependentReviewPaths` / `stageBlockedPaths` | 对象身份缺口 / 待独立审查 / 阶段发布阻塞路径计数                                                                                |

发布门阻断码全集（`orchestration-contracts.ts` `PUBLISH_BLOCK_REASONS`）：`source_snapshot_mismatch`、`base_release_changed`、`missing_report`、`review_missing`、`blocking_issue_open`、`program_check_failed`、`carry_over_unmarked`、`required_review_doc_missing`、`confirm_binding_stale`、`source_disposition_missing`；staging 校验另有 `source_not_covered`（源既未被引用也未列入 skipped）与 `full_empty_output`（full 构建零产出拒绝发布空库）。处置表见 [build-operations.md](build-operations.md)。

## 7. build_* / kb_* 工具族

定义唯一源 `server/src/agent/tool-specs.ts`。v2 构建相关：

| 工具                                                                                    | 调用方        | 职责                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `build_manifest`                                                                        | Leader        | 工作集清单（每页 12 项，`nextCursor` 分页；`scope=all` 背景查询）；含 `sourceShape` 章节坐标、`identityGaps`、`carriedPublishedPaths` 等 |
| `build_assign_output` / `build_revoke_output`                                           | Leader        | 输出分配/收回（doc 路径或 family 键；revisionFallback 见 §4）                                                                            |
| `build_handoff_submit` / `build_handoff_list`                                           | 子任务 / 全员 | 交接记录提交（幂等）/ 分页读取                                                                                                           |
| `build_issues_submit` / `build_issues_list`                                             | Leader        | 聚合问题清单（blocking 需 targetPath）/ 读取最新版                                                                                       |
| `build_checkpoint`                                                                      | Leader        | `save`/`status`：检查点原子落盘与只读状态查询                                                                                            |
| `build_register_migrations`                                                             | Leader        | 对象迁移登记（merge/split/remove，后继须有共同来源证据）                                                                                 |
| `build_request_publish`                                                                 | Leader        | 申请发布当前候选（锁定候选哈希，`skipped` 带理由登记）                                                                                   |
| `kb_write_doc` / `kb_edit_doc` / `kb_delete_doc`                                        | luban         | 整篇重写（须重申全部声明）/ 局部修改（正文 patches + 证据/覆盖增量 + objectMerges）/ 删除                                                |
| `kb_submit_review`                                                                      | diting        | 审查回执（`coverage.docPaths` 单篇、`sourceRefs` 与文件头一致）                                                                          |
| `raw_read` / `raw_csv_cells` / `raw_csv_find` / `raw_search` / `raw_list` / `raw_links` | 子任务读面    | 冻结源读取（分页 + 读取回执登记）与检索                                                                                                  |
| `draft_list` / `draft_read` / `draft_search`                                            | 子任务读面    | staging 草稿读取（声明可筛选）                                                                                                           |
| `kb_read_batch`                                                                         | 子任务读面    | 批量读取（单页 `maxLines` 缺省 1200，`nextCursor` 续页，预算每页重置）                                                                   |
| `kb_tool_schema`                                                                        | 全员          | 只读查询单个工具的完整参数 schema                                                                                                        |
| `kb_unit_done` / `kb_finish`                                                            | 仅 legacy     | 旧批处理编排工具，不在 v2 角色授权面                                                                                                     |

## 8. 证据与读回执

- **读取回执**：`raw_read`/`raw_csv_cells`/`kb_read_batch` 每页登记 `readReceiptId`（`rr_*`）与资源行范围；证据声明的 selector 必须落在回执覆盖的范围内，否则发布校验报证据无覆盖回执（`server/src/agent/agent-tool-service.ts`，提示信息按资源合并相邻区间一次列出）。
- **字节预算分页**：页预算按**最终发送文本** UTF-8 字节计（含转义、坐标前缀、回执页眉），软预算 17,000B、硬上限 19,500B（pi MCP 客户端 20,480B 起截断工具输出）；超硬上限的单行页改为 `<oversized_line>` 显式跳过标记，不登记回执。`next_offset` 是唯一续页坐标（`end` 表示末页），不按 `offset+returned` 猜。
- **继承证据自动重绑**：阶段发布（progressive release）沿用未变文档时，其 text/csv/media 证据在快照复核通过后自动重绑为 `krr_stage_*` 回执并追加 `read-receipts.jsonl`（`server/src/kb/progressive-source-snapshot.ts`）；继承图片证据与冻结来源版本不符则阻断。跨构建的旧回执不可凭猜测继承——`kb_evidence_unresolved` 时按当前源重读后局部更新 selector 或整篇重申。

## 9. 配置项

`standardKb` 段（`server/src/types/agent-knowledge.ts`，缺省见 `buildDefaultStandardKbConfig`）：

| 配置                               | 范围/缺省                | 说明                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orchestrationMode`                | `'pi-amagi'`             | 新构建唯一接受值；旧值仅历史兼容                                                                                                                                                                                                                             |
| `buildRoles`                       | writer/reviewer 必选     | `modelPresetId` 引用 llm 预设（`''`=跟随活跃预设）；`thinking` 缺省 off                                                                                                                                                                                      |
| `reviewPolicy.maxAutoRevisions`    | 1..5，缺省 2             | 每个审查对象最多自动修订轮数（换稿不重置）                                                                                                                                                                                                                   |
| `reviewPolicy.maxInterfaceRetries` | 0..5，缺省 2             | 模型接口失败重试（与内容修订分开计数）                                                                                                                                                                                                                       |
| `reviewPolicy.mechanicalPrecheck`  | 缺省关                   | 审查提示词注入机械预检疑点段（只提示不门禁）                                                                                                                                                                                                                 |
| `evidenceBudgetBytes`              | 1MB..2GB，缺省 20MB      | 单 release 证据资源总量上限；未显式设置时按冻结来源数分配额度                                                                                                                                                                                                |
| `buildBatchWordBudget`             | 4000..400000，缺省 40000 | 每批有效字数预算（0=关闭按源数分批）；full 模式单元上限 ×3                                                                                                                                                                                                   |
| `buildConcurrency`                 | 1..6，缺省 2             | 全部文本构建任务共享并发上限（旧名 `buildParallelism` 兼容读）                                                                                                                                                                                               |
| `strictGates`                      | 缺省 false               | 严格门禁；构建创建时冻结进 `gatePolicy`                                                                                                                                                                                                                      |
| `retainReleases`                   | 缺省 3                   | release 保留数                                                                                                                                                                                                                                               |
| `agent.maxConcurrentProcesses`     | 1..6，缺省 3             | 非构建进程容量 M（会话与普通后台合计；后台类 ≤ M−1，M≥2 时为交互会话保留 1 槽）。构建走独立 build 通道 N=`buildConcurrency`，不受 M 截断，总运行上限 = N+M；Leader 占 build 通道 1 槽，子任务由 amagi 启动不入池（`server/src/agent/agent-process-pool.ts`） |

风险告警（`build-metrics.ts` `computeRiskWarnings`，不阻断）：`oversized_unit`（最大单元 words 占比 ≥50% 且并行 >1 路）、`reviewer_same_model`（编排流水下 writer 与 reviewer 同 provider+model）、`pool_capacity_high`（构建 N + 非构建 M 合计 > 8）。

## 10. 与 legacy 并行管线的边界

- legacy（0.4.0 之前默认）：单进程批处理流水（`kb_unit_done`/`kb_finish` 收尾轮），多模型调度骨架是 `server/src/kb/build-orchestration.ts`（B 案三轴状态机，仅存在于检查点 `orchestration` 字段的旧快照恢复）。检查点含 `leaderRun` 字段的一律走 v2 恢复，不得用旧调度器解释（`build-checkpoint.ts` 注释）。
- v2：派发系统只有 amagi；`kb_builds.orchestration_mode` 列记录每次构建的模式；度量 `metrics_json.orchestration` 段仅 pi-amagi 构建产出。
- 版本史：0.3.50 工作台发版引入；0.4.0 起构建默认 Pi 编排（`CHANGELOG.md`）。

## 11. 关键不变量

| #   | 不变量                                                                                                                             | 执法点                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | 同一目标同一时刻只有一个有效输出分配                                                                                               | `build-actors.ts` `assignOutputs`/`assertOutputAssignment`   |
| 2   | 审查者与作者进程分离（不同续接链）                                                                                                 | `assertReviewerIndependent`                                  |
| 3   | 审查回执绑定候选版本：正文/声明/来源快照/规则任一漂移即失效                                                                        | `review-authority.ts` 依赖核验 + `invalidateReviewsForPaths` |
| 4   | 阻断问题只能被完整独立 pass 复核关闭（uncheckedScope 空、checkedDimensions 非空、精确绑定当前候选）；strict/无标记清单 fail-closed | `passReviewClosureForIssues`、`openBlockingIssues`           |
| 5   | 发布只认真实管线回执；发布窗口内新写入被拒                                                                                         | supervisor `publish_completed` + `build_publishing`          |
| 6   | 终止对账 unconfirmed 阻断第二个 Leader（换 epoch 不可绕过）                                                                        | `prepareResume` 守卫                                         |
| 7   | 子任务模型工具面无 codemode/递归目录工具；派发前冻结面触盘重核验                                                                   | `child-policy.ts` + `runtime-integrity.ts`                   |
| 8   | 凭据不进 `PI_*` 命名空间；`FEISHU_SYNC_*` 不到子任务；桥接凭据按 mcp envRefs 引用交付                                              | `environment.ts` 白名单 + `envAuditIssues`                   |
| 9   | 派发守卫在 Leader 进程内执行前生效，模型无法绕开                                                                                   | 转发扩展 tool_call 钩子                                      |
| 10  | 成果真相在应用侧（候选区+账本+回执），amagi 任务终态 ≠ 构建成功                                                                    | 协议文件「结束判定」+ supervisor 终局                        |
| 11  | epoch/generation/launchId 三层身份分离，不用 generation 冒充进程身份                                                               | `RuntimeBinding` 契约                                        |
| 12  | 无法证明的残留个体不杀、不假装退出（unconfirmed 持久化）                                                                           | `process-residual.ts` 证明纪律                               |

测试入口：`server/tests/build-runtime-*.test.ts`（32 个）、`build-actors.test.ts`、`build-orchestration.test.ts`、`build-metrics*.test.ts`、`publish-render.test.ts` 等，清单见 [testing.md](testing.md)。
