# 运行时隔离与 Pi 宿主底座交付报告（构建重构 v2 §3/§8/§11）

- 任务：`server/src/agent/build-runtime/`（contracts / 配置生成 / 包安装管理 / 能力探测 / 环境 / 派发守卫纯逻辑 / adapter）+ `pi-rpc-process.ts` 构建模式增量 + `server/tests/build-runtime-*.test.ts`。
- 产物 worktree：`.amagi-worktrees/build-v2-runtime`（未提交，dirty-snapshot；不碰 kb-build-service / agent-tool-service / feishu-sync-agent.js / 共享 types）。
- 设计依据：`基于Agent基座与工作流插件的构建重构设计-v2.md` 全文 + `v2-核查证据/amagi-pi-嵌入能力核查.md` + amagi-pi 2.21.31 源码与 pi 1.4.0 docs 逐项核实（配置形状零猜测，锚点见 §4）。

## 1. 接口契约（供集成/扩展/工具切片直接消费）

### 1.1 共享契约 `server/src/agent/build-runtime/contracts.ts`

类型：`BuildRunSpec` / `RuntimeBinding` / `RuntimeEvent` / `BuildRuntimeAdapter` / `CapabilityReport`（+`CapabilityCheck`）/ `CancelResult` / `BuildCheckpoint` / `ProbeInput` / `BuildModelDescriptor` / `BuildAutoRounds` / `BuildLimits` / `AmagiPackageRef` / `BuildResumeCapability`。

常量（跨切片对齐用）：

| 常量 | 值 | 说明 |
|---|---|---|
| `DEFAULT_ROLE_AGENTS` | writer→luban, reviewer→diting, research→baize | 角色→amagi agent 默认映射 |
| `AMAGI_TASK_TOOLS` | task_submit/task_query/task_control/task_resume/amagi_resource | Leader 白名单必须含 |
| `KNOWN_AMAGI_AGENTS` | luban/diting/baize/fuxi/luoshen | spec 只验内置表；**guard 允许集取 spec.roles** |
| `BUILD_MODEL_PROVIDER` / `ZHIPU_API_KEY_ENV` | `zhipuai` / `ZHIPU_API_KEY` | 唯一受支持 provider（PROVIDER_KEY_MAP 实测） |
| `BUILD_MCP_SERVER_NAME` | `feishu-kb-bridge` | agentDir mcp.json 唯一 server |
| `BUILD_MCP_URL_ENV` / `BUILD_MCP_TOKEN_ENV` | `FEISHU_SYNC_BUILD_MCP_URL` / `FEISHU_SYNC_BUILD_MCP_TOKEN` | mcp.json ${VAR} 引用 + Leader env 注入，amagi 按引用交付子任务 |
| `REPORT_WRITE_GLOB` | `agent-outputs/**` | 子任务唯一写面 |
| `BUILD_ID_PATTERN` | `/^b_[A-Za-z0-9_-]+$/` | **b_ 前缀 = 现有真实规则**（kb-build-service.ts:574 `b_${ts}_${6hex}`，实测核实；kb_ 不是构建 id） |

纯函数：`validateBuildRunSpec(spec): string[]`（问题列表；含 pools 合计≤max、同模型池容量一致、research 模型必填——见 §4.4 实测依据）、`modelSpecPoolKey(spec)`（去 thinking 档位，与 amagi 池键同语义）。

### 1.2 派发守卫 `build-runtime/dispatch-guard.ts`（零依赖纯模块，扩展可直接加载）

```
guardTaskSubmit(config: FrozenDispatchConfig, args, {now?}) →
  { decision:'allow', args:冻结后参数, audit } | { decision:'block', code, message, audit }
guardTaskResume(config, args, {now?}) → 同上（resume 只校验模型覆盖 + 防御性剥离权限字段）
freezeGuardConfig(input) → FrozenDispatchConfig（非法即抛）
validateGuardConfig(config) → string[]
```

