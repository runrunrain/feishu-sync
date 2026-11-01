# F03-R1 修复报告：对象声明影响面授权的提交期重核（fix2-tools）

状态：**已完成并验证**（R2 修复批·工具授权切片）。基线 = 本 worktree dirty-snapshot（a776971 = 25cc0b4 + 统一修复 + 用户 WIP，未复用旧 worktree 代码/被拒 046 补丁）。

## 〇、结论速览

- **缺陷**：对象/族/旧 canonical 授权只在装配期（`buildKnowledgeDeclaration` 对象段）检查；其后工作簿/图片证据装配会 `await` 让出，Leader 可在窗口内经真实 `assignOutputs`/`revokeOutputs` 转移族归属或撤回旧主路径授权，最终落盘只重检 ctx + 目标文档（`assertV2WriteWindow`），在途声明按装配期快照越权落盘（增量复审 `family-lease-probe.mts` 复现：`familyOwner:"b", fileWritten:true, receiptCount:1`）。
- **修复**：装配期记录本次声明的完整授权影响面（`DeclarationAuthImpact`：全部涉及族 + 跨路径迁移的旧主登记），最终**同步提交段**（`writeDocCore` 内 `recheck` 之后、mkdir/原子写入之前）重核——判据与装配期完全一致（族排他 / `authorizedForDeclarationTarget` 旧主路径·族双通道）。检查与后续写入间无 `await`，与 Leader 的分配变更（同步方法）不再交错形成窗口。
- **入口收口**：单一收口在 `writeDocCore` 最终提交段——`kb_write_doc`、`kb_edit_doc`（含 `inheritDeclarationsForEdit` 继承声明重申，即 redeclare 路径）全部经此；`kb_delete_doc` 无声明路径（同步删除、无 await 窗口）未动；幂等重放路径（calls 账本/回执）在提交段之前返回，不受影响。
- **行为保留**：合法显式授权迁移（窗口内族授予写者本人 → 放行）、无冲突分配（无关族变更 → 放行）、旧模式（无 v2 child 凭据）不设防——均有正例测试。

## 一、改动清单（2 文件，+254/-1）

| 文件 | 改动 |
|---|---|
| `server/src/agent/agent-tool-service.ts` | ① 新增 `DeclarationAuthImpact` 类型（装配期记录的影响面）；② `buildKnowledgeDeclaration` 对象段在族排他/跨路径迁移检查通过后登记 `impactFamilyKeys`/`impactCrossPath` 并随返回值带出（装配期判据零改动）；③ 新增 `assertDeclarationImpactAuthorized`（同步提交段重核，错误码 `kb_object_not_authorized` 同装配期）；④ `writeDocCore` 最终提交段在 `recheck` 之后调用 ③（kb_write_doc/kb_edit_doc 单一收口）。 |
| `server/tests/build-runtime-toolfix-regressions.test.ts` | 新增 `F03-R1` describe：7 用例（5 负 + 2 正）。 |

未改：`build-actors.ts`（复用既有 `authorizedForDeclarationTarget`/`activeFamilyAssignmentFor`）、发布/审查/skill/Runtime/adapter 兄弟切片、`draft_read`/`includeDeclarations` 用户扩展、amagi 上游、前端。

## 二、验证证据（真实入口执行）

| 验证 | 命令/方式（cwd=worktree） | 结果 |
|---|---|---|
| 新增 race 用例 | `cd server && npx vitest run tests/build-runtime-toolfix-regressions.test.ts` | **33/33**（原 26 + 新 7）exit0 |
| 负对照（证明测试抓住回归） | 临时禁用提交段重核（`if (false && …)`）再跑 `-t 'F03-R1'`，随后还原 | **5 failed / 2 passed**（两个正例须双向通过）；还原后 7/7。日志 `/tmp/f03r2-neg.log`、`/tmp/f03r2-pos.log` |
| 归档反例重放（复用 incremental-review-evidence/family-lease-probe.mts 同口径） | `/tmp/f03r2-probe/family-lease-r2-probe.mts`：导入本 worktree 真实源码，同一暂停边界（`buildKnowledgeDeclaration` 完成后的既有 await），Leader 动作=真实 `assignOutputs({targetKind:'family',targets:['shared-family'],ownerTaskId:'b'})` | `WRITE_ERROR_CODE kb_object_not_authorized`；`FINAL {familyOwner:"b",fileWritten:false,receiptCount:0}`；**VERDICT: FIXED** exit0（原反例为 fileWritten:true + 成功回执） |
| F01/F06/F03 既有回归 + review 凭据 4 租约矩阵 | `vitest run tests/build-runtime-review-authority.test.ts tests/kb-knowledge-tools.test.ts tests/build-runtime-publish-cancel.test.ts` | **75/75** exit0（Root 已有审查凭据锁内 4 租约重检保留未动） |
| 发布/集成/e2e 消费链 | `vitest run tests/knowledge-publish.test.ts tests/knowledge-governance.test.ts tests/build-runtime-integration.test.ts tests/build-runtime-e2e.test.ts`；另 `adapter/bridge/knowledge-seam/knowledge-schema`、`fix-e2e/process-residual` | **78 过/3 skip**、**99/99**、**22 过/4 skip**，全 exit0 |
| server 全量 | `cd server && npm test --silent` | **2893 过 / 16 skip / 1 失败**；唯一失败 `protected-workspace.test.ts R01 server/node_modules` 为**本 worktree 环境性既有失败**：`node_modules`/`server/node_modules` 是 amagi portable symlink，`validateWorkspacePath` 的 `lstatSync` 视 symlink 非目录 → `workspace_path_invalid`（主树真实目录才判 `workspace_path_forbidden`）。已用 HEAD 版 `agent-tool-service.ts`（完全还原我的改动）复跑同用例：**同样 1 failed**（`/tmp/f03r2-ws-head.log`），证明与本修复无关 |
| typecheck / lint | `cd server && npx tsc --noEmit`；`npx eslint <两个改动文件>` | 均 exit0 |
| 前端（结算基线） | 根 `npm test --silent` | **519/519** exit0 |

