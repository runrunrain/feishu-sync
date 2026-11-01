# build-runtime-v2：唯一一次 full 增量复审

**VERDICT: FIX**

原 F01–F15：**9 closed、5 partial、1 open**。保留阻断的原编号为 **F03 / F09 / F10 / F11 / F12**（下列 7 个 Major 反例）；F14 仍有 1 个 Minor。未确认 Critical。按约定至此上报主上，**不自动修复、不再循环审核**。

## 1. 审核基线与证据口径

- 审核源码唯一对象：`/tmp/feishu-build-v2-feature-tree`（实际工具显示 `/private/tmp/...`，同一目录），无 `.git`；相对 `25cc0b4` 的阶段材料为 `/tmp/feishu-build-v2-baseline/final-feature.patch`。按 patch 定位产品改动，回读实际消费者与针对性测试；不是以主仓当前工作树代替冻结快照。未将主仓 `draft_read.includeDeclarations` 用户扩展计入本批。
- 必读并已读：主仓本目录 `review-report.md`（原 eec182a8）、`fix-map.md`、`fix-integration-report.md`；阶段 patch；另读 `runtime-fix-guidance.md`、主仓 `CLAUDE.md`。主仓只读对照；没有以未采纳的 0469e24a worktree 补丁关闭 F10。
- 原报告 13 Major + 2 Minor 为基线，本报告只判断原编号修复及其直接接缝，不扩成全仓重新审核。`closed` 指原缺陷在本次声明范围内关闭，**不等于该平台/功能完整验收**。
- 本轮只写本报告及 `/tmp/feishu-build-v2-incremental-review/` 隔离脚本/夹具/日志。未改源码、配置、项目测试、用户文件或 index；未提交，未修改 amagi 上游，未触碰 `~/.feishu-sync`，未用真实生产源或真实密钥调用模型。

## 2. 原编号逐项结论

下列路径均相对 feature 快照；测试运行证据统一见 §4。

