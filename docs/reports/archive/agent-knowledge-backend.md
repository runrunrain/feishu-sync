# F1 后端完整纵向切片实施报告

- 任务：F1 标准库、pi 会话与 MCP 后端纵向切片（分支 `amagi/agent-knowledge-backend`，基线 104ba2f）
- 契约：`docs/design/agent-knowledge-design.md`（D1 已接受版）+ Leader 三条运行中调整（pi-agent-dir 真实凭据 smoke / GLM 路由 / Workspace 受保护根）
- 本报告逐项映射「需求 → 代码 → 命令/结果 → 未覆盖」，不写「全部通过」掩盖未知。

## 一、交付总览

新增 ~6,900 行（模块+路由+扩展+MCP+测试），修改 7 个既有文件（+1,657/−110，其中 −110 主要是 package-lock）。`npm run check` 全绿（实测含 steer #4 修复后）：lint（0 error，2 处遗留 warning 为既有）+ 三段 typecheck + 前端 54 + server 53 文件 703 用例（新增 81 用例：path-guard 22 / runtime-resolver 12 / kb-build 19 / agent-internal-auth 10 / mcp-kb 4 / agent-config 7 / agent-session 7 / pi-probe 5 / agent-status-regression 2）。mcp-kb 在 CI（test 先于 build）下按需用与 build 同一共享入口（`scripts/lib/mcp-bundle.mjs`）打包，不产生第二份配置。

| 模块 | 文件 | 职责 |
|---|---|---|
| 类型/契约 | `server/src/types/agent-knowledge.ts` | AgentConfig/StandardKbConfig/DTO/工具集常量（唯一权威） |
| 运行时 | `agent/runtime-resolver.ts` | Node≥22.19 + pi ≥1.4<2 发现、8 就绪码、显式覆盖排他 |
| | `agent/runtime-probe.ts` | 短命 RPC 探测模型列表（不发 prompt） |
| RPC | `agent/pi-rpc-process.ts` | JSONL 严格 LF 分帧、命令白名单、§4.4 完成判定、重试上限、terminate（POSIX SIGTERM→SIGKILL / win taskkill） |
| | `agent/agent-process-pool.ts` | 并发上限 1..4、会话空闲回收、closeAll |
| 工具 | `agent/tool-specs.ts` | 17 工具纯 JSON Schema 规格（唯一来源） |
| | `agent/agent-tool-service.ts` | 运行令牌 → 上下文 → allowedTools → PathGuard 裁决 + 执行 + Work 审计 |
| 会话 | `agent/session-service.ts` | CRUD/模式切换/运行编排/SSE 环形缓冲(1000)+resync/pi JSONL v3 树解析 |
| KB | `kb/raw-source-snapshot.ts` | 源集合（有成功本地版本即保留，非只筛 synced）、sha256 快照、readVerified 防构建中变更 |
| | `kb/standard-kb-store.ts` | CURRENT(mtime 缓存)+manifest+tree+search；`feishu_sync_kb` header 与原始库 `feishu_sync` 区分 |
| | `kb/kb-build-service.ts` | 六态流水线、staging、确定性校验、原子发布、保留策略、启动对账 |
| | `kb/kb-search.ts` | 纯函数搜索（UI/工具/MCP 同一实现） |
| 安全 | `agent/path-guard.ts` | resolveInside(read/write/mkdir)、原子写、symlink/hardlink/ADS/UNC 拒绝、workspace 授权（含 steer #3 受保护根） |
| 扩展 | `agent/pi-extension/feishu-sync-agent.js` | 纯转发（execute(toolCallId, args) 正确签名、body 单读、fail-closed tool_call、$ENV key 插值） |
| prompt | `agent/prompts/standard-kb-{style,build}.md` | planner-doc-style 提炼内置，运行时不依赖 ~/.agents |
| MCP | `mcp/kb-mcp-server.ts` → esbuild → `server/dist/mcp/kb-mcp.cjs`（520KB 单文件、CJS、node20 target、无原生依赖/无 SQLite） |
| 路由 | `routes/agent-internal.ts`（**auth 前**，回环+令牌+拒 Origin 三重校验）、`routes/agent.ts`、`routes/kb.ts`（auth 后） |
| 构建 | `scripts/build-agent-assets.mjs`（复制 prompt/扩展 + esbuild MCP，挂入 `npm run build`） |
| smoke | `scripts/agent-real-model-smoke.ts`（可选真实模型端到端） |

