# 研究报告：build-runtime-v2 — Pi + amagi-pi 构建编排重构（只读调查与切片建议）

> 任务：按《基于Agent基座与工作流插件的构建重构设计-v2》调查现有 feishu-sync 实现，产出模块符号、可复用链路、接口建议、验收矩阵、并行切片建议与真实运行测试可行性。**未修改任何源码。**
>
> 证据基线：
> - feishu-sync 工作区：main @ `aa13b34`（与设计 §15 声明的基线一致）+ **14 个文件的未提交用户改动**（§1.6，实现切片必须避开或等待其落地）
> - amagi-pi：/Users/run.mao/workpace/amagi-pi @ `929000e`（package 2.21.31，与设计/核查报告基线完全一致，本次抽查复核关键条目均吻合）
> - pi：1.4.0（本机 Node v24.21.0 全局安装，docs 实读）
> - 设计文档：492 行全读；核查证据 `amagi-pi-嵌入能力核查.md` 271 行全读；`docs/design/agent-knowledge-design.md`（783 行）、`docs/design/kb-agent-upgrade-design.md`（644 行）全读
>
> 结论索引（下游按行回查正文）：
>
> | # | 主张 | 状态 | 锚点 | 适用边界 |
> |---|---|---|---|---|
> | F1 | 设计 §11 引用的行号（runPipeline 682 / runOrchestratedPhase 3016 / runOrchestratedIntegrate 3338 / buildPiEnv 2140 / resolveRoleModel 4011）与当前工作区一致 | 观察 | §1.1 | 未提交改动未移动这些定义行 |
> | F2 | `orchestrationMode`/`pi-amagi` 在 server/src 与 src 中零命中，设计 §8 全部结构均为拟新增 | 观察 | §1.1 | grep 全仓（含前端） |
> | F3 | 设计 §1.2 全部 11 项 amagi-pi 事实在 929000e 抽查复核成立（env 白名单、PROVIDER_KEY_MAP zhipuai、skills allowlist、--tools 强制覆写、准入分池、mcp 路由、角色卡工具名单） | 观察 | §2 | amagi-pi 2.21.31 @929000e |
> | F4 | pi `tool_call` 扩展钩子官方语义支持"Authorize or **modify** a tool call"——派发守卫改参有文档依据，但"改参进入冻结契约"仍须实测（设计 §14 已自认） | 观察推断 | §2.4 | pi 1.4.0 extensions.md L159 |
> | F5 | amagi 子进程读面由 file-permission 执法（read-override → fileReadPermissionBlockReason），写面由 AMAGI_PROTECTED_PATHS/ALLOWED_PATHS guards 执法；"禁区禁读"依赖 grant 读范围，**实际拦截语义未实测** | 观察+推断 | §2.5 / §9-P0 | 核查报告自称 file-permission 细则未逐行核 |
> | F6 | 现有 PiRpcProcess 单活跃 run（`run_in_progress`）与 amagi 完成通知自触发新一轮（triggerTurn）不兼容，需构建模式适配 | 观察 | §3-C1 | pi-rpc-process.ts L477/478 |
> | F7 | 工具重名风险确认：app TASK_TOOL_NAMES 与 amagi task_* 同名；但转发扩展只注册 server 下发清单，构建 Leader 不下发 app task 族即不重名；`--tools` 白名单同时过滤 amagi 注册面 | 观察 | §3-C1 | §1.2/§2.2 |
> | F8 | 未提交改动集中在 kb-build-service.ts（截断续接+修订轮）与 agent-tool-service.ts（声明回读+删除守卫），与实现切片的主写入面重叠，需串行或先落地 | 观察 | §1.6 | git diff 全量核对 |
> | F9 | 真实运行测试可行：本机 Node 24.21.0 + pi 1.4.0 + amagi-pi 本地源码 + GLM（zhipuai）密钥配置链齐备；六源对照需真实模型额度与临时 FEISHU_SYNC_HOME | 观察 | §8 | 本机环境探测 |

---

## 0. 调查范围与证据基线

| 输入 | 路径 | 读取状态 |
|---|---|---|
| 设计 v2 | /Users/run.mao/workpace/Database/.../基于Agent基座与工作流插件的构建重构设计-v2.md | 全文 492 行 |
| 核查证据 | 同目录 v2-核查证据/amagi-pi-嵌入能力核查.md | 全文 271 行 |
| 基线设计 | docs/design/agent-knowledge-design.md | 全文（含 §16/§17/§18 修订） |
| 升级设计 | docs/design/kb-agent-upgrade-design.md | 全文（含 S0–S14 实施勘误） |
| 项目约定 | CLAUDE.md（项目上下文注入） | 已读 |
| amagi-pi 源码 | /Users/run.mao/workpace/amagi-pi @929000e | 抽查 task-run/admission/mcp-config/guards/read-override/agents 卡/task-facets |
| pi 文档 | pi-coding-agent 1.4.0 docs（cli/json/extensions/mcp/models-configuration/rpc） | 按需实读 |
| 用户未提交改动 | git status/diff（14 文件 +182/−32） | diff 全量 |

---

## 1. 现状代码地图（模块符号 + 锚点）

### 1.1 构建流水线（server/src/kb/）

**kb-build-service.ts（6217 行，仓库最大核心模块之一）**

