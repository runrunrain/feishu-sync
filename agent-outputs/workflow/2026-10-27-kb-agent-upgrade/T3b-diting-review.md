# T3b 独立审核报告（full 请求；覆盖尚未闭环）

## ① 审核范围与方法

- 请求基线：`feat/agent-knowledge-workbench @59a76fa`；请求范围：工作区相对 HEAD 全部未提交变更（任务书称 49 tracked + 60 untracked）。**本轮无法独立确认 HEAD、文件清单及 diff：实际工具只有 read/grep/find/write/resource/codemode，没有 shell/git 执行工具；工具发现亦未发现 bash。** 不把任务书中的数量当成已复核事实。
- 状态：**full 门控 blocked，不能签发全量完成或 PASS。** 下述 FIX 仅针对已静态证实的调用链；并不表示余下文件已通过。
- 必读输入均已分段完整读取：`docs/design/kb-agent-upgrade-design.md`、`docs/design/agent-knowledge-design.md`、`server/src/sources/source-edit-service.ts`、`server/src/sources/feishu-write-service.ts`、`server/src/kb/kb-build-service.ts`、`server/src/middleware/cli-auth.ts`、`server/src/agent/approvals/approval-service.ts`。
- 追加完整读取：`sources/push-planner.ts`、`agent/tools/app-command-family.ts`、`ops/command-table.ts`、`routes/cli.ts`、`routes/llm.ts`、`cli-endpoint.ts`、`kb/source-cleanup.ts`、`kb/source-images.ts`。其余调用者按下列证据位置定向读取/搜索，未宣称整文件覆盖。
- 方法：以设计 U9/U15/U17–U21、§7 写回协议和基线 §13 为承诺，构造权限降级、元数据不可读、派生确认值、符号链接及停止时序反例，沿入口→授权→业务→写入消费者静态核实。
- 证据等级：以下均为**静态路径证实，未动态复现**。没有运行测试、网络请求、飞书写操作或复现脚本；未编写项目测试或修复代码。上游所述 1169/237 全绿及真实写回仅为任务背景，本轮未复核其日志、fixture 或覆盖范围。
- 归因：无 git diff，不能逐行确认引入时间。findings 针对本升级设计明确新增的能力及其新可达路径；例如 llm 测试路由可能既有，但新增 app_command 把它开放给无 desktop token 的 Discuss 模型，新增可达性正是本轮问题。

## ② Findings 分级列表

### T3b-01｜Critical｜只读 `llm.test` 可把已存 provider 密钥发往模型指定的端点

**定位**：`server/src/ops/command-table.ts:195–216`；`server/src/agent/tools/app-command-family.ts:177–199,229–232`；`server/src/routes/llm.ts:77–114,157–180`；`server/src/modules/direct-channel.ts:211–214`。

**触发条件**：Discuss 或 Work 会话调用 `app_command llm.test`，传入 `args.llm`，其中 provider 的 `id` 对应已保存且有密钥的提供商、`apiKey='***'`，但把 `baseUrl` 改为攻击者端点。保留该 provider 的 enabled/model/active 选择信息即可。模型可先通过只读 `config.get` 获取脱敏结构再修改 URL；不需要知道真实 key。

**失败行为 / 实际影响**：命令被标为 read 且 agentExposed，无批准直接执行。`restoreMaskedLlmSecrets` 按 provider id 恢复真实 key，保留请求中修改过的端点；DirectChannel 以该 key 和该 baseURL 构造 SDK 客户端，向攻击者发送认证信息。提示注入可从 Discuss 只读工具跨到密钥外传。

**证据**：命令表接受整个 `llm` 对象并透传；app_command 仅检查它是 object，read 分支直接 runSpecs。路由恢复秘密时使用 `{ ...candidate, apiKey: saved.apiKey }`，没有将 URL 锁定为已保存端点；SDK 使用 `apiKey` 与 `baseURL` 发请求。这是模型不持有 desktop token 时新增的高权限代理路径。

**最小修复方向**：Agent 命令只接受已保存的 provider/model ID，由 server 从可信配置解析完整连接信息，不接受原始 LlmConfig/URL/apiKey 覆盖；不要把需要恢复密钥的任意端点测试暴露为 Agent read 命令。由实施者补“恶意 URL + masked key”拒绝及正常保存端点测试。

### T3b-02｜Critical｜CLI 可自行开启 `feishuWrite.enabled`，desktop-only 写入开关形同虚设

**定位**：`server/src/ops/command-table.ts:89–110,230–249`；`server/src/routes/cli.ts:169–177,225–240`；`server/src/routes/config.ts:159–164`；`server/src/middleware/cli-auth.ts:83`。

