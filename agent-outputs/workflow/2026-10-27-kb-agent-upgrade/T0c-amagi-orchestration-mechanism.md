# T0c 调查报告：amagi-pi 编排机制精读（可复刻面）

- 调查角色：白泽（证据链）；日期：2026-10-27
- 范围：`/Users/run.mao/workpace/amagi-pi`（只读，v2.21.21）、`/Users/run.mao/workpace/feishu-sync`（只读，feat/agent-knowledge-workbench @59a76fa）
- 方法：只读取证；每项主张带文件级锚点。amagi-pi 大文件（task-tool 2981 行 / task-run 2898 行 / task-kernel 1394 行等）精读了模块头注释、工具 schema 与 spawn/内核关键段，未逐行通读——见文末「待核验项」。

## 结论索引

| # | 主张 | 三态 | 锚点 | 适用边界 |
|---|------|------|------|----------|
| C1 | amagi 以 pi 原生 package 发布：pi 段注册 extensions/skills/prompts/themes；`agents/*.md` 角色卡不在 pi 段，由 amagi-core 启动时自行发现 | 观察 | `amagi-pi/package.json`（`"pi": { extensions/skills/prompts/themes }`）；`extensions/amagi-core/index.ts:496-499` | 以当前 checkout 为准 |
| C2 | 角色卡=frontmatter(name/description/type/tools/capabilities/model)+正文；type∈fast/work/expert；capabilities 是能力唯一来源且 fail-closed | 观察 | `agents/baize.md:1-24`；`agents-loader.ts`（discoverAgents/validateRoleCapabilities 接线）；`task-permission.ts:22-45` | — |
| C3 | 派发工具面两代并存：legacy `task`+`query_task`；v2 分面 `task_submit/task_resume/task_control/task_query` + 高级分面 `task_batch`（CallerContext.facets 门控） | 观察 | `task-tool.ts:1594-1740`；`task-query.ts:382-385`；`task-facets.ts:108`；`tool-surface.ts:534` | — |
| C4 | 生命周期=执行轴（10 态）+结算轴（回执 publish-receipt）+接受轴（decide accept/reject+waive）；内核 `apply(KernelCommand)` 是唯一写入口（10 种封闭命令，stateSeq CAS+revision 栅栏） | 观察 | `contracts/task.ts:146-152`；`contracts/command.ts:113-124,220-231`；`task-kernel.ts:1-58` | K1 契约自述 decide 缺 reject 判别字段（内核只实现 accept 面） |
| C5 | 子任务=独立 pi 子进程（`--mode json -p`），resume 用 `--session`，fork 用 `--fork`；系统提示经临时文件 `--append-system-prompt` 注入；另有 rpc 常驻池后端 | 观察 | `json-execution-adapter.ts:104-106`；`task-resume.ts:528-538`；`task-tool.ts:452-455`；`rpc-pool.ts:1103-1107` | — |
| C6 | 准入：provider/model 分池 FIFO（tryOccupy/waitForGrant/release），缺省容量 4，队列不跨重启 | 观察 | `admission.ts`（capacityOf/tryOccupy/头注释） | — |
| C7 | 权限=声明性四方交集（角色上限∩用户/受信授权∩任务请求∩后端可兑现，deny 恒优先）冻结进 TaskSpec；执行点由 guards 硬执法（主+子进程） | 观察 | `task-permission.ts:3-24`（通道矩阵）；`task-run.ts:1740-1790`（P4 交付/预检）；`index.ts` 头注释 P2 装配 | — |
| C8 | blocked 问答有完整闭环：marker 协议（`<!--AMAGI:BLOCKED-->`/`<!--AMAGI:DONE-->`）→ wait 回流提示 → TUI 待答队列 → resume 作答 | 观察 | `task-run.ts:611-627`；`task-tool.ts` wait blockedHints 段；`answer-queue.ts` | — |
| C9 | feishu-sync 现状：server 权威工具授权+转发扩展 fail-closed、RPC 常驻进程池（1..4、idle 回收、busy 挂起）、插件双层（上下文插件 registry + Pi 原生包 CLI 管理+运行期固定快照） | 观察 | `feishu-sync-agent.js:117-123`；`agent-process-pool.ts:57-66,96-117`；`pi-plugin-service.ts`；`app-plugin-store.ts`；设计文档 §17（`docs/design/agent-knowledge-design.md:729-737`） | — |
| C10 | amagi 的自由 spawn/自由工具面/自由模型解析与 feishu-sync 安全模型直接冲突，须改造后才可移植（详见 §4 冲突面） | 观察（基于两侧代码对照） | 本报告 §4 | 冲突清单是推断——前提为两侧代码语义对照，未做运行实验 |