| 符号 | 行号 | 现状语义（对设计的意义） |
|---|---|---|
| `runPipeline(localMapStore, buildId, mode)` | L682 | 唯一流水入口：preflight（快照/BuildSpec 冻结/governance 冻结/闭包/图片预描述）→ running（三路分支）→ validating → publishing/awaiting_release。**orchestrationMode 分支的插入点**：L1142 `orchestrated = reviewPipelineActive(...)` 与 L1146 `singleProcessPath` 判定处 |
| 三路分支 | L1173-1320 | ①`orchestrated`（B 案审写修整流）②`workerCount<=1` 单进程等价回退 ③W≥2 单元并行。新模式为第四条分支，**不进入 ①的 runOrchestratedPhase** |
| `runOrchestratedPhase` | L3016 | 应用侧调度器（readyTasks 循环+inflight 并发+acceptance 闭环）——**新模式的对照物，绝不复用**（见 §6 防线） |
| `runOrchestratedIntegrate` / `runOrchestratedIntegrateRevise` | L3338 / L3395 | 整合轮（未提交改动正在改这两处） |
| `buildPiEnv(...)` | L2140 | 构建 worker 环境：`buildPiProcessEnv` + PROVIDER_JSON/PLUGIN_SNAPSHOT/PI_PACKAGE_ROOT。**扩展点**：构建 Leader 需追加 `ZHIPU_API_KEY`、两类凭据变量、`AMAGI_AUTO_VERIFY_OFF=1` 等（设计 §11） |
| `spawnBuildProcess` | L2166 | 单进程 spawn（等价回退路径）：`toolsForRunKind('build')`、`noSession:true`、cwd=`agent/empty-cwd`、`set_auto_retry off`、pool.register('build') |
| worker spawn（无名单） | L2440-2507 | orchestrated/并行 worker spawn：`roleModel.apiKey` 注入、`poolKey` 注册。Leader spawn 的骨架参考 |
| `resolveRoleModel(buildId, role)` | L4011 | 角色模型解析（writer/reviewer/integrator → model/apiKey/providerJson/thinking）；`describeRoleModel` 冻结进 BuildSpec（diting F05）。**直接复用于 amagi.json 角色模型生成** |
| `frozenRoleMismatches` | resumeBuild L609+ 与 runPipeline 内 | 冻结模型与当前配置一致性校验——resume 新分支复用 |
| `resumeBuild` / `cancelBuild` | L594 / L644 | 检查点恢复（`BuildCheckpointStore.read`→verifySnapshotIntact→runPipeline(resume)）与取消（cancelRequested+abort 全 worker）。`awaiting_release` 可取消（T2b） |
| `terminateAllWorkers` | L2898 | 构建 worker 终止集——Leader 终止+残留核对的新分支挂点 |
| `releaseConfirm` / `releaseConfirmInner` | L4513+ | 待确认发布：candidate.json 绑定候选哈希、重新 verifySnapshotIntact+确定性校验+canPublish。**设计 §5.4"申请发布→全量校验"的现有对应物，可复用为发布出口** |
| `promptUnitWithTrace` | L4217（未提交新增） | 截断续接（model_output_truncated 后续写提示）——**用户在途工作** |
| `emitBuild`/`emitLog`/events.jsonl | L314/L337 + L328 | 构建事件双写（SSE + `<outputRoot>/.builds/<buildId>/events.jsonl`）——RuntimeEvent 持久化的现成底座 |

**build-orchestration.ts（835 行）**：`BuildOrchestration`（三轴状态机）、`buildSpecFromConfig`（构造即冻结 specHash）、`computeSnapshotHash`、`reviewPipelineActive(spec)`（reviewer 显式配置才走新流水）、`nextAttemptTaskId`。新模式下 BuildSpec 仍可冻结角色模型/发布方式（供 candidate/acceptance 用），但 `readyTasks()` 驱动执行**不启用**。

**orchestration-contracts.ts（482 行）**：`BuildRole = 'plan'|'write'|'review'|'integrate'|'final_review'`；`BuildSpec{roles,reviewPolicy,publishMode,resolvedRoles,sourceSnapshotHash,specHash}`；`CandidateRelease`（含 acceptance 绑定 validReportIds+candidateHash）；`canPublish`。**设计 §8 的 ActorBinding/OutputAssignment/ReviewReceipt 与 CandidateRelease.acceptance 是同构概念，发布链可对接**。

**path-claims.ts（61 行）**：`PathClaims.claim(path, unitId)` —— owner 是任意 string，**持有者从 unitId 换成任务身份零结构改动**（设计 §4.2 判断成立）；认领只存内存、构建结束销毁（OutputAssignment 需要持久化进 BuildCheckpoint——checkpoint 已有 `claims: PathClaimPreload[]` 字段）。

**build-units.ts（305 行）**：`planUnits`（增量=连通分量、全量=目录聚类、闭包链接）、`packBatches`。新模式复用其"源大小/索引/影响分析"产出材料清单，不用于决定工作者数量。

**build-checkpoint.ts（211 行）**：`BuildCheckpoint`（含 orchestration 快照 additive 字段、KNOWLEDGE_ARTIFACTS 白名单：knowledge-draft.json/organization-plan.json/read-receipts.jsonl/candidate.json/governance-freeze.json）。`BuildCheckpointStore.save/restore/read`。

**publication-service.ts（1571 行）**：`KbPublishService`（L469）、原子发布（staging→releases rename→CURRENT tmp+rename）、retainReleases 清理。发布真相=指针+manifest，与新模式无耦合，直接复用。

### 1.2 进程与扩展（server/src/agent/）

| 符号 | 锚点 | 对设计的意义 |
|---|---|---|
| `PiRpcProcess` | pi-rpc-process.ts；spawn args L157-210 | `--mode rpc --no-extensions --no-skills --no-mcp --no-approve --offline ...`；`--tools` 仅在 `tools.length>0 && !allowExternalPluginTools` 时传（L163-166）——**构建模式传显式白名单即可，现有参数逻辑兼容**；`-e` 支持 extensionPath+additionalExtensionPaths 多扩展；`--provider/--model` 拆分注入（L184-193）；`--skill/--prompt-template/--theme` 逐项追加（L173-176） |
| `RPC_COMMAND_WHITELIST/BLACKLIST` | L33-58 | prompt/steer/follow_up/abort/get_state/…/compact；禁 bash/fork/clone 等。构建 Leader 监督沿用 |
| 单活跃 run | `prompt()` L477 | `run_in_progress` 抛错——**与 amagi 完成通知自触发轮次冲突（F6）**；`activeRun` 状态机只认自己发的 prompt |
| `terminate(graceMs=3000)` | L743 | 3s 宽限后 SIGKILL/Windows taskkill。**设计 §9 要求构建 Leader 宽限可配置（建议 10s）** |
| `buildPiProcessEnv` | L712+ | app-llm 白名单继承 / pi-agent-dir 继承剔除 `FEISHU_SYNC_AGENT_*`；`PI_CODING_AGENT_DIR=<dataRoot>/agent/pi-home` 强制；`PI_OFFLINE/PI_SKIP_VERSION_CHECK/PI_TELEMETRY`。**注意：构建 agentDir 要换成 `<dataRoot>/agent/builds/<buildId>/home`——此处是硬编码 pi-home 的唯一注入点** |
| 转发扩展 `feishu-sync-agent.js` | 176 行 | ①启动 GET /api/agent-internal/tools 注册工具；②app-llm registerProvider；③tool_call 对非本扩展工具 block（fail-closed）；④`FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS='1'` 时 external() 全量放行+session_start setActiveTools 全量激活（L160-168）——**构建模式必须新增"白名单收窄"分支，不能设该变量**；⑤守卫挂点：`pi.on('tool_call')` 返回 `{block:true,reason}` 或 undefined——**改参返回形态需按 pi 1.4 扩展协议实现（§2.4）** |
| `AgentProcessPool` | agent-process-pool.ts；头注 L1-35 | 三通道：session（立即语义）/background（≤M−1 FIFO）/build（独立 N=buildConcurrency）。`acquire(kind,{signal})`、`configure({buildConcurrency})`、F3-R05 预留-再-spawn。**Leader 占 build 通道 1 槽位直接可用**；子任务由 amagi 启动不入池 |
| `AppPluginStore` | app-plugin-store.ts | `snapshot(scope)/frozenSnapshot(revision)`：内容寻址快照（0600），AppPluginSnapshot{extensionPath,extensionPaths,skillPaths,promptPaths,themePaths,externalPlugins}。构建快照冻结机制可参照；但**构建 Leader 不加载 knowledge-workbench 内置包（设计 §3.4）**，agentDir 配置生成是新模块 |
| `PiPluginService` | pi-plugin-service.ts L20+ | `agentDir = <dataRoot>/agent/pi-home`（settings.json 管理、内置 knowledge-workbench 包写入）。**版本化 amagi-pi 安装目录（`<dataRoot>/agent/runtime-packages/amagi-pi@<ver>/`）是新增面**：pi install 到新 agentDir、审计包列表、活动构建拒绝删除——该类有 `running()/retireIdle` 互斥模式可借鉴 |
| `PiRuntimeResolver` | runtime-resolver.ts | 显式覆盖>env>候选发现；校验包根 package.json name/version/dist/cli.js；缓存+recheck。**probe() 的 Node/pi 探测复用；amagi 包探测（版本+内容哈希+与子进程同源核对）是新增** |
| Claude 路径 | claude-code-process.ts L156 | spawn `-p --bare --tools '' --strict-mcp-config`（与设计 §10 描述一致）；`ClaudeCodeProcess extends PiRpcProcess`（duck-typed）；`createClaudeProcess` 工厂。**--bare 模式内置子 agent 被关死，事件解析排除 parent_tool_use_id——设计 §10 改造点确认存在** |
| MCP 桥 `claude-bridge.cjs` | 50 行 | stdio→回环 `/api/agent-internal/*`（tools/list+tools/call），`X-Agent-Run-Token`。**未读 AMAGI_TASK_ID/AMAGI_AGENT、未转发 _meta toolUseId——设计 §11"抽出通用 stdio 桥"的两处扩展点确认** |
| `TaskService`（app 任务族） | agent/tasks/task-service.ts | 应用自己的 task_* 编排（agent_tasks 表、pool.acquire('background')、冻结工具集=角色∩父模式）。**构建 Leader 工具集必须剔除（重名+双调度系统）**；`orchestrationEnabled()` 开关在 AppPluginStore 'orchestration' 条目 |

