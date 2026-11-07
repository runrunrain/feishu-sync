# WP-B2 报告：发布门「早发现」——发布就绪预览 + 派发侧写权冲突摩擦

上游输入：`agent-outputs/kb-build-speedup/diagnosis.md`（R3.1/R3.3）。
证据基础：`~/.feishu-sync/agent/builds/b_20261105233621_7161f7` 与 `b_20261105210253_de0b24` 的 Leader 会话 JSONL（只读取证，未写真实数据目录）。

## 1. changed files（本任务改动；同文件可能有并行任务的其他改动，此处只列本任务 hunk）

| 文件 | 改动 |
|---|---|
| `server/src/kb/publish-readiness.ts` | **新增**。共用纯函数 `uncoveredWorksetTokens`（发布门 source_not_covered 的唯一判定）、只读事实收集 `gatherWorksetCoverageFacts`、真遗漏/在途分类 `classifyUncoveredSources`、组合入口 `computePublishReadiness`、覆盖项集合 `coverageSourceIdsOf` |
| `server/src/kb/kb-build-service.ts` | ① `validateStagingDocs` 覆盖检查改为调用 `uncoveredWorksetTokens`（行为等价，判定收敛）；② `executeLeaderPublishRequestInner` 的 `kb_validation_failed` 拒绝结果随附 `readiness`（新增私有 `computeLeaderReadiness`，只读） |
| `server/src/agent/agent-tool-service.ts` | ① `build_manifest` 工作集首页附带 `publishReadiness`；② `build_checkpoint(action=status/save)` 的 statusSummary 附带 `publishReadiness`（新增私有 `buildPublishReadiness`）；③ `publishValidationIssues` 携带 `objToken`，`build_request_publish` 拒绝文本渲染为 `source_not_covered {objToken}` |
| `server/src/kb/build-actors.ts` | ① `registerTaskCreation` 续接继承按「作者链」判定（持有者是父任务后代时同样转交并撤销持有者）；② `kb_output_assignment_conflict` / `kb_output_owned_by_other_task` 错误信息带完整转交参数 |
| `server/src/agent/skills/knowledge-build/leader-protocol.md` | 仅第 7 步：申请发布前先看 `publishReadiness`，处理 `uncoveredWorksetSources`（第 3–5 步未动） |
| `server/tests/publish-readiness.test.ts` | **新增**，7 用例（见 §4） |
| `server/tests/build-actors.test.ts` | 新增 2 用例：链上转交继承、错误信息带转交参数 |

## 2. 字段说明：`publishReadiness`（manifest 工作集首页 / checkpoint status / 发布拒绝随附，同形同源）

```jsonc
{
  "uncoveredWorksetSources": [          // 真遗漏（在途已剔除）
    { "objToken": "…", "title": "…",
      "reason": "processed_not_referenced" }   // 覆盖项已处置却无 sources 引用 → 补 kb_edit_doc.sourcesAppend 或写 skipped 理由
    // 或 "unassigned"：无任何在途写作分配负责该源 → 派写作或 skipped
  ],
  "inFlightWorksetSourceCount": 2,       // 仍在写作中的未覆盖源（有活跃分配且未交接，不提示只计数）
  "openBlockingIssues": 0,               // 最新问题清单 blocking 数（checkpoint 原有字段，预览内一并给出）
  "identityGapCount": 0,                 // manifest 场景提供（与 build_manifest.identityGapCount 同值）
  "pendingIndependentReviewPaths": 0,    // 待独立复审路径数
  "stageBlockedPaths": 0,                // 阶段发布阻断路径数
  "note": "…以 build_request_publish 实时校验为准…"
}
```