---

## 1. amagi-pi 包结构与注册

**package.json pi 段**（`amagi-pi/package.json`）：

```json
"pi": { "extensions": ["./extensions"], "skills": ["./skills"], "prompts": ["./prompts"], "themes": ["./themes"] }
```

pi 加载 `./extensions` 目录 → 入口为 `extensions/amagi-core/index.ts`（文件头自述 "amagi-core — pi extension entry point"，1168 行组合根：guards、status-ui、input-router、mcp、rpc-pool、K8c 内核接线等全部在此装配）。

**角色名册不在 pi 段**：`index.ts:496-499` 以模块目录推算 packageRoot（`extensions/amagi-core/../..`），`discoverAgents(path.join(packageRoot, "agents"))` 自行扫描 `agents/*.md`（baize/diting/fuxi/luban/luoshen 五卡）。

**角色卡格式**（`agents/baize.md:1-24` 实样）：

```yaml
name: explorer          # frontmatterName（功能名）；文件名 basename 才是查找键
description: |          # 多行职责描述；rosterRows() 从中确定性提取名册短语
  白泽，以证据链把问题转为可复核的事实供给。……
tools: amagi_advisor,read,write,grep,find,amagi_resource,codemode,mcp_call,mcp_list_tools,bash,lsp
capabilities:           # 结构化能力上限（唯一能力来源，见 §3）
  assurance: guarded
  shell: guarded
  read: ["**"]
  write: []
  report: ["agent-outputs/**"]
  mcp: ["*"]
  lsp: [diagnostics, definition, references, hover]
type: fast              # fast | work | expert
```

解析规则（`agents-loader.ts`，299 行全读）：
- 必需字段校验（description/type 非法即跳过+warning）；**symlink 拒绝**（防包外 Markdown 注入 system prompt）；重复 alias 直接 throw；tools 为空拒绝（"无白名单会扩大子进程权限"）。
- systemPrompt 装配序：角色正文 → `resources/core/common/agent-base-constraints.md`（公共基线，唯一权威）→ `COMMON_AGENT_SYSTEM_PROMPT`（独立节点协议）→ 按 type 的返回格式段（fast/work/expert 各异）。公共纪律只此一份，五卡零复制。
- capabilities 非法 → `capabilitiesError` 标记，该角色任务在授权计算处整单拒绝（fail-closed，不回退宽权限）。

## 2. 编排工具面清单

### 2.1 两代工具并存（task-facets.ts:18-20 自述命名策略）

| 工具 | 定义处 | 面向 |
|------|--------|------|
| `task`（label "Amagi Task"） | `task-tool.ts:1594` | legacy 单工具：派发+控制混在一个参数对象 |
| `query_task` | `task-query.ts:382` | 只读观察：状态/轨迹/回执/看板/stats/recovery |
| `task_submit` / `task_resume` / `task_control` / `task_query` | `task-facets.ts:108` | v2 四分面（模型面新轨） |
| `task_batch` | `tool-surface.ts:534` | 高级分面，经 `enableFacet="batch"` 显式启用（CallerContext.facets 门控） |

### 2.2 legacy `task` 参数面（`task-tool.ts:1610-1740`，互斥组执行点校验）