### 1.3 工具面与身份（server/src/agent/）

| 符号 | 锚点 | 对设计的意义 |
|---|---|---|
| `toolsForRunKind(kind)` | types/agent-knowledge.ts L810 | discuss/work/build/probe/task 五面。`BUILD_TOOLS`（15 个）现含 kb_write_doc 等。**新模式需要拆分：Leader 面（材料清单/输出分配/问题清单/检查点/申请发布 + 无 task 族冲突）与子任务面（经桥接）是两个新面** |
| `AgentToolService.registerToolFamily` | agent-tool-service.ts L415 | 工具族注册（spec+runKinds+execute）；`computeAllowedTools`（disableToolFamilies/allowedToolsOverride，子任务永不含 task_*/app_command）。**新增"build-leader"/"build-sub"工具族的注册骨架现成** |
| `BuildWorkerInfo` | L212-224 | `phase: 'unit'|'final'|'plan'|'review'` + 未提交新增 `revision?: boolean`。**子任务绝不能复用 worker.phase 伪装（§6 防线）**——`assertPathClaim`（kb_write_doc/delete 处）与审查提交门禁都按 worker.phase 判定 |
| `createRunContext` | L577+ | 每进程发新令牌（X-Agent-Run-Token → runKind/allowedTools）。**设计 §4 两类凭据（Leader/子任务凭据，绑定 buildId+generation）需要新令牌域**：现有 token 是进程级一次性，无代次撤销 |
| runKind 判定 | routes/agent-internal.ts（三重校验：回环+无 Origin+token） | 内部 API 是工具唯一入口——**桥接带来的子任务身份（AMAGI_TASK_ID/AMAGI_AGENT）在此层解析并叠加代次校验** |
| 知识协议工具 | tool-specs.ts（KB_SUBMIT_PLAN/KB_GET_PLAN/KB_SUBMIT_REVIEW、KB_WRITE_DOC objects/claims/evidence 声明） | 设计 §7"工具减负"（局部编辑/批量读取/服务端变更集）在 kb_write_doc 体系上扩展；KB_DECLARATION_CONSTRAINTS（server 分配身份、拒自报）已是现成门禁 |

### 1.4 发布与校验

- `validateStaging`（runPipeline validating 段 L1342+）：确定性校验（header/来源/覆盖/正文量）→ report.json。
- candidate 链：`assembleCandidate`（L4470 附近，CandidateRelease+candidateHash 落盘 candidate.json）→ `publishMode==='confirm'` 停 `awaiting_release` → `releaseConfirm` 复核发布。**设计 §5.4 的"申请发布具体候选版本→全量检查→按策略切指针"与该链语义一致；Leader"申请发布"工具应驱动同一出口（不能让模型直接挪指针——现状已保证）**。
- `KbVersionStore`/knowledge-draft.json/read-receipts.jsonl：声明真相文件（检查点白名单内）。

### 1.5 前端（src/）

| 组件 | 说明 |
|---|---|
| `src/components/kb/KbBuildPanel.tsx` | 构建面板（进度/日志/取消/恢复）；`BuildLogLine`、SSE 消费 |
| `src/components/knowledge/BuildOrchestrationProgress.tsx` | 编排进度（任务/排队原因/接口重试）；`waitingReasonOf`/`orchModelLabel` 导出 |
| `src/components/kb/KbPublishModal.tsx` / `KbPublishPanel.tsx` | 发布确认（awaiting_release） |
| `src/components/agent/TaskPanel.tsx` | 会话任务区（app task_*，与新模式无关但交互模式可参考） |
| `src/components/settings/BuildOrchestrationSettings.tsx` | 角色模型/审查预算/发布方式设置——**orchestrationMode 选择器的落点** |

### 1.6 未提交用户改动（写面冲突清单，git diff 全量核对）

