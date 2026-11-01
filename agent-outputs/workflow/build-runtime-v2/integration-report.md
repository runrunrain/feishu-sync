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

## 六、§13.2 取消/恢复硬验收 e2e（已完成：6/6 全绿）

实测命令（cwd=server）：`AMAGI_PI_SOURCE_DIR=<amagi-pi 源> npx vitest run tests/build-runtime-e2e.test.ts` → **Tests 6 passed (6)**（~16s；最终复跑 /tmp/e2e-final2.log EXIT=0；fixture 模型无真实凭据）。

| 用例 | 硬验收 | 关键证据 |
| --- | --- | --- |
| ① 正例升级版（7.1s） | 1 Leader + 2 真实 writer 并发产 2 篇 + 独立 reviewer + 真实候选发布 | `buildConcurrency=3`（host 分池 writer 槽 K−1=2）；fixture 记录每请求 `{t, doc}`，断言 A(overview)/B(details) 模型请求时间区间**双向重叠**（min(A)<max(B) ∧ min(B)<max(A)，queued 串行不重叠）；保留真实 system/skill 读取（read 正文验证「内容质量基线」marker 后才写）；acceptedDocumentCount=2；双文档进 release；终局 `GET build` `orchestrationMode='pi-amagi'` |
| ② 运行中取消（5.0s） | ≥1 草稿已提交后取消：旧凭据拒绝、CURRENT 不切、Leader/child/桥退出 | status=cancelled；CURRENT 指针保持取消前 releaseId 不变；Leader 旧 pid ESRCH；权威账本 `staging build-actors/events.jsonl` 含 `generation_revoked`；**旧凭据拒绝直接证据（steer #4②）**：取消前经 `BuildRuntimeHost.listChildBridgeTokens`（新增诊断方法）取证真实已签发且被 write_doc 回执证明使用的桥令牌，取消后重放 `POST /api/agent-internal/tools/build_manifest`（X-Agent-Run-Token）→ **401 `run_token_invalid`** |
| ③ checkpoint 真实恢复（2.6s） | 漂移拒同会话 → 成果级恢复 → 双文档发布且 A 不重写 | provider baseUrl 漂移 → session 恢复被拒（build failed，error `kb_resume_runtime_changed`）；还原后 `resume(rebuild)` 202 → 新 Leader（成果级，代次≥2）→ 补写 details.md → diting 审查 → **published**；release 含双文档且 overview 正文为 run1 原文；权威账本 write_doc 回执 overview=1 次（不重写）/details=1 次；终局 DTO `orchestrationMode='pi-amagi'` |
| ④ 重启后保留（~1s） | 持久模式跨实例 | 新 `buildServer` 实例（同 config/home）GET build → status=published、`orchestrationMode='pi-amagi'` |

**steer #2 同步与适配（root c985790）**：`local-map-store.ts`（kb_builds.orchestration_mode 列）/`build-checkpoint.ts`（optional mode）只读副本已同步（chmod 444）；KBservice 六小段适配（saveCheckpoint 记 mode、toDto fallback `row.orchestration_mode`、createBuild 传模式、resumeBuild savedMode 优先 checkpoint→leaderRun→DB + 不受支持拒绝 + session 无冻结拒绝），未覆盖本树取消/恢复修复；root `build-runtime-persisted-mode.test.ts` 4 例同步后本树实测 **4/4**。

**恢复 300s 卡死根因（steer #4③ 澄清）**：非 read-receipts/kb_evidence_invalid（未复现）——实为成果级恢复复用同一 pi 会话：resume 判定误锚首条 user（原始任务）走 fresh 分支，且 diting 派发计数把取消前已终止的派发算作在途 → 永等被杀子任务。修复：resume 判定锚定**末条** user（续接 briefing）+ 派发/审查计数只统计 briefing 之后切片。产品门禁零删改。