| 原编号 | 结论 | 实际修复与复核证据 | 剩余边界 |
|---|---|---|---|
| F01 Major | **closed** | `agent-tool-service.ts:680–716,721–731,1904–1919`：撤 token/session/build 同步标记持有中的 ctx；异步声明装配后、同步落盘段前重核。生产 host 撤租确实调用这些入口。`build-runtime-toolfix-regressions` 覆盖真实 revokeToken/revokeByBuild 排队写与 edit；`build-runtime-review-authority.test.ts:182–202` 四矩阵覆盖审查凭据锁内 ctx/actor/generation/publishing。134 例批次通过。 | 族/旧对象授权终检仍缺，归 F03，不把 F01 的 ctx 修复外推为所有权限都闭环。 |
| F02 Major | **closed** | `claude-bridge.cjs` 声明 listChanged，观察快窗后转低频退避；401 永久停止、stdin 关闭清定时器。真实服务桥测试覆盖迟到确认及写入/撤销。独立 `mcp-refresh-probe.mjs` 用**真实 Pi McpServerConnection + 生产桥**，快窗之后才 confirmed：`[raw_read]→[raw_read,kb_write_doc]`、`sameClient=true`、自动刷新回调 2 次、调用到达 fixture HTTP，未 reconnect。 | HTTP 身份变化为夹具；业务授权成功另由真实服务桥测试证明，不把夹具 HTTP 当完整原生 child。 |
| F03 Major | **partial** | 现已拒绝 B 从自己文档夺取 A 的 clientKey/三元组，保留显式旧路径/族授权迁移，族分配冲突归一化也已修。针对性测试通过。 | **F03-R1**：对象/族授权仅装配时检查，最终提交未重核，期间 Leader 新分配族给 B 后 A 仍成功写入。 |
| F04 Major | **closed** | `agent-tool-service.ts:4029–4050` 改为字符 before/newText/after 拼接；行内前后缀、跨行两端、插入多行、声明坐标平移正式用例均通过。 | 未声称穷举全部 Markdown/Unicode 编辑组合。 |
| F05 Major | **closed** | `agent-tool-service.ts:3790–3830,3921–3924` 每请求重置行预算，cursor 只带剩余队列；输入重新归一化。`tool-specs.ts:889–894` requests/cursor anyOf。正式测试证明 raw/draft 多页完整遍历最终 null、cursor-only 与非法 cursor 拒绝。 | 不是源库全规模吞吐测试。 |
| F06 Major | **closed** | `agent-tool-service.ts:3957–3987,4101–4121` 锁内重放、稳定 task+operation 键；calls 落盘 payloadHash，异载荷/异 path 冲突及旧无 hash 明确拒绝。正式测试含并发同键一次修改、随机桥 toolCallId、丢 receipts 后重放与负例，已重跑通过。 | 不把幂等重放扩成分布式 exactly-once 承诺。 |
| F07 Major | **closed** | `kb-build-service.ts:5199–5230` 以权威回执选择实际 actor 报告；`review-authority.ts` 检查 reportUnitId/reportId/draftHash 和依赖。默认省略 unitId 的真实对象发布、两个独立 reviewer 进入候选正式用例通过。 | 不是审查语义质量认证。 |
| F08 Major | **closed** | `agent-tool-service.ts:3033–3074,3467–3515` 独立审查四依赖绑定、锁内重算、机器凭据回写；`review-authority.ts:126–136` 规则未知 fail-closed。`kb-build-service.ts:5383–5405` manual 冷实例从检查点/账本执行同一 authority。真实 objects/claims/readReceipt→machine passed→CURRENT，以及声明/来源/规则漂移、null规则、非pass/自审拒绝、manual 冷实例正负用例已重跑通过。 | 业务授权在回写锁内复核；不把模型自报 pass 当成真实内容准确性。 |
| F09 Major | **partial** | `adapter.ts:153–159` epoch 唯一 session；rebuild 新 home/work/session/amagi 库，session 明确复用原会话。上游最新 native 用例本体包含新旧 epoch/session/launch 与真实续接，均通过。 | **F09-R1**：session 保留 epoch 时，旧 generation actor 仍参与后端 idle 判定，UI 已按 generation 排除，前后端不一致。 |
| F10 Major | **open** | 已新增锚点/账本/出生令牌、信号前 fresh、结构化终止结果持久化、显式 unconfirmed 与恢复阻断。严格 queued/not-started/无锚点反例也通过，认可其保守可用性边界。 | **F10-R1/R2/R3** 仍分别存在假 confirmed、错误组员回收、无终止记录的 rebuild 跳过对账。不是要求采纳被拒的 queued 放宽补丁。ENOTEMPTY 归因未闭合，另见 §5。 |
| F11 Major | **partial** | ctx authorityLease 从工具→host→发布 executor 完整透传（host 原样传 request），CURRENT 前重核 ctx/取消/timeout/代次；manual 重核 DB publishing；auto catch 精确 releaseId+manifest.buildId 收敛，manual 不把其他 build 指针当成功。对应正负正式用例已重跑通过。 | **F11-R1**：新增租约拒绝位置晚于 v1 docs rename，失败清理删除唯一草稿，CURRENT 不切但成果丢失。 |
| F12 Major | **partial** | `feishu-sync-agent.js:230–258,356–386` 启动及每次 task_submit/resume 都调用 verifyRuntimeIntegrity，不只是参数守卫；实际四配置、policy 内容、包全量 hash、workflow skill 路径+字节 sha256 参与核验；workflow skill 缺失/篡改/本体 symlink 拒绝。上游最新 feature native 日志 integrity 25 例通过，含真实 Leader 启动后删 policy/注入 settings 无 child 请求；相关源码接线已独立核对。 | **F12-R1**：按 Leader steer #2 补核，真实 child 对禁区祖先目录递归 grep 泄漏合成 sentinel；完整性核验接线已修，但被冻结工具面不能兑现禁区护读。 |
| F13 Major | **closed（代码层）** | 路由 `kb.ts` 与 dispatch-guard 改用宿主 `path.isAbsolute`，消除了 Windows 盘符/UNC 必被 startsWith('/') 拒绝的原分支。Windows 进程身份不可得仍 fail-closed。 | **Windows 真机/安装包/UNC 实操未测**；代码层关闭不等于 Windows 整链可用。 |
| F14 Minor | **partial** | 原 server 名、title/review/handoff 字段已改对；六资产 JSON schema 子集检查本轮通过。 | **F14-R1**：新加“Leader 工具”仍用子任务 MCP 外壳，真实 Leader 不允许 mcp_call；schema 测试未检查角色实际工具面。 |
| F15 Minor | **closed** | DTO/checkpoint 持久 rounds/epoch/generation/termination；历史缺 rounds 显示未知，终局计数改末次观测，历史任务按 epoch/generation 排除，unconfirmed 行不标 stopped。本轮前端 25/25 重跑；上游真实 API/UI §七实际 published+unconfirmed，不是假 DTO。 | 本轮未重跑浏览器/看截图，不新增视觉认可；后端 idle 的历史 actor 漏洞归 F09，退出真相漏洞归 F10。 |