- **单任务派发**：`agent` + `task`（sync 阻塞）或 `background:true`（返回 taskId，完成自动通知）。
- **批量派发**：`context`（共享上下文）+ `tasks[1..32]`，节点级 `name/agent/task/model/cwd/allowedPaths/reportPath`；batch 缺省异步（asyncGroup 缺省 true）。
- **续接**：`session`（taskId/name 前缀或 runId/name）+ `task`（作答/接手文本）；`fork` 模板用 `--fork` 真分叉。
- **控制面**（与派发互斥，同调用只取其一）：`cancel`（+`resolve:"external"` 轻量收口）、`wait{ids|group, mode:any|all, timeoutMs}`（超时只报告不取消；缺省时长按角色类型自适应 5min/30min）。
- **编排模板**：`fanout`/`pipeline`/`tournament{agent,task,n,judge}`/`redteam`/`fork{session,branches[]}`——纯语法糖，展开为 GroupSpec 交 GroupScheduler（见 §5）。
- **横切**：`model`（字符串或降级链数组，仅单任务）、`autoRetry{retries,backoffMs}`（瞬时故障自动重派，另有未声明时的隐式 1 轮预算）、`evidenceTimeouts`、`workspaceNeeds`、`allowedPaths`（白名单）与 `protectedPaths`（黑名单）互斥、`dryRun`（只解析不派发）、`exportPrompt`、`worktree`。

### 2.3 v2 分面参数面（`task-facets.ts:419-441,576-587`）

- `SubmitParams`：`agent`（必填）、`task|taskFile` 恰选一、`delivery: "wait"|"handle"`（wait=阻塞到本轮终态；handle=立即返回句柄）、`inputs/outputs`（对象含 purpose/required/sourcePath）+ `inputPaths/outputPaths` 字符串简写、`scope{read,write,deny,reportFiles,shell,mcp,lsp,codemode,advisor}`、`workspace{cwd,mode:existing|worktree,...}`、`profile`（受信配置名，非任意覆盖）、`contextMode: isolated|selected|fork`、`dryRun`。
- `ControlParams`：`action: wait|cancel|resolve-external|steer|accept|reject|reconcile` + `handles/handle/mode/timeoutMs/reason/message/receiptId/expectedRevision/waivedCheckIds`。accept/reject 须引用回执的 `receiptId` 与 `expectedRevision`（revision 栅栏防过期裁决）。
- `ResumeParams`：`handle` + `message` + `delivery`。

### 2.4 生命周期三轴与回执（contracts/task.ts + task-kernel.ts 头注释）

- **执行轴** 10 态（`contracts/task.ts:146-152`）：queued/running/done/blocked/error/answering/answered/cancelled/truncated/resolved-external。TaskRecord 补充 `blockReason: "questions"|"needs-handoff"`（`task-registry.ts:70-110`）区分"待答复"与"待接手"。
- **内核命令**（`contracts/command.ts:220-231`）10 种封闭命令：`register / grant-start / observe / cancel / resolve-external / begin-resume / finish-resume / publish-receipt / decide / reconcile`。`apply(KernelCommand)` 唯一写入口：每命令恰好一次 store CAS，stateSeq 连续；携带 TaskKey 的命令要求 revision 匹配（revision 失效栅栏）；观察事件（started/session/activity/exited）幂等且 exited 不可被低序号覆盖。
- **结算/接受轴**：子进程终态 → `publish-receipt`（不可变落盘成功后才 CAS 提交 currentReceipt 指针；回执只接受初始 unreviewed）→ Leader `decide accept/reject`（accept 生成新 receiptSeq 沿用证据；incomplete 接受须显式 `waivedCheckIds`；error 接受须 waive `error-execution-coverage`）。待接受节点可阻塞 DAG 下游（`requires: "accepted"` 边，K8b）。
- **resume lease**：`begin-resume` 持 lease 防并发续接（只启动一个）；`finish-resume` 携 outcome answered|blocked + successorTaskId 父链（`task-resume.ts:9-22`）。Leader 重启后 registry 清空，`resolveSessionWithBackfill` 从磁盘（artifact metadata + pi sessions 目录）回填收编再解析（`task-resume.ts:57-66`）。
- **steer 通道**（`task-steer.ts:1-20`）：`<amagiData>/task-steer/<taskId>.jsonl` append-only；Leader 写 `{kind:"steer",seq,message}`，子进程 `pi.on("context")` 在每个 provider 请求前把活跃 steer 幂等追加到最后一条 user message，回写 `{kind:"ack",seq,pid}`；spec 冻结不动摇，审计事实在通道文件本身。

