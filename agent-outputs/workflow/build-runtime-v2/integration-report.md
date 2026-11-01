# 构建重构 v2 · 生产集成切片报告（第 2 轮 · DONE）

> 执行树：`.amagi-worktrees/build-v2-integration`（未提交；初始用户改动保留）。本轮以主树为唯一权威 API 源消费 R/E/T/U 成果（29 项只读副本全 md5 对齐，含 #12/#13 接缝与 child-policy）；自写面仅限任务书授权文件。
> 首轮「三方源码未公开」报告作废。**本轮交付：生产 API 成功发布端到端全绿（非 probe 替代）+ 发布安全缺口修复 + 质量基线真实物化 + DTO additive 字段。**

## 一、Leader steer 逐项落点

| Steer | 落点 | 验证 |
|---|---|---|
| #3 DTO additive | `LeaderRunProgressDto` 增 `termination`（cancelling/finished/none；仅检查点时如实 null）与 `skill{path,revision}`；`summary.openBlockingCount/queueReason(null)` 如实（无可靠 native 字段不虚构）；`leader.resumeCapability` 暴露恢复级别 | e2e 断言 openBlockingCount=0、skill.revision 64hex、termination=finished |
| #4 多端点拒绝 | `resolveLeaderModels` 三角色端点集合 ≠1 → 显式 `build_mode_unavailable` 400 不降级（核实已在位） | 代码复核 + 契约测试（主树侧） |
| #5 质量基线 | `materializeWorkflowSkill()`：六协议模板 + 内置 promptAssets（buildRules/styleGuide/reviewPrompt）单文件物化，内容 sha256=workflowRevision（规则变化→session 恢复被拒） | e2e：物化文件含「内容质量基线」marker |
| #6 发布安全 | `executeLeaderPublishRequest` 重写：复用 runPipeline 权威入口——`throwIfPoisoned`+`validateStaging`+`verifySnapshotIntact`（PathGuardError code 映射）；programChecks 真实；publishRelease 前后取消/代次重检；发布后候选漂移检测；两模式 accepted 后 `publishLock`+host `settlePublishWindow()`（撤销全部子任务写令牌，Leader 令牌保留收尾） | 7 门禁回归：候选漂移/代次不符/窗口已结算/取消竞态/坏候选(混入非md)/变化来源/缺审查 → CURRENT 全程未切换 |
| #7 夹具复用 | e2e fixture SSE 对齐 probe 定稿格式（OpenAI chunk、tool_calls 单帧完整）；probe 夹具零改动 | e2e 模型真实往返 |
| #8/#9 不假 pass | codemode 防御归 child-policy（20d7aaeb accepted，root probe 35pass/0fail）；本切片未动、未假通过 | 如实记录 |
| #11 skill 可读接缝 | 物化路径迁至 **`<dataRoot>/agent/builds/<id>/home/skills/workflow-skill.md`**（build 专用 home，与 policy/config 禁区分开；outputRoot 整体禁区不再使用） | e2e：子任务 `read` 真实返回正文 + 「内容质量基线」marker 验证通过后才写作 |
| #12 系统注入 | 副本同步（adapter appendSystemPrompt/pi-rpc terminate 等close）；briefing/resumeBriefing 减掉重复全文只留材料/计划+skill 路径；物化 hash=sha256(全文) 与 adapter 校验同口径 | e2e 通过（adapter start/resume hash 校验真实执行） |
| #13 child-policy | `child-policy.ts`/`agent-dir-config.ts` 副本同步；host 以新 renderer `computeAgentDirConfigHash(files)` 回填 spec（同步即生效） | agent-dir-config/adapter 副本测试全绿 |
| #14 生产成功发布 | **独立达成**（见 §二；非 probe 替代） | e2e 3/3 |

## 二、生产 API 成功发布端到端（目标 7；fixture 模型，非真实模型质量）

`POST /api/kb/build-runtime/install`（source 物化+真实 pi CLI 安装 2.21.31）→ `POST /api/kb/builds` 202 → **真实 pi Leader** → `task_submit` 真实派发 → **真实 amagi 子任务**（真实 pi 子进程；amagi.json skills 指向物化文件）→ 子任务 `read` 真实读取技能正文并验证规则 marker → MCP 桥接真实写入（`kb_write_doc`）→ `build_handoff_submit` → 完成通知以 user 消息回流 Leader → diting 真实独立审查（`kb_submit_review`）→ `build_request_publish` → `executeLeaderPublishRequest` 真实权威校验 → `canPublish` → `publishRelease` → **published**（~7s）。

真实产物：`standard/CURRENT.json` 指针 + `releases/r_20261101T110918_eb99be/docs/combat/overview.md`；终局 `/leader` 200（`publishRequest.accepted=true`、`endedReason=publish-accepted`、`termination=finished`）；检查点带 `publishLock`+`publishRequest`+成果账本（write_doc 回执/审查报告）。

本轮实测修复（真实链路暴露）：① actorStore 代次与凭据代次失配（监督器换代递增未带动账本 rotate → `credential_generation_revoked` 全拒）→ `rotateGeneration` 回调接线；② `entry.leaderRun` 在 runLeaderPhase 返回后才赋值 → 全程检查点无 leaderRun → `onReady` 状态就绪即挂引用；③ 监督器状态对象替换致引用分叉 → prepareResume/finally 原地变更；④ 发布结算即时落盘（终局后 live/entry 路径消失，检查点是唯一真相源）。

## 三、验证汇总（全部真实命令，cwd=server）

- `npx tsc --noEmit` EXIT=0
- 自有测试：`build-runtime-integration.test.ts`（16）+ `build-runtime-checkpoint.test.ts`（4）= **20/20**；`build-runtime-e2e.test.ts` **3/3**（跳过条件如实：pi PATH/amagi 源缺失时 skip 并说明）
- 兄弟副本+回归批次（12 兄弟文件+5 回归）：**335/335**（adapter 重同步后 22/22 复验）
- `npx eslint`（6 个改动文件）无输出

## 四、写面与回滚

改动（本切片 diff，未提交）：`server/src/index.ts`（BuildRuntimeHost 接线）、`server/src/kb/build-runtime-host.ts`（新）、`server/src/kb/build-leader-supervisor.ts`（重写为纯监督状态机）、`server/src/kb/kb-build-service.ts`（leader 模式分支/发布执行器/模型解析/skill 物化）、`server/src/kb/build-checkpoint.ts`（schemaVersion 2）、`server/src/routes/kb.ts`（build-runtime 端点）、`server/src/types/agent-knowledge.ts`（v2 契约）、测试 3 文件、skill 6 文件（前轮）。回滚=丢弃工作树未提交改动（保留基线 2c82041 初始 diff 需单独核对）。兄弟只读副本清单：`amagi-task/sibling-deps-manifest.txt`（29 项全 SYNCED，chmod 444，不作为交付 diff）。

## 五、未覆盖项（如实）

- e2e 的取消/恢复真实链路未跑（监督器级单测已覆盖取消三步序/换代撤凭据/冻结比对拒绝续接/续接父链继承）。
- 模型为本地 fixture（确定性脚本）——**非真实模型质量**；真实 LLM 性能未测。
- codemode 防御（#8/#9）归 child-policy 任务；root native probe 已绿，本切片不重复。
- UI 适配由 Leader 续接（DTO 字段已 additive 就位）。