## 3. 未关闭 findings（均与原修复直接相关）

### F03-R1｜Major｜族/旧主定义授权没有最终提交租约

- **定位**：`server/src/agent/agent-tool-service.ts:2460–2490`（装配期对象/族授权）、`:1888–1889,1912–1913`（await 后仅 ctx + v2 写窗口/目标 doc 重检）。
- **触发**：A 已持 a.md，声明准备时 family 尚未分配；准备让出执行后，Leader 将 `shared-family` 显式独占分配给 B，A 的 a.md 分配不变；A 继续提交。
- **实际影响**：A 在族已属于 B 时仍写入该族对象并记成功回执；同类风险也适用于迁移所需旧 canonical 授权在准备期间被撤回。目标文档租约不等于完整对象影响面的授权。
- **可复核证据（已复现）**：`/tmp/feishu-build-v2-incremental-review/family-lease-probe.mts` / `.log`。真实 AgentToolService/BuildActorStore；仅在现有异步声明准备边界加暂停夹具，原装配逻辑和终检照常执行；Leader 动作为真实 `assignOutputs({targetKind:'family',targets:['shared-family'],ownerTaskId:'b'})`。最终输出：`familyOwner:"b",fileWritten:true,receiptCount:1`，工具返回成功。不是伪造 actor/ctx，也没有绕过权限函数。
- **最小修复方向**：记录本次声明涉及的既有 canonical 路径/族及新族排他影响面，在最后同步提交段重核；或让相关授权变更与声明提交共享可失效租约。保留合法显式迁移。正式 race 测试由实施者补。

### F09-R1｜Major｜session 续接后旧代次 actor 仍挂住 idle

- **定位**：`server/src/kb/build-leader-supervisor.ts:387–410,683–693`；对照前端 `BuildOrchestrationProgress.tsx:345–348`。
- **触发**：旧 epoch=1/generation=1 中存在最后观测 running/confirmed actor；session 续接 generation→2、epoch 仍=1，该 actor 不再有完成通知。
- **实际影响**：UI 已把旧 generation 当历史，但 evaluateIdle 只过滤 epoch 和 revoked，没有过滤 generation；旧 actor 继续阻止两段空闲收口，直至整体超时/人工取消。rebuild 测试只证明换 epoch 后不挂，不覆盖 session 同 epoch。
- **证据（监督器实核）**：`resume-probe.mts/.log` 将同 epoch 旧 generation actor 保留，设置超过 idle 宽限且已提醒，实际 `evaluateIdle()` 仍 `null`；源码确认 prepareResume 不同步撤销 `state.actors`，账本 rotate 与该数组不是同一份状态。
- **最小修复方向**：后端活跃集合统一按当前 generation/epoch 及有效身份过滤，旧 actor 只作历史；补同 epoch session 的正常空闲收口，不只测试启动后取消。

### F10-R1｜Major｜根进程已退出即可假 confirmed，同组桥/孙进程被遗漏