冻结策略（与扩展侧 extension-report §2 已对齐为同一策略）：
- 阻断：`agent` 不在 `config.roles`；`model` 覆盖不在角色冻结集；`taskFile` 越出 workDir；resume 缺 `handle`/模型越界。
- 冻结：`scope.shell='deny'`；删除 `scope.lsp/advisor/codemode`；`scope.write=[reportRoot/**]`（替换）；`scope.reportFiles` 过滤到报告面；`scope.deny=config.forbiddenZones`（**覆写**，非合并）；`scope.mcp=角色精确工具名`；`workspace={cwd:workDir, mode:'existing'}`（丢 worktree/base/dependencyVisibility）；`outputPaths/outputs` 过滤到报告面；删除 `profile`。
- 审计：`audit.taskSha256`（只哈希不存正文）、生效 scope/workspace、changes 列表。
- 参数形状按 amagi 2.21.31 `task-facets.ts` SubmitParams/ResumeParams 实测（非猜测）。

**扩展消费方式**（两选一，字段同源）：
1. TS：`import { guardTaskSubmit, guardTaskResume } from './build-runtime/dispatch-guard.js'`
2. 纯 JS 扩展：宿主注入 `FEISHU_SYNC_BUILD_GUARD_MODULE`（编译产物 `server/dist/agent/build-runtime/dispatch-guard.js` 绝对路径），扩展内 `await import(env…)` 即得同名导出。模块仅依赖 `node:crypto`。

### 1.3 环境契约 `build-runtime/environment.ts`

`buildLeaderEnv(input)` 产出 Leader 进程 env：白名单基础变量（PATH/HOME/代理等，与 amagi 子进程白名单同源）+ `PI_CODING_AGENT_DIR=<build home>` + `PI_OFFLINE/PI_SKIP_VERSION_CHECK/PI_TELEMETRY` + `ZHIPU_API_KEY`（Leader 模型 + amagi 按 provider 交付 zhipuai 子任务）+ `FEISHU_SYNC_AGENT_URL/RUN_TOKEN`（Leader 转发扩展）+ `FEISHU_SYNC_BUILD_MCP_URL/TOKEN`（桥接变量）+ amagi 自动行为开关（`AMAGI_AUTO_VERIFY_OFF=1`、`AMAGI_AUTO_CONTINUE_ROUNDS/AMAGI_AUTO_REPAIR_ROUNDS/AMAGI_AUTORETRY_IMPLICIT_ROUNDS` 按 spec.autoRounds）。

扩展构建模式三变量（与 extension-report §1 对齐，提供 `guardConfig+leaderTools` 时注入）：

| env | 值 |
|---|---|
| `FEISHU_SYNC_AGENT_BUILD_SPEC_JSON` | `renderExtensionSpecJson(guardConfig, tools)`：`{tools, guard: guardConfig}`；原样交唯一运行时策略校验，删除旧9字段映射 |
| `FEISHU_SYNC_BUILD_GUARD_CONFIG_JSON` | FrozenDispatchConfig 原文（guardTaskSubmit/Resume 输入） |
| `FEISHU_SYNC_BUILD_GUARD_MODULE` | 编译后 dispatch-guard.js 绝对路径 |

辅助：`envAuditIssues(env)`（检出意外 FEISHU_SYNC_*/PI_* 凭据/危险变量）、`ensureWorkLayout(dirs)`（预建 agent-outputs）。

### 1.4 agentDir 配置生成 `build-runtime/agent-dir-config.ts`

`planBuildDirectories(dataRoot, buildId)` → `{buildRoot, homeDir, workDir, sessionDir}`（`<dataRoot>/agent/builds/<buildId>/{home,work}`）。
`renderAgentDirConfigFiles(spec, dirs|null, {bridgeCommand, bridgeArgs})` → 四文件文本（纯函数）；`computeAgentDirConfigHash(files)` → spec 冻结哈希（不含密钥：apiKey/env 全是引用）；`writeAgentDirConfig(...)` 落盘（0600、tmp+rename）并返回哈希；`validateRenderedConfig(...)` 形状+交叉校验；`agentDirConfigMatchesSpec(homeDir, spec, bridge?)` 容忍式漂移核对（amagi/models 逐字节、mcp 可选逐字节、**settings.json 只比 packages**——实测 amagi 启动会追加 retry 段）；`buildForbiddenZones({workDir, dataRoot, knowledgeBaseRoot, outputRoot, userHome?})` → 禁区清单（工作目录配置面 + 数据根 config.json/db/run/source-edits + 原始库/标准库 + `~/.pi`）。