接线：`server/src/index.ts` 构造全部模块、DI 中间件挂 `agentSessionService`/`kbBuildService`/`agentRuntimeResolver`、内部路由先于 auth、`startServer` 回填内部端口、`close()` 先 `pool.closeAll()` 再关 HTTP（修复了 closeAll 脱离 this 的解构 bug）。

## 二、逐需求映射（验收 → 证据 → 状态）

### 接线逐项（任务书）

| 需求 | 证据 | 状态 |
|---|---|---|
| 类型/服务定义 | types/agent-knowledge.ts 全量 DTO/配置/常量 | ✅ |
| ConfigManager 默认合并与严格校验；旧 config 兼容；key 不泄漏 | `agent-config.test.ts` 7 用例（缺段补默认+写回一次、二次 load 不写回、宽容归一、workspaces 路由忽略+PUT 层剔除、非法 source/越界拒绝）；sanitizeConfig 未触及 llm 之外字段，agent/standardKb 无秘密字段 | ✅ |
| LocalMapStore additive 两端 | kb_builds/agent_sessions 在 `getCreateTablesDDL()`；访问器 createKbBuild/updateKbBuild/getActiveKbBuild/markInterruptedKbBuilds/createAgentSession/…；`kb-build.test.ts` SQLite 段往返验证 | ✅ |
| buildServer 构造与 context 属性 DI | index.ts L150-215 构造 + `(c as any).agentSessionService` 等；agent-internal-auth.test 经 buildServer 真实入口断言 | ✅ |
| 内部工具路由在 auth 前 + 回环+令牌+拒 Origin | routes/agent-internal.ts（index.ts 在 health 后、auth 前挂载）；`agent-internal-auth.test.ts`：无令牌 401/伪令牌 401/非回环 Host 401/Origin 403/合法 200 | ✅ |
| server close 回收进程 | index.ts close() → pool.closeAll()（先进程后 HTTP）；smoke 全流程退出无挂起 | ✅ |
| 构建复制 prompt 与扩展 | build-agent-assets.mjs 挂 `npm run build`；dist 产物三件套存在（见上） | ✅ |
| MCP 单文件产物与连接信息 | kb-mcp.cjs 520KB；`GET /api/kb/mcp` 按 process.execPath 生成 command/args/env(ELECTRON_RUN_AS_NODE)/alternative/snippet，available 以产物存在为准 | ✅（Electron 方式未实测，见未覆盖） |
| 真实启动 API/RPC/MCP 端到端 | smoke 脚本经 `startServer` 真实 HTTP 入口；pi-probe 5 用例真实 pi 1.4；mcp-kb 经 SDK StdioClientTransport 真子进程 | ✅ |

### 核心范围