### 2.5 准入（admission.ts，292 行全读）

- 所有 spawn 路径（sync/background/resume/编排分支/RPC）在 `registry.create` 后、真实 spawn 前过 `tryOccupy`；按最终模型 spec 分池：`concurrency.models["provider/model"]` 精确命中 → 独立模型池；否则池键=provider 前缀；容量 `models > providers[provider] > AMAGI_ADMISSION_MAX env > concurrency.default > 4`。
- 各池独立 FIFO：`tryOccupy` 同步原子（"running" 已占槽 / "queued" 已入队）；`waitForGrant` 只有 running/cancelled 两种终局；`release` 幂等并同步晋级本池队首（单池容量永不突破）；队列不跨重启（restore 把 queued 恢复为 cancelled）。
- 瞬时故障冷却（429 链尽）不占槽：`queueReason:"cooldown"` + `retryAt` 到期重入 FIFO（TaskRecord 元数据，`task-registry.ts:105-110`）。

## 3. 进程模型、上下文继承与权限执行

### 3.1 子进程 = 一次性 pi 进程（json 后端）

- **fresh 派发**：`args = ["--mode","json","-p","--name",sessionName] (+["--model",effModel]) (+["--tools",tools.join(",")]) + assignment`——任务书作为最后一个 argv 传给子 pi（`task-tool.ts:452-455`；契约适配器同款 `json-execution-adapter.ts:104-106`）。
- **resume**：`["--session"|"--fork", prevSessionId, "--mode","json","-p","--name",sessionName, "--tools",..., (--append-system-prompt tmpFile), (--model effModel), nudge]`（`task-resume.ts:528-538`）。系统提示组装后经 `writePromptTmp` 落盘（mkdtemp + 0o600）再以 `--append-system-prompt` 注入。
- **长任务书防线**（`task-run.ts:646-680`）：>128KB 落盘 `<cwd>/amagi-task/<taskId>/goal-full.md`，argv 只投降级摘要（子 Agent 开工自读）；>900KB 拒单。
- **环境**：ENV_WHITELIST 精选透传（PATH/HOME/代理变量/AMAGI_TASK_ID/AMAGI_DATA_DIR 等，`task-run.ts:107-126`）；子进程独立进程组（detached，便于组终止）；spawn 前采集 git 基线 + 工作区状态快照（写盘归因）。
- **可靠性闭环**：JSONL stdout 流解析（task-jsonl.ts）→ 完成契约校验（`<!--AMAGI:DONE-->` 末行精确匹配 + ACHIEVEMENT 清单在前）→ 缺 marker/结构缺陷走定向补正 nudge 自动续跑（`--session` 复用会话，`task-tool.ts:549,572`）；transient 400 自愈、watchdog 静默超时、doom loop 阈值、provider 熔断/退避。
- **rpc 后端**（二选一，TaskRecord.backend `"json"|"rpc"`）：常驻 pi 进程池（rpc-pool.ts），spawn 面带 `--tools`/`--append-system-prompt`/`--no-extensions`/`--no-skills`（`rpc-pool.ts:1103-1107`），由 `rpc_task` 工具驱动。

### 3.2 上下文继承三态（ContextMode，`contracts/task.ts:94`）