生成的四文件形状（全部按真实解析器核实）：
- **settings.json**：`packages:[{source:<版本化包根绝对路径>, skills:[], prompts:[], themes:[]}]`（local package 不复制；object form 收窄资源面）。
- **amagi.json**：`agents.<luban|diting|baize>={model:"zhipuai/<id>[:thinking]", skills:[<构建skill路径>]}`（缺省角色不写 model→实测回退角色卡 deepseek，故 spec 三角色模型必填）；`concurrency.models={"zhipuai/<id>":容量}`（键=去档位模型池）；`mcp={leader:[], default:[], agents.<角色>:["feishu-kb-bridge"]}`（显式空=Leader 不连 MCP、子任务仅角色路由）。
- **models.json**：`providers.zhipuai={baseUrl, api:"openai-completions", apiKey:"$ZHIPU_API_KEY", models:[…]}`（$NAME 环境插值；无密钥值）。
- **mcp.json**：`mcpServers["feishu-kb-bridge"]={command:<应用node绝对路径>, args:[<桥接脚本>], env:{FEISHU_SYNC_BUILD_MCP_URL:"${FEISHU_SYNC_BUILD_MCP_URL}", …TOKEN…}, exposure:"codemode"}` + `autoEnableCodemode:false`（设在 mcpServers 旁，pi mcp.md 实测位置）。

### 1.5 包版本安装管理 `build-runtime/amagi-package.ts`（修正轮 steer #11 后）

`installAmagiPackage({nodePath, piCliPath, dataRoot, version, sourceDir?, npmRegistry?, timeoutMs?, log?})` → `{version, installDir, packageRoot, contentHash, record, fresh}`：
- **幂等复用默认【完整哈希校验】**：已存在记录时先 verifyAmagiPackage（全量重算）；被篡改的包在此抛 `amagi_content_drift`，绝无可信 fresh:false。
- **npm 模式**：`pi install npm:amagi-pi@<version>`（PI_CODING_AGENT_DIR=版本化目录；实测 404：2.21.31 未发布公共 npm，包发布后可用）。
- **source 模式（当前生产路径）**：①源/目标包含关系守卫（防递归拷贝）；②staging 临时目录物化（拷贝阶段 symlink 一律拒绝，不静默丢弃）；③staging 验证（版本+完整哈希）后 rename 入位——不覆盖已冻结版本；无记录残留目录移 `*.stale-<ts>` aside 保留不删除；④【真实执行】`pi install <绝对物化包路径>`（专用安装 home = 版本化目录）；⑤核对 pi 写入 settings.json 的包来源确实解析到物化包根（`amagi_pi_settings_mismatch` 拒绝）+ pi install 前后版本/哈希复核；⑥记录 installedVia.piInstallArgs 实际命令与 piSettingsPackages。
- `verifyAmagiPackage({dataRoot, version, verifyHash?})`：版本一致 + 记录存在 + 内容哈希全量重算一致（漂移=失败）。verifyHash=false 快速路径仅存在性核对，调用方自担。
- `computePackageContentHash(packageRoot, budget?)`：**完整内容冻结**——逐文件分块（1MiB）流式哈希全量字节；包内任何 symlink（目录/文件）一律拒绝（`amagi_symlink_in_package`，不留未哈希可加载入口）；超预算（缺省 20000 文件/512MiB）明确抛 `amagi_hash_budget_exceeded`，不产出截断哈希。实测 amagi-pi 2.21.31 物化 3545 文件/85.5MiB，全量哈希约 260ms。
- 记录 `<installDir>/install-record.json`（0600；layout/installedVia 含实际 pi 命令/piSettingsPackages/hashedFiles/hashedBytes）。

### 1.6 能力探测 `build-runtime/capability-probe.ts`