新用例覆盖矩阵（暂停点=生产代码既有 await 边界，`during`=真实 `BuildActorStore.assignOutputs/revokeOutputs`，装配与终检原样执行——与增量复审 probe 同口径）：

| 场景 | 期望 | 断言 |
|---|---|---|
| kb_write_doc·族窗口内转移给他人（原反例） | `kb_object_not_authorized` | 文件未产生、无 knowledge-draft、无回执、族归属保留为目标方 |
| kb_write_doc·跨路径迁移族授权窗口内收回 | 同上 | canonical 仍 a.md、revision=1、b.md 未写、docs['b.md'] 无、回执 0 |
| kb_write_doc·旧主文档显式授权窗口内收回（目标≠旧主） | 同上（目标文档重检通过，拦截来自影响面重核） | canonical 不变、无部分写入、回执 0 |
| kb_write_doc·含真实证据装配（raw_read 回执 + text_span）同竞态 | 同上 | 同上（证据 await 路径同样被提交段收口） |
| kb_edit_doc·继承声明重申的族窗口内转移 | 同上 | 正文字节不变、revision=1、回执 0 |
| 无关族窗口内变更（负空间） | 成功 | 文件写入、回执 1 |
| 窗口内族授予写者本人（合法显式迁移） | 成功 | 文件写入、回执 1、族归属=写者 |

## 三、接口变化

- `buildKnowledgeDeclaration` 返回值新增 `authImpact: DeclarationAuthImpact`（新导出类型）；**唯一调用方**是 `writeDocCore`（已确认单一调用点），无其他消费者，无兼容窗口需求。
- 对外工具契约（错误码、参数、回执、幂等语义）零变化；新拒绝只发生在"装配期已过检、提交期归属已变"的竞态窗口（此前为越权成功，属缺陷行为收窄）。
- 兄弟切片无需接口变更（未触碰发布/skill/Runtime/adapter）。

## 四、未测边界与剩余风险

- 竞态测试的暂停门闩插在生产 `await buildKnowledgeDeclaration(...)` 边界（复审 probe 同口径）；证据装配内部的更早 await 窗口被提交段重核逻辑上覆盖（重核晚于一切 await），未逐一注入窗口内多点突变。
- 未跑真实远程模型/真实生产资料/Windows 真机（本切片与之无关，不宣称）；A23、F09/F10/F11/F12/F14 其余 finding 不在本切片范围。
- `protected-workspace R01` 环境性失败在主树（真实 node_modules 目录）不成立，属 amagi worktree symlink 形态；如需 worktree 内常绿可另行处理（非本切片授权面）。
- 事务性说明：提交段重核拒绝时正文尚未触碰（检查在 mkdir/写入之前），无部分写入——由用例断言"文件未产生/字节不变"覆盖。

## 五、回滚方式

仅逆向应用本切片净增量 patch，先 `git apply --reverse --check` 核对目标现场，再回退经核验的增量；主树集成副本为 `/tmp/feishu-build-v2-r2/tools.patch`，原实现副本 `/tmp/f03r2-mine.patch`。禁止在主树整文件 checkout/restore，以免抹去初始用户改动或兄弟修复。

**上游输入**：`agent-outputs/workflow/build-runtime-v2/incremental-review-report.md`（F03-R1 定位与证据）、`fix-integration-report.md`、`incremental-review-evidence/family-lease-probe.mts`、`CLAUDE.md`、`agent-tool-service.ts`/`build-actors.ts` 模块注释。