- **定位**：`server/src/agent/build-runtime/process-residual.ts:294–302,334–346`。
- **触发**：有可信子任务锚点，rootPid 已退出，但原组内桥/孙进程仍存活（**不需要 setsid 逃逸**）。
- **实际影响**：根 pid 不在 ps 表便 `exited; continue`，根不在就完全不枚举组员；整体可返回 confirmed，恢复守卫可据此放行，残留模型/桥继续运行。
- **证据（真实 OS 已复现）**：`residual-probe.mts/.log` 创建本审核自己的 detached Node 根及其同组长驻子进程，读取真实出生令牌，写 amagi 形状隔离锚点，准确 SIGKILL 该根后执行生产 reconcile（真实 ps/libproc、无探测/信号 mock）。输出 `root=37979,orphan=38028,orphanAlive:true,outcome.state:"confirmed"`，children 只有根 exited。脚本 finally 只清理自己创建的 orphan PID，没有广泛 pkill。
- **最小修复方向**：根退出事实不能覆盖整个任务后代退出；对有存活组员但无足够个体归属证明的情况至少保留 unconfirmed，结合根存活期可信预录/原生退出证明收敛。不能简单在根死后按 pgid 杀组员。

### F10-R2｜Major｜根身份失效后仍回收未经归属证明的“组员”

- **定位**：`server/src/agent/build-runtime/process-residual.ts:334–346,398–425`。
- **触发**：分类时根出生令牌匹配；在新的组员枚举前根退出/身份变化。枚举得到的是变化后的组成员；根在首 TERM 前 fresh 核验失败。
- **实际影响**：尽管根已判 unconfirmed，代码仍无条件执行预录 memberPlan。成员自身 birth 的 fresh 匹配只证明它“还是刚才发现的那个进程”，**不能证明属于本次构建**，会向无关进程发 TERM。先给根 fresh 并不能自动给此前枚举的成员建立归属链。
- **证据（安全注入复现，未实际误杀）**：同一 `residual-probe.mts/.log` 的 `ROOT_REUSED_BEFORE_MEMBER_DISCOVERY` 使用模块正式注入口：分类根为旧 token，第二张进程表为新根+无关成员；根 fresh 发现变化零信号，但信号记录仍为 `[{pid:5001,signal:"SIGTERM"}]`，成员被标 reaped。注入的是 OS 探测与信号记录，不是替换业务判定。
- **最小修复方向**：成员发现/出生取样必须与根当前归属证明组成有效时序证明；该证明失败时不能继续消费整份 memberPlan。逐成员 fresh birth 需保留，但不能取代所属运行证明。由实施者补根在枚举前/中失效的矩阵。

### F10-R3｜Major｜崩溃未落终止记录时 rebuild 不做残留对账

- **定位**：`server/src/kb/build-leader-supervisor.ts:348–377`；`server/src/kb/build-runtime-host.ts:850–867` 的 rebuild→adapter.start；`adapter.ts:123–149`。
- **触发**：应用硬崩来不及写 termination，检查点已有旧 binding/任务；应用重启，旧 Leader 也已退出但 child 仍活着。用户显式 rebuild。
- **实际影响**：prepareResume 仅当已有 state/binding termination=`unconfirmed` 才重试对账；null/缺失不查。session 另有 adapter.resume 兜底，但 rebuild 直接 adapter.start 新 epoch，故证据缺失反而能绕过同 build 第二 Leader 门槛。
- **证据（守卫实核 + 静态消费者闭环）**：`resume-probe.mts/.log` 用旧 binding/空 termination，注入“对账若调用必返回 unconfirmed”的正式 callback；实际 `reconcileCalls:0,generation:2,runtimeEpoch:2,guardAllowed:true`。静态 host 路径确认此后 rebuild 直接 start，不有另一层旧 epoch 对账。不是声称已跑完整应用硬崩端到端。
- **最小修复方向**：所有有旧运行事实的恢复（尤其 rebuild）均先取得当前残留收敛证明，null/缺失不是 confirmed；在换 epoch 前完成，且保留旧 epoch 对账结果。不要靠补写假 confirmed 解决。