`runStaticProbes(input)` → CapabilityReport：静态项（pi-version、amagi-package、amagi-package-hash、model-key-mapping、model-key-present、spec-valid、thinking-level-map、forbidden-roots、agent-dir-config、workdir-clean）+ **实测项 10 个全部 `not-measured`**（extension-load/model-call/mcp-channel/identity/guard-effect/completion-notify/quota/cancel/recovery/prompt-injection-overhead，附 runbook）。`fullyVerified` 恒 false（由接入试验置位，不假通过）。`assertProbeUsable(report)`：静态 fail → `BuildRuntimeProbeError` 明确拒绝启用（不静默 fallback legacy）。

### 1.7 adapter `build-runtime/adapter.ts`（BuildRuntimeAdapter 实现）

`PiAmagiBuildRuntime(deps)`：deps 含 nodePath/piCliPath/dataRoot/两根路径/转发扩展路径/桥接脚本路径/agentUrl/三个凭据签发与撤销回调/leaderTools/getLeaderModel/`isProcessAlive?`（宿主进程探测钩子，测试可注入），必填 `roleMcpTools` 精确角色工具表与可选 `guardModulePath`。
- `probe/probeWith`：静态探测（probeWith 额外 fail-closed 断言）。
- `start(spec)`：包复核→写 agentDir 配置（哈希须与 spec 冻结值一致，否则指引先 render+compute）→ `launch`（buildMode PiRpcProcess：sessionDir、双 `-e`、model=leader、cwd=workDir、env=buildLeaderEnv）→ RuntimeBinding（**leaderPid=真实子进程 pid**，PiRpcProcess.getPid()）。
- `observe(binding, after?)`：AsyncIterable<RuntimeEvent>（e<N> 游标、source='leader-rpc'、nativeEventId=record.id）。
- `resume(binding, checkpoint)`（调整 #9 A17/A18）：binding 路径与 dataRoot 推导一致（防伪造）；**应用重启后内存态为空也能按 binding 自描述重建**；旧 leaderPid 经 isProcessAlive 核对仍存活 → 拒绝双 Leader，未注入钩子时如实告知未核对；包哈希+配置容忍式核对通过 → 原 session id 重启；漂移则明确拒绝（走成果级恢复）。
- `cancel(binding)`（调整 #9 A24）：先 `revokeGenerationCredentials`（注入钩子）→ terminate（宽限=spec.leaderTerminateGraceMs 缺省 10s）→ CancelResult：exitInfo 不可得时如实说明；有 isProcessAlive 钩子时对 pid 复核，「仍存活」与「已确认退出」都写入 residualNote，不伪称已清理。
- `getRpcProcess(binding)` / `buildGuardConfigInput(spec, dirs, roleMcpTools)`：集成方驱动 prompt/round 等待与守卫冻结配置的便捷入口。

### 1.8 PiRpcProcess 增量（`server/src/agent/pi-rpc-process.ts`，普通会话零变化）

`RpcSpawnOptions` 新增：`buildMode?: boolean`（始终显式 `--tools`，空名单 fail-closed 拒启动）、`terminateGraceMs?: number`（terminate 默认宽限，构建 10s）、`selfTriggeredRounds?: boolean`（跟踪 amagi 完成通知触发的轮次：`round_started`/`round_settled` 事件、`hasActiveRound()`、自触发轮中 `prompt()` 明确拒绝 `round_in_progress`、abort 同样可中止自触发轮；完成判定仍只归属宿主 prompt 轮）。

## 2. 改动清单

新增 `server/src/agent/build-runtime/`：`contracts.ts`(360)、`dispatch-guard.ts`(~300)、`agent-dir-config.ts`(~380)、`amagi-package.ts`(~330)、`environment.ts`(~230)、`capability-probe.ts`(~300)、`adapter.ts`(~330)。
修改：`server/src/agent/pi-rpc-process.ts`（+85/-2，见 §1.8 + getPid()）。
报告：`agent-outputs/workflow/build-runtime-v2/runtime-report.md`（主树共享 artifacts）。
新增测试：`server/tests/build-runtime-{contracts,dispatch-guard,agent-dir-config,environment,package,capability-probe,pi-rpc-process,adapter}.test.ts`（8 文件 127 用例；adapter 用例含真实子进程 start/cancel/重启后 resume/伪造 binding 拒绝/observe 游标）。

## 3. 验证证据