| 需求 | 证据 | 状态 |
|---|---|---|
| Node≥22.19 + pi≥1.4<2 发现/就绪诊断 | runtime-resolver.ts（PATH+fnm/nvm/volta 候选复用 lark-cli-client、lib/node_modules、pi bin realpath 回溯、npm root -g）；runtime-resolver.test 12 用例含全部 fixture 场景；真机 `agent status: ready, available=99`（smoke 实测） | ✅ |
| JSONL 命令白名单 + 事件完成/错误/取消/重试上限/回收 | pi-rpc-process.ts；RPC_COMMAND_WHITELIST/BLACKLIST；pi-probe.test 实测 `bash`/`new_session`/`switch_session` 全部拒绝 | ✅ |
| 扩展仅加载自有工具，禁默认扩展/skills/MCP/context；禁 RPC bash | spawn 参数固定 `--no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes --no-mcp --no-approve --offline --tools <白名单>` + `-e`；扩展 tool_call fail-closed block；bash 在宿主白名单层拒绝 | ✅ |
| 工具双重校验（规格+server 参数/权限） | tool-specs JSON Schema → pi 执行期校验（真实模型往返已证）+ server 端 requireString/optionalInt/白名单/PathGuard 二次裁决 | ✅ |
| Discuss 只读；Work 绑定显式授权 workspace、仅文件工具无 shell；模式切换撤销旧令牌 | createRunKind 白名单；switchMode 需 `confirm:'WORK'`+有效 workspace；revokeBySession；agent-internal-auth.test「Discuss 调 ws_write 403」「revoke 后 401」；agent-session.test 模式切换 4 断言 | ✅ |
| 持久会话列表/重命名/删除/树形 JSONL 历史、SSE 续传/resync/中止 | session-service + routes（列表/CRUD/messages/abort/mode/events）；parseSessionJsonl v3 树回溯（分叉不串）；SSE 1000 环形+Last-Event-ID+resync（agent-session.test） | ✅（SSE 流式 HTTP 层未单测，见未覆盖） |
| Work 审计不记录正文/凭据 | auditWork 只记 时间/工具/路径/字节数/结果；测试断言审计行含 path 不含正文 | ✅ |
| 源集合含 changed/error 但有成功本地版本 | hasSuccessfulLocalVersion（syncedObjEditTime ∨ syncState=synced ∨ status=synced）；kb-build.test 正负用例 | ✅ |
| 快照 hash、全量/增量、provenance、staging 工具写文档+kb_finish、覆盖校验、构建中源变失败、CURRENT 原子发布、保留上一发布、interrupted 对账、取消/失败不发布 | kb-build-service + kb-build.test 19 用例：变更集三分量、校验失败 issue 分类、发布失败 CURRENT 不动、retainReleases 清理保 CURRENT、markInterruptedKbBuilds+指针对账补 DB、source_changed_during_build、原始库前后 hash 不变 | ✅ |
| 模型不可用真实报错 | no-key → model_auth_missing（pi-probe.test 真实 pi 隔离 PI 目录实测）；无 provider → model_unconfigured；smoke 无模型路径退出码 2 | ✅ |
| std header 与 feishu_sync 不同 | `feishu_sync_kb`（doc_id/sources/build_id）；stripStdHeader/parseStdHeader round-trip | ✅ |
| 只读搜索/树/阅读/source 状态 API | routes/kb.ts（status/tree/docs/:docId 带 current/changed/missing 状态/search）；mcp-kb.test 同数据源断言 | ✅ |
| MCP stdio 四工具与同一纯查询实现、无 SQLite | kb-mcp-server.ts import kb-search/standard-kb-store（esbuild 打平）；SDK client 4 工具 + 未发布报错 + 发布切换即时可见 | ✅ |
| PathGuard 唯一实现 | 全部工具路径经 resolveInside/atomicWriteFile/listDirInside/removeFileInside；POSIX realpath 精确比较（大小写不折叠有断言） | ✅ |
| 令牌/key 不进 argv/SSE/日志/DTO | spawn 只经环境变量；provider apiKey `$FEISHU_SYNC_AGENT_API_KEY` 插值；audit/事件/SSE 无 key 字段；测试断言审计不含正文 | ✅ |
| status 路由配置新鲜度（Leader steer #4） | routes/agent.ts 每次请求 `configManager.load()`，buildModelProbe(config) 按次传参；checkReadiness 对「probe 显式跳过」不再误报 pi_spawn_failed；回归：未配置→PUT 保存 pi-agent-dir→status/recheck 均切换到新配置（agent-status-regression.test 2 用例） | ✅ |
| PI 子进程不继承危险 NODE_OPTIONS/任务环境 | buildPiProcessEnv：app-llm 白名单继承；pi-agent-dir 剔除 NODE_OPTIONS/NODE_PATH/NODE_PRELOAD/ELECTRON_RUN_AS_NODE/FEISHU_SYNC_AGENT_* | ✅ |
| 会话/构建并发状态可观察可持久 | pool.runningCount/max → status DTO；kb_builds 状态机 + events.jsonl（含 tool/build_log/build_status 全量事件） | ✅ |

### 验收清单（任务书「验收」段）