- `isolated`：子进程只拿到任务书（+预检），无 Leader 会话内容。
- `selected`：`dispatch-handoff.ts` 的 `buildSelectedHandoff` 从 Leader 会话已过滤快照按任务相关性**选取原文行**（用户原话保序、指代连带上下文、噪声/重复剔除），连同省略统计（omitted noiseLines/duplicates/unselected/budget）与 evidenceFile 存档一起冻结进任务书——证据链完整可回源，不重放历史操作。
- `fork`：`--fork` 真分叉，各枝独立 sessionFile，互不污染；readOnly 枝可真并发（orchestrate.ts fork 模板）。

### 3.3 权限：声明性交集 + 执行点执法（task-permission.ts）

- 授予计算 = **角色上限（agents 卡 capabilities）∩ 用户/受信授权（amagi.json authority）∩ 任务请求（scope）∩ 后端可兑现**；deny 恒优先（`task-permission.ts:3-24` 通道×语义矩阵）。
- 通道语义摘要：read 声明性无上限（仅 deny 护读）；write/reportFiles 请求逐条须被角色上限覆盖（超上限=整任务拒绝），用户侧只收窄不放大；shell=guarded 需四方全过，`assurance: tool-enforced` 强制 `shell: deny`（校验器镜像冻结）；mcp/lsp 请求 ⊆ 角色名单；outputs 每条须被 reportFiles∪write 覆盖且不中 deny。
- **冻结与交付**：通过校验的 PermissionGrant 以 digest 冻结进 TaskSpec（specDigest=canonical JSON SHA-256）；子进程交付=spawn 面两路——① `--tools` 取派发工具与授权交集（交集空=fail-closed 拒发，`task-run.ts:332-334`）；② 授权 JSON+digest 经 env 注入，子进程 `file-permission` bootstrap 校验 digest 一致才激活，失败 exit 1（`task-run.ts:1740-1790` 段）。
- **执法**：guards 在主+子进程都注册（index.ts 头注释 P2 装配），edit/write/bash 命中白名单外/黑名单内路径即**终止性阻断**（`BOUNDARY_GUARD_MARKER`，结算侧识别后抑制自动续跑）；写盘归因经 task-writes JSONL 登记（子 Agent 写入 vs 外部进程写入，防共享树误归因回滚）。
- LSP 缺项降级剥除照常派发；MCP 显式请求缺项=拒发（`task-run.ts:1755-1775`）。

### 3.4 blocked 问答闭环

子 Agent blocked 时终稿首行输出 `<!--AMAGI:BLOCKED-->` + `STATUS: blocked` + QUESTIONS（`task-run.ts:611-627`）→ 进程退出 → Leader 侧 wait 返回 blockedHints（提示读 QUESTIONS 后 `task({session, task:"逐项答复…"})` resume）→ TUI 待答队列 widget（`answer-queue.ts`，ctrl+shift+a → select 任务 → input 答案 → runResumeTask 回流）；`needs-handoff` 型 blocked 不进待答队列（行动语义是接手开工）。

## 4. 对照 feishu-sync：可复刻 / 冲突 / 形态

### 4.1 feishu-sync 现状锚点

| 机制 | 现状 | 锚点 |
|------|------|------|
| 进程 | RPC 模式常驻池；上限 `Math.max(1, Math.min(4, maxConcurrentProcesses ?? 2))`；reserveSlot 先预留后 spawn；busy 挂起 idle 回收；会话空闲 terminate | `agent-process-pool.ts:57-66,75-117,127-149` |
| 启动旗标 | `--mode rpc --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes --no-mcp --no-approve --offline`（+`--tools` 白名单/`-e` 扩展/`--session-id`） | `pi-rpc-process.ts:141-182` |
| 工具授权 | server 权威：转发扩展启动时 `GET /api/agent-internal/tools` 取本运行规格并 registerTool；`tool_call` 钩子对非自注册且非显式外部插件工具一律 `block:true`（fail closed）；运行令牌 `X-Agent-Run-Token` | `feishu-sync-agent.js:88-123` |
| 上下文插件 | registry.json overrides+custom（≤30、256KB 总量）、revision 乐观锁、按 scope 生成不可变快照（`snapshots/<revision>.json`） | `app-plugin-store.ts` |
| Pi 原生包 | settings.json packages 声明；CLI install/update/remove；停用筛选备份；mutation 前置 `running()` 拒绝活跃任务 + `retireIdle()` 回收空闲进程；generation 拒旧缓存；npm/git 包实体必须在应用目录内；`protectedRoots()` 纳入 Workspace 保护 | `pi-plugin-service.ts`；设计文档 §17（`agent-knowledge-design.md:729-737`） |