- 覆盖口径与发布门**同一纯函数**：预览的「未覆盖集合」= `validateStagingDocs` 的 `source_not_covered` 集合（同一 state 上断言相等，见测试）。
- 在途判定：`活跃分配 ∧ 持有者已确认 ∧ 角色可写文档 ∧ 未提交交接回执`。交接（`build_handoff_submit`）是子任务收尾动作，已交接的持有者视为完成，其**残留 active 分配不再抑制**预览（实测 7161f7：已完成任务的分配长期保持 active，Leader 必须显式 revoke）。
- 占位源（40403 权限 / 空白工作簿 / 未展开引用）与发布门自动跳过同口径，不进未覆盖列表。
- 只读：预览不推进任何基线、不落盘、不 mutate state（源核验失败按普通源降级，发布门另有 `source_changed_during_build` 独立拦截）。

## 3. 根因分析：写权冲突（`kb_output_owned_by_other_task` / `kb_output_assignment_conflict`）

### 3.1 kb_output_owned_by_other_task（7161f7，02:13–02:15、02:40）——**应用代码缺口，已修**

实测链路：w1=4d2c8521 原写 `天下大势/天下大势系统.md` → Leader `task_resume` w1 派修订 w2=bb7c8226（`registerTaskCreation(parentTaskId=w1)` 继承分配，w1 分配 superseded、w1 身份 revoked）→ w2 完成（分配**保持 active**）→ 02:13 发布被拒 `source_not_covered` 后，Leader **再次 resume 原任务 w1**（而非最新的 w2）补 sourcesAppend → 直接父继承只找 `ownerTaskId===w1` 的 active 分配（已被转移走），新任务继承落空 → 写入被 `kb_output_owned_by_other_task`（持有者 w2）拒绝 → 子任务 blocked 退出，Leader 02:14–02:15 手工 `build_revoke_output` + `build_assign_output` 才解卡（buff 系统同型，02:40 三观系统第三次重演）。

修复：`registerTaskCreation` 的继承按「作者链」判定——持有者是父任务**后代**（`ancestryOf(holder).has(parent)`，同链续接）时同样转交给新续接任务，并撤销持有者（`superseded_by_lineage_resume`），事件记录 `lineageTransferredFrom`。不变量不放宽：supersede 旧分配 + 新建 active，同一目标同一时刻仍只有一个有效分配（测试断言 active 数=1）。跨链持有（不同任务族）仍按冲突拒绝，走 3.2 的指引。

### 3.2 kb_output_assignment_conflict（de0b24，21:26）——**Leader 操作次序问题，错误信息已带下一步**

Leader 给已存在分配的目标派**新任务**（非 resume）：`build_assign_output` 按设计报冲突（`supersedes` 只作用于同任务旧分配，与 tool-specs 描述一致，非 bug）。修复为错误信息自带完整参数：`build_revoke_output({ownerTaskId:"<holder>"})` 后重分配；存在未闭环阻断修订时优先 `task_resume` 持有者链、显式改派需 `revisionFallback`。`kb_output_owned_by_other_task` 同样带 `revoke + assign` 完整命令（含双方任务 ID 与路径），子任务可直接转述，省去 Leader 手工推断次序。

### 3.3 发布拒绝「一次列出全部」

核对现状：staging 校验的**全部** issue（含每类多条）本就随 `details.issues`/`reasons` 返回，但文本只渲染 code 不渲染 objToken（7161f7 02:12 Leader 因此反查 manifest）。已修：文本渲染 `code {objToken}：message`。跨门类（staging 失败 vs review_missing vs canPublish）仍按原次序早返回——后续门依赖 `assembleCandidateRelease` 落盘 candidate.json，在脏 staging 上强行聚合会产生误导性副作用；改为 staging 拒绝时随附 `readiness`（同一计算入口），Leader 在拒绝结果内即见全貌。门禁强度零变化。

## 4. 测试与结果（`cd server && npx vitest run …`，全部真实执行）