**触发条件**：命令行访问已开启，飞书写回开关仍关闭；持 CLI token 请求 `POST /api/cli/config.set`，请求体 `{"args":{"path":"feishuWrite","value":{"enabled":true}}}`。

**失败行为 / 实际影响**：`CONFIG_SET_FORBIDDEN` 不含 feishuWrite；该 mutate 命令无 confirm 门。CLI handler 使用 desktop token 新建内部 Request，未保留 cliActor；config 路由亦未剔除 feishuWrite。结果是 CLI 令牌持有者可自行启用设计明确限定 desktop 设置操作的云端写入权限门。

**证据**：全 `server/src` 搜索 cliActor 只命中 cli-auth 的赋值，没有消费者；转发只携 `X-Desktop-Token`。命令表将该路径原样包装为 PUT config。设计增补 §7.6 明确“只接受 desktop token 修改；actor=cli 丢弃该字段”。

**最小修复方向**：命令表阻止 feishuWrite 修改，并在可信内部转发层保留主体、在配置业务入口执行权限限制，避免用 desktop token 洗掉来源；不能信任外部可伪造的 actor body/header。由实施者补 CLI config.set 开关拒绝及 desktop 正常开启回归。

### T3b-03｜Critical｜云端冲突前置读取失败时 fail-open，写后校验无法补救已覆盖的远端内容

**定位**：`server/src/sources/feishu-write-service.ts:170–181,243–245,363–377,452–501`。

**触发条件**：本地编辑基线后云端已产生新内容；drive metas 请求失败、返回 failed/空 metas 或 latestModifyTime 不可读，但 docx revision 读取与 overwrite 仍可成功；调用者没有 force，只按普通 overwrite 确认推送。

**失败行为 / 实际影响**：fetchCloudObjEditTime 吞异常为 null；push 只有 cloudTime 非空且大于 base 才拒绝，因此继续覆盖。随后回读得到刚写入的本地正文，与预期相等，仍标 pushed 并回拉清脏。云端新增内容被覆盖，且不报告 source_push_conflict。此情形不是设计接受的短 TOCTOU 窗口，而是唯一前置防线整体失效后仍继续写。

**证据**：代码注释承认 obj_edit_time 是唯一竞态防线；revision 只防未来值，不能替代比较。写后回读只比较“云端是否等于我刚写的正文”，无法发现写前被删掉的他人内容。preview 甚至声称“三段式兜底”，该兜底在此反例不成立。

**最小修复方向**：非 force 的写入必须先取得可信云端与基线时间；不可读即拒绝并保留本地修改。若允许用户绕过不可读状态，应明确要求独立 force + OVERWRITE_CLOUD，而不是无冲突默认放行。由实施者补 metas 失败但 revision/write 可达的拒写测试。

### T3b-04｜Critical｜子任务 outputDir 未相对父 Workspace 做 realpath 围栏，可借祖先 symlink 扩大授权根

**定位**：`server/src/agent/tasks/task-service.ts:103–121,325–345,654–660,683–689`；`server/src/agent/agent-tool-service.ts:984–998,1064–1087`；`server/src/index.ts:225–227`；`server/src/agent/path-guard.ts:107–119,330–355`。

**触发条件**：已授权 Workspace `W` 中存在 symlink `W/link -> E`，E 是未授权、但不与原始库/标准库/应用/运行资源保护根重叠的普通外部目录。派发 converter，`outputDir='link/sub'`（sub 可已存在或由 spawn mkdir 创建），然后子任务 `ws_write {path:'victim.md', content:'...'}`。

**失败行为 / 实际影响**：任务只检查 outputDir 的字符串分段；spawn 用 path.join + recursive mkdir，再把 W/link/sub 直接作为新 Workspace 根。PathGuard 的 root lstat 只看到最后 sub 是目录，realpath 将根锚定为 E/sub；后续写入合法落在 E/sub，超出用户授权的 W。动态 workspaceGuard 只排保护根重叠，不检查该子根属于父授权根，因此不能阻断普通外部目录写入。即使 E 是保护根，spawn 的 mkdir 也已经在工具守卫前执行。

**证据**：TaskService 此处没有 `resolveInside(parentWorkspace, outputDir, 'mkdir')` 或等价父根 containment；后续工具以已经扩大的 root 为权限根，丢失父根约束。无需依赖外部恶意代码制造竞态，已有链接即可触发。

**最小修复方向**：从父授权根用唯一 PathGuard 逐级创建/解析 outputDir，任何创建前及创建后均保证 realpath 仍在父根内；冻结经验证的子根，不以 path.join 结果直接授予权限。由实施者补祖先 symlink 指向外部的创建/写入拒绝用例。

