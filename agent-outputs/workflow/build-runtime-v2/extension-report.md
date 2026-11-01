# 扩展侧交付报告（收敛版）：Leader 工具收窄与派发守卫接线（构建重构 v2 §3.4）

- 任务：`server/src/agent/pi-extension/feishu-sync-agent.js` 构建模式接线 + `server/tests/build-runtime-extension.test.ts`（独占写面，无其他源码改动；未提交）。
- 本版按 Leader 反馈完成**接缝收敛**：删除扩展内联权限策略，守卫策略唯一来源为运行时底座 `build-runtime/dispatch-guard.ts`（build-v2-runtime worktree，宿主注入模块绝对路径 dynamic import）；补齐**真实 amagi-core 冻结契约探测**。
- 上游输入：设计 v2 全文 + 核查证据、CLAUDE.md、Pi 1.4.0 docs（extensions/types.d.ts/rpc/cli 及交叉引用）、amagi-pi 2.21.31 源码（task-facets SubmitParams/ResumeParams、contracts/task.ts TaskSpec、contracts/permission.ts PermissionGrant，只读核实）、运行时底座 contracts.ts/dispatch-guard.ts 实读。

## 1. 环境契约（与运行时/集成切片对齐；本轮已收敛）

构建模式由**两个 env 同时注入**才激活（任一缺失 → 扩展 factory fail-closed 抛错）：

| 环境变量 | 值 | 说明 |
|---|---|---|
| `FEISHU_SYNC_BUILD_GUARD_MODULE` | dispatch-guard 模块**绝对路径** | 名称取自 dispatch-guard.ts 头注的消费契约。生产=编译产物 `server/dist/agent/build-runtime/dispatch-guard.js`；开发/测试=源码 `.ts`（pi jiti 实测可加载，见 §3-B2）。扩展校验导出面 `guardTaskSubmit/guardTaskResume/validateGuardConfig` |
| `FEISHU_SYNC_AGENT_BUILD_SPEC_JSON` | `{"tools": string[], "guard": FrozenDispatchConfig}` | `tools`=Leader 白名单（扩展自身校验：非空、无重复、必含 `task_submit`）。`guard` **原样透传**运行时 `validateGuardConfig`（扩展不复制任何权限校验逻辑），issues 非空即 fail-closed |

FrozenDispatchConfig 形状以运行时 dispatch-guard.ts 为准（`schemaVersion/buildId/generation/workDir/reportRoot/forbiddenZones/roles{amagiAgent→{key,models[],mcpTools[]}}`）。**角色模型为逐字精确名单**：覆盖值必须与该角色 `models` 条目完全一致（thinking 档位不同也算越界）——这是对 Leader 指出的"全表允许/任意剥 thinking"缺陷的收敛结果。

其他语义（不变）：`FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS=1` 在构建模式被忽略（只记警告）；应用 task 族（task_submit/task_query/task_resume/task_cancel）即使 server 下发也跳过注册；session_start 激活集合与 tool_call 放行集合**同源为 spec.tools**。

### 集成侧待办（不在我写面，需 Leader 协调）

1. **运行时 `environment.ts` 的 `buildLeaderEnv` 目前不注入上述两个变量**，且 `envAuditIssues` 的 `FEISHU_SYNC_*` 白名单（仅 AGENT_URL/AGENT_RUN_TOKEN/BUILD_MCP_URL/BUILD_MCP_TOKEN 四项）会把它们判为"意外透传"——运行时切片需在 Leader env 中追加这两个变量并同步放宽 audit 白名单（或集成方在 buildLeaderEnv 之后追加注入并豁免 audit）。
2. dispatch-guard.ts 的 `FrozenDispatchConfig.forbiddenZones` 注释仍写"追加进 scope.deny"，但实现已是**冻结覆写**（模型自报 deny 被替换，01:57 修订）——注释与其测试若未同步，归运行时切片。
3. 运行时 adapter 期望 `PiRpcProcess` 支持 `buildMode/selfTriggeredRounds/terminateGraceMs` 选项，我的 worktree 的 pi-rpc-process.ts 尚无这些字段——主链切片写面。

## 2. 守卫语义（全部委托运行时；扩展只做事件接线）

- Pi 契约（extensions/types.d.ts）：`event.input` 原地可变、"No re-validation after mutation"；阻断返回 `{block:true, reason}`。
- 扩展 tool_call：白名单检查 → `guardTaskSubmit/guardTaskResume(config, input)` → block 则 `reason = message（code）`；allow 则把返回的**新 args 对象**逐键原地写回 `event.input`（对象身份不变，执行时参数即冻结后参数）。
- task_resume：模型覆盖对全表精确匹配；防御性删除模型塞入的 scope/workspace/profile（amagi schema 本会拒绝，守卫提前剥离保证 dry-run 预检口径一致）。
- 审计：`guard_amended/guard_blocked` 以单行 JSON 写 stderr，audit 体即运行时 `DispatchGuardAudit`（roleKey/taskSha256/effective scope/changes 逐项），不含任务正文。
- 普通会话（无构建 env）：不挂守卫、不收窄，外部插件开关语义逐字保留（A4 回归锁定）。

