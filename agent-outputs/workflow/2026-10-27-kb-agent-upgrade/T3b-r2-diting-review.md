# T3b-R2 独立续审（full，静态取证）

## 审核基线与证据口径

- 项目：`/Users/run.mao/workpace/feishu-sync`；分支按任务书为 `feat/agent-knowledge-workbench`。
- 上游必读：同目录 `T3b-diting-review.md`、`T3c-fix-report.md`；快照材料：`T3b-materials/HEAD.txt`、`status.txt`、`diff-stat.txt`、`untracked.txt`、`full-diff.patch`（按相关文件分段取证）。未解包 tar，直接读取工作区新文件。
- `HEAD.txt` 为 `59a76fa26bb1b7f316da644ab907d46cda4fbb3f`。材料的 diff-stat 实际为 **54 files changed / 6318 insertions / 458 deletions**，不是任务正文的 49 tracked；untracked.txt 含目录级条目，不能据行数当源码文件总数。本轮以清单和实际源码为准。
- 契约：`docs/design/kb-agent-upgrade-design.md` 的 U9/U15/U17/U20/U21、§3–7、§9；`docs/design/agent-knowledge-design.md` 的工具隔离、路径围栏、生命周期与插件快照条款。
- 本轮只有 read/grep/find/write/codemode，**未运行 shell、测试、构建、浏览器或真实云端写操作**。下述为源码及测试断言的静态验证，不把 T3c 的 1189/237 全绿改称本轮执行结果。无执行退出码可报告；未编写项目测试或修复 patch。
- 续审归因：7 项按原编号判定；上轮未覆盖面的新增问题另编 R2 编号。上轮已明确记录但未修改的风险放入遗留观察，不伪装成修复回归。

## ① 7 项修复验证表

