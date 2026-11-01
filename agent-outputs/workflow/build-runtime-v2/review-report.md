# build-runtime-v2 独立 full 高风险审核

**VERDICT: FIX**

范围：设计 v2 对应的主树重构，包括未提交 UI、API/types 与 orchestration_mode 持久化修复。发现 **13 Major、2 Minor；未确认 Critical**。以下问题均不要求删除初始用户增强。A23 仍未验收；不能以本报告或最小通道试验宣布完整上线门槛通过。

## 1. 基线、授权与证据口径

- 初读 HEAD：`c985790`，包含 `5f39dd8`、`97376ec`；同时审工作树而非仅提交 diff。交付前实施者将已在本轮读取/测试的 UI 与模式持久化提交为 `25cc0b4`。已核对其 16 文件 stat 及服务/检查点/迁移完整 diff，与本轮原工作树审核面一致；最终范围为 **`25cc0b4` + 保留的用户工作树增强**。
- 初始基线实际对象：`43c35e71`（dirty-snapshot）；用户原始差异：`/tmp/feishu-build-v2-baseline/initial.patch`。任务文本中的 `dirty-snapshot43c35e71` 不是 Git ref；首次按该字面查询失败，随后按真实对象解析成功，没有更动 Git 状态。
- 原用户 maxTokens、模型输出上限、声明读取/修订保护、preview 等均作既有现场，不归为本次缺陷。本次跨任务对象权限问题明确区分“既有声明迁移机制”与“新权限包装遗漏”。
- amagi 上游只读确认 HEAD=`929000ecbd8725e72b191493345d6abeef51c147`；未修改上游。Pi 路径为任务所用安装中的 `@earendil-works/pi-coding-agent`，核对官方 `docs/mcp.md`、`cli.md`、`sessions.md` 完整正文及相关运行源码。没有用另一版本的文档推断缓存/会话语义。
- 必读上游：设计 `/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/编排构建效率优化/重构/基于Agent基座与工作流插件的构建重构设计-v2.md`；本目录 `workflow.md`、`acceptance-matrix.md`、`integration-followups.md`、`integration-report.md`、`tools-report.md`、`runtime-report.md`、`child-policy-report.md`、`runtime-decision-child-policy.md`、`live-probe-report.md`、`real-model-smoke-report.md`、`ui-real-api-acceptance.md`。设计首读 50KB 截断部分已续读尾部。
- 审核期间观察到实施者调整暂存归属、文档更新及上述 UI 里程碑提交；这不是本审核的写入。以下行号对应实际读取的主工作树。没有读取关联 worktree 的未回流修复来替主树关闭 finding。交付前对 vision-describer、model-selection、ModelProviderSettings、AgentSettingsCard、MarkdownView 与其测试、model-output-limits 与其测试逐个比较 `43c35e71:<path>` 和当前文件 Git blob hash，**8/8 UNCHANGED**。
- 只写本报告及 `/tmp/feishu-build-v2-review/` 取证产物；未改源码、未提交、未安装依赖、未跑真实模型、未读真实凭据/原始库。没有重跑全量 check/build。

## 2. Findings

### F01｜Major｜取消只撤 token，已排队/准备中的写入仍能提交

- **定位**：`server/src/agent/agent-tool-service.ts:655–656, 1698–1735, 1855`；`server/src/kb/build-runtime-host.ts:833–841, 994–1000`。
- **触发**：`kb_write_doc` 已通过 executeTool 的 token 检查，等待声明锁或异步证据装配；此时生产 requestCancel 经 revokeSessionTokens 删除 token，然后该写入继续。
- **实际影响**：assertV2WriteWindow 只查代次、actor、角色、分配、publishWindow。生产取消没有 rotateGeneration/revokeActor，也不把撤销标记写进现存 context；因此旧调用仍可落正文并登记新回执，违反“取消后知识写入立即停止”。`kb_edit_doc` 共用该漏洞。
- **证据（已复现）**：`/tmp/feishu-build-v2-review/behavior-probe.ts` → `behavior-probe.log`：`CANCEL {tokenValid:false,fileWritten:true,receipts:1,...已写入草稿...}`。锁队列→revokeToken→释放，真实 AgentToolService/BuildActorStore，无模型。
- **测试↔风险缺口**：`server/tests/build-runtime-tools.test.ts:595–621` 名称写“取消”，实际调用 `store.revokeActor`；生产取消不是这条路径。51 例原测试仍全过。
- **最小修复方向**：撤凭据时使进行中的上下文持有可检查的失效租约；最终提交前验证该租约，或同步撤 actor/换代并确保读写都按相同原子失效机制执行。由实施者补生产取消链、锁队列及异步准备窗口回归。