| 文件 | 改动内容 | 与实现切片的冲突 |
|---|---|---|
| `server/src/kb/kb-build-service.ts`（+43/−9） | `promptUnitWithTrace` 截断续接（phase 增 'revise'/'integrate_revise'）、setWorkerAssignment 增 revision 标记、整合修订轮"恢复检查"提示 | **直接重叠**：orchestrationMode 分支插在 runPipeline L1142 附近、resumeBuild/cancelBuild 改动区相邻 |
| `server/src/agent/agent-tool-service.ts`（+68） | draft_read `includeDeclarations`、`kb_revision_delete_forbidden`、coverage 身份漂移守卫 | **直接重叠**：新工具族注册同文件 |
| `server/src/agent/tool-specs.ts`（+3/−1） | DRAFT_READ_SPEC 增参 | 轻微重叠 |
| `server/src/modules/model-selection.ts` + 新文件 `model-output-limits.ts` + 测试 | suggestedMaxOutputTokens 默认输出上限 | 独立，无冲突 |
| `server/src/agent/vision/vision-describer.ts`、`src/components/preview/MarkdownView.tsx`(+test)、`ModelProviderSettings.tsx`、`AgentSettingsCard.tsx`、`server/tests/kb-knowledge-tools.test.ts` | 小修 | 无冲突 |

**结论 F8**：kb-build-service.ts 与 agent-tool-service.ts 是切片主写面，且正被在途改动修改。建议：实现启动前先请主上提交/落地这批改动，或把对这两个文件的切片排在其后串行；新模块（agentDir 生成、桥接、适配层）尽量放新文件减少重叠。

---

## 2. amagi-pi 侧关键事实核对（929000e 实查，设计依赖项）

对核查报告的 14 项结论做了抽查复核，重点核对设计 §3/§4 依赖的条目，全部成立：

### 2.1 子进程环境（task-run.ts L107-201 实读）
- `ENV_WHITELIST` 硬编码（PATH/HOME/代理变量/AMAGI_* 非凭据类）；`PI_*` 前缀**全量透传**（L174-177）→ `PI_CODING_AGENT_DIR` 是子进程加载 amagi-pi 的唯一通道（构建 agentDir 因此有效）。
- `PROVIDER_KEY_MAP`（L137-161）实读确认 `zhipuai: ["ZHIPU_API_KEY"]`——设计 §3.2 "provider id 取 amagi 已有密钥映射" 成立；无自定义条目、无追加配置 → 未映射 provider 报不支持是唯一诚实路径。
- `AMAGI_TASK_ID`（写归因/steer 定位/orphan 血统）与 `AMAGI_AGENT`（MCP 角色路由+baize 只读 override）在 spawn 时冻结注入（L191-196）——桥接身份来源确认。可伪造性：对本进程是只读事实；伪造他人归因需他人 `AMAGI_PERMISSION_GRANT` 三件套（per-task 冻结），推断不可得。
- 追加透传键**无配置项**；`FEISHU_SYNC_*` 不达子进程——设计 §1.2 前提成立。