| 原编号 / 上轮定位 | 修复实现核实 | T3c 测试锚点与断言核实 | 结论 |
|---|---|---|---|
| **T3b-01 / Critical**；command-table llm.test → routes/llm → DirectChannel | `server/src/ops/command-table.ts:195–231` 仅构造 providerId/modelId/timeoutMs，不透传 llm；`routes/llm.ts:82–111,130–208` 从已保存配置解析引用，恢复 masked key 时拒绝异端点。原 Agent 任意 URL 携已存 key 路径关闭。 | `ops-command-table.test.ts:240–258` 确认完整恶意 llm 被丢弃；`trash-llm-routes.test.ts:662–831` 有顶层/provider 异端点 400、正常同端点、引用/未知 id/混合模式测试。正常测试用不可达回环端点，只证明未被配置门拒绝，不证明远端连通成功。 | **FIXED**（静态） |
| **T3b-02 / Critical**；CLI config.set → config PUT | `command-table.ts:90–111` 禁 feishuWrite；`routes/cli.ts:225–240` 注入 cli actor；`routes/config.ts:166–178` 消费者丢弃该字段。外部伪造 cli actor 只能降权，不能据此提权。 | `ops-command-table.test.ts:204–208` 拒根及子路径；`config-routes.test.ts:131–160` 断言 cli patch 剩余字段、desktop 修改；`cli-source-commands.test.ts:328–361` 真实 server 形态的拒绝、持久开关未改与 desktop 回归均在。该三例中第一例是 HTTP 命令调用，不等于每例都经过打包 CLI 二进制。 | **FIXED**（静态） |
| **T3b-03 / Critical**；FeishuWriteService metas fail-open | `sources/feishu-write-service.ts:365–393` 非 force 必须云端时间和基线均有限值，否则拒写、恢复 dirty、记审计；force 仍必须 OVERWRITE_CLOUD，且明确跳过 metas。preview 同步 blocked。 | `source-push.test.ts:735–790,939–959` 确认 metas 抛错/空+failed 零写、零回拉、dirty、审计；force 显式绕过成功；preview blocked 与警告断言存在。未分别覆盖所有非数字/基线缺失形态，但源码相应分支闭合。 | **FIXED**（静态） |
| **T3b-04 / Critical**；outputDir 祖先 symlink 扩根 | `tasks/task-service.ts:137–151,450–470,680–687` 用父根 resolveInside mkdir 后下发 realpath；生产 spawn 不再 recursive mkdir。`path-guard.ts:160–180` 在每一级创建前 lstat 拒 symlink/非目录，创建后 realpath containment。原“已有祖先 symlink”反例在创建前被拒，创建后也有复核。 | `agent-tasks.test.ts:216–245,392–423` 有顶层/深层/已有外部子目录链接拒绝、正常 mkdir、零 spawn 和外部零创建。正常集成例只检查 done+目录存在，未断言 spawner 收到的 root 或真实 ws_write；单元例确实断言返回 realpath。另见 R2-02 的任务跨轮身份问题。 | **FIXED**（原反例及创建双时点；非 OS 竞态沙箱证明） |
| **T3b-05 / Major**；批准后 confirm 被降为 PUSH | `app-command-family.ts:200–218` 改成缺失才补，overwrite/force 不再被降级。但统一派生未闭合，且让原先可行的 append+allowOverwrite=true 失败，详见下文原编号复核。批准 preview 仍固定展示 def.confirm.value=PUSH。 | `app-command-family.test.ts:185–215` 存在且有效断言转发 body，但 `:49–53` 的 push stub 无条件成功并固定回 mode=overwrite；未进真实 source 路由/服务，也没有 force 或 append+allowOverwrite 用例。不能支持“真实服务链闭合”。 | **REGRESSED**（原 overwrite/force 故障修复，但引入下述 append 回归） |
| **T3b-06 / Major**；W=1 reserveSlot 绕过后台配额 | `kb/kb-build-service.ts:923–925,1115,1184–1235` 用 acquire(background)，连取消信号和 deadline，迟到授槽补 release；不再走 session reserve。 | `kb-build-parallel.test.ts:387–436` 排队期间零 spawn、queueDepth=1，释放后台槽后发布；取消后零 spawn、出队。交互 reserveSlot 断言位于启动构建之前，单独不能证明排队期间保留槽，但与 pool 配额实现及排队断言合读支持修复方向。 | **FIXED**（静态） |
| **T3b-07 / Major**；停止到 settled 之间批准可执行 | abort 立即 emit session_abort + cancelForSession，批准执行前查 aborting/idle，原“已经 pending 的批准迟到”窗口关闭；但仍没有 runId/代际绑定，跨轮旧请求可被新 running 状态洗白，见下文。 | `agent-session.test.ts:262–283` 实际只测空闲会话发 abort 事件与幂等；虽测试名含“新运行清旧标记”，没有启动新轮或断言活跃 aborting。`app-command-family.test.ts:217–268` 手动 stub 状态验证 aborting/idle 拒执行、running 回归有效；不是真实 abort→ACK延迟→下一轮流事件测试。 | **NOT-FIXED**（部分修复；原要求的跨轮隔离未实现） |

### T3b-05｜Major｜确认值保留修复导致 append + allowOverwrite 回归

- **定位**：`server/src/agent/tools/app-command-family.ts:200–218,250–258`；`server/src/ops/command-table.ts:594–627`；`server/src/sources/feishu-write-service.ts:344–360`；旁证 `server/tests/source-push.test.ts:792–809`。
- **触发条件**：本地修改为纯追加；Work 调 `source.push {objToken, allowOverwrite:true}`，force 不传；用户批准。
- **实际影响**：allowOverwrite 只是允许覆盖，不会让 planner 把 append 改成 overwrite。命令表却按 allowOverwrite 产生 OVERWRITE_CLOUD；修复后保留该值，真实服务按实际 append 要求 PUSH，返回 confirmation_required。修复前无条件覆盖为 PUSH 恰好让这个输入成功，因此是本次修复有因果关系的回归。overwrite/force 的原故障确已关闭，不能据此称所有模式闭合。
- **证据**：request 的 `allowOverwrite || force` 与 service 的 `plan.mode === 'overwrite' || force` 不是同一个条件；服务测试明确断言 append 携 OVERWRITE_CLOUD 必须 400。批准卡仍按表基线显示 PUSH，并非实际派生的值。新增 mock 路由不执行这些校验，掩盖了差异。
- **最小修复方向**：server 在批准前取得权威 push plan，按实际 mode/force 统一派生并展示确认语义，执行复核同一契约（计划过期需重新批准），不能简单放宽服务确认。实施者补 app_command→真实路由→服务的 append/overwrite/force，以及 append+allowOverwrite:true 回归。

