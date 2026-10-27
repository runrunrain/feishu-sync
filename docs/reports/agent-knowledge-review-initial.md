# F3 独立审核（full）

## 结论与范围

**FIX：1 Critical、10 Major。** 以下均为本阶段新增路径的问题；不是既有同步模块问题。除明确列出的实际测试外，finding 是沿当前调用链静态证实的可失败行为，**没有冒称已运行攻击、真实模型复现或故障注入**。

- 工作区：`feat/agent-knowledge-workbench`，比较基线 `104ba2f`。使用 `git status --short`、`git diff 104ba2f`、`git ls-files --others --exclude-standard server src electron scripts` 纳入未跟踪模块，未仅审 tracked diff。
- 上游输入：`docs/design/agent-knowledge-design.md`、`docs/plans/agent-knowledge-workflow.md`、`docs/reports/agent-knowledge-{backend,ui,integration}.md`。
- 主线：运行代码/凭据隔离 → 工具令牌/进程生命周期 → 构建工作集/校验/发布/对账 → JSONL/SSE/DTO → MCP/渲染/构建接线。时间预算内重点审高危链路；UI 次要布局分支和运行时发现的全部平台候选没有逐行穷举。
- 遵守只读实施边界：唯一自写产物为本报告；无 patch、正式测试新增、依赖/ABI/OS调整、提交或新模型请求；未读取实际用户 config/DB、pi auth/models 文件，未访问其他 worktree，也未操作 Leader 的3191/5178服务。

## Findings

### R01｜Critical｜Workspace 可写应用运行依赖，突破“无 shell”边界
- **位置**：`server/src/routes/agent.ts:299-318`；`server/src/agent/agent-assets.ts:17-18`；`server/src/agent/agent-tool-service.ts:635-641,705起`；`electron-builder.config.cjs:68-105`。
- **触发/调用链**：将当前项目的 `server/node_modules/hono`（或其他已加载依赖目录）注册 Workspace → 切 Work → `ws_write` 改写其 JS → 下一次 server 启动/import 执行。当前额外保护仅默认 `.pi/agent`、`serverDistRoot()`、发现到的 pi 包根。tsx 下该根实际是 `server/src`；编译态是 `server/dist`。二者都没有覆盖旁边的 `server/node_modules`；开发态也遗漏另一个输出/源码树、根依赖与 Electron 代码。打包 `asarUnpack: server/**` 同样将可写依赖放在 `app.asar.unpacked/server/node_modules`，不在受保护 `server/dist` 内。
- **影响/证据**：允许写执行代码是实际权限扩张，不需要 shell 工具、路径逃逸或同 uid 外部恶意程序。`requireWorkspace` 只返回已绑定目录，写工具接受任意合规文件名，并非只允许文档。单独 PathGuard 单测无法证明实际保护根完整。未实际改写运行代码。
- **最小修复/验收**：服务端推导并保护完整应用安装/开发运行树（含依赖、两种编译布局和资源），对实际 `PI_CODING_AGENT_DIR` 等配置/环境派生凭据根也使用同一策略。以真实路由验证源码、dist、node_modules、Electron、打包 unpacked 依赖全部拒绝，独立文档目录允许；不得靠扩大泛型单测代替接线验证。

### R02｜Major｜配置更新可使既有 Workspace 与 raw/std 或新运行资源重叠
- **位置**：`server/src/modules/config-manager.ts:873-929`；`server/src/routes/config.ts:155起`；`server/src/agent/session-service.ts:208-232,294-300,394-456`；`server/src/agent/agent-tool-service.ts:635-641`。
- **触发/调用链**：先合法授权 `/tmp/docs-ws`，再将 `knowledgeBaseRoot` 或 `standardKb.outputRoot` 改到该目录；重新进入 Work/启动会话，仍只按 workspaceId 取旧路径，没有重新做重叠校验。更新 pi 路径后，旧 Workspace 也可能覆盖新 pi 安装根。忽略 PUT 的 `agent.workspaces` 不能挡住这些反向修改。
- **影响/证据**：随后同步进该目录的 raw 文件或新发布标准库可被 Work 整体覆盖。ConfigManager 只验证段形状/少量数值，保存 root 时没有检查现存 Workspace；工具执行只做 Workspace 内 containment，不检查当前受保护根。
- **最小修复/验收**：配置保存对合并后全量配置做交叉校验；切模式、spawn及写入能力使用时重新检查当前根，冲突时拒绝并撤销旧能力。验收“授权后改 raw/std/pi 根”及已有空闲/运行中进程，raw/CURRENT哈希不得被 Work 改写。