### F02｜Major｜pending 首次连接会永久缓存只读 MCP 工具面

- **定位**：`server/src/agent/claude-bridge.cjs:36–44`；`server/src/agent/agent-tool-service.ts:688–703`。
- **触发**：桥首次 tools/list 早于原生创建事件；应用返回 pending 读取面，之后身份 confirmed、输出分配完成，同一连接继续使用。
- **实际影响**：桥没有声明/发送 `notifications/tools/list_changed`。amagi `mcp_list_tools` 只遍历 Pi 已注册工具；`mcp_call` 在工具未注册时直接拒绝，不请求重新发现。写工具会一直“尚未连接/已隐藏”，正常任务不能写稿；多次 HTTP GET 单测不能证明此链可用。
- **证据（已复现，真实 Pi MCP 连接组件＋生产桥，HTTP 仅模拟身份变化）**：`mcp-cache-probe.mjs/.log`：`PENDING ['raw_read']` → `CONFIRMED_SAME_CONNECTION ['raw_read'] HTTP_LISTS 1`；只有显式 reconnect 后才出现 kb_write_doc。官方 `mcp.md` 明确通过变更通知刷新；Pi `dist/extensions/mcp/runtime.js:300–306,352–360` 与 amagi `mcp-native.ts:80–85,100–126` 相符。
- **最小修复方向**：建立受控工具清单变更/刷新机制（并保留每次业务调用授权），验证真实原生 MCP 长连接在延迟确认后可发现并调用写工具。不能只把 pending 直接当 confirmed。

### F03｜Major｜文档分配不能阻止跨作者夺取对象身份/主定义

- **定位**：`server/src/agent/agent-tool-service.ts:1707,2378–2383,2432–2465`；`server/src/kb/build-actors.ts:561–644`。
- **触发**：A 持有 a.md 并登记对象；B 仅持有 b.md，在自己的 kb_write_doc 中使用 A 的 clientKey 或同 family/variant/scope 三元组。
- **实际影响**：分配检查仅看目标 docPath。既有声明迁移机制沿用对象 ID，并把同一对象 canonical 移到 B 文档、替换其内容，不检查原主定义或对象族的所有者。A 的有效分配仍在，A 正文仍在，但对象注册已被 B 改写。新任务权限模型暴露了既有迁移机制缺少授权适配的问题。
- **证据（已复现）**：`object-ownership-probe.ts/.log`：A/B 两次写均成功、objectMap 同一 `ko_...`；最终仅一对象，`path=b.md,revision=2`，两项分配仍 active。脚本没有让 B 写 a.md，也没有 shell/伪造身份。
- **相关静态缺口**：family 分配没有进入正文声明授权；assertOutputAssignment 只检查 docPath。family 冲突预检传入已剥前缀的 key，而 activeAssignmentFor 只在 target 以 `family:` 开头时匹配 family，存在不一致。
- **测试↔风险缺口**：现例主要证明不同文档路径不会互写，未证明全局对象表/共享对象族不被另一作者修改。
- **最小修复方向**：将本次声明实际修改、移动、删除的对象/对象族及原主定义纳入写租约检查；合法跨路径迁移需显式授权。保留原用户稳定身份机制，不删除迁移能力来掩盖问题。

### F04｜Major｜exact_text 替换把同行未选中的内容一起删除