### T3b-07｜Major｜会话级 running 检查不能识别旧轮请求

- **定位**：`server/src/agent/approvals/approval-service.ts:84–114`；`server/src/agent/tools/app-command-family.ts:246–295`；`server/src/agent/session-service.ts:382–392,476–481,640–642`；`server/src/agent/agent-tool-service.ts:349–367,397–403`。
- **触发条件**：旧轮已发出的工具 HTTP 请求延迟到服务端处理；用户停止该轮、run_end/finally 完成后开始新轮，配置/插件未变，原进程与工具令牌复用；此时旧请求创建批准，用户批准。
- **实际影响**：abort/run_end 只能取消当时已登记的 pending；延迟请求不在集合内。批准记录只有 sessionId，执行复核只看该会话此刻 running，新轮会清 abort 标记，因此旧轮命令可在新轮执行。并非声称已经取消的同一 pending 会自行恢复，而是旧轮尚未登记的请求没有可校验代际。
- **证据**：createRunContext 明确每次进程启动发令牌，不是每 prompt；executeRun 复用进程；ApprovalService.begin 和 app_command 都没有 runId；runState 不比较批准所属轮。此输入/时序由静态链确认，未动态注入网络延迟。
- **最小修复方向**：把工具请求及批准绑定服务端权威 runId/epoch；停止时失效该 epoch，批准前及执行前都验证仍是同一可执行轮，不能把“新轮正在跑”当旧请求仍可执行。实施者补迟到请求跨到下一轮的真实流回归。

## ② 补审范围与新 findings

### R2-01｜Critical｜task_resume/task_cancel 没有任务归属检查，Discuss 可借其他会话的 Work 子任务写盘

- **定位**：`server/src/agent/tasks/task-tools.ts:73–78,125–143`；`tasks/task-service.ts:798–839,699–705`。
- **触发条件**：编排启用的 Discuss 会话 A 得知会话 B 的 blocked converter taskId（例如用户粘贴任务信息或不可信源含该 ID），调用 task_resume，message 内给出写入指令；B 的 Workspace 仍有效。
- **实际影响**：A 无 Work 授权，却能把消息喂给 B 已冻结的 ws_write 子任务并启动它，写 B 的 outputDir；也可取消其他会话任务、取得其 DTO/result。随机 ID 降低猜中概率，不能替代 server 的能力归属校验。
- **证据**：requireParentSession 返回调用者 sessionId，但 resume/cancel 两执行器丢弃返回值，仅凭 taskId 调服务。服务只查任务存在/状态，不比较 row.session_id；spawn 仍使用目标任务的冻结工具及其父 Workspace。对照 query 分支确实按调用者 sessionId 过滤。该链是本轮未审工具族的新能力问题，不是旧项目通用问题。
- **最小修复方向**：内部工具 mutation 必须传入权威 callerSessionId，在任何状态修改、结果返回和调度前验证归属；desktop 任务管理入口可保留独立的全局授权契约。实施者补 A/B 两会话的跨会话 resume/cancel 拒绝、零 spawn/零写入及同会话回归。

### R2-02｜Major｜任务的 Workspace 记录被冻结，但派发/续跑却使用父会话当前 Workspace

- **定位**：`server/src/agent/tasks/task-service.ts:383–390,450–458,638–646`；`server/src/index.ts:307–321`；`server/src/agent/session-service.ts:250–290`。
- **触发条件**：父会话在 Workspace W1 派发 converter（排队中或后续 blocked）；父会话空闲后切为 Work/W2，再让任务取得槽位或 resume。
- **实际影响**：任务继续持有 W1 时冻结的 tools、workspace_id 和原 outputDir，却在 W2/outputDir 创建/写文件，任务授权目标和记录不一致；切 Discuss 则 root 变 undefined，原本冻结可用的 ws 工具失效。这违背“父模式变化不影响冻结任务”的契约，并可误写另一个 Workspace 的同名目录。
- **证据**：submit 存 workspaceId；dispatchRound 忽略它，以 row.session_id 查询当前父会话，再 resolveTaskWorkspaceRoot。index 的 sessionInfo 从父行当前 workspace_id 查配置；switchMode 不因后台任务拒绝。PathGuard 此时只证明“属于 W2”，不能证明属于任务原授权 W1。
- **最小修复方向**：按任务冻结的 workspaceId 解析并校验对应授权，冻结规范父根/子根身份；Workspace 撤销时显式失败或取消任务，不静默转授新根。实施者补排队切根、blocked 后切根/切 Discuss/移除 Workspace 的回归。本轮无法从 untracked 的 HEAD diff 重建 T3c 前版本，不武断把它归为 T3c 引入。