| 验收 | 证据 | 状态 |
|---|---|---|
| 新增关键正负测试 | 79 新用例（上述各文件；正负成对） | ✅ |
| source 原始文件 hash 构建前后不变 | kb-build.test「原始库只读」+ smoke `rawUnchanged=true`（真实构建） | ✅ |
| 失败/取消/部分工具调用不推进 CURRENT | kb-build.test「发布失败 CURRENT 不动」；取消走 CancelledError 路径不发布（流水线同一 fail 出口） | ✅（取消路径单测覆盖对齐 failed 出口，端到端取消见 smoke 未覆盖项） |
| 指针后 DB 失败恢复 | kb-build.test「指针后 DB 失败的启动对账」：CURRENT 指向但 DB 无记录 → 补写 published（指针为真相） | ✅ |
| 路径逃逸与 Discuss 越权拒绝 | path-guard 22 用例 + agent-internal-auth「ws_write ../../escape 拒绝且不落盘」「Discuss 403」 | ✅ |
| 会话 SSE 与持久化 | SSE 缓冲/resync 单测 + JSONL 解析单测 + smoke 消息经 messages API 持久可见 | ✅ |
| 真实 pi probe | pi-probe.test 5 用例（本机 Node24.21/pi1.4 真实执行：启动/get_state/扩展装载 GET /tools 打点/bash 拒绝/no-key 诊断/JSONL id 关联） | ✅ |
| 真实 MCP SDK client stdio 四工具 | mcp-kb.test（StdioClientTransport 真子进程） | ✅ |
| 隔离 tmp 数据 | server vitest globalSetup 临时 FEISHU_SYNC_HOME；其余全部 mkdtemp；smoke 启动校验 FEISHU_SYNC_HOME 非真实根 | ✅ |
| targeted 自验 + typecheck/build | `npm run check`（lint+typecheck+701+54）exit 0；`npm run build:all` exit 0 | ✅ |

### 真实模型端到端（Leader steer #1/#2 授权，glm-5.3-flash）

命令：`FEISHU_SYNC_HOME=$(mktemp -d) npx tsx scripts/agent-real-model-smoke.ts`（退出码 0；steer #4 修复仅改配置读取时机，smoke 场景 config 静态、行为不变，未重复消耗额度）

| 步骤 | 结果 |
|---|---|
| agent status（真实 pi probe） | ready，available=99（本机 pi 凭据，未读取/打印任何 auth 文件） |
| Discuss 一轮（raw_read 工具往返） | PASS：模型真实调用 raw_read 读取临时源并复述文档独有公式（断言 formula+marker+非 error 结果三重） |
| Work ws_write | PASS：文件写入 + 审计行（不含正文） |
| 最小 KB 构建（2 源→发布） | PASS：release 生成、docs=2、sources=2、CURRENT 指针、原始库未变 |

该 smoke 关闭了设计 §15 两个关键未知：**纯 JSON Schema 工具参数在 pi 1.4 的执行期校验可用**、**GLM openai-completions 工具调用兼容**（amagi-glm/glm-5.3-flash 实测）。

排障记录（真实证据驱动）：初次 smoke 暴露两个真实缺陷——扩展 execute 参数签名误用（pi 为 `execute(toolCallId, args, ...)`，首个参数不是 args）与 apiPost 双读 body（text 后再 json 报 "Body is unusable"）。两者都使工具结果在模型侧表现为错误而 server 侧可能已成功；修复后全绿。早期「discuss 通过」是弱断言假阳性（marker 来自用户提示），已改为公式内容断言。

## 三、未覆盖与已知边界（如实）