- `cd server && npx tsc --noEmit` → 通过。
- `cd server && npx vitest run tests/build-runtime-*.test.ts`（8 文件）→ **127/127 passed**（含：guard 冻结/阻断矩阵、四配置形状断言、容忍式漂移、包安装幂等/篡改检出/env 隔离、probe 静态/实测区分、真实子进程 spawn 的 argv 与自触发轮、adapter 真实子进程 start/cancel/重启后 resume/伪造 binding/observe 游标——假 pi CLI fixture 测本模块编排，注明非真实 pi）。
- 相邻回归（PiRpcProcess 消费方）：`npx vitest run tests/agent-process-pool.test.ts tests/agent-session-concurrency.test.ts tests/agent-tasks.test.ts tests/build-metrics.test.ts tests/build-pipeline.test.ts tests/build-scheduling-supplement.test.ts` → 115/115 passed（构建模式改动不破坏普通会话）。

## 4. 实测记录（不猜配置形状的证据）

1. **数据根禁读读面 grant 语义（P0，Leader steer #3）**：amagi `task-permission.ts:548` `deny = 角色∪用户∪scope.deny`，`dirAwareEntry` 无通配目录条目自动扩为子树；**deny 读写双禁**——`guards.ts:3356-3364` read/grep/find 逐次经 `fileReadPermissionBlockReason`（file-permission.ts:385）校验，「词法或真实落点任一命中即 block，符号链接 realpath 解析用于 deny 锚定」；提交点对 inputs/outputs 落 deny 区整单拒绝（"input-in-deny-region"）。⇒ 守卫把 forbiddenZones 写进 scope.deny 即达成禁读+禁写，symlink 逃逸被 realpath 锚定。
2. **真实 pi 启动测量**（2026-11-01，真实 pi 1.4.0 + source 模式物化的 amagi-pi 2.21.31 + 本模块生成的四配置 + 构建 Leader 同构 argv，无模型调用）：`get_state` 应答 success、**model=glm-5.3 provider=zhipuai baseUrl=我生成的 models.json 端点**（静态声明被 pi 真实读取）、extension_errors=0、干净退出；amagi 预检日志显示它读了我生成的 amagi.json 角色模型（"luban(work) zhipuai/glm-5.3-flash → no-auth" 属预期——测量 env 未放密钥）。
3. **npm 404 实测**：`pi install npm:amagi-pi@2.21.31` → npm 404（包未发布）；错误回显 pi 实际执行 `npm install amagi-pi@<v> --prefix <agentDir>/npm --legacy-peer-deps`，证实受管落点。⇒ 增加 source 模式（见 §1.5），不交付「永远装不上」的 npm-only 形态。
4. **amagi 会话韧性链会写 settings.json**：真实启动时向 agentDir settings.json 追加 `retry.provider.timeoutMs:300000`（带 .amagi-bak-* 备份）⇒ 整文件哈希必漂；已实现容忍式核对（packages 必须一致、其余文件逐字节），resume/probe 均改用该口径。
5. **research 未冻结模型的回退实测**：未写 `agents.baize.model` 时 amagi 回退到 baize 角色卡 frontmatter（deepseek/deepseek-v4-flash），**不是 Leader 模型**（stderr 预检警告实证）⇒ spec 三角色模型必填已固化进 validateBuildRunSpec。
6. **skills 注入形态**：`task-run.ts:243-254` `agentSkillSpawnArgs`——amagi.json `agents.<role>.skills` 配置即 `--no-skills`+逐项 `--skill`（amagi 仓 `.agent-outputs/skill-allowlist-probe/` 有宿主实证记录）；配置生成器按此写 skills 数组。
7. 配置形状锚点：pi `docs/{packages,models-configuration,mcp,cli}.md` + `dist/core/package-manager.js`（local source 按解析后绝对路径加载不复制、npm 受管落点、isLocalPath）；amagi `schemas/amagi-config.json`（2.21.31）+ `mcp-config.ts loadMcpRouting`（mcp.leader/default/agents）+ `admission.ts`（concurrency.models 池键=去档位）+ `task-facets.ts`（Submit/ResumeParams）。
8. **真实 pi 源码安装实测（修正轮）**：真实 pi 1.4.0 + 本机 amagi-pi 开发仓 + 真实临时 home：staging 物化（85.5MiB/3545 文件）→ rename → `pi install <绝对物化包路径>` 真实执行成功（"Installing…/package... Installed"）；真实 pi 将 settings.json 归一为 `packages:["package"]`（相对 agentDir，与 normalizePackageSourceForSettings 源码一致，核对逻辑兼容）；端到端 10.7s；全量哈希 260ms；幂等复用 229ms（全量校验通过才 fresh:false）；篡改后复用被拒（amagi_content_drift）。
9. **修正轮影响面（如实）**：installAmagiPackage source 模式现在真实执行 pi install，fixture pi 必须支持 `install <绝对路径>` 分支（写 settings.json）。本树 `build-runtime-adapter.test.ts` 的 fake pi 是 RPC-only，未适配新契约→6 例超时失败（本轮按指示未改 adapter 侧；主树合入时需给其 makeFakePi 加 install 分支，约 5 行）。capability-probe 测试不调用 install（手落盘 fixture）33/33 照常通过。