- **定位**：`server/src/agent/agent-tool-service.ts:3783–3809,3827–3831`；`server/src/agent/tool-specs.ts:913–930`。
- **触发**：正文 `prefix OLD suffix`，exact_text oldText=`OLD`、newText=`NEW`。
- **实际影响**：实现用字符匹配只计算起止行，随后整行 splice；结果变成 `NEW`，prefix/suffix 被静默丢失。合法局部修订破坏未选正文，并连带改变对象正文/证据坐标。
- **证据（已复现）**：`behavior-probe.ts/.log` 的 EDIT：原 `prefix OLD suffix\nnext line` 变成 `NEW\nnext line`。
- **测试↔风险缺口**：已有定位用例不足以覆盖行内/多行边界的保全；spec 描述“被替换文本”，没有声明必须整行。
- **最小修复方向**：exact_text 按精确字符区间替换并正确推导坐标变化；若只支持整行，须先拒绝非整行匹配，不能默默扩大编辑范围。

### F05｜Major｜批量读取 nextCursor 到达预算后永不前进

- **定位**：`server/src/agent/agent-tool-service.ts:3593–3610,3634–3637,3725–3727`；`server/src/agent/tool-specs.ts:892–895`。
- **触发**：源长于 maxLines；第一页耗尽行预算，按返回 nextCursor、相同 maxLines 续读。
- **实际影响**：cursor 中保存 linesUsed，并在下一页原样恢复；while 条件仍为 linesUsed < maxLines。第二页返回空结果和完全相同的非空 cursor，之后永久重复。默认预算下的长源读取也会如此，直接破坏设计 §7 分页能力。
- **证据（已复现）**：`behavior-probe.log`：`firstCount=1,firstUsed=3,secondCount=0,secondUsed=3,sameCursor=true`。
- **额外消费者缺口**：schema required=['requests']，而说明称有 cursor 时忽略 requests；本轮 service 直调验证了死游标，真实 MCP 还会先拒绝单独 cursor 的合法续页用法。
- **最小修复方向**：每次请求重置本页预算，cursor 只携带剩余队列/位置；schema 明确 requests/cursor 二选一。实施者补跨预算边界的多页遍历与最终 cursor=null 验证。

### F06｜Major｜kb_edit_doc 并发重放不幂等，桥接回执丢失重试也缺稳定键

- **定位**：`server/src/agent/agent-tool-service.ts:3743–3750,3760–3767,3861–3864,3883–3890`。
- **触发**：两个同 operationId、同载荷编辑在锁释放前并发到达；或第一次编辑落盘后 v2 receipt 丢失，再经生产桥重试。
- **实际影响**：v2Replay 在锁外执行，两者都看到无回执；第二个持锁后不重查，继续在已改变文本上编辑，可能重复改动或报锚点缺失，而非返回原回执。editMeta 又优先采用每次桥接随机 toolCallId，声明 calls 账本并不是注释声称的稳定 v2 键，回执丢失路径不能兜底。
- **证据（并发原错已复现）**：`behavior-probe.log` 的 EDIT_DUP：同操作一个成功、一个 `kb_edit_anchor_not_found`。与 kb_write_doc 的锁内重放对照即可定位；随机 bridge ID 来源 `claude-bridge.cjs:52`。
- **测试↔风险缺口**：同 operationId 并发和回执丢失专项只覆盖 kb_write_doc，不能外推到 edit_doc。
- **最小修复方向**：锁内先查回执再读正文/定位；v2 编辑使用确定性声明幂等键，并对崩溃重放恢复原结果，覆盖非幂等补丁、桥接新调用 ID 和已落盘无回执。

### F07｜Major｜默认审查回执被生产候选组装器忽略