### T3b-05｜Major｜Agent 写回覆盖/强推确认被执行层降回 PUSH，批准后仍无法执行

**定位**：`server/src/ops/command-table.ts:587–615`；`server/src/agent/tools/app-command-family.ts:200–211`；`server/src/sources/feishu-write-service.ts:351–360`。

**触发条件**：Work 模型请求 source.push，`allowOverwrite=true` 且正文需要 overwrite，或 `force=true`；用户批准。

**失败行为 / 实际影响**：命令 request() 正确派生 OVERWRITE_CLOUD，但 runSpecs 无条件把所有非 GET body 的 confirm 覆盖为 `def.confirm.value`，source.push 表中该值固定 PUSH。FeishuWriteService 随即以 confirmation_required 拒绝，故 Agent 通道无法完成覆盖/强推。CLI 路径没有这次二次覆盖，与 Agent 行为不一致。

**证据**：app-command-family:207 的赋值并非注释声称的“漏烘兜底”，而是无条件覆盖；service 按实际 mode/force 要求 OVERWRITE_CLOUD。

**最小修复方向**：确认值由 server 命令的统一派生函数产生并展示给用户，批准后注入同一个值；剔除模型 confirm 仍保留。不要仅取消检查。由实施者补 app_command→真实 source 路由→服务的 append/overwrite/force 批准链测试。

### T3b-06｜Major｜单 worker 回退绕过后台排队与 M−1 配额

**定位**：`server/src/kb/kb-build-service.ts:609–633,918–919,1101–1105,1159`；`server/src/agent/agent-process-pool.ts:143–149,189–199,273–289`。

**触发条件**：M=3，有两个后台任务占满 M−1 配额但总槽仍有 1 个空余；启动 buildParallelism=1 的构建，或单元数使实际 workerCount=1 的构建。

**失败行为 / 实际影响**：回退路径通过默认 session 类 reserveSlot 立即拿最后一个总槽，再以 build kind 注册，后台实际变为 3，交互保留槽消失。总槽满时则立即失败而不按 U9 FIFO 排队。并行路径用 acquire(background)，两条路径准入语义不同；默认并行数也可能因小工作集落入此路径。

**证据**：reserveSlot 只判总容量，不判 backgroundLimit；register 将 kind=build 记为后台，但已经授槽，也不再执行后台配额检查。设计 U9 及 §4.7 对所有后台构建/任务统一限制，W=1 等价回退不应撤销该限制。

**最小修复方向**：保留旧单进程 prompt 语义即可，准入仍统一走可取消/有期限的 acquire(background)，不得用 session 预留绕过后台约束。由实施者补单 worker + 两任务占槽的排队/取消/保留交互槽验证。

### T3b-07｜Major｜停止仅在 run_end 时撤销批准，ACK/settled 前迟到批准仍可执行

**定位**：`server/src/agent/session-service.ts:611–622`；`server/src/agent/pi-rpc-process.ts:514–530`；`server/src/index.ts:377–378`；`server/src/agent/approvals/approval-service.ts:126–137,154–163`；`server/src/agent/tools/app-command-family.ts:258–274`。

**触发条件**：app_command 正挂起等待批准；用户点停止，请求已进入 SessionService.abort、RPC 已设置 aborting，但 agent_settled/run_end 尚未到达（abort ACK 最长等待 15 秒，之后另有 2 秒兜底）；此窗口另一页面或在途批准请求到达。

**失败行为 / 实际影响**：批准记录仍 pending，decide 接受 approve；工具随后直接 runSpecs，不检查运行是否在中止。构建/源编辑/远端写可在停止请求之后才开始执行。待 run_end 才 cancelForSession，已经决定的批准不会被取消。与增补 §6.5“会话中止即不执行”的批准取消契约不符。

**证据**：本轮定向读取的 abort 路径只调用 process.abort，未撤销批准；index 仅监听 run_end 才 cancel；runSpecs 前无 run token/aborting 状态复核。这里不要求伪造完成事件，而是批准生命周期应在停止请求时立即关闭。

**最小修复方向**：停止入口先同步撤销本轮 pending 批准，并让批准后的执行再次检查本轮可执行状态；按 runId 绑定批准，避免会话级旧请求进入新轮。由实施者补“停止已收到、settled 延迟、批准到达”真实事件顺序回归。

### Minor

本轮不另列纯风格/推测问题。未覆盖不等同于无 Minor。

## ③ 各重点面的结论与覆盖清单