### F11-R1｜Major｜提交点拒绝取消虽保住 CURRENT，却删除 v1 已接受草稿

- **定位**：`server/src/kb/kb-build-service.ts:6240`（v1 staging/docs rename 入 release）、`:6279`（新增 preCommitLease）、`:5691–5694`（异常清理 releaseDir）。
- **触发**：新模式的合法纯 Markdown（无对象声明，仍走 v1 发布布局）候选，发布准备阶段取消/撤 ctx/超时；提交点租约拒绝。
- **实际影响**：lease 执行前 docs 已移出 staging；失败 catch 删除 releaseDir，唯一的草稿随之删除。CURRENT 未切属实，但“取消保留候选供恢复”不再成立；再次确认/恢复也缺 docs。知识化 v2 草稿保留的正例不能覆盖 v1 分支。
- **证据（真实发布内核已复现）**：`publish-lease-probe.mts/.log` 临时纯 Markdown + 真实 `KbBuildService.publishRelease`，preCommitLease 抛 `run_token_invalid`；结果 `stagingDocs:false,acceptedDraft:false,release:false,current:false`。没有 monkeypatch 文件系统/删除动作；只注入正式租约钩子。
- **最小修复方向**：提交前失败必须保留 staging 草稿（v1 不提前移走唯一副本，或在未提交清理前准确恢复）；保留最后提交点租约，不能把检查前移到异步准备前来掩盖取消窗口。新增验证不应只断言 CURRENT/release，还要核对草稿字节及可恢复性。

### F12-R1｜Major｜真实 child 递归 grep 从祖先目录越过 deny 读取禁区

- **定位**：应用 `server/src/agent/build-runtime/dispatch-guard.ts:267–306` 将原始库/配置等作为 scope.deny 冻结，但保留可调用递归工具；`child-policy.ts:47` 只禁 codemode/tool_search。底层实际执法在只读上游 `/Users/run.mao/workpace/amagi-pi/extensions/amagi-core/guards.ts:3355–3360`（只检查请求的搜索根）及 `file-permission.ts:238–253,398–408`（只判请求路径本身是否命中 deny）。
- **触发**：真实 child 已暴露 grep，对不在 deny 内、但包含 forbiddenRoot 的祖先目录递归搜索；不需要 bash/codemode、不需要修改设置、不需要读取真实凭据。
- **实际影响**：根路径通过守卫，底层 grep 遍历 deny 子目录并把内容送回 child 模型。直接 read 或直接 grep 禁区根被拒，不能证明递归跨根仍拒绝。相同集成语义保护原始库/配置根，故这破坏既定文件围栏，不是要求提供 OS 沙箱。
- **证据（完整真实原生链复现）**：`/tmp/feishu-build-v2-incremental-review/recursive-sentinel-probe.ts` 是仓库现有 `server/scripts/probe-build-runtime.ts` 的隔离副本，仅把 W1 的 grep 根从 sentinel 目录改为 raw 禁区的祖先 `fixtures/`，导入路径改为冻结 feature 绝对路径，SERVER_ROOT 仍锚 feature；没有改产品/上游代码。运行真实 Pi1.4.0 + 版本化 amagi2.21.31 + 生产 adapter/child-policy/MCP桥，本地 fixture 模型与临时 HOME/数据根、合成 sentinel。`recursive-sentinel-report.md` 与 `live-probe-evidence.json` 记录：直接 read 结果为 deny 拒绝；第二步 grep 返回 `raw/sentinel/secret-token.md:3: SENTINEL-SECRET-e19d0f4a...`，`哨兵内容泄漏=true`。**exit2；35pass/1fail/10not-measured**，唯一失败 `p0-sentinel-deny`。不是把 sentinel 关键字仅存在于模型工具参数误判为泄漏：工具结果确实含文件相对路径、行号和文件正文。该次收尾对账 confirmed（5 children），没有以结束状态免除泄漏反例。
- **归因/审核边界**：底层只校验搜索根的行为是 **amagi2.21.31 既有缺口**，不是本批改坏上游；本应用的新构建集成依赖其禁区保护且当前仍暴露递归工具。原 full 的直接 sentinel 检验未覆盖祖先遍历。本项依 Leader 本轮明确 steer #2（F12受影响安全边界）列入本次门控，而不是冒充本批源码引入的新上游回归。没有修改上游。
- **最小修复方向**：在应用拥有的 child 策略/工具面中保证递归工具不能跨入 forbiddenRoot（执行前排除交叉根或采用逐文件授权的受控读取入口）；find/ls 同类元数据枚举也应按真实行为核验。不要只增加 scope.read 声明、改文案或从结果文本删 sentinel，不因上游只读而默认安全。具体实施/是否改工具面由 Leader/主上裁决；不在审核节点写 patch。