### 2.2 spawn 与工具面（task-run.ts L1745+ / agents 卡实读）
- 三条 spawn 路径（sync/background/resume）汇入 runPiTask 唯一引擎；P4 冻结授权路径 `--tools = grant.tools ∩ 派发工具面 + [codemode, toolcall_continue]`（enforceToolsArgument 强制覆写，L366 恒追加两工具）。
- `agentSkillSpawnArgs`（L243-254）：amagi.json `agents.<role>.skills` → `--no-skills` + 逐项 `--skill <path>`——设计 §3.5 子任务只加载构建 skill 的机制确认存在。
- 角色卡仅从包内 `agents/` 加载；luban/diting/baize 三卡的 tools 行**均含 `mcp_call,mcp_list_tools`**（实读 agents/*.md L7）——知识工具走 MCP 的前提成立。自定义工具名在 v2 权限交集下 fail-closed 拒发（派生工具面只含内置名）。
- Leader 的 `--tools` 白名单同时过滤 amagi 注册的工具面（pi cli.md L119-135 实读："Replaces the default selection with a comma-separated allowlist of built-in, extension, or custom tools... MCP tools are kept unless an entry starts with mcp__"）——**构建 Leader 传显式白名单即可收窄 amagi 面，但 MCP 工具例外保留（经 codemode 可达），须配合 mcp 路由收紧**。

### 2.3 准入/取消/通知（admission.ts / task-run.ts / evidence-context.ts）
- 准入按最终模型分池：`concurrency.models["provider/model"]` 精确键 > providers > default(4)，每次准入读盘即时生效（admission.ts L12-16 头注实读）——设计 §3.6 "amagi.json 冻结各池容量" 成立。
- 取消：进程组 SIGTERM→(2s)→SIGKILL（task-run.ts L1660-1672）；Leader 被 SIGKILL 时 detached 子进程继续跑，靠启动锚点+恢复对账+orphan-reaper 收口——设计 §9 的残留核对必要性确认。
- 完成通知：`amagi:task-completion` custom message + `triggerTurn:true`（pi extensions.md L216 实读确认 custom message 会启动新一轮 agent run）→ **宿主 PiRpcProcess 必须接受自触发轮次（F6 的根源）**。

### 2.4 派发守卫改参语义（设计 §3.4 的核心假设）
- pi 1.4.0 extensions.md L159 官方表格："Authorize or **modify** a tool call | `tool_call`"——钩子改参有文档依据。
- 但"守卫修改后的 scope 出现在冻结任务契约中"（设计 §13.1 探测项）未实测：amagi task-facets 的 submit 在 tool_call 拦截层修改 params 后，v2-store 落盘的契约是否用改后值、子进程 grant 是否由改后 scope 推导——**列为 P0 探测项（§9）**。设计 §14 也自认此风险。

### 2.5 子进程读写执法（设计 §3.1 禁区的真实边界）
- 写面：`AMAGI_PROTECTED_PATHS`/`AMAGI_ALLOWED_PATHS` 由子进程 guards 读取并在 edit/write/bash 覆盖层阻断（guards.ts L2590/L3282 实读）。
- 读面：read-override.ts 引入 `fileReadPermissionBlockReason`（file-permission.ts 的活动执法器）——读也受 P4 grant 的文件权限约束，但**grant 读范围语义（scope.read 缺省是否全放行？）未逐行核实**（核查报告自称 file-permission.ts 细则未展开）。设计"数据根禁区禁读（config.json 明文密钥、SQLite、CLI 端点）"依赖该层——**P0 探测项**；若 grant 读面缺省放行，须靠"子任务无 shell + 不进禁区靠提示词 + 数据根目录不在任务 cwd/allowedPaths"缓解并在探测中如实记录边界。

### 2.6 其余核对
- 提示注入无开关（leader-prompt.ts 每轮 ~5-6KB L0）；`AMAGI_CONTEXT_INJECT_OFF=1` 只关关键词注入。
- `AMAGI_AUTO_VERIFY_OFF=1` 关自动验证（luban 会触发，与知识审查重复——设计 §3.5 关闭理由成立）。
- 自动续跑/修复轮默认存在（AMAGI_AUTO_CONTINUE_ROUNDS=2 等）——设计"首轮实验各保留 1 轮"需显式写入环境。
- Pi 子任务桥接的 stdio MCP 连接继承子进程全部环境（pi-mcp transports/stdio.js）——桥能读到 AMAGI_TASK_ID/AMAGI_AGENT，也能读到 ZHIPU_API_KEY——设计"只连接这一个 server"的约束理由确认。
- pi mcp.json 支持 `"autoEnableCodemode": false`（mcp.md L230 实读）——设计 §3.3 关闭自动 codemode 暴露的机制存在。
- pi models.json 的 apiKey 支持 `"$NAME"` 环境变量插值（models-configuration.md L17 实读）——设计 §3.2 "apiKey 写成 $ZHIPU_API_KEY 引用" 成立。

---

## 3. 设计逐项验收矩阵（§11 调整范围逐行核对）

| 设计 §11 现有模块 | 现状锚点（本次核实） | 差距/实现要点 | 可测性 |
|---|---|---|---|
| kb-build-service.ts runPipeline 按 orchestrationMode 分支 | L682/L1142 分支点；resumeBuild L594 / cancelBuild L644 / terminateAllWorkers L2898 | 新分支在 orchestrated 判定前拦截 `spec.orchestrationMode==='pi-amagi'`：完成 preflight（快照/图片/材料清单）后进入 Leader 监督，不进 runOrchestratedPhase/runOrchestratedIntegrate/worker 派发；旧三路保留 | vitest：mode 分支选择 + 旧路径回归（buildParallelism=1 与 orchestrated 既有测试全绿） |
| buildPiEnv 扩展构建环境 | L2140 | 追加：ZHIPU_API_KEY、Leader/子任务两类凭据变量、AMAGI_AUTO_VERIFY_OFF、自动轮次变量、PI_CODING_AGENT_DIR→builds/<id>/home（注意 buildPiProcessEnv L757 硬编码 pi-home，需参数化） | vitest：env 内容断言（密钥不进 argv/日志） |
| 复用 resolveRoleModel + 冻结角色校验生成 amagi.json | L4011 + describeRoleModel + frozenRoleMismatches | 直接复用；新增 amagi.json 写出（agents.<role>.model/skills、concurrency.models、mcp 路由） | vitest：配置文件形状 + 与 BuildSpec 一致性 |
| pi-rpc-process.ts 构建模式启动参数 | L157-210 | `-e` 加版本化 amagi-core 安装目录的扩展入口（additionalExtensionPaths 已支持）；始终传显式 `--tools`（现有逻辑 tools.length>0 && !allowExternalPluginTools 已满足，构建模式不设 externalPlugins）；sessionId 传 Leader 会话 ID；终止宽限参数化（默认仍 3000，构建传 ~10000）；**接受自触发轮次**：activeRun 空闲期收到新一轮 message_end/agent_settled 时emit 事件而不报错（监督循环消费） | 集成：真 pi + 假 Leader 扩展触发 custom message 自触发轮 |
| feishu-sync-agent.js 构建模式 | L160-176 tool_call/session_start | ①工具拉取按 Leader 凭据得到构建白名单（server 侧 runKind 新面）；②不设 EXTERNAL_PLUGINS；③新增 task_submit/task_resume 的 tool_call 守卫（角色表/模型/shell:deny/写面 agent-outputs/**/禁区/scope.mcp 按角色注入+记录运行事件）——改参形态按 pi 扩展协议（§2.4 P0） | 集成：守卫单测（jiti 装载）+ 探测：改后 scope 进冻结契约 |
| claude-bridge.cjs 抽通用桥 | 50 行现读 | 新增：env 读 AMAGI_TASK_ID/AMAGI_AGENT 随调用上行（headers 或 body）；Claude 路径另转发 _meta toolUseId（后置） | vitest：stdio 帧协议 |
| tool-specs/agent-tool-service 构建 Leader 工具集 | toolsForRunKind L810 / registerToolFamily L415 | 新增 Leader 工具族（材料清单/输出分配/问题清单与交接记录/检查点/申请发布）——**不含 task_*/app_command/正文写**；子任务经桥接调知识工具（读取类带 readOnlyHint）+ 局部编辑/批量读取（§7 减负）；身份解析按凭据类别+AMAGI_TASK_ID（agent-internal 中间件叠加） | vitest：白名单派生 + 身份三态（pending/confirmed/revoked） |
| path-claims 持有者→任务身份 | path-claims.ts 全读 | owner 已是 string，改语义不改结构；OutputAssignment 持久化进 checkpoint（claims 字段现成）+ 撤销/转移/父链继承 | vitest：分配冲突/收回/继承 |
| build-units 复用影响分析产材料清单 | build-units.ts | planUnits 输出转为 manifest（标题/结构/大小/哈希/读取入口）；不用目录装箱决定工作者数 | vitest：清单生成 |
| build-orchestration 不进就绪队列 | L3016 | 新模式不调 readyTasks/executeOrchestratedTask（§6 防线） | 代码审查断言 + 回归 |
| agent-process-pool Leader 占 build 1 槽 | 三通道已实现 | acquire('build') 现成；子任务不入池（不调用 pool） | 现有池测试 |
| app-plugin-store/插件管理版本化安装 | pi-plugin-service.ts | 新增 runtime-packages 安装（pi install 版本化目录）、agentDir 配置生成器、settings 包列表审计、活动构建拒绝删版本 | vitest：目录/审计；集成：真 pi install |
| claude-code-process/factory 开放派发 | L156 `--bare --tools ''` | 设计 §10 后置（能力验证通过后启用），本里程碑不动 | 后置 |
| 知识编译与发布绑定候选版本 | releaseConfirm L4513 | 现有 awaiting_release 链直接作为"申请发布"出口；Leader 工具触发同一服务端复核 | 现有发布测试 |
| 构建侧栏显示实际任务 | KbBuildPanel/BuildOrchestrationProgress | 新 DTO（任务/排队原因/产出/问题）+ SSE 事件扩展；"当前计划"不显示精确百分比 | 组件测试+真机 |

**设计 §13.1 能力探测矩阵**（首里程碑验收，全部可脚本化到临时 FEISHU_SYNC_HOME）：