### 4.2 可复刻机制清单（最小移植面）

1. **角色定义文件格式**（C2）：frontmatter schema + systemPrompt 三段装配（正文→公共基线→运行契约）。feishu-sync 可将其做成内置 knowledge-workbench 包内的 `agents/` 资源或 server 资产（经 `readAgentPromptAssets` 同路发放），随插件快照冻结。
2. **任务记录与状态机**（C4 执行轴）：TaskRecord 字段集（status/blockReason/artifactRefs/rounds/runId/nodeId/dependsOn/backend/queuedAt/queueMs）可直接借为 feishu-sync 编排任务表/JSON 结构；终态集与 reopenForAutoContinue（自动续跑重开）语义同样可借。
3. **派发工具参数面**（C3）：单任务/batch/控制面互斥组、batch 1..32 节点排队（不是 32 进程）、`delivery: wait|handle` 二态、`dryRun` 预检——这套模型面经过实战打磨，可直接映射到 feishu-sync 的编排工具 schema。
4. **准入队列**（C6）：feishu-sync `AgentProcessPool.reserveSlot` 已有"预留-消费-释放"原语，缺的是排队语义——把 `AgentBusyError` 409 拒绝换成 FIFO 等待（tryOccupy/waitForGrant 模式）即可支撑多子 agent 并行需求，同时不破池上限。
5. **完成契约 marker + 定向补正**（C8）：`<!--AMAGI:DONE-->`/`<!--AMAGI:BLOCKED-->` + ACHIEVEMENT 校验 + 缺陷分型补正 nudge，是纯提示词+解析层机制，零安全冲突，整体可搬。
6. **blocked 应答流**：blockedQuestions → 会话回流 → 用户作答 → resume——feishu-sync 有现成 SSE 会话通道与 `--session-id` 会话复用，映射成本低。
7. **selected 上下文继承**（3.2）：派发时按任务相关性从会话快照选取原文+存档+省略统计的做法，对"构建转化知识库"场景很有用（把用户讨论上下文精准带给子 agent），实现思路可复刻（源换成应用侧会话 DTO，见冲突面 4）。
8. **回执记录（裁剪版）**：结算轴的"不可变回执落盘+artifactRefs"可简化为 feishu-sync 的任务产物登记；接受轴（decide accept/reject）对 GUI 应用非必需，v1 可显式裁剪。

### 4.3 约束冲突面（amagi 设计必须改造才能装进 feishu-sync 安全模型）