- **定位**：`server/src/agent/agent-tool-service.ts:3234–3236,3293`；`server/src/kb/kb-build-service.ts:1742–1745,5119–5125`。
- **触发**：原生 diting 按真实 spec 省略可选 unitId 提交通过审查；默认文件名是 reviews/<actorId>.json。
- **实际影响**：v2 buildState.units=[]，assembleCandidateRelease 只收单元报告及 all.json，不收 actor 报告。已成功登记的独立审查不会出现在 acceptance.validReportIds，正常发布必然 review_missing。
- **证据（已复现）**：`review-binding-probe.ts/.log`：默认 kb_submit_review 返回成功且文件存在；真实 assembleCandidateRelease 产生 validReportIds=[]，真实 canPublish 返回 review_missing。
- **测试↔风险缺口**：`server/tests/build-runtime-e2e.test.ts:179–186` fixture 硬写 unitId='all'，绕过了新接口的默认消费接缝；3/3 发布不是默认 actor 审查路径证据。
- **最小修复方向**：发布候选按 v2 权威审查回执选取实际报告，不依赖 legacy 的 all 文件约定；保留多审查者和版本绑定。补省略 unitId 的真实主链成功用例。

### F08｜Major｜原生审查未接对象级审查凭据，知识化成果无法发布

- **定位**：`server/src/agent/agent-tool-service.ts:3234–3331`；`server/src/kb/kb-build-service.ts:1086–1096,4155–4164,5953–5973`；`server/src/kb/knowledge-validator.ts:232–240`。
- **触发**：v2 作者提交 objects/claims 等真实知识声明，独立 diting 对当前候选提交 pass；即使显式 unitId='all' 避开 F07，再申请发布。
- **实际影响**：对象写入时 reviewStatus=pending；原生 kb_submit_review 只写报告和 actor ReviewReceipt，不回写对象级机器审查凭据。现有唯一 markObjectsMachineReviewed 消费者仍在 legacy 编排的审查收束链，新 Leader 分支不会进入。正式知识门禁因此始终以 kb_review_pending 阻止正常新知识对象发布。没有对象声明的 fixture 文档能发布，不代表完整知识化构建可用。
- **证据（已复现真实知识发布准备门）**：`review-binding-probe-final.log` 显示当前审查 `status=valid,verdict=pass`、canPublish.publishable=true，但 objects.reviewStatus=pending；`knowledge-publish-probe.ts/.log` 随后调用真实 prepareKnowledgePublish，结果 `kb_publish_blocked`，**唯一**阻断为 kb_review_pending。CURRENT 未被试验修改。该脚本首轮因取证夹具遗漏 configProvider 报错，补齐临时配置后得到上述真实门禁结果，未改产品代码。
- **同一接缝的安全面**：ReviewReceipt dependencyHashes 仅 doc:*、ruleVersion 固定 kb-review/1；生产 canPublish 不读取 actor 审查 stale 状态。初次 `review-binding-probe.log` 已证明只改对象元数据、docs hash 不变时 actor 回执全 stale，但 canPublish 仍返回 true。**这不是完整发布绕过证据**：随后知识门禁的 pending 防线确实拦住了本例。不能为修可用性直接无条件 mark passed，否则会把这个潜在失效绑定变成真实放行漏洞。
- **测试↔风险缺口**：fixture e2e 正文无对象声明；测试验证 actor stale，而未追到对象机器凭据/正式知识门。既漏正常成功链，也漏修复后的安全约束。
- **最小修复方向**：将当前版本独立审查原子接入对象级凭据；先核验正文/对象/证据/来源/规则精确依赖、角色与父链、有效状态，再标记机器审查。发布消费同一权威绑定，手动确认一致。不得降低 pending 门禁或让模型自报审查通过。

### F09｜Major｜成果级 rebuild 仍打开原 Leader 会话及同一内部 agentDir

- **定位**：`server/src/kb/build-runtime-host.ts:846–864`；`server/src/agent/build-runtime/adapter.ts:110–139,166–169`；`server/src/agent/pi-rpc-process.ts:207–216`。
- **触发**：用户明确选择 resumeStrategy='rebuild'，同一 buildId 已有 Leader 会话，或因包/规则漂移不能原会话续接而选择成果级恢复。
- **实际影响（静态调用链证实）**：host 走 adapter.start；start 仍使用同一 build home/sessionDir；launch(null) 固定 sessionId=`build-${buildId}`。Pi --session-id 的官方语义是“存在即打开”，不是“强制新建”。因此所谓成果级恢复实际继续旧对话，且包不兼容时也复用旧 amagi 内部存储，违反显式恢复级别和不复用不兼容内部状态的契约。
- **相关风险**：supervisor prepareResume 只换 generation，state.actors 的旧 running/confirmed 项未随账本撤销；evaluateIdle 继续计入它们。新代次不收到旧通知时可能永远达不到空闲收口，须在修复恢复链时一起核实。
- **证据**：Pi 官方 `docs/cli.md:90–97`、`docs/sessions.md`；源码调用链如上。未在本轮运行真实模型恢复，不把 integration-report 续批中的 300s 卡住直接归因为本项。
- **最小修复方向**：成果级恢复用新的、代次唯一的 session 和必要时新的内部 agentDir，仅导入可验证成果/问题；session 恢复才复用原会话。旧任务仅作历史，不能充当新代次活跃任务。