### F14-R1｜Minor｜Leader 示例通过 schema，不通过真实工具面

- **定位**：`server/src/agent/skills/knowledge-build/mcp-examples.md:39–51`；`server/src/kb/build-runtime-host.ts:75` 的 Leader whitelist；`server/src/agent/pi-extension/feishu-sync-agent.js` 构建 tool_call 白名单。
- **触发/影响**：Leader 照新增“Leader 工具（仅 Leader 身份）”三例使用 `mcp_call` 外壳调用 manifest/分配/发布。真实 Leader whitelist 是原生 amagi task 工具+应用直接构建工具，**没有 mcp_call**，故被拒；这不是参数字段已正确就能调用。
- **证据**：静态工具名单与新增示例一一对照；`knowledge-skill-examples.test.ts` 只检查内层 tool-spec，未检查调用者角色的外层工具可达性。本轮其 3 例仍通过，说明测试盲区。
- **最小修复方向**：Leader 示例使用直接应用工具调用；MCP 外壳仅给 child，示例验证增加调用者实际工具面约束，不需增开 Leader MCP 权限。

## 4. 本轮验证与上游证据分离

### 本轮执行

所有新脚本位于 `/tmp/feishu-build-v2-incremental-review/`，只用临时数据/夹具，未调用远程模型。

| 命令/步骤 | cwd / 退出状态 | 真实结果与边界 |
|---|---|---|
| `npm test -- --cache=false tests/build-runtime-toolfix-regressions.test.ts tests/build-runtime-review-authority.test.ts tests/build-runtime-publish-cancel.test.ts tests/build-runtime-process-residual.test.ts tests/build-runtime-bridge.test.ts tests/knowledge-skill-examples.test.ts tests/build-runtime-integration.test.ts tests/build-runtime-adapter.test.ts` | feature `server/`；exit 0 | **8文件134例通过**；日志 `targeted-tests.log`。设置临时 HOME/FEISHU_SYNC_HOME/TMPDIR，显式 AMAGI_PI_SOURCE_DIR 与 PI_PROBE_SOURCE_AMAGI=/Users/run.mao/workpace/amagi-pi。未跑 native 完整链。 |
| `npm test -- --cache=false src/components/knowledge/BuildOrchestrationProgress.test.tsx` | feature root；exit 0 | **25/25**；`ui-tests.log`。这是组件行为测试，不是浏览器视觉验证。 |
| `node node_modules/tsx/dist/cli.mjs <本目录>/{family-lease-probe,residual-probe,resume-probe,publish-lease-probe}.mts`（逐个执行） | feature root；各 exit 0 | 上述 Major 反例已实际输出，日志同名 `.log`。OS 反例只终止本脚本创建的进程；误杀反例仅记录注入信号。 |
| `node <本目录>/mcp-refresh-probe.mjs` | feature root；最终 exit 0 | 真实 Pi MCP 客户端自动刷新、同连接迟到确认、可调用。首次脚本错误使用 SDK callTool 对象参数而非实际 `(name,args)`，exit1；原日志保留 `mcp-refresh-probe.first.log`，按实际 SDK 签名纠正夹具后通过；未改产品代码。 |
| 原生祖先递归探针（命令如下） | feature root；exit 2 | **35pass/1fail/10not-measured**；真实 child 的 grep 泄漏隔离 sentinel，见 F12-R1。不是正式测试套件数量，也不是模型质量证据。 |
| 失败夹具残留目录取证（find/stat/精确 home 字符串的 ps 检索） | 宿主只读；`cleanup-forensics.log` | 不读取 auth 内容，不用裸 PID 推断历史退出。见 §5。 |