### R03｜Major｜默认 app-llm 会话没有注册 provider
- **位置**：`server/src/agent/session-service.ts:424-462`；对照 `server/src/agent/runtime-probe.ts:30-65`、`server/src/kb/kb-build-service.ts:610-646`、`server/src/agent/pi-extension/feishu-sync-agent.js:26,81-100`。
- **触发/调用链**：有效 app-llm provider/key → status 探测就绪 → 新建 Discuss/Work并发送。会话只注入 key，选择 `feishu-sync-llm/<model>`，但没有生成/注入 `FEISHU_SYNC_AGENT_PROVIDER_JSON`；扩展仅在该变量存在时注册此 provider。隔离 pi-home 没有这个自定义模型。
- **影响/证据**：status 可以 ready、构建路径也能注册 provider，而真实会话找不到模型，默认产品通道不可用。Leader 的真实 pi-agent-dir 验证不覆盖此路径；无需真实 key 请求即可核对缺失的环境注入。
- **最小修复/验收**：复用 probe/build 的 provider描述生成和注入（key仍仅子env）。用本地协议 fixture或扩展装载检查会话子env与注册模型，不消耗真实key即可证明 provider存在，再保留真实端点兼容性未验证声明。

### R04｜Major｜运行中插话/排队必撞单运行锁，并破坏原运行状态
- **位置**：`server/src/agent/session-service.ts:266-278,303-308,312-350,383-390`；`server/src/agent/pi-rpc-process.ts:449-452`。
- **触发/调用链**：已有运行时 POST messages，带合法 `delivery:'steer'` 或 `'followUp'`。服务接受后再进入 `executeRun`，覆盖该会话 runs记录、移除旧转发监听，然后调用 `rpc.prompt`；该方法看到已有 activeRun直接抛 `run_in_progress`，根本不发送 streamingBehavior。
- **影响/证据**：插话/后续消息丢失；新运行 catch/finally将仍在工作的旧运行标成 idle，原流被重新归属新runId，随后模式切换/删除可能被误放行。F2 fixture 的 delivery日志不证明真实RPC投递成功。
- **最小修复/验收**：活跃进程走真正 steer/follow_up或专门队列接口，不创建第二个运行所有者/移除第一轮监听；并发状态必须由同一运行收尾。验收两种delivery均真实到达RPC、旧run不提前idle、后续消息进入JSONL、模式切换仍409。

### R05｜Major｜spawn失败/池满及自然回收不释放运行能力，池满还遗留未托管进程
- **位置**：`server/src/agent/session-service.ts:405-469`；`server/src/agent/agent-process-pool.ts:72-96,118-133`；`server/src/agent/agent-tool-service.ts:104-150`。
- **触发/调用链**：① 已达到池上限时发新会话：先create token、spawn/start、set_auto_retry，最后才register；register抛AgentBusyError。② 子进程自然exit/idle回收。③ start失败。
- **影响/证据**：① 没有finally terminate/revoke；已启动进程未注册，因此closeAll也找不到它。② 池删除进程记录没有撤销对应token，旧Work令牌在内部API仍能执行。③ 会话catch只写错误，不释放token/子进程。搜索会话撤销点只有切模式/删会话/删Workspace与部分模型配置失败，未连接进程exit/失败通用出口。
- **最小修复/验收**：spawn前预留容量；每个进程与令牌绑定唯一所有权；失败、exit、idle、close均幂等释放，register失败立即清理。验收池满前后OS子进程数不增加，捕获的旧测试令牌在全部回收出口返回401（不打印令牌）。

### R06｜Major｜“空闲回收”计时器会杀死正在生成的会话
- **位置**：`server/src/agent/agent-process-pool.ts:88-115`；`server/src/agent/session-service.ts:350-355,388`。
- **触发/调用链**：注册进程即启动idle timer；只有run_finished/finally才touch，发prompt开始和streaming期间没有暂停计时。默认idle为10分钟而prompt允许15分钟；复用进程若已经空闲9分钟，新一轮只运行1分钟即会被回收。
- **影响/证据**：正常未超时模型响应被强杀为pi_process_exited。此处计的是距注册/上次完成的墙钟时间，不是空闲时间。
- **最小修复/验收**：显式busy/idle状态；busy期间不回收，完成后再起idle计时。用短时钟/受控RPC验证临近idle阈值启动的新运行不被杀，完成后才开始完整空闲窗口。