### F10｜Major｜异常 Leader 后无子进程残留核对/回收，终止失败结果还会丢失

- **定位**：`server/src/agent/build-runtime/adapter.ts:279–301`；`server/src/kb/build-leader-supervisor.ts:356–379`；`server/src/kb/build-runtime-host.ts:890–923`。
- **触发**：Leader 被外部 SIGKILL/崩溃，而子任务仍存活；或 terminate 报 pi_termination_unconfirmed。
- **实际影响（静态调用链证实）**：adapter.cancel 只终止/探测 Leader PID，无任务进程记录读取、子 PID 所有权识别、残留收敛路径；terminate 错误被 catch 掉，process 引用随后清空。非 requestCancel 终局时 supervisor 又丢弃 CancelResult，host 删除 session。后台模型/桥可能仍运行，UI 却终态 finished；重建只查旧 Leader，不查残留 child。
- **证据**：全目录相关实现仅有上述 Leader PID 探测；静态 probe 的 residual 文案是实测提示，不是实现。上游与任务书都明确 Leader SIGKILL 不能触发正常 amagi session_shutdown；正常 stdin 关闭的 35-pass 证据无法覆盖该情况。
- **最小修复方向**：记录/读取可信进程身份并核验启动身份、命令及所属运行，安全回收残留、持久化未确认状态并持续收敛；不能按裸 PID 杀掉复用后的无关进程。本轮没有发现现有代码会主动误杀复用 PID，问题是缺少该所有权/残留链。

### F11｜Major｜发布过程中取消可在 CURRENT 已切换后落 cancelled/“未发布”

- **定位**：`server/src/kb/kb-build-service.ts:1115–1147,1772,2083–2090`；`server/src/kb/build-leader-supervisor.ts:601–644`。
- **触发**：发布前取消检查已通过，publishRelease 的异步知识编译/准备阶段收到取消或整体超时；随后发布仍提交 CURRENT。
- **实际影响（静态调用链证实）**：最后一次 entry.cancelRequested 检查位于 await publishRelease 之前，提交点没有本次取消租约；监督循环可因 signal.aborted 返回 cancelled，外层 1772 又在处理 publish-accepted 前抛 CancelledError，catch 无条件写 cancelled 并记录“未发布任何变更”。CURRENT 真相与 DB/UI 状态分叉。启动对账不能保证本进程内即时终局正确。
- **测试↔风险缺口**：已有发布门测试仅证明发布前拦取消；没有驱动异步发布中取消以及提交后收尾期超时。续批真实取消/恢复尚未回流，不视为关闭。
- **最小修复方向**：在真正提交点前核对运行租约；CURRENT 一旦已提交，以指针/发布回执为权威处理后置取消及 DB 异常，不把它改成未发布，也不回滚/删除 current release。

### F12｜Major｜Leader 启动后 policy 缺失/设置注入没有派发前 fail-closed