祖先递归探针实际命令（cwd=feature root）：设置临时 HOME/FEISHU_SYNC_HOME/TMPDIR 为本取证目录、AMAGI_PI_SOURCE_DIR 与 PI_PROBE_SOURCE_AMAGI 均为 `/Users/run.mao/workpace/amagi-pi`，执行：

```bash
node node_modules/tsx/dist/cli.mjs /tmp/feishu-build-v2-incremental-review/recursive-sentinel-probe.ts --piCli /Users/run.mao/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --sourceAmagi /Users/run.mao/workpace/amagi-pi --keep --timeoutSec 110 --report /tmp/feishu-build-v2-incremental-review/recursive-sentinel-report.md
```

独立原始日志 `recursive-sentinel-probe.log`，证据目录仍保留。该次实际物化包 hash `fdd90b029725…`、3546文件；上游旧probe为9485dd95/3545文件，本轮不冒称字节相同，只按本次物化后复核相等的2.21.31包取证。未调查这一非本任务写面的文件计数差异，不据此另报回归。

绿测试与反例同时成立：134+25 正式测试没有覆盖族授权在准备中改变、根先退出的同组孤儿、根变化时的成员归属、没有 termination 的 rebuild，或租约拒绝后 staging/docs 是否仍在。不能据绿测豁免这些窗口。

### 仅审阅、不冒充本轮重跑的上游证据

- `/tmp/feishu-build-v2-baseline/feature-only-check.log`：纯 feature typecheck + 7文件148例（包括严格 queued 无锚点反例）。
- `fixes-full-check-final.log`：主树静场 check exit0，前端519、server2886/16skip；`fixes-full-build-final.log`：build exit0。未独立重跑全量/构建，不将用户既有 metadata-shell 初次3秒超时改称本批缺陷或首次全绿。
- `fixes-native-e2e.log`：前次 Root 3文件34例 exit0；`merged-live-probe-report.md`：真实 native35pass/0fail。次数含导入 contracts，不再额外累加成更多场景。
- **最新纯 feature `feature-only-native.log`：34个用例本体通过，但 1 suite failed，exit1。** 失败为 fix-e2e afterAll 第373行 ENOTEMPTY。不能写“最新原生套件全绿”。
- `ui-real-api-acceptance.md §七`：真实 published、末次观测并发5、轮次1/0、真实 unconfirmed 告警、无百分比。采用上游交互记录，不把未看的 shot-19/20 当本轮视觉证据。

## 5. ENOTEMPTY / 终止 quiescence 接缝

已核实：最新 native 日志 34 例本体均过；`build-runtime-fix-e2e.test.ts:368–374` afterAll 只等待 Hono HTTP server 和 fixture model server 的 `close` 回调，然后立刻递归删 home。`cancelAndWait:604–618` 仅轮询业务终态，不显式等待宿主/后台所有 FS 写者 quiescence。HTTP close 不等价于 Pi/所有异步写盘已退出。

本轮对日志指明的**同一个**目录只读取证，最终残留仅：

`.../kb-fix-e2e-NluHe2/agent/builds/b_20261101154022_6edf4a/epochs/e2/home/auth.json`

stat 显示 2 bytes，birth/mtime 为本机 `2026-11-01T07:40:43`；未读取内容。当前精确 home 字符串进程检索无匹配，**这不能证明失败时没有进程**，也不能证明所有不含该字符串的进程均不存在。不能由单次 ENOTEMPTY 直接认定残留进程或 Major。