### R07｜Major｜full仍使用增量工作集，可发布部分甚至空标准库
- **位置**：`server/src/kb/kb-build-service.ts:340-345,354-355,372-400,416-420,468-476,1020-1026`。
- **触发/调用链**：已有发布含A/B，源未变，用户点full。staging为空，但workset仍由changeset.added/changed构成，因此为空；跳过所有批次，只发送finish提示。工具调用 `kb_finish({summary:'完成',skipped:[]})` 被接受，空docs校验也返回无问题，然后切CURRENT。若仅B变更，A同样不在强制覆盖集合。
- **影响/证据**：full不再表示全部重建；未变源无任何覆盖保障，可将有效库替换为空库/局部库。模型“也许主动raw_list(all)”不是服务端约束。
- **最小修复/验收**：full工作集明确取全部snapshot；覆盖验证独立按full语义核对。验收重复full、仅一源变更的full、模型只finish三种路径；遗漏源未带合法skip不得发布。另请同批核对仅removed的增量：当前affectedDocs只进入batchPrompt，而没有added/changed时零批次，finish提示没有收到受影响文档清单。

### R08｜Major｜source_changed工具错误可被模型绕过；发布前不复核源
- **位置**：`server/src/kb/raw-source-snapshot.ts:177-213`；`server/src/agent/agent-tool-service.ts:157-185`；`server/src/kb/kb-build-service.ts:515-546,939-1029`。
- **触发/调用链**：冻结快照后源或CSV被同步修改，raw_read得到source_changed_during_build；内部API将其作为普通工具错误交还模型，构建状态没有不可恢复标记。模型随后skip该源并finish，或源在最后一次read后改变，最终校验都不比较当前hash。
- **影响/证据**：承诺应失败的源变更可以继续发布；CURRENT对应旧snapshot或混合读时点。现有“readVerified抛错”单测只证明工具能发现变化，未证明整个构建必失败。
- **最小修复/验收**：将快照完整性错误标为构建不可恢复失败，并在发布前复核源集合/哈希（含附件）。验收“工具报错后仍finish”和“最后read之后变更”，均不移动CURRENT。

### R09｜Major｜指针后DB失败的真实同buildId场景无法启动对账
- **位置**：`server/src/kb/kb-build-service.ts:548-551,888-914`；`server/src/modules/local-map-store.ts:2112-2123`；`server/tests/kb-build.test.ts:333-354`。
- **触发/调用链**：build行在queued时已插入；CURRENT成功后update published失败/进程退出。重启时该行成为failed/interrupted，对账先执行同id的普通INSERT，触发PRIMARY KEY冲突，catch吞掉，后面的update永不执行。
- **影响/证据**：已发布的build长期被报告失败/中断，未恢复要求的历史一致性。通过的测试用freshStore且仅插入不同id的b_orphan，实际覆盖的是“整条build记录不存在”，不是发布流水线既有同id行。
- **最小修复/验收**：存在行直接更新，缺失行才插入或事务upsert，并清掉旧error。验收同buildId分别为publishing/failed/interrupted且CURRENT已提交，重启都准确published且releaseId一致。

### R10｜Major｜指针提交后的保留清理异常会删除CURRENT所指release
- **位置**：`server/src/kb/kb-build-service.ts:736-741,803-816,834-854`。
- **触发/调用链**：CURRENT rename成功；随后cleanupOldReleases的readdir/stat或同步log订阅抛错；异常返回publishRelease外层catch，无论是否已提交都rm整个新releaseDir。可失败条件例：releases目录有写/执行但无读权限，创建和rename可成功，清单读取EACCES。
- **影响/证据**：CURRENT已移动但其docs/manifest被删除，所有UI/MCP读取失效；失败出口也不会恢复旧指针。不是仅“清理失败留多一份release”。未在真实运行目录注入权限故障。
- **最小修复/验收**：明确commit point；指针提交后不允许删除当前release，保留清理为独立best-effort步骤。验收清理故障注入后CURRENT仍能完整读取新release，状态/报告如实描述已发布。

### R11｜Major｜JSONL回溯丢弃非message节点，压缩/元数据节点会截断历史
- **位置**：`server/src/agent/session-service.ts:565-590`；`server/tests/agent-session.test.ts:105-120`。
- **触发/调用链**：合法树`message e1 → compaction c1 → message e2(parentId=c1)`；解析时只将message加入byId，回溯e2遇不到c1即停止，e1丢失。model_change等中间节点同理。
- **影响/证据**：长会话/模式模型元数据变化后的历史接口不再展示当前分支完整消息/写入记录；这与pi自身是否恢复上下文是不同问题。现有测试虽插入compaction，却让后续e5.parentId直接指e4，绕开了非message作为父节点的真实结构。
- **最小修复/验收**：索引所有带id/parentId的树节点，沿最终叶回溯，只在DTO输出时过滤非消息；单独处理真实分支/压缩语义。验收中间元数据、末尾元数据、compaction和分叉不截断、不串分支。

## 覆盖与验证可信度