0. **steer #4 修复后的真实模型重跑**：status 路由改为每请求取新配置，smoke 未重跑（配置静态、路径等价，由新增回归测试覆盖）；F3 整合验证时首跑会自然覆盖。
1. **Electron 打包链**：Electron 31 本机 dyld 启动卡（任务书已知），`ELECTRON_RUN_AS_NODE` 运行 MCP、asarUnpack 后扩展路径、Windows 发现/终止均未实测。已给外部 Node 备用配置（`GET /api/kb/mcp` alternative）。electron-builder 无需改动（`asarUnpack: server/**` 已覆盖 mcp 产物）。
2. **SSE HTTP 流**：环形缓冲/resync/事件拼装有单测；真实 HTTP SSE 长连接（fetch ReadableStream 断线重连）留给 F2/F3 真机交互验证。
3. **构建端到端取消**（用户点击 cancel 的 HTTP 路径）：取消出口与 failed 出口共用不发布逻辑，DB 状态机已测；真实取消按钮链路未单独 smoke。
4. ~~steer/followUp 投递~~ **已覆盖（F3-R04 修复）**：sendMessage 运行中带 delivery 直投同一活跃 RPC 进程的官方 steer/follow_up 命令；受控单测（命令/409/监听器不抹）+ 真实 pi 集成（工具轮挂起时 steer，第二轮 messages 含 steer 文本、历史两条 user）均绿。
5. ~~app-llm 模式真实模型~~ **已覆盖（F3-R03）**：本地 OpenAI 兼容 SSE fixture + 真实 pi + 真实扩展：provider 注册、模型选中、`Authorization: Bearer <sentinel>`（key 只进子 env）、run token 不外发、文本往返全链路绿（不消耗真实额度，无 key 诊断路径另测）。
6. **文件围栏非 OS 沙箱**：Work 模式的文件工具边界是应用层校验，不抵抗同 uid 恶意进程（按 steer #3 要求如实声明）；shell 未提供（§7.5）。
7. **大库构建成本**：仅在 2 源 fixture 上真实构建；批次耗时/token 记录未产出统计（构建事件日志已含全部 tool 调用，可后补分析）。
8. **旧库升级**：kb_builds/agent_sessions 为新表，无存量迁移风险；旧 config.json 补默认已测。真实用户库上的 additive 迁移未执行（不做真实用户 DB 写入，按任务边界留给 F3）。
9. **exit→revoke 的 spawn 集成**：会话/构建两处 spawn 路径均为 `rpc.once('exit', () => revokeToken(token))` 单行绑定，池侧 exit 回收有单测；真实 spawn 的退出→令牌失效链路未做集成实测（需真实 pi 进程退出时序）。
10. **R01 的 Windows 打包树**：resourcesPath/Contents 保护逻辑已实现，Electron 打包环境（winasar/unpack 路径形态）未实测（同第 1 条 Electron 边界）。

## 四、F3 审核修复关闭矩阵（R01–R11，全绿）