### R2-03｜Major｜blocked 已发出但旧 dispatch 尚未清理时 resume 会永久丢调度

- **定位**：`server/src/agent/tasks/task-service.ts:406–411,490–495,524–526,818–839`。
- **触发条件**：任务进入 blocked 并已广播 task_update；旧子进程 terminate 尚未完成，此时用户从任务面板作答（或另一页发 resume）。
- **实际影响**：resume 把行改为 queued，但 kickDispatch 因 dispatches 仍有旧 promise 直接 return；旧 promise finally 随后只删除 map，不再检查 queued/重新调度。任务永远 queued，且再次 resume 因非 blocked 被拒。
- **证据**：finish(blocked) 在 processOutcome 内先落库/发 SSE；dispatchRound finally 之后还 await pool.terminate，提供真实异步窗口；kickDispatch 的存在检查和 finally 删除之间没有重排机制。既有 `agent-tasks.test.ts:266–290` 先 await whenSettled 后 resume，主动避开该窗口。
- **最小修复方向**：同 task 串行化“轮结束/作答重排”，或 finally 在删除旧 dispatch 后原子检查 queued 并补派发；不能靠 UI 延时。实施者用可控延迟 terminate 复现 blocked SSE→resume→释放 terminate，断言恰好一次新 spawn 和最终落定。

### R2-04｜Major｜kb_delete_doc 用原始字符串认领路径，可用 ./ 别名删除其他单元文档

- **定位**：`server/src/agent/agent-tool-service.ts:902–920`；`server/src/kb/path-claims.ts:31–42`；`server/src/agent/path-guard.ts:52–80,220–233`。
- **触发条件**：u1 已认领并写入 `topic/a.md`；u2 调 kb_delete_doc，path=`topic/./a.md`（或反斜杠别名）。
- **实际影响**：u2 以另一个字符串成功 claim，却删掉同一个实际文件，破坏单元独占与并行确定性。u1 可能已完成；聚合校验未规定必须保留每篇已有文档，因此不能依赖后续校验补回被删正文。此处无需依赖文件系统竞态。
- **证据**：write 先 validateStdDocPath 拒绝 ./ 与反斜杠，delete 没有同等校验；PathClaims 使用字符串 Map；removeFileInside 使用 parseRelativeSegments 折叠 .、转换反斜杠，再 path.join 到同一文件。`kb-path-claims.test.ts` 只覆盖相同字符串竞争，不覆盖真实工具别名。
- **最小修复方向**：所有写/删先使用同一合法规范路径，再以同一规范键认领并触盘；Windows/大小写不敏感卷还要处理实际路径别名。实施者补双 worker 真实工具测试，断言别名删除拒绝且原文件字节不变。

### R2-05｜Major｜插件管理不把 task 算活跃；所谓 frozenSnapshot 又混入当前原生插件资源

- **定位**：`server/src/index.ts:246–250`；`server/src/agent/pi-plugin-service.ts:147–160`；`agent/agent-process-pool.ts:285,370–372`；`agent/app-plugin-store.ts:136–153`；`agent/tasks/task-service.ts:718–752`。
- **触发条件**：Leader 一轮已结束，但后台子任务仍 running，用户更新/停用插件；或任务 blocked 后插件集改变，再 resume。
- **实际影响**：第一种情形不返回 plugin_busy，retireIdle 把未标 busy 的 task 进程当空闲终止，正在运行的任务被无意中断。第二种情形保留旧 revision 的文本快照，却加载当前 native extension/skill/prompt/theme 路径，冻结记录不能反映实际插件集；移除包时还可能加载缺失资源。
- **证据**：running 回调只有 SessionService 和 KbBuildService；TaskService register 后从不 pool.setBusy；retireIdle 对所有非 busy key terminate（不区分 build/task）。frozenSnapshot 从 revision 定位 JSON，但 native 直接调用当前 nativeResources，没有按该 JSON 的 nativeRevision 取资源或检查一致性。这里不把受信任原生插件错误描述为 OS 沙箱逃逸。
- **最小修复方向**：将 queued/running task 纳入插件管理互斥；retireIdle 仅回收确为空闲的会话。冻结快照需绑定原生资源身份，资源缺失/版本变更时诚实阻断或经明确重建新 revision，不把最新资源装进旧 revision。实施者补后台任务独占运行时管理拒绝、blocked 期间变更后 resume 的资源一致性测试。