- **定位**：`server/src/agent/pi-extension/feishu-sync-agent.js:305–328`；`server/src/agent/build-runtime/adapter.ts:110–132,240–270`；`server/src/agent/build-runtime/agent-dir-config.ts:397–449`。
- **触发**：初始 start/probe 核验后，在后续 task_submit/task_resume 之前 child-policy 文件缺失，或 settings.resources 被外部操作/损坏改变。
- **实际影响**：校验函数本身会拒绝，但实际派发钩子只调用纯参数守卫，不重新核验 settings/policy/包冻结面。Leader --no-extensions 不加载 child policy；新 child 由 settings 自动发现。Pi 对 settings 中不存在的 extension 可以静默跳过，child 继续请求模型，失去 codemode 调用拒绝层。
- **证据（Pi 加载器行为已复现；完整派发后缺失窗口由静态路径证实）**：`missing-policy-probe.mjs/.log` 用真实 Pi、临时 settings 指向不存在的 child-policy、AMAGI_TASK_ID、假模型：`code=0,requests=1,tools=['read','codemode'],stderr='',hasAssistant=true`。这是原生加载器试验，不冒充完整 Leader→amagi 子任务试验；`resource-loader.js:409–421` 只对 CLI additionalExtensionPaths 显式补缺失错误。
- **边界**：不声称模型能改禁区文件，也不把同 uid 外部可信代码说成被沙箱隔离。本项是任务明确承诺的运行期完整性 fail-closed 未接入真实派发链；八锚点防重激活与微任务声明窗口不是本项根因。
- **最小修复方向**：在每次原生派发/续接前复核冻结配置与 policy 必要内容，并对加载异常明确阻止运行；以缺失/篡改/设置注入后“没有 child 模型请求”作为验收，而非仅单测 verify 返回 false。

### F13｜Major｜Windows 合法绝对路径被硬编码 POSIX 校验拒绝

- **定位**：`server/src/routes/kb.ts:559`；`server/src/agent/build-runtime/dispatch-guard.ts:84`。
- **触发**：Windows 安装 sourceDir=`C:\\...`/UNC，或新模式正常构造 workDir=`C:\\...`。
- **实际影响（静态分支证实，未在 Windows 执行）**：两处 startsWith('/') 都为 false；source 安装立即 400，即便另行安装成功，freezeGuardConfig 也拒绝正常工作目录，整个 pi-amagi 路径不能启动。不是仅“Windows 尚未测”的未知风险，而是当前可定位的必败条件。
- **最小修复方向**：使用与实际宿主平台一致的绝对路径判定/规范化；若该平台暂不支持，应明确能力拒绝并说明范围，不让 UI 声称可启动。补 Windows 真机安装/打包及 UNC/盘符契约验收。

### F14｜Minor｜冻结 skill 的 MCP 示例与真实契约不一致

- **定位**：`server/src/agent/skills/knowledge-build/mcp-examples.md:8,16,26`；`achievement-protocol.md:15–18`。
- **触发/影响**：照示例调用：server 写 feishu-kb，而实际是 feishu-kb-bridge；write 缺必填 title；review 用 verdict/scopePaths 而真实是 conclusion/coverage/checkedDimensions 等，缺 operationId、draftLocation/sourceLocation。交接 prose 用 artifacts/needsFromLeader，真实字段 artifactRefs/nextInfo。首次调用会在路由/schema/服务端拒绝，增加返工。
- **证据**：与 contracts.ts、tool-specs.ts、AgentToolService 真实消费者逐项对照；fixture 使用正确参数，未验证这些示例。模型可通过 mcp_list_tools 自行纠正，故不作为单独阻断级问题。
- **最小修复方向**：更新六份冻结资产中所有调用示例，使之按真实 schema 可执行；由实施者做示例契约检查，不增加另一套拟定 API。

### F15｜Minor｜终局“已停止”任务仍被计作实际并发，历史轮次填 0/0

- **定位**：`src/components/knowledge/BuildOrchestrationProgress.tsx:230–248,337–354`；`server/src/kb/kb-build-service.ts:1231`（leaderProgressOfState 的 rounds）。
- **触发/影响**：终局 task 最后观测 execState=running，行正确显示已停止，但汇总 runningCount 仍计入“实际并发”；检查点 DTO 不存轮次则固定返回 0/0，前端当真实启/收轮次数呈现。用户同时看到已结束与多个“实际执行中”，历史不确定数被填成零。
- **证据**：真实 UI 上游已记录终局 12 个 stopped 行，源码计数不看 terminal/termination/endedReason；本轮未重新执行浏览器，不给视觉判断。
- **最小修复方向**：区分最后观测计数与当前活跃数；终局不把历史 running 计作当前并发。轮次持久化或明确 unknown，不重置为貌似实测的 0。