| # | 根因修复 | 验证证据（均可复现） |
|---|---|---|
| R01 严重 | 新增 `agent/protected-roots.ts`：应用完整运行依赖树（server src/dist、根/子包 node_modules、electron/、dist-electron、Electron resources+Contents、~/.pi/agent、PI_CODING_AGENT_DIR）+ 外部 Node 安装 bin（含 realpath 形态）+ pi 包根；workspace 授权路由全量接入 | `tests/protected-workspace.test.ts`：依赖树内 6 目录全部 400、node bin 目录 400、普通临时目录 201（可用性不破坏） |
| R02 | 三层防线：`ConfigManager.updateConfig` 合并后交叉校验拒绝落盘（同步启动不受影响，load 宽容）+ `PUT /api/config` runtime 变更路由级校验 + spawn/工具执行动态复核（session `workspaceGuards`、tool-service `requireWorkspace`）；实测根因修复：`normalizeForCompare` macOS 根别名上溯归一（不存在的 guard 逐级上溯最近已存在祖先，修复 /var→/private/var 漏判与丢层误判） | 同上文件：knowledgeBaseRoot/outputRoot 与已授权 Workspace 冲突 PUT 400 且不落盘；配置变更后旧 run context `ws_write` 403 |
| R03 | 新增 `agent/provider-descriptor.ts` 单一实现，probe/会话/构建三链路共用；key 只进子 env | `tests/app-llm-fixture.test.ts`：真实 pi+真实扩展+本地 OpenAI 兼容 SSE fixture：模型选中 `feishu-sync-llm/fixture-model`、`Bearer <sentinel>`、run token 不进 LLM 请求、FIXTURE_ACK 文本往返 |
| R04 | sendMessage 运行中+delivery → 直接向同一活跃 RPC 进程发官方 `steer`/`follow_up` 命令（pi 自带队列语义；不新建第二 run、不 removeAllListeners）；收尾窗口 409 不伪造投递 | `tests/agent-session-concurrency.test.ts` 5 例（命令/同 runId/监听器不抹/409×2）+ fixture：工具轮挂起时 steer → 第二轮 messages 含 steer 文本、JSONL 历史两条 user |
| R05 | 容量先预留后 spawn：`pool.reserveSlot()/register(slot) 消费/release 幂等/closeAll 拒绝`；session/build 两个 spawn 失败路径 terminate+revoke+release；token 与进程同生命周期（exit→revoke） | 同上文件 5 例：预留/消费/幂等/closeAll/池满第二会话立即 agent_busy 且不 spawn（runningCount=1） |
| R06 | busy 挂起 idle 回收，运行结束（成功/失败/异常）重起完整 idle 窗口 | 同上文件 fake timers：busy 120s 不回收；完成后 59s 存活、61s 回收 |
| R07 | full 工作集=快照全部源（changeType=rebuild，重复 full/部分变化 full 都重建全库）；仅 removed 增量合成一个批次明确受影响文档；`full_empty_output` 拒绝空库 | `tests/kb-build.test.ts` 3 例：全 skip 零产出拒绝、incremental 不受该语义约束、full 未覆盖源（即使无变更）source_not_covered |
| R08 | source_changed 不可恢复：`readRawContent` 毒化置位 + `throwIfPoisoned`（批/finish/validating 三检查点，独立方法避开 TS 跨 await 收窄）+ `verifySnapshotIntact` 发布前逐源复核（主文档+CSV 同哈希函数，导出可测） | 同上文件 2 例：raw_read 命中变更报错且 poisoned 置位（skip/finish 无法绕过）；主文档或 CSV 变更发布前拒绝 |
| R09 | 对账 upsert：同 buildId 行 UPDATE 修复（publishing/failed/interrupted 均收敛 published、error 清空），缺行才 INSERT，不再撞 PK 吞错 | 同上文件 1 例：三态逐个验证 + 无重复行 + release_id 回填（CURRENT 指针动态取） |
| R10 | 指针提交点明确（CURRENT rename 为界，前失败清理 releaseDir/CURRENT 不动）；提交后清理 best-effort 双层防护（publishRelease 外层只包提交前 + cleanupOldReleases 扫描自带 try/catch），任何清理/扫描异常不删 current release | 同上文件 1 例：真实故障注入（spy `fs.readdirSync` 对 releases 目录抛 EACCES）→ 发布成功、CURRENT 切换 B、B 可读、A 保留 |
| R11 | `parseSessionJsonl` 回溯索引全部带 id/parentId 节点（compaction/model_change 等作父节点与最终叶均不截断），回溯起点=文件顺序最后节点，输出阶段才过滤 message；分叉不串支 | `tests/agent-session.test.ts` 3 例：compaction 中间不截断、model_change 末尾叶不截断不进消息流、分叉取文件序最后一支 |

全套验证：`server` vitest 56 文件 738 例全绿（基线 709 + 新增 29：protected-workspace 6、agent-session-concurrency 11、app-llm-fixture 2（真实 pi+本地 fixture）、agent-session R11 3、kb-build R07-R10 7）；`npm run check`（lint+typecheck+前端+server）与 `npm run build:all` 结果见交付消息。

## 五、回滚

全部为新增模块/路由/配置段/新表 + 既有文件的小改（index.ts 接线、config-manager 归一段+交叉校验、local-map-store 新表、config.ts 一行剔除+runtime 校验、types Config 扩展、package.json scripts/deps、path-guard 重叠判定重构、routes/agent.ts 保护根接入、routes/config.ts 交叉校验、session-service 投递/预留/busy 重构、agent-process-pool 预留与 busy 重构、agent-tool-service 守卫与毒化、kb-build-service full 语义/毒化/对账/提交点）。回滚 = revert 本分支 diff；标准库目录与 `<dataRoot>/agent` 可整体删除不影响同步功能（设计 §14）。

## 六、建议下一步（供 Leader）

1. F2 按 `docs/design/agent-knowledge-design.md` §9/§11 并行开发（API 已可用；`GET /api/kb/mcp` 给连接片段）。
2. F3 真实入口整合验证：桌面 dev:all 跑通 status/sessions/builds 三 API + SSE；打包产物验证 RunAsNode MCP。
3. 首次真实知识库构建前，先 `GET /api/kb/status` 确认 pending 计数与 outputRoot；构建事件日志（.builds/<id>/events.jsonl）可作为成本分析数据源。