### R2-06｜Major｜vision 图片限额在全量读入 Buffer 后才生效，构建内存随全工作集无界增长

- **定位**：`server/src/agent/vision/vision-describer.ts:203–219,248–278,291–309`；调用者 `server/src/kb/kb-build-service.ts:815–859`。
- **触发条件**：工作集含大量未缓存图片，配置 maxImagesPerBuild 为小值甚至 0；例如 2000 张各 4 MiB，单图都未超默认 5 MiB。
- **实际影响**：describeMany 先读取所有文件，并把每个未缓存图的 Buffer 存在 pending；到 quota 截断之前已同时持有约 7.8 GiB 图片字节，远超并发数与请求限额暗示的资源边界。Electron server 与主进程同进程，普通大型构建可导致严重卡顿/内存耗尽。单图超限检查也在 readFileSync 之后，不能保护读取本身。
- **证据**：pending.push 包含 bytes，循环结束才 pending.slice(0, quota)，quota=0 也如此；worker concurrency 只限网络调用，并未限制预加载。现有 vision-describer 测试确认 quota=0 不触网，但只用一张 tiny PNG，不能证明内存受限。
- **最小修复方向**：先 stat/受限读取，逐图哈希检查缓存后不长期保留字节；远端 worker 只读取有准入且配额内的图，取消时停止枚举/排队。实施者补配额与读取/峰值在途字节的有界性验证，不要求审核者实际用多 GiB 压垮主进程。

### 补审覆盖清单

| 重点面 | 本轮核对与结论 |
|---|---|
| build-units / path-claims / kb 写族 | 完整读取两纯模块，沿 planUnits 输入 requiredRewrites、removed、workset 到预认领/工具写删、unit_done/final。写/删是同步执行，首写字符串 claim 本身无 await 竞争；发现 R2-04 的别名绕过。增量纯删除分量和全量排序没有另报无实际影响的风格问题。大型连通分量性能未压测。 |
| SyncEngine 入口穷尽 | 仓库搜索 syncDocuments / syncSingleDocument：普通 routes/sync 与 feishu 写后回拉均到 syncDocuments；syncSingleDocument 唯一调用在该方法锁内，docx/sheet/slides/bitable 以及 legacy 写分支都在同一锁及 dirty 检查之后。dry-run 也报 blocker。custom-folder quick-add 是独立 helper，路由先拒已有 token 并选无冲突文件名，非已有 dirty 正文覆盖入口；并发集成未执行。保留下面 fail-open 遗留观察。 |
| task 生命周期 / 角色 / 隔离 | 完整读取 task-service、task-tools、role-registry；角色文件名与 name 匹配、拒链接、工具交集及禁 task_*/app_command 均有实现。发现 R2-01/02/03/05。父删除会调用 cancelSessionTasks，但逐个 await abort、终态先于进程撤销的时序并未做动态流回归；不把“状态已 cancelled”视为 OS 进程已结束证明。 |
| raw_read_image | src 要属于当前原始文档的本地引用；source-images 经 PathGuard 拒绝已存在的根外 symlink，缺失文件保留后报 missing_file。raw_read_image 调 describeOne **没有传 signal**；当前停止不会取消已开始的识图 HTTP，可能继续计费/落缓存直到超时。SDK 层支持 signal 的测试不覆盖该消费者；列为剩余风险，不冒称取消路径已通过。 |
| vision 三协议 / 缓存 / 限额 | 完整读取 channel/describer；三种协议分别构造 image_url/input_image/base64 source，错误脱 key，缓存内容寻址及 tmp+rename；阅读 vision-channel 的真实 SDK+回环 fixture 断言和 vision-describer 的缓存/限额测试。未执行；R2-06 为资源限额缺陷。缓存无淘汰是设计明确接受的已知风险，不作为 finding。 |
| DDL + additive | kb_builds 四新增列在 PRAGMA+ALTER（local-map-store:95–110）和 DDL（:2884–2887）双登记；agent_tasks 两 CREATE 定义字段一致。source_edits 在 DDL :2919–2936；initialize :70–72 对旧库也先执行全套 CREATE IF NOT EXISTS，故旧库会创建该表，不因没有重复写同一 CREATE 就认定迁移失效。未把预发布中间版本缺列情形当已支持的迁移窗口；未执行旧库迁移。 |
| WRITE_SCOPES / 授权消费者 | DEFAULT_REQUIRED_SCOPES 不含 write_only/upload；startDeviceAuth 缺省 read，仅 scopeSet=write 才主动并 WRITE_SCOPES。reauthorize 保留历史已授并集是既有设计，不等于默认申请写 scope。auth-status 与 FeishuWriteService 都核 currentScopes；push 仍要求 enabled+scope。无发现默认读链静默新增写 scope。CLI auth.login.start 命令尚不接受 scopeSet/--write，设计中的 CLI 写授权便捷入口未实现，现只能走 desktop 授权，作为能力差异留给 Leader 对齐。 |
| CLI 打包 / 轻量 UI / 预览 | 读取 build-agent-assets、cli-bundle、CLI 参数/调用器：产物 CJS/node20，命令表只做 type import 配置类型，没有引入 SQLite；roles/prompts 均复制。轻量追到 SourceEditControls、API/DTO 与任务状态消费者，并阅读 MarkdownView 完整相关 diff（patch:7946–8647）：受控 React 元素、URL/样式白名单，无新增 raw HTML 注入执行路径结论。没有打包 Electron 启动或浏览器交互/视觉验收；不能以静态审查代替。 |