| 套件 | 结果 |
|---|---|
| `tests/publish-readiness.test.ts`（新增 7 例：纯函数与发布门一致＋占位/skipped 口径；在途→交接→真遗漏流转；processed_not_referenced；manifest 首页附带/翻页不附；checkpoint status 附带与流转；发布拒绝文本带 objToken） | ✅ 7/7 |
| `tests/build-actors.test.ts`（含新增 2 例：链上转交继承、错误信息带转交参数；既有 20 例回归） | ✅ 22/22 |
| `tests/kb-build.test.ts`（validateStagingDocs/source_not_covered 既有口径回归） | ✅ 38/38 |
| `tests/build-runtime-tools.test.ts`（manifest/checkpoint/分配/写入链/发布窗口） | ✅ 62/62 |
| `tests/knowledge-skill-examples.test.ts`（协议冻结契约，leader-protocol 改动后） | ✅ 通过 |
| `tests/kb-build-size.test.ts`、`tests/kb-build-parallel.test.ts`（真实发布管线 kb_validation_failed 分支过新代码）、`tests/build-runtime-toolfix-regressions`、`tests/review-subject-standard`、`tests/build-runtime-publish-cancel`、`tests/build-runtime-authority-impact`、`tests/build-runtime-review-authority`、`tests/build-runtime-bridge`、`tests/build-runtime-integration`、`tests/build-pipeline`、`tests/build-orchestration`、`tests/build-runtime-checkpoint`、`tests/kb-build-resume`、`tests/kb-auto-resume` | ✅ 全部通过 |
| `npx tsc --noEmit` | ✅ 0 错误（基线 3 个 portable-kb-service 错误已被并行任务修复；本轮结束时全仓 0 错，无新增） |
| `npx eslint`（本任务 6 个文件） | ✅ 0 问题 |

过程记录：一次 `kb-build-resume+kb-auto-resume` 首跑 3 例失败，随即两次复跑全绿（共享树并行任务中间态所致，与本改动无关，改动行不在该路径）。未运行全量 vitest（任务书约定子代理跑针对性测试；结算由 harness 以 `npm test` 收口）。

## 5. 回滚说明

按 hunk 反向还原即可，无数据/格式迁移：
1. 删除 `server/src/kb/publish-readiness.ts` 与 `server/tests/publish-readiness.test.ts`；
2. `kb-build-service.ts`：还原 import、validateStagingDocs 覆盖段（恢复内联循环）、删除 `computeLeaderReadiness` 及 kb_validation_failed 中的 `...(readiness ? { readiness } : {})`；
3. `agent-tool-service.ts`：还原 import、`buildPublishReadiness` 方法、manifest/checkpoint 两处附带、`publishValidationIssues` 的 objToken 字段与拒绝文本渲染；
4. `build-actors.ts`：还原 registerTaskCreation 继承段与两条错误信息；
5. `leader-protocol.md` 第 7 步还原原句；
6. 删除 `build-actors.test.ts` 新增 2 用例。
检查点/账本格式未变（新增字段均为只读响应字段、事件 payload 为 additive），无需数据回滚。

## 6. 风险与未覆盖项

- **在途判定依赖交接回执**：写者不交接收尾即崩溃时，其源会持续显示「在途」不提示（保守漏报，不误报；发布门仍兜底拒绝）。崩溃任务同时也会被 Leader 侧发现（无完成通知）。
- **processed_not_referenced 判定读全量 knowledge-draft coverage**（含 progressive 构建中被过滤的项）：可能把已过滤项也标为「已处置」→ 提前提示为真遗漏，方向是偏严不偏松。
- `computeLeaderReadiness` / `buildPublishReadiness` 内部 try/catch 降级为 null（预览失败不影响工具主结果与门禁）。
- identityGapCount 在 checkpoint 场景省略（manifest 场景与清单同值提供）；未在 checkpoint 重复计算重 IO。
- `kb_validation_failed` 的 `readiness` 随附仅覆盖 staging 拒绝分支；review_missing / canPublish 拒绝维持原语义（未动 WP-B1 的问题关闭逻辑）。
- 并行任务同文件编辑频繁（本任务一处渲染 hunk 曾被兄弟写入覆盖后重新应用）；结算快照以最终文件为准。