## 3. 本轮验证证据（与上游转述分开）

所有临时验证 cwd 为项目根或 server；HOME/FEISHU_SYNC_HOME 指向 `/tmp/feishu-build-v2-review/`，无真实模型调用。

| 执行 | 真实结果 | 能证明/不能证明 |
|---|---|---|
| `node node_modules/tsx/dist/cli.mjs /tmp/feishu-build-v2-review/behavior-probe.ts` | exit 0；F01/F04/F05/F06 原错复现 | 真实工具服务、锁、回执/文件；不等于完整生产 API 取消 |
| `node /tmp/feishu-build-v2-review/mcp-cache-probe.mjs` | exit 0；确认后不刷新，reconnect 才刷新 | 真实 Pi MCP Connection + 生产 stdio 桥；HTTP list 是身份时序夹具，非完整 child |
| `node node_modules/tsx/dist/cli.mjs /tmp/feishu-build-v2-review/object-ownership-probe.ts` | exit 0；F03 原错复现 | 两身份/两分配/真实声明全局注册 |
| `node node_modules/tsx/dist/cli.mjs /tmp/feishu-build-v2-review/review-binding-probe.ts` | exit 0；F07/F08 原错复现 | 接上一个脚本夹具，真实报告/候选组装/canPublish；programChecks 标为 fixture，未执行正式发布 |
| `node node_modules/tsx/dist/cli.mjs /tmp/feishu-build-v2-review/knowledge-publish-probe.ts` | exit 0；valid/pass 审查后对象仍 pending，正式知识准备门拒绝 | 完整编译/知识门禁准备，唯一 kb_review_pending；非 CURRENT 提交试验 |
| `node /tmp/feishu-build-v2-review/missing-policy-probe.mjs` | exit 0；模型请求 1 次、含 codemode | 原生 Pi 缺失 settings extension 不拒启动；假模型，不是完整 amagi 派发复现 |
| `../node_modules/.bin/vitest run tests/build-runtime-tools.test.ts tests/build-actors.test.ts tests/build-runtime-persisted-mode.test.ts`（cwd=server，TMPDIR 亦临时） | exit 0；**3 文件、51/51**，4.31s | 原测试全绿及模式迁移针对性通过；不能抵消上述反例 |

原始输出分别为 `/tmp/feishu-build-v2-review/{behavior-probe,mcp-cache-probe,object-ownership-probe,review-binding-probe,review-binding-probe-final,knowledge-publish-probe,missing-policy-probe,targeted-tests}.log`。取证脚本是独立审核脚本，不是替实施者编写的项目测试；没有为了制造失败去改项目源码。

上游 2757/11skip、build:all、probe35、真实模型17、浏览器多次 published 均按**提供的上游报告**审阅，不写成本轮重跑。它们有有效正向价值，但不足以证明本次反例窗口。原测试存在重要接缝假设：actor 撤销替代生产 token 撤销、unitId=all 替代新默认 actor 报告、顺序 HTTP list 替代 MCP 缓存。这比继续堆同型 happy-path 测试更值得修正。

## 4. full 覆盖清单与未确认风险