**多轮实测修复（均 fixture 行为不当）**：amagi 死循环保护（同参连续 4 次调用即终止子任务）×3 → read 垫拍交替/递增路径/调用计数控制时长；桥结果文本词序（`已提交交接记录 ho_`/`已提交审查报告 kr_` 与旧断言不符）→ 按真实文本匹配；角色判定被技能正文词汇污染（diting 误入 writer 分支调未授权工具）→ 锚定首条 user；fixture 步数上限 60→200。

## 七、最终验证汇总（本切片增量）

- `npx tsc --noEmit` EXIT=0；`npx eslint`（改动 5 文件）EXIT=0
- e2e **6/6**（install/正例并发/取消/恢复/重启保留）；persisted-mode 4/4 + 自有 integration 16 + checkpoint 4 = **24/24**
- 未整体重跑：前轮兄弟+回归批次 335/335 在最后三处 additive 改动（host 诊断方法/index 挂钩/KBservice 模式段，root 已于其环境验证）后未再全套重跑，如需由 Leader 统一回归
- 模型为本地 fixture（确定性脚本）——**非真实模型质量**；UI 复验归 Leader（root 侧已过）

## 八、阶段交付（steer #5：停止 fixture 迭代，保存现场移交 findings 修复批）

### 本轮产品代码变化（对照主链终版；注：仓库无 `c593` git 对象，锚定主树 `c985790→25cc0b4` 系列）

产品源码仅 3 处、均为 additive：
1. `server/src/kb/build-runtime-host.ts`：+`listChildBridgeTokens(buildId)` 诊断方法（~6 行；e2e 旧凭据重放取证用，撤销后立即失效，不新增授权面）
2. `server/src/index.ts`：+`__listChildBridgeTokens` 挂钩（2 行，与 `__agentToolService` 同区，仅诊断出口）
3. `server/src/kb/kb-build-service.ts`：root c985790 模式持久化 6 小段适配（saveCheckpoint 记 orchestrationMode / toDto fallback `row.orchestration_mode` / createBuild 签名+传模式 / resumeBuild savedMode 优先 checkpoint→leaderRun→DB + 不受支持拒绝 + session 无冻结拒绝 + updateKbBuild 传模式）——未覆盖本树取消/恢复逻辑

整文件同步（root 版本，chmod 444）：`local-map-store.ts`（kb_builds.orchestration_mode 列）、`build-checkpoint.ts`（optional orchestrationMode）；测试副本 `build-runtime-persisted-mode.test.ts`（本树 4/4 实测过）。

### 并发用词纠正（steer #5 要求）

早前 K=2 轮次（buildConcurrency=2 → host 分池 writer 槽=1）A/B 为**串行**（amagi 后台单槽排队，B 等 A settle 后才启动）——此前若表述「并发」不成立，予以纠正。终版 K=3（writer 槽=2）后为真实重叠：fixture 记录每请求 `{t, doc}`，正例断言 A(overview)/B(details) 模型请求时间区间双向重叠（min(A)<max(B) ∧ min(B)<max(A)）实测通过；未把 queued 计为并发。

### F09/F10/F11 如实移交（e2e 绿 ≠ 产品闭环）

- **F09**（rebuild 同 home+固定 sessionId 复用旧会话；旧 actors running 未清）：本树恢复用例通过依赖 fixture 侧适配（resume 判定锚定末条 user、派发计数取 briefing 切片），**未修产品根因**；修复归 findings 批，修后可直接复用本套 e2e（断言覆盖漂移拒同会话/成果保留/不重写已接受稿/双文档发布/代次≥2）。
- **F10/F11**：本树未触碰；取消用例的 401 重放证据与既有四断言（cancelled/CURRENT 不切/ESRCH/账本 generation_revoked）可在产品修复后复验。
- F01–F08 等其余 findings 不在本切片写面，未触碰。

### 清理与现场

专用 Pi/桥进程零残留（`pgrep -f 'build-b_'` 0）；e2e 临时 home 由 afterAll 常规清理，失败轮次日志保留于 `/tmp/e2e-ext*.log`；工作树改动未提交（Leader 统一回流）；兄弟只读副本未改动。