| 探测项 | 通过条件 | 实现落点 | 失败处置 |
|---|---|---|---|
| 扩展加载 | Leader 同载 amagi-core+转发扩展无同名诊断；实际工具=白名单；子进程载同一安装目录 | C1（§7） | 修工具集/布局，不启用 |
| 模型 | zhipuai 静态声明可派发+调工具；子进程 env 只含所需密钥 | A1+C2 | 标记组合不可用 |
| MCP 通道 | 子任务经 mcp_call 调桥接工具；scope.mcp 显列放行/未列拒绝；无 codemode 自动启用 | A3+B1 | 调路由/授权/exposure |
| 身份 | 桥接任务 ID=创建事件；并行各自正确；续接链继承分配 | B1+B2 | 不启用并行写入 |
| 派发守卫 | 改后 scope 进冻结契约；非构建角色/越界模型被阻 | C1（P0 探测） | 不启用新模式 |
| 完成通知 | 后台完成触发 Leader 新一轮；宿主正确处理自触发轮次 | C1 | 修正适配层 |
| 配额 | 并发≤池容量和；排队原因可见 | A1 amagi.json | 调 concurrency |
| 取消 | 无残留子进程；旧凭据写入被拒 | C3 | 记录能力不足 |
| 恢复 | 原会话续接对账正确或成果级恢复 | C3 | 明确恢复级别 |
| 通用规则注入 | 输入开销+偏离次数记录 | 试验记录 | 推进 amagi-pi 开关 |

---

## 4. 关键接口建议（设计 §8 的落点映射）

```ts
// 新模块建议目录：server/src/kb/build-runtime/（全部新文件，避免与在途改动冲突）
// ① agent-dir-setup.ts —— §3.1 构建 agentDir/运行目录生成
export interface BuildAgentDirSpec { buildId: string; amagiPackagePath: string; amagiContentHash: string; roles: ResolvedRoleModel[]; admissionPools: Record<string, number>; bridgeCommand: string; bridgeEnv: Record<string,string>; skillPath: string; workRoot: string; forbiddenPaths: string[] }
export function setupBuildAgentDir(spec): { agentDir: string; workDir: string; configHash: string }  // settings.json(只声明版本化 amagi-pi)/amagi.json(角色模型+skills+mcp 路由+concurrency)/models.json(zhipuai $ZHIPU_API_KEY)/mcp.json(桥接+autoEnableCodemode:false)；工作目录禁写 amagi.json/.pi/.agents/.mcp.json/AGENTS.md/CLAUDE.md；数据根禁区清单返回给守卫

// ② build-actors.ts —— §4 身份/凭据/输出分配（AgentToolService 新族挂点）
export interface ActorBinding { actorId: string; nativeTaskId: string; parentTaskId: string | null; generation: number; role: string; status: 'pending'|'confirmed'|'revoked' }
export class BuildActorRegistry { confirmFromLeaderEvent(...); bindFromBridgeCall(AMAGI_TASK_ID, AMAGI_AGENT, token); assertWritable(actor, target); }  // 待确认身份只读；角色不一致拒绝
export class BuildCredentialVault { issue(kind: 'leader'|'sub', buildId, generation): token; revokeGeneration(generation); verify(token): {kind, generation} }  // 取消/换代立即失效

// ③ build-runtime-adapter.ts —— §8 五入口
export interface BuildRuntimeAdapter { probe(): Promise<CapabilityReport>; start(spec: BuildRunSpec): Promise<RuntimeBinding>; observe(binding, after?): AsyncIterable<RuntimeEvent>; resume(binding, checkpoint): Promise<RuntimeBinding>; cancel(binding): Promise<CancelResult> }
// probe 复用 PiRuntimeResolver + 新增 amagi 包探测（版本/内容哈希/与子进程同源）
// start: setupBuildAgentDir → 签发凭据 → PiRpcProcess(构建模式) → prompt(启动参数 JSON)
// observe: 消费 PiRpcProcess 'record' 事件流（tool_execution_start/end 含 toolName/args——json.md L105 实读字段）+ 桥接侧工具事件 + 事件去重（来源分键）
// resume: 核对冻结哈希 → 残留子进程核对 → 原会话 ID 续接或成果级重建（返回实际方式，UI 区分）
// cancel: 撤销凭据代次 → stdin.end + 宽限 10s → SIGKILL → amagi 任务存储残留核对

// ④ 幂等与回执（§4.4 写入链）
// 幂等键 buildId+generation+nativeTaskId+operationId：同键同载荷返回原回执、异载荷拒绝；
// 与 kb_write_doc 的 expectedDraftRevision（乐观并发）衔接；ArtifactReceipt 进 BuildCheckpoint
```

**Leader 工具面（拟新增，全部经现有 agent-internal 通道）**：`kb_materials`（材料清单）、`kb_assign_output`（输出分配，冲突返回持有者）、`kb_issues_handoff`（问题清单与交接记录读写）、`kb_checkpoint`（检查点）、`kb_request_release`（申请发布→服务端 releaseConfirm 同链）。**剔除**：task 族（与 amagi 重名）、app_command、kb_write_doc 等正文写。

---

## 5. 可复用链路清单（新模式的直接依赖）

| # | 链路 | 入口符号 | 复用方式 |
|---|---|---|---|
| R1 | 快照冻结与源完整性 | `RawSourceSnapshot.scan/enrichEntriesWithMedia/verifySnapshotIntact`、`computeSnapshotHash`（build-orchestration.ts） | 新模式 preflight 原样使用；BuildRunSpec.sourceManifestHash 取 computeSnapshotHash |
| R2 | 图片/白板预处理与缓存 | `describeWorksetImages`、`VisionDescriber`（内容寻址缓存）、`collectWhiteboardTextsForEntries` | 原样复用（冷缓存计时入指标） |
| R3 | 角色模型冻结 | `resolveRoleModel`/`describeRoleModel`/`frozenRoleMismatches`（kb-build-service L4011+） | 生成 amagi.json 角色模型 + resume 一致性校验 |
| R4 | 构建事件双写与 SSE | `emitBuild/emitLog` + events.jsonl + routes/kb.ts SSE | RuntimeEvent 追加新 event type 即可进现有通道 |
| R5 | 检查点持久化 | `BuildCheckpointStore` + `persistCheckpoint` + KNOWLEDGE_ARTIFACTS 白名单 | 增字段（actorBindings/outputAssignments/runtimeEvents 游标）additive |
| R6 | 候选与发布 | `assembleCandidate`/`candidate.json`/`awaiting_release`/`releaseConfirm`/`KbPublishService` | Leader 申请发布 → releaseConfirm 同链（模型永远不直接挪指针） |
| R7 | 增量影响闭包 | `computeImpactClosure` + governance freeze（runPipeline L920-960） | 增量构建时作为"必须覆盖范围"输入 Leader |
| R8 | 工具族注册/白名单派生 | `registerToolFamily`/`computeAllowedTools`/agent-internal 三重校验 | 新增两族（leader/sub）+ 身份中间件叠加 |
| R9 | 进程池三通道 | `AgentProcessPool.acquire('build')` | Leader 占 1 槽；取消信号贯通 |
| R10 | 知识声明体系 | kb_write_doc objects/claims/evidence + KB_DECLARATION_CONSTRAINTS + read-receipts | 子任务经桥接复用同一校验链（§7 减负在其上加局部编辑/批量读取） |
| R11 | 路径认领 | `PathClaims`（string owner） | 持有者换任务身份 |
| R12 | MCP 桥 | `claude-bridge.cjs` stdio 协议 | 抽通用桥 + 身份上行 |
| R13 | pi 运行时发现 | `PiRuntimeResolver` | probe() 的 Node/pi 部分 |