| 审核维度 | 实际覆盖 | 结论/边界 |
|---|---|---|
| 正确性/真实消费者 | API→主服务→host/supervisor→adapter/RPC→扩展→原生任务→MCP→工具→成果→候选/发布 | F01–F12；不是只看孤立单测 |
| 权限/边界 | Leader 显式工具白名单、child 精确角色 MCP、env 身份、pending、分配、续接父链、自审拒绝、源快照读取围栏 | 原生身份不取模型 args；Leader tool_call 白名单在位。对象授权与撤租漏洞见 F01/F03；未以工具文本伪造测试替代原生事件 |
| child-policy | 八锚点、独立 tool_call deny、内容寻址、配置字段感知核验、Leader --no-extensions、设置缺失加载路径 | active 过滤≠卸载，文件围栏≠OS 沙箱；认可已披露微任务声明窗口，不重报为新缺陷；运行期完整性见 F12 |
| 一致性/并发/恢复 | 写入锁/OCC/operationId、发布窗口、代次切换、检查点草稿/审查复制、原子 CURRENT 与既有回滚边界 | F01/F03/F06/F08–F11；没有要求把标准库恢复套成同步引擎 DB 回滚文件 |
| 兼容/迁移 | legacy 默认、Claude-native 拒绝、create/resume/toDto、centralDDL/additive 新列、配置反向保护静态接线、原始用户差异 | 模式持久化本轮4例通过；没有证据要求撤掉该修复。新路径权限/发布问题不归咎用户声明增强 |
| 性能/资源 | 单 Leader 占池、子任务由 amagi 原生调度、分池上限、包全量 hash/拷贝预算、无应用第二队列 | A23 未测。身份/工具往返失败会增加返工；同模型分池配置存在容量利用/边界待查，不在无进一步执行证据下新增定量性能结论 |
| UI/API/types | 新模式分支、真实 DTO、404 恢复轮询、stopped 最后观测说明、usage unknown、安装状态/探测与能力降级、模式迁移 | 无虚构百分比、无父用量当子用量；F15。未独立重跑浏览器/视觉，不把编译当视觉验收 |
| 打包/平台 | 资产复制六 skill/桥/扩展、dist/源码路径与 asarUnpack 约定、外部 Node/Pi 路径 | 本轮未生成安装包/启动 Electron；Windows 硬拒路径 F13，macOS packaged/preload/Windows 故障退出实机均未覆盖 |
| 测试有效性/维护 | 对比测试动作与生产动作，最小反例验证，区分导入注册造成的执行次数与独立场景 | 不建议删有效原测试或放宽断言。新增正式测试由实施者落地；优先补上述接缝而非无必要全量/重复安装模型试验 |

### 关键盲区与外部验收

1. **A23：未覆盖且仍阻塞**。同六源冻结字节目前4/6可得，2份 sheet 缺失且无批准夹具；三路径、三次中位数、完整质量对照未跑。fixture/GLM-flash 最小通道不得替代六源质量或20分钟结论；legacy 必须保持默认。
2. **A22/A24 续批未闭环**：关联 d21e38cc worktree 的双作者、真实 API 取消/恢复尚未回流；integration-report 增补记录不能代替当前主树验收。不能因披露该缺口而停止审核，本轮已继续源码及反例审查。回流若有实质修复，应与本次 findings 一起做一次增量复审。
3. F09/F10/F11 的完整异常进程/恢复/CURRENT 故障链为静态证实，不是本轮原生端到端故障注入。真实进程 PID 复用、Leader 硬崩、管道不关、切指针后 DB 异常应由实施者提供可回源证据；未知残留不能显示已完成终止。
4. 不对真实 LLM 的六源语义质量、成本或吞吐签字。新 DTO 未展示价格化成本；静态 models 未提供定价时，SDK 默认为0不代表实际免费。上游最小模型通道只证明端点/凭据交付可用。
5. 官方 Pi 扩展全体 API、所有交叉文档和全仓逐行未穷举；本轮对争议机制核对了完整 MCP/CLI/会话文档及对应实际源码，child-policy 既有全部重激活变体采用上游报告而未逐个重跑。这是 full 的证据盲区，不是“所有环境均安全”的保证。

## 5. 交付与下一轮门槛

- 本报告不含修复 patch，未替实施者写项目测试。每项仅给最小修复方向；不能以说明已披露或测试现绿来关闭。
- 增量复审按 **F01–F15 原编号**逐项提供关闭/未关闭/修复引入回归结论；优先 F01/F02/F03/F07/F08/F09/F10/F11/F12。F04–F06 属可复现业务正确性缺陷，同样不能留到 PASS 后。
- 用户已有现场保持不动；临时取证可整目录保留用于下一轮核验。本审核的回滚面仅此报告与临时取证目录；不存在源码回滚或 Git 丢弃操作。

**VERDICT: FIX（仅对上述声明的主工作树重构审核范围；不是六源上线验收通过）。**