| 面 | 本轮证据/结果 | 限制 |
|---|---|---|
| 运行权限/工具接线 | 阅读实际routes、RunContext、Workspace派生保护根、RPC参数/命令、扩展、进程池、env与会话spawn；R01–R06 | 没有攻击真实应用/安装目录；没有读取凭据 |
| raw与CSV修正 | `lastSyncedAt`成功证据、cloudDeleted仅观测、附件realpath根别名/缺失/越界拒绝，相关21项kb-build测试通过 | R08说明工具级发现不等于构建级失败；主文件缺失仍按设计源集合变化，不机械判回归 |
| 标准库/原子发布/迁移 | 阅读工作集、validator、publish/cleanup/startup reconcile及LocalMapStore新增访问器/DDL差异；R07–R10 | 无真实发布故障注入；未对真实用户旧DB迁移 |
| 会话/DTO/SSE | 阅读JSONL、SSE buffer/HTTP路由与前端hook/parser；空游标0、buffer副本、resync游标推进路径与测试一致；R04/R11 | 未重做Leader真实浏览器；不以绿色UI替代RPC完成证据 |
| Leader进行中的DTO修正 | 收尾读取已变为`toAssistantMessageDto(message,id): AgentMessageDto`，live id/role/at齐全，历史调用保留原at | 按任务调整#2的冻结版本复核，不把此已知问题另列未修finding；本轮实跑计数为10项，和Leader所述11项不一致，保留计数差异，增量复审应再次确认最终hook/draft回归 |
| MCP | 共享StandardKbStore/纯搜索、四工具只读；esbuild node20 CJS单文件、build脚本与`asarUnpack server/**`路径一致；MCP SDK stdio测试4项通过 | StandardKbStore目前仅基本manifest结构检查，正文未按manifest hash复核；外部改坏文件/整棵docs根symlink的防御仍有限。未实际篡改，不能宣称抗同uid外部修改 |
| Markdown/外发 | href统一协议allowlist，知识库/原文入口confirm，远图授权按URL，远图无desktop头；Agent MessageStream为React纯文本，不自动渲染模型URL | 49项相关前端测试通过；未重新做视觉/浏览器网络抓包 |
| 原有兼容/IPC | Config additive、workspaces PUT剔除、DI和auth顺序、目录选择IPC三端及前端契约，Electron资源布局只读核对 | 未全面重跑原同步回归；采用上游已记录check/build证据，未把ABI构建当运行成功 |

### 实际执行（不是计划）

1. cwd=`server/`，`npx vitest run tests/path-guard.test.ts tests/agent-config.test.ts tests/agent-internal-auth.test.ts tests/agent-session.test.ts tests/agent-status-regression.test.ts tests/kb-build.test.ts tests/mcp-kb.test.ts`：**exit 0，7文件76项通过**。测试输出确认使用临时FEISHU_SYNC_HOME/临时DB；无新模型请求。
2. cwd=项目根，`npx vitest run src/utils/sseStream.test.ts src/utils/agentReadiness.test.ts src/components/preview/MarkdownView.test.tsx src/components/preview/remoteImageConsent.test.ts`：**exit 0，4文件49项通过**。
3. 看到会话DTO并发修正后，cwd=`server/`再跑`npx vitest run tests/agent-session.test.ts`：**exit 0，10项通过**；这些10项尚不足以覆盖新DTO修正的全部浏览器多轮场景。

未编写复现脚本/项目测试：任务只允许写本报告，因此以上反例以准确输入、状态与调用链交给实施者补正式回归，不另占agent-outputs写面。测试通过只证明现有断言，没有反证上述静态路径。

## 保留的盲区与后续门槛

- Leader真实证据按其范围接受：startServer+pi-agent-dir(GLM)工具往返/Work审计/2源发布、浏览器full发布与取消后CURRENT/raw完整SHA不变、MCP四工具和写工具拒绝、重启上下文恢复；**未重跑、未冒充本轮复现**。F2新端点fixture不作真实F1联调证据。
- Electron最小运行仍被本机dyld阻塞；Windows终止/发现、安装包资源真加载、Electron RunAsNode MCP、app-llm真实key调用仍未验证，不调整OS/重装。R03是无需真实key即可确认的接线缺陷，不能用“key未验证”掩盖。
- 运行时发现全部版本/平台候选、超大库性能/成本、完整旧同步回归、UI视觉审美不是本次独立重验范围。当前MCP读取模型信任本地发布目录，不是操作系统级不可变存储。
- 建议一次集中修复后，按R01–R11逐个复核关闭，新增测试重点放实际消费者链，而非只扩PathGuard/纯算法断言。报告自身回滚仅删除本报告；没有项目实施改动需要回滚。

VERDICT: FIX