**不可复用（明确排除）**：`runOrchestratedPhase` 的就绪队列/acceptance 驱动、`TaskService` 的应用任务调度（双派发系统禁令）；`buildPiProcessEnv` 的 pi-home 硬编码（需参数化 agentDir）。

---

## 6. 禁止项防线（任务书特别要求的三项）

| 禁止项 | 具体防线（代码层） | 验收断言 |
|---|---|---|
| **新身份伪装 final** | ①子任务写入资格只由 `BuildActorRegistry`（身份三态）+ `OutputAssignment`（path-claims 任务身份持有）判定，**不经 `BuildWorkerInfo.phase`**；②`assertPathClaim` 现有 phase='final' 豁免只保留给旧模式收尾轮；③新模式构建中 `entry.workers` 不含 amagi 子任务（它们不是 PiRpcProcess），无"顺手塞 phase"通道；④设计 §11 明文"不能把新子任务全部伪装为 final 来绕开限制"写进实现注释与测试 | vitest：子任务（confirmed+已分配）写目标 OK；未分配/revoked/pending 写拒绝且错误码可区分；任何 phase 值不改变子任务判定 |
| **应用重建调度器** | ①新模式分支不调用 `BuildOrchestration.readyTasks/executeOrchestratedTask`（runPipeline 分支处静态可查）；②Leader 工具集无 task_* → 应用侧无派发入口；③应用只做"冻结-监督-校验-发布"，任务编排全部由 Leader 经 amagi task_submit 表达；④接入失败时**不得**用外层临时调度器替代宣称集成成功（设计 §13.2 原文） | 代码审查 + 事件断言：新模式构建的 amagi:task-completion/桥接事件来自 amagi 子进程而非应用 spawn；应用 spawn 的 pi 进程数 = 1（Leader）+ 桥接 |
| **静默 fallback** | ①probe() 不通过 → 构建 409/503 明示 capability 缺项，不回落单进程/orchestrated 路径（orchestrationMode 是 BuildRunSpec 冻结字段，运行中不可变）；②模型 provider 未映射 PROVIDER_KEY_MAP → 报不支持（设计 §3.2），不降级单 agent；③桥接不可达/角色不一致 → 工具错误如实上抛；④resume 不支持 → 返回"不支持"而非假装续接 | vitest：probe 失败路径断言错误码；集成：拔掉桥接配置 → 子任务工具调用失败可观察 |

---

## 7. 可并行切片建议（不重叠写面）

**前置约束 F8**：切片 S2/S3 触碰 kb-build-service.ts 与 agent-tool-service.ts（在途改动区）。建议先请主上落地未提交改动（或明确接受基于其上开发），S2/S3 内部再串行。

| 切片 | 内容 | 主要写面（文件） | 依赖 | 验收（mock 优先） |
|---|---|---|---|---|
| **S1** 运行包与 agentDir | `pi install` 版本化 amagi-pi 到 `<dataRoot>/agent/runtime-packages/amagi-pi@<ver>/`；`setupBuildAgentDir`（四配置文件+禁区清单+configHash）；amagi 包探测（版本/内容哈希） | 新文件 `server/src/kb/build-runtime/runtime-packages.ts`、`agent-dir-setup.ts`、`amagi-probe.ts` | 无 | vitest：配置文件形状/哈希稳定性/禁区列表；集成：真 pi install + 子进程同源核对 |
| **S2** 身份/凭据/分配/回执（并行于 S1） | BuildActorRegistry、BuildCredentialVault、OutputAssignment（path-claims 任务化+持久化）、幂等回执、RuntimeEvent 记录与去重；agent-internal 身份中间件 | 新文件 `build-actors.ts`、`build-credentials.ts`、`build-assignments.ts`、`runtime-events.ts` + `agent-tool-service.ts`（追加族注册，**与在途改动串行**） | 无（S1 仅类型依赖） | vitest：身份三态/代次撤销/分配冲突与继承/幂等同键异载荷拒绝/事件去重 |
| **S3** Leader 进程与守卫（并行于 S2 的独立部分） | PiRpcProcess 构建模式参数（-e amagi-core/白名单/sessionId/宽限可配/自触发轮次）；feishu-sync-agent.js 构建模式（工具集收窄 + task_submit 守卫）；通用桥（身份上行） | `pi-rpc-process.ts`、`pi-extension/feishu-sync-agent.js`、新 `pi-extension/build-leader-guard.ts`、`claude-bridge.cjs` 泛化 | S1（安装目录） | 集成（真 pi）：探测矩阵前三项；守卫单测（jiti 装载） |
| **S4** 适配层与流水线接线 | BuildRuntimeAdapter 五入口 + orchestrationMode 分支 + BuildRunSpec/checkpoint 增字段 + resume/cancel 新分支 + 类型/配置 additive | `kb-build-service.ts`（分支+buildPiEnv 参数化，**主冲突文件**）、新 `build-runtime-adapter.ts`、`types/agent-knowledge.ts`、`local-map-store.ts`（DDL）、`routes/kb.ts` | S1+S2+S3 | vitest：分支选择/旧路径回归/cancel 撤销代次/resume 恢复级别 |
| **S5** 工具减负（可后置到接入试验后） | kb_write_doc 局部编辑（服务端继承声明+变更集）、批量读取（预算/游标/截断标记）、子任务知识工具族（readOnlyHint） | `agent-tool-service.ts`、`tool-specs.ts`（**与在途改动串行**） | S2 | vitest：局部编辑继承未变声明/变更集范围/批量预算 |
| **S6** 侧栏与设置 | orchestrationMode 选择、任务/排队/产出/问题展示、"当前计划"语义 | `src/components/kb/KbBuildPanel.tsx`、`BuildOrchestrationProgress.tsx`、`BuildOrchestrationSettings.tsx`、`src/api/client.ts` | S4（DTO） | 组件测试 + 真机交互截图（洛神视觉核） |
| **S7** 接入试验与探测自动化 | 13.1 探测脚本化（临时 FEISHU_SYNC_HOME）+ 13.2 最小闭环（1 Leader+2 并行写作+1 审查+候选提交） | 新 `server/scripts/build-runtime-probe.ts`、`tests/build-runtime.e2e.ts`（真模型标记） | S1–S4 | 设计 13.1/13.2 逐项通过；六源对照后置 |

**并行编组**：`{S1, S2, S3(独立部分)}` 并行 → `{S4}` → `{S5, S6, S7}`。S4 是唯一必串行点（kb-build-service.ts 单写者）。