1. **自由 spawn vs 池化托管**：amagi Leader 侧 `getPiInvocation` 直接 `spawn(process.execPath, [当前入口, ...args])`（`task-run.ts:549-560`），任意建子 pi、json 后端每任务一个新进程。feishu-sync 必须经 `AgentProcessPool`+`PiRpcProcess` 统一启动（隔离旗标+运行令牌+sessionDir 注入）；编排工具不得自带 spawn，"启动子任务"应变为向 server 提交派发请求。
2. **角色 tools 白名单直通 vs server 权威工具集**：amagi 把角色卡 tools 交集后经 `--tools` 交给 pi，子进程拿的是 pi 原生工具（read/write/bash…）。feishu-sync 的工具面由 server 每运行下发、tool_call fail-closed（`feishu-sync-agent.js:117-123`），Work 不提供 shell。编排插件的"角色工具"必须映射为 server 工具授权子集（每个子 agent 一个运行令牌+独立 tools 规格），不能照搬 `--tools` 直通。
3. **准入容量 vs 池上限 1..4**：amagi admission 缺省 4 并可配，容量与进程一一对应；feishu-sync 池上限被 clamp 在 1..4 且 build/session/probe 共享——编排并发度必须 ≤ `maxConcurrentProcesses`，batch 大列表只能排队；还要与"构建占 1 槽"的既有语义共存。
4. **selected 扫 Leader JSONL vs 会话树真相**：amagi 的 dispatch-handoff 直接读宿主 pi 会话 JSONL 选原文；feishu-sync 契约规定"会话历史真相在 pi JSONL 树，元数据节点不能截断回溯"（CLAUDE.md 工作台节）——复刻 selected 必须以 server 会话 DTO/应用侧存档为源，不能让插件进程直接扫 pi 内部文件。
5. **glob 写白名单 vs 路径守卫/Workspace 围栏**：amagi allowedPaths/protectedPaths 是 glob 语义+guards 执法，面向"当前用户权限 Node 代码"（无 OS 沙箱声明，§17 末段同款边界）。feishu-sync 有 `resolveInside` 路径守卫、Workspace 与原始库/标准库隔离、原始源 hash 阻断——编排任务的写入面必须落到 Workspace 围栏与 path-guard 体系，amagi 的白名单只能作为任务书声明层，不能替代围栏。
6. **运行期固定快照 vs 动态工具注册**：amagi 允许运行期注册/启用资源；feishu-sync §17 要求"每次运行固定插件配置快照，包管理时拒绝活跃对话/构建并回收空闲进程"——编排插件自身工具集必须在 snapshot 冻结内，运行期不得动态增删工具或包。
7. **模型解析面**：amagi `amagi.json` + modelRegistry 任意 provider/降级链；feishu-sync 模型经应用配置注入（feishu-sync-llm provider + configured-models 只读复用），编排的 model 覆盖只能引用应用已配置模型。
8. **裁决者错位**：amagi 的 decide accept/reject 是 Leader 工具动作；feishu-sync 中任务验收若保留，裁决者应是应用会话用户（GUI 交互），需映射到 SSE 交互或显式裁剪（见 4.2-8）。

### 4.4 形态建议要点（供 fuxi 设计消费，非正式设计）

- **载体**：编排器做成内置 knowledge-workbench 包新增的 Pi 扩展资源（随 `pi.extensions` 注册、随运行期快照冻结加载）；工具面走 feishu-sync-agent 同款转发模式（server 下发规格、fail-closed、运行令牌），编排状态机与准入队列落在 **server 侧**（插件进程无状态或薄状态），与"服务端裁决工具集与能力令牌"的既有裁决一致。
- **v1 最小闭环**：角色卡（3-5 个内置角色）+ `task_submit`（单任务/batch 排队）+ `task_query` + resume + marker 完成契约 + blocked SSE 回流。缓做：steer、fork、接受轴、worktree、编排模板（fanout 可后补）。
- **并发**：沿用 AgentProcessPool；把 409 拒绝改为 FIFO 排队（admission 模式），池上限即编排并发上限。
- **进度观测**：复用 run_log/文档树之外建独立任务记录（文件或 SQLite additive 迁移），字段集参照 TaskRecord 裁剪。

## 5. 依赖关系简图（文字版）