| 重点面 | 已检查事实 | 结论 / 未覆盖 |
|---|---|---|
| R5 编辑 | 完整读取 header 切分、身份校验、OCC、base/seq 备份、原子写/往返校验、revert、状态、审计 | 正常路径有 header/OCC 机制；未动态验证磁盘/DB 故障回滚、备份失败及配置切根；不签发数据安全通过 |
| R5 同步与生命周期 | 定向检查 SyncEngine:396–408/444–467/1057–1088，trash pending 守卫、orphan 路径前缀守卫；完整读 source-cleanup | 普通 apply 在 per-token 锁内检查 dirty；生命周期存在显式拦截。未穷尽所有同步入口/删除消费者及重建级联；getPendingLocalEditState 异常时返回 null 是需额外故障验证的盲区，不以推测另报 finding |
| R5 云端写回 | 完整读取 FeishuWriteService/push-planner；读取 client 写方法与 execute 队列 | FIX：T3b-02/03/05；三段式存在但无法代替云端前置冲突读取。未访问真实云端，不独立认可全部转义/表格/图片/空正文往返保真。未完整读取 WRITE_SCOPES 默认集与授权消费者，scope 隔离未签发通过 |
| R2 并行发布 | 完整读取 KbBuildService：worker 拉取、单元重试、unitDone join、final、取消句柄、staging 校验、发布及启动对账 | 正常并行路径先 join/final 再校验、指针 rename 后清理尽力而为；FIX：T3b-06。build-units、PathClaims 与 kb 写工具未完整审核；未证明其竞争下正确性、所有失败不动指针、W=1 全面等价或 SSE seq 全链单调性 |
| CLI 安全 | 完整读取 cli-auth/endpoint/CLI 路由与命令表 | token 独立、timingSafeEqual、端点 0600/0700 有实现；命令域与 desktop 管理域分开。FIX：T3b-02。未进行 Windows ACL、真实 HTTP Origin/Host 与跨令牌动态检验；实现 X-Cli-Token/专用命令域与增补原文通用 API OR-token 描述存在已注释的契约差异，需 Leader 对齐，不在无授权裁决下当纯文案缺陷阻断 |
| app_command/批准 | 完整读取 ApprovalService/工具族；定向跟到 SDK、会话 abort 与 run_end | FIX：T3b-01/05/07。模型顶层 confirm 会剔除，未知/非 exposed 命令会拒绝；但不等于整个命令面安全 |
| 子任务/路径 | 检查工具白名单 override 二次剔除 task_* 注册族/app_command；定向读取 task submit 与生产 spawn；读取 PathGuard 及动态保护根消费者 | FIX：T3b-04。未完整审 task resume/模式变更/插件冻结/删除竞态及角色解析，不签发子任务权限全面通过 |
| 图片 | 完整读取 source-images；读取 raw_read_image 成员校验与读取链 | 正常路径要求 src 属于源引用，经 resolveInside；未动态验证链接/文件缺失/取消与 vision 三协议、缓存、限额 |
| 文档 / 错误码 | 两份设计完整读取，代码定向对照 | 已证实写回确认、后台配额、中止批准和 CLI 开关行为偏差；未逐接口核对 §8 全表，前端与预览修复未审 |
| 兼容迁移/性能/维护性 | 本轮仅检查所读路径的旧行为回退、状态边界与发布架构 | 未完整核对 DDL+additive 双登记、旧配置消费者、CLI 打包、16 切片相互作用及性能；不能签发全量 full 覆盖完成 |

### 验证可信度与剩余风险

- 本轮可信证据是当前工作树文件内容及工具返回行号，非执行结果。所有反例均可由实施者按触发条件落临时 fixture 验证；未运行的复现不冒称已运行。
- 不补写项目测试，避免独立审核与自证循环；未生成/运行复现脚本，因为本工具面无执行能力。
- 尚无 baseline diff/untracked 清单，不能保证 109 文件完整覆盖，也不能最终区分全部既有问题与回归。因此 **全量审核未完成**，当前 findings 已足以拒绝合并放行。
- 需要的续接输入：提供可读的 `git rev-parse HEAD`、`git status --short`、`git diff HEAD`（可拆分文件）以及 untracked 文件清单/正文，或在后续只读审核节点提供可用的 git/shell 取证工具。建议保持基线与工作区冻结后续审，避免修复和审核并发改变行号。
- 不要求/不授权真实云端破坏性复现；优先临时目录与隔离假上游证明拒写和权限边界，真实写回仅用主上明确授权的测试文档。
- 本轮实际产物仅此报告；无代码变更、无 commit。回滚：删除本报告即可，不涉及应用数据或飞书内容。

## ④ 结论

以下结论只对本报告列明的静态审核范围有效；full 合并门控保持 blocked，修复上述问题后仍需补全 diff 全覆盖与针对性验证。

VERDICT: FIX