**归因尚未闭合**：现有日志没有删除时刻各写者 PID/launch/exit/close 与文件写入时序，不能区分 SDK/auth 的有限异步收尾、退出中 child 写入，或其他生命周期窗口。没有盲重跑来把失败覆盖成成功。已复现的 F10-R1/R2/R3 独立于此失败，不能反过来把它们当作该 ENOTEMPTY 的已证根因。

最小建议：实施者在夹具释放前等待应用宿主任务/取消与已创建进程的实际收尾，以及已知异步 FS 写者完成；记录精确写者/close/termination 时间线。若最终证明只为有限清理竞争，可在取得 quiescence 后对删除做有界重试，**不能只加重试/放宽超时掩盖活进程**。本轮没有修改测试或清理该失败现场。

## 6. full 增量覆盖、可信度与盲区

| 维度 | 覆盖结论 |
|---|---|
| 正确性/接口消费 | 原F逐项对照：写入/编辑/分页/calls→声明账本，review→候选→知识门禁，MCP通知→真实Pi连接，host→adapter→监督恢复→DTO/UI。 |
| 安全/权限 | ctx/actor/generation/发布窗口、对象/族与旧主定义授权、独立审查、派发运行完整性、进程出生与成员归属；反例不是凭风格推测。发现 F03/F10 的实际越界窗口及 F12 真实递归禁区泄漏。 |
| 一致性/并发/恢复 | 声明锁、最终提交、回执重放、CURRENT真相、manual冷实例、epoch/session/launch、缺失终止记录、历史generation活跃集合。F09/F10/F11未闭环。 |
| 兼容/迁移 | legacy默认未切；旧无hash拒绝盲重放；旧rounds未知；平台绝对路径代码修复。未以兼容名义接受假confirmed或丢候选。 |
| 性能/资源 | 没有性能基准结论。逐次包hash与轮询确有成本，但本轮没有可复核定量回归证据，不新增偏好型finding。 |
| 测试/可维护性 | 审查了断言是否覆盖真实接缝；本轮正式134+25绿与7个Major反例并存。没有替实施者写项目测试或patch。 |
| UI | 仅DTO语义/组件单测独立验证，交互采用上游记录。F15本身可关；后端错误confirmed可能让UI再次信错真相，归F10而非要求UI伪造修补。 |

明确未覆盖：

1. **A23 六源、三路径三次中位数/20分钟/完整语义质量仍未验收**；Root/feature没有生产资料测试。fixture发布、native probe、此前GLM最小烟测都不能替代。
2. **Windows 真机/打包、setsid逃逸孙进程**未测。F10-R1 是普通同组遗留，不属于已披露 setsid 盲区，不能据此豁免。
3. 未穷举同 uid 外部代码/文件系统TOCTOU、所有祖先symlink，以及真实操作系统PID复用的全时序；错误组员发信号为可控注入证明，未在真实无关进程上执行误杀。
4. 没重跑远程模型、真实浏览器、全量check/build；本轮另实际运行了祖先递归原生probe（不是完整性能/发布验收）；上游记录已与本轮运行分列。ENOTEMPTY真实失败保留，根因不足明确标未核实。
5. 认可 F10 的最终严格裁决：queued/not-started、无 PID/锚点不等于 never-spawn；空ps也不能证明该微窗口不存在。正常published可以保守unconfirmed，这一已裁定可用性限制**不是本轮finding**，不得回流被拒的放宽补丁。但当前其他路径仍有假confirmed/误回收/缺证启动，所以F10不能关闭。

## 7. 交付与处置

- 本轮产物仅本报告和隔离取证；回滚只涉及移除本报告/本轮临时目录，不涉及任何源码/index或他人现场；建议先保留证据，不自动删除。
- 建议 Leader 按约定将 **F03/F09/F10/F11/F12仍有Major** 的结论及上述复现路径上报主上，由主上决定后续；本节点不自动派发或继续修复循环。

**VERDICT: FIX（仅对纯 feature 修复批的原 F01–F15 增量范围；非完整上线/性能/Windows验收）。**