```
amagi-pi（宿主外插件，Leader 进程内）
package.json[pi.extensions=./extensions]
 └─ extensions/amagi-core/index.ts（组合根：guards/status-ui/mcp/rpc-pool/内核接线）
     ├─ agents-loader.ts ──→ agents/*.md（角色卡）→ task-permission.ts（capabilities 校验/四方交集/冻结 PermissionGrant）
     ├─ task-tool.ts（legacy task 工具；sync 链 runTask）──┐
     ├─ task-background.ts（background 链）──────────────┤
     ├─ task-facets.ts（task_submit/resume/control/query 分面）→ task-service.ts（submitTaskKernel 冻结 TaskSpec）
     ├─ orchestrate.ts（五模板→GroupSpec）→ group-scheduler.ts（DAG/unlockOn/requires 回执轴/ResultEnvelope）
     ├─ task-resume.ts（--session/--fork 续接；lease；磁盘回填）→ dispatch-handoff.ts（selected 证据）
     ├─ admission.ts（分池 FIFO 准入）←─ 上述全部派发路径
     ├─ task-kernel.ts（apply 唯一写入口；stateSeq CAS/revision 栅栏/回执/decide）
     │    ├─ contracts/{task,command,view,permission,evidence}.ts（K1 冻结契约，纯类型+校验）
     │    ├─ task-registry.ts（内存投影/TaskRecord）
     │    └─ task-store.ts（FileTaskStore 磁盘 CAS）
     ├─ task-run.ts（runPiTask 唯一 spawn 点：--mode json/-p/--tools/--append-system-prompt/env 白名单/进程组/watchdog）
     │    └─ task-jsonl.ts（子进程 JSONL 流解析；marker/usage/artifactRefs）
     ├─ task-steer(-channel).ts（运行中 steer：jsonl 通道+context 注入+ack）
     ├─ answer-queue.ts（blocked TUI 待答队列）　task-recovery/reconcile.ts（重启对账）
     └─ guards.ts（edit/write/bash 执法，主+子进程）＋ task-write-log.ts（写盘归因）

feishu-sync（应用内嵌 server 权威）
server/src/index.ts buildServer
 ├─ AppPluginStore（上下文插件 registry/overrides/快照 revision）──→ /api/agent/plugin-contexts
 ├─ PiPluginService（包管理：settings.json 声明+CLI install/remove/toggle+generation/revision+retireIdle+protectedRoots）
 │    └─ inspect-packages.mjs（Pi SDK 只读盘点）＋ runtime-resolver（node/pi 解析）
 ├─ AgentProcessPool（槽位预留/busy/idle 回收，1..4）
 │    └─ PiRpcProcess（--mode rpc --no-* --offline --tools/-e/--session-id 启动）
 │         └─ pi-extension/feishu-sync-agent.js（转发扩展：GET tools 规格→registerTool；provider 注入；tool_call fail-closed）
 │              └─ POST /api/agent-internal/tools/:name（server 裁决执行；X-Agent-Run-Token；path-guard/Workspace 围栏）
 └─ knowledge-workbench 内置包（agent/plugins/knowledge-workbench：上下文插件+构建规则/文风资产）
```

## 待核验项

1. `index.ts`（1168 行）只读了前半+组合根关键段；全量装配细节（status-ui/input-router 接线）未逐行核。
2. `tool-surface.ts` 的 `task_batch` 门控与 `amagi_resource enableFacet=batch` 的 CallerContext 传递链未逐行核实（结论 C3 以 task-facets.ts:108 与头注释为据）。
3. `rpc-pool.ts`/`rpc_task` 工具面、`rpc-pool-tool.ts` 未精读；rpc 后端与 json 后端的行为差异只采信了 TaskRecord.backend 字段与 spawn 面证据。
4. amagi 受信配置面（`auth-preflight.ts`/`baseline-scope.ts`/`trust-context.ts`）未读——§4.3-2/5 中"用户授权面"的具体形态以 task-permission.ts 头注释矩阵为准。
5. `group-scheduler.ts`（回执轴解锁语义）只经 orchestrate.ts 侧面引用，未直接读全文。
6. feishu-sync `agent-tool-service.ts`（能力令牌签发细节）与 `pi-rpc-process.ts` 的 RPC 协议帧未展开——冲突面 2 的"运行令牌"以 feishu-sync-agent.js 环境变量与请求头用法为据。