## 3. 验证证据（真实执行，非 mock 返回值）

测试 11/11 通过（`cd server && npx vitest run tests/build-runtime-extension.test.ts`；本机 pi 1.4.0 真跑，无 skip）：

**A 层（单元/接线）**：信封校验与 fail-closed（坏 JSON/缺 guard 模块/schemaVersion 不符均拒绝启动）；经真实运行时模块的守卫语义（他角色模型、未冻结 thinking 档位 `dispatch_model_not_frozen`、越界角色 `dispatch_role_not_allowed`、taskFile 逃逸 `dispatch_task_file_outside_workdir`、写面过滤、禁区覆写、mcp 按角色、profile 删除、workspace 固定、input 对象身份保持）；普通会话行为保留。

**B1 真实 Pi 管线（mock 任务工具）**：白名单激活快照、守卫改参真实进入执行侧（probe 落盘的 args 即冻结后参数）、白名单外工具即使被再激活（模拟 CLI --tools 泄漏）仍被扩展层阻断、运行事件 stderr。

**B2 真实 amagi-core 派发（本轮新增，临时 HOME/agentDir、无生产凭据）**：真实 pi 加载 amagi-pi 包（`-e` 包根，与运行时 adapter 同序：amagi 先、转发扩展后）+ mock OpenAI 模型发出 1 次合法 + 2 次越界 task_submit：
- 合法派发（敌意 scope：write `**`/shell guarded/advisor/lsp/mcp 任意/cwd `../escape`+worktree/profile）经守卫冻结后**进入 amagi 冻结契约** `<agentDir>/amagi/v2-store/<taskId>/spec-<id>.json`，实测落盘值：
  - `permission.shell="deny"`；`permission.mcp` = 恰好 `kb_read_material/kb_submit_draft`（amagi 归一为 amagi-mcp server + policyDigest）；`permission.write` = `agent-outputs/**` glob + `agent-outputs/report.md`；`permission.deny` = 6 项禁区（workDir 绝对化）；`reportFiles=[]`、`lsp=[]`；`workspace={cwd:workDir, mode:"existing"}`。
- 越界调用被守卫阻断且**未建任务**（v2-store 仅 1 份 spec）：未冻结 thinking 档位与跨角色模型均返回 `dispatch_model_not_frozen`（错误回执进模型次轮请求，session JSONL 可复核）。
- 真实 amagi 工具面上的白名单收窄：模型请求声明的工具 = 白名单∩已注册（task_submit/amagi_resource/kb_build_probe…，无 run_bg/codemode/bash）。

探测中修正的两个真实障碍（供集成参考）：① 测试宿主 env 携带 `AMAGI_SUBAGENT=1` 会让 amagi-core 走子进程分支（Leader 工具面全不注册）——测试 env 从零构造规避，生产 `buildLeaderEnv` 白名单天然无此问题；② amagi v2 派发预检**硬校验任务模型已在 Leader modelRegistry 注册**（较核查证据 E4"仅 stderr 警告"更严）——探测用转发 provider 自身的 mock 模型作冻结模型通过；生产 zhipuai 模型经 agentDir models.json 静态声明满足同一校验。

回归：pi-probe + agent-assets 7/7、`tsc --noEmit`、eslint 两写面文件零告警、根 `npm test` 492 用例通过。

## 4. 未测边界（如实，不宣称全覆盖）

- B2 子任务**子进程侧**行为未断言（子进程解析不到 mock provider 属预期快速失败；冻结契约在 spawn 前落盘，符合断言目标）。真实 zhipuai 模型 + 真实密钥的端到端派发属集成 Gate。
- 未跑 amagi `dryRun` 预检路径（选择了真实最小派发，覆盖更强）；`task_control/task_query` 无守卫（任务书未要求，白名单仍约束可见性）。
- scope.deny 语义按运行时 01:57 修订版（覆写）断言；运行时模块仍在并行演进（本轮期间改过一次），合并时若有再变更需同步对齐测试期望。
- 运行时 `buildLeaderEnv` 未注入两 env（§1 待办 1）——扩展契约已就绪，宿主接线后才能在真实构建中生效。
- Windows/打包产物（asar.unpacked）未实测；机制上无平台分支（纯 JS + dynamic import 编译 JS）。
- 生产加载路径核实：扩展纯 JS、`build-agent-assets.mjs` 原样复制，guard 走宿主注入的 dist 编译 JS 绝对路径——不依赖开发 TS，无需打包改动；唯一前提是 §1 待办 1 的 env 注入。

## 5. 回滚

`git checkout -- server/src/agent/pi-extension/feishu-sync-agent.js && rm server/tests/build-runtime-extension.test.ts`（仅本任务写面两文件）。