## 5. 未验证项（如实，均属 13.1 实测面，须接入试验驱动）

- 真实模型链路（Leader prompt、子任务 spawn、zhipuai 密钥交付）未跑——需要真实密钥与接入试验环境。
- 转发扩展与 amagi-core 联合加载/白名单一致性、MCP 桥接通道（mcp_call 嵌套调用错误率）、身份一致性、guard 改参进入冻结契约（v2-store spec）、完成通知自触发轮在真实 amagi 下的表现、取消无残留、恢复对账——探测描述符已登记 not-measured，runbook 在 `MEASURED_PROBE_RUNBOOK`。
- source 模式拷贝 85MB/3545 文件耗时约秒级（测量机）；npm 模式待包发布后实测。
- 桌面打包（asarUnpack 后 dist guard 模块路径、桥接脚本绝对路径）由集成切片在真实打包产物验证。

## 6. 回滚方式

全部为新增文件 + pi-rpc-process.ts 单文件增量（普通会话行为不变，测试锁定）。回滚 = 删除 `server/src/agent/build-runtime/`、`server/tests/build-runtime-*.test.ts`，revert `pi-rpc-process.ts`。无 DB 迁移、无配置段、无路由。

## 7. 与并行切片的接缝

- **扩展（build-v2-extension）**：env 三变量契约见 §1.3；deny 覆写策略已与其统一；其 resume 任务可直接 `await import(FEISHU_SYNC_BUILD_GUARD_MODULE)` 消费 `guardTaskSubmit/guardTaskResume`+`FEISHU_SYNC_BUILD_GUARD_CONFIG_JSON`，删除内联策略。
- **工具（build-v2-tools）**：`BUILD_MCP_URL_ENV/TOKEN_ENV` 名已按 steer #5 定义于 contracts.ts；桥接脚本读 `AMAGI_TASK_ID/AMAGI_AGENT` 做身份。
- **主链（build-v2-integration）**：入口=§1.1 类型 + §1.7 adapter deps + §1.4 render→compute→spec.agentDirConfigHash→write 流程；`buildGuardConfigInput` 汇出 guard 冻结输入（角色 MCP 工具名单由工具切片的 build-actors 提供）。

## Leader主树接缝修正
- environment改为扩展实际消费的`{tools,guard}`，adapter.launch实际注入guard与共享模块路径，不再只是未使用的helper。
- 启动/恢复同时核对spec冻结的包hash和绝对路径；恢复缺PID/旧Leader仍存活拒绝，无探针时默认本机核对。
- 单zhipuai provider禁止混用端点；Leader及所有角色必须静态声明；每个不同角色模型必须冻结准入池，禁止落到默认池突破总上限。
- PiRpcProcess.terminate等真实close，KILL后仍确认；未确认抛pi_termination_unconfirmed。专项发现测试清理ENOTEMPTY后按真实退出/诊断落盘竞争修正，不盲重跑。
- 先前基础check/build:all通过；最新包/退出修正专项证据见workflow。真实模型质量/性能仍未测，不标fullyVerified。