## ③ 剩余风险与验证可信度

1. **只签静态审核范围**：所有 finding 为可按所列输入/时序复核的静态路径证实；没有动态复现、复现脚本或测试退出状态。未生成脚本的原因是当前无运行工具，并非把项目测试作者职责转给审核者。实施者应在隔离临时目录/假上游补正式回归，禁止用生产飞书文档做破坏性复现。
2. **测试报告可信度**：T3c 声称的 7 组测试锚点均找到，不存在“只有报告没有测试文件”的情况。但 T3b-05 的 mock 不能验证真实服务确认，T3b-07 的 stub 不能验证真实跨轮时序，T3b-04 的正常集成未真正写盘；这些证据缺口已逐项标注。T3c 的 worker 瞬时异常无原始日志，本轮既不确认负载抖动归因，也不据此单独报代码缺陷。
3. **遗留观察，不混充本轮修复回归**：SyncEngine `getPendingLocalEditState`（:1062–1070）读 source_edits 抛错时仍返回 null。上轮已明确留作盲区且本轮未修，故不新编回归 finding。真实 DB 故障下 fail-open 仍需处理/故障注入，不能宣布“任何状态下绝不覆盖”已证明。
4. **文件系统与运行环境**：创建前/后 containment 有实现，不等于抵抗同 uid 外部进程在任意系统调用之间替换目录的 OS 沙箱。未验证 Windows ACL、大小写不敏感卷路径别名、打包签名后的 RunAsNode、真实 lark-cli scope 授予和飞书 markdown 往返保真。
5. **范围完整性**：本轮完成任务列出的剩余面静态补审，不声称逐字读完 453KB 全 diff 或对整仓既有代码重新审计。前端限定契约一致性与相关 diff，未做视觉质量判断。HEAD/清单按材料接受，没有 git 独立重采；工作区与材料若继续变化，结论需要重新锚定。
6. **产物与回滚**：本轮只新增本报告，无代码、项目测试、应用数据、云端或 Git 变更。回滚仅删除本报告；不需回滚项目现场。

## ④ 修订结论

- 原 7 项：**FIXED 5 项（01/02/03/04/06），REGRESSED 1 项（05），NOT-FIXED 1 项（07）**。
- 补审新 findings：**1 Critical + 5 Major，0 Minor**；另有显式保留的取消、scope CLI 入口、DB 故障、动态/平台验证风险。
- 原先“材料不足导致 full blocked”的前提已解除；当前拒绝放行依据是上列具体调用链缺陷，而不是缺 shell/git 本身。

VERDICT: FIX