---

## 8. 真实运行测试可行性

**环境就绪（本机实查）**：
- Node v24.21.0（≥22.19 ✓）；pi 1.4.0 全局安装（docs/dist 实读）✓
- amagi-pi 源码 @/Users/run.mao/workpace/amagi-pi（929000e）——可 `pi install ./local`（本地包不复制、改源即生效；版本化安装目录策略需在 S1 决定复制或引用，探测阶段核对内容哈希）
- GLM 密钥链：config.json llm.providers（bigmodel）→ resolveProviderModel → ZHIPU_API_KEY 注入可行 ✓
- 隔离：临时 `FEISHU_SYNC_HOME`（既有测试惯例）+ 候选副本

**可行结论**：
1. **能力探测（13.1）全部可行**——不需真实模型额度（除"模型"项需一次真实派发+工具调用，GLM flash 成本可忽略）。
2. **接入试验（13.2）可行**——1 Leader + 2 写作 + 1 审查，GLM 双模型（glm-5.3-flash 写作 / glm-5.3 审查）皆在 PROVIDER_KEY_MAP zhipuai 映射内；预计单次分钟级。
3. **六源对照（13.3）有真实成本**——同快照三路径（已修复路径/新插件路径/通用工作流）×多次（中位数需 ≥3 次/路径）：47,546 字 143 图的构建是 20 分钟级/次；前置依赖真实六源夹具与"世界金字塔/里与亭并行建制"验收样本（设计 §13.3 指定）。**冷图片缓存计入端到端**。建议排在探测+接入试验全绿后。
4. **风险点**：GLM 并发额度（两池 4+2 合计 ≤6）、Leader 上下文增长与压缩、`mcp_call` 嵌套参数的调用错误率（设计 §3.3 要求实测记录）、通用规则注入干扰（记录偏离次数）。
5. **不可行/盲区**：Claude Code 路径（§10）本机当前 PATH 无 `claude` 命令（核查报告确认），实测需先备环境——按设计后置，不阻塞 Pi 主链路里程碑。

---

## 9. 待核验项与所缺证据（按优先级）

| # | 待核验项 | 影响 | 建议核验方式（属实施阶段，本报告不改码） |
|---|---|---|---|
| P0 | **tool_call 守卫改参是否进入 amagi 冻结契约**（§2.4）：拦截层修改 params 后 v2-store 契约/grant 推导是否用改后值 | 派发守卫是设计 §3.4 的硬前提；失败则守卫只能"阻止+提示 Leader 重发"，实现形态改变 | S3 探测：jiti 装载守卫扩展 + 真 amagi task_submit dryRun/落盘契约比对 |
| P0 | **子任务读面 grant 语义**（§2.5）：scope.read 缺省是否全放行；数据根禁区（config.json 明文密钥等）能否被 read/grep 读到 | 数据根禁区"禁读"承诺的真实边界；密钥泄露面 | S3 探测：子任务 read 数据根文件，记录结果；必要时守卫写入 protectedPaths 并复测 |
| P1 | pi RPC 自触发轮次事件形状：custom message 触发的新一轮在事件流的完整表现（message_end 无对应 prompt response） | PiRpcProcess 适配（F6）的具体事件序 | S3 集成：假扩展 sendMessage triggerTurn 观察事件 |
| P1 | amagi.json 工作目录覆盖链：任务 cwd（builds/<id>/work）下的项目级 amagi.json 会覆盖 agentDir 全局配置——应用须保证 work 目录无该文件且禁写（守卫写面清单已含） | 准入容量/MCP 路由被改写风险 | S1 目录生成测试 + S3 守卫单测 |
| P2 | `~/.agents/.mcp.json` 兼容配置实机内容（本机 5 个 server，核查报告结论）：桥接 server 命名冲突面 | mcp.json 桥接命名需避开 | S1 探测：读本机兼容配置列名 |
| P2 | 版本化 amagi-pi 安装形态：pi install 对本地路径是否复制（影响"装好后不原地修改"承诺与内容哈希稳定性） | S1 设计决策 | S1 集成试验 |
| P3 | pi 1.4 `--skill` 路径与 skills allowlist 在构建 agentDir 的实际加载序（子进程 `--no-skills` 由 amagi 注入） | 构建 skill 加载 | S3 探测（矩阵"扩展加载"项子检查） |

**覆盖边界（负面发现）**：本次未实测任何 amagi/pi 运行行为（只读约束）；未逐行核 guards.ts（3794 行）与 file-permission.ts 全量语义；未读 server/scripts/sync-latest.ts 等同步侧脚本（与本设计无关）；前端仅符号级调查，未做交互验证；amagi-pi 仓 929000e 之后的提交未跟进（若实施时升级版本需重跑核查报告的 14 项抽查）。

---

## 附：证据锚点速查

- feishu-sync：kb-build-service.ts（L682/1142/1173/2140/2166/2440/2898/3016/3338/3395/4011/4217/4470/4513）；build-orchestration.ts（L58-70 computeSnapshotHash、L119 起 BuildSpec 构造）；orchestration-contracts.ts（L28 BuildRole、L92 BuildSpec）；path-claims.ts（全文 61 行）；build-checkpoint.ts（L14-56、L64 KNOWLEDGE_ARTIFACTS）；pi-rpc-process.ts（L33-58 白名单、L157-210 spawn、L477 prompt、L712-770 buildPiProcessEnv/terminate）；feishu-sync-agent.js（L160-176）；agent-tool-service.ts（L212-224 BuildWorkerInfo、L415 registerToolFamily、L439-456 白名单派生、L577 createRunContext）；agent-process-pool.ts（L1-35 头注三通道）；app-plugin-store.ts（L1-30、L168-208 snapshot）；pi-plugin-service.ts（L20-46）；tool-specs.ts（L778+ 任务工具）；types/agent-knowledge.ts（L92-140 buildConcurrency/buildRoles、L778-810 工具面、L810 toolsForRunKind）；routes/agent-internal.ts（L1-50）；server/src/index.ts（L300-420 装配）
- amagi-pi @929000e：extensions/amagi-core/task-run.ts（L107-201 env、L243-254 skills、L310-325 enforceTools、L1745-1774 spawn）；admission.ts（L12-16）；mcp-config.ts（L334/352/376）；agents/{luban,diting,baize}.md（L7 tools 行）；guards.ts（L2590/L3282）；read-override.ts（L24 fileReadPermissionBlockReason）
- pi 1.4.0 docs：cli.md（L119-135 --tools/--mcp__）；extensions.md（L159 tool_call modify、L216 custom message triggerTurn）；json.md（L105-107 tool_execution_* 字段）；mcp.md（L230 autoEnableCodemode）；models-configuration.md（L17 apiKey $ENV）
