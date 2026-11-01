# build-runtime-v2：R2 新整批 full Gate

**结论：FIX。确认 4 个 Major，无已确认 Critical。原 F01–F15：13 closed、2 partial（F03、F10）。**

本报告是新的累计候选门控，不改写 R1 的 FIX，也不把 R1 增量复审重新宣布通过。原 7 Major 反例的直接修复已有实质证据，但完整授权影响面和生命周期缺证路径仍有反例；新增 shutdown 还未封住在途创建准入。

## 1. 基线与隔离

- HEAD：`25cc0b4`；候选：`agent-outputs/workflow/build-runtime-v2/r2-candidate-feature.patch`。独立执行 SHA256，结果为任务指定的 `02d8c85415b870cac60bc75c84dd04dcb968179c53e4b99705f7d074bcabeef6`。
- `GIT_INDEX_FILE=/tmp/feishu-build-v2-r2/feature.index git diff --cached --binary HEAD | shasum -a 256` 得到相同值。逐个比较该 index 相对 HEAD 的 **54 个路径**与 `/tmp/feishu-build-v2-r2/feature-final` 的 Git blob hash，零不一致。
- 以下源码行号**均相对 feature-final**，不混用带用户 WIP 的主树行号。主树作只读消费链对照；目录比较确认功能源差异仍是原 12 修改 + 2 新增；`node_modules` symlink 只作依赖。没有把用户声明修订/覆盖保护、输出上限和预览增强计入 feature 防线。
- 先完整读取本目录 `incremental-review-report.md`、`review-report.md`、`fix2-integration-report.md`、`fix-map.md`；再核对设计 v2 全文、`CLAUDE.md`、`docs/design/agent-knowledge-design.md`、`docs/design/kb-agent-upgrade-design.md` 及实现/测试/调用方。读取大文档的截断部分已续读。
- 另核对 `/tmp/feishu-build-v2-baseline/status.txt`、`/tmp/feishu-build-v2-r2/user-remains.patch` 的相关共享文件差异；审核脚本只导入纯 feature。
- 写入仅本报告、`r2-review-evidence/` 自建脚本/日志和 `/tmp/feishu-build-v2-r2/review/` 隔离夹具；未写项目源码/项目测试/index/上游，未提交。未读生产知识库或凭据，未请求远程模型。唯一真实 OS 子进程由本轮脚本创建并持有 ChildProcess，最终只向该句柄发 TERM 并等 close。

## 2. 原 F01–F15 逐项结论

closed 是所述代码缺陷关闭，不等于所有平台、模型质量或性能验收通过。

| 原编号 | R2 状态 | 本轮回源结论与证据 |
|---|---|---|
| F01 | **closed** | `agent-tool-service.ts:1927–1940` 在异步装配后同步查 ctx 租约、目标写窗口，再触盘；撤 token/session/build 会失效在途 ctx。真实撤租、排队写/编辑及审查锁内 ctx/actor/generation/publishing 矩阵重新通过。完整对象影响面另归 F03。 |
| F02 | **closed** | `claude-bridge.cjs` 的 list_changed、快窗后退避、401/stdin 收口；本轮桥接 11 例通过，包含同连接迟到确认→可见写工具→实际服务写入与撤销拒绝。没有把两次 HTTP list 当 MCP 缓存刷新证据。 |
| F03 | **partial** | 原族变更和跨 canonical 迁移的提交时重核已接入唯一同步落盘段；针对新族/旧路径/迁移族/真实证据 await/edit 继承声明的正式反例均通过。但 `DeclarationAuthImpact` 未覆盖旧族移出和同路径对象删除，见 R2-F03-01。 |
| F04 | **closed** | exact_text 现在以 before/newText/after 字符拼接，保留行内/跨行前后缀，声明坐标随行变化；本轮相应正式用例通过。 |
| F05 | **closed** | 每页重置预算，cursor 只保存剩余队列，cursor-only schema 可用；本轮 raw/draft 多页直到 null、坏 cursor 拒绝用例通过。 |
| F06 | **closed** | edit 锁内重放、稳定任务+operation 键、calls payloadHash 校验；并发同键、丢回执、异载荷/异路径及旧无 hash 拒绝均通过；不宣称分布式 exactly-once。 |
| F07 | **closed** | 权威 actor 审查回执驱动候选报告选取，不再遗漏缺省 unitId；本轮省略 unitId 的真实知识对象发布和双 reviewer 用例通过。 |
| F08 | **closed** | `review-authority.ts` 绑定正文/声明/快照/规则；工具在锁内核权后回写机器凭据，auto/manual 冷实例消费同一 authority。依赖漂移、null 规则、自审/非 pass 拒绝与真实 CURRENT 正例重新通过。 |
| F09 | **closed** | `build-leader-supervisor.ts:348–466,727–744`：fresh 不换代，generation=1；idle 同时过滤 epoch/generation；rebuild 新 home/session，session 保留原 epoch。integration+adapter 55 例本轮通过，含同 epoch 旧代次不挂 idle。原生续接证据采用已核日志，不冒充本轮重跑。 |
| F10 | **partial** | 原根死同组孤儿、根换人前后夹逼、无 termination 的 rebuild 三反例已有修复；生产历史数字 PID 无默认 kill 出口。新增 Leader pre-spawn pid0 意图、账本 schema/degraded、跨 epoch 对账均在实际链上。但 binding/账本缺失时丢掉已有锚点，以及内层扫描错误被当空，仍可假 confirmed，见 R2-F10-01/02。 |
| F11 | **closed** | `kb-build-service.ts:6442–6488` v1 复制、不提前移走草稿；v2 保留原草稿；提交点租约不后退。17 例重新通过，含 v1/v2 拒租保字节、manual 可恢复、取消/超时/缺 ctx 拒绝、CURRENT 后 DB 失败不删 current。 |
| F12 | **closed（所审工具边界）** | 派发/续接前实际调用 verifyRuntimeIntegrity；递归 grep/find/ls、codemode/发现面被移除并调用拒绝；native 文件仅冻结根，知识仅 MCP。独立 SDK probe 证明普通相对/绝对 read 实际可读，@/file URL/外部相对/symlink/缺失目标拒绝。核对安装的 Pi1.4.0 `paths.js`、`path-utils.js` 的实际别名与候选回退语义，及 child-policy 的相应拒绝分支。正式原生探针日志证明递归/续轮/直连负例和 skill/work/report/MCP 正例；本轮不重复冒称真实原生链重跑。Windows 只有词法用例，无真机认可；不宣称 OS sandbox。 |
| F13 | **closed（代码层）** | 路由与派发守卫用宿主 isAbsolute，消除原 startsWith('/') 必拒路径。Windows 真机/UNC/打包仍未测，进程探测无能力时保持 unknown。 |
| F14 | **closed** | `mcp-examples.md:39–55` Leader 三例已是直接应用工具；child 保留 mcp_call 外壳。与 host 白名单/扩展 tool_call 对照，本轮示例契约 4 例通过，包含调用者可达面。 |
| F15 | **closed（DTO/组件语义）** | 持久 rounds/epoch/generation/termination，历史任务不计当前并发，unknown 不标 stopped；本轮监督 DTO/检查点回归通过，组件源码与现有交互记录对照。F10 的假 confirmed 是生产事实源缺陷，不要求 UI 自造另一套真相。本轮未作浏览器/视觉复验。 |

**ENOTEMPTY 专项：partial。** 生产 close→shutdownServices→KbBuildService.shutdown、e2e/probe 消费 `quiesced===true`/`termination.state` 的形状和顺序正确；unknown 真实保留而不是 rm 重试。上游 native 日志确有 `[kept-home:shutdown-unsettled]`，正式 probe 末尾也明确保留。但当前 confirmed 生产器仍可在证据丢失时撒谎（R2-F10-01/02），且 shutdown 没有关闭准入（R2-LC-01），不能关闭整个 quiescence 承诺。

## 3. 阻断 findings（本批一次性完整上报）

### R2-F03-01｜Major｜授权影响面只收新族，旧族移出/删除可以绕过族排他

- **定位**：`server/src/agent/agent-tool-service.ts:2525–2553`（旧对象授权仅针对跨路径）、`:2559–2574`（只登记输入的新 familyKey）、`:2642–2652`（同路径旧对象直接移除）；`:2172–2210` 最终授权仅消费上述不完整集合。
- **触发**：A 持 a.md，先登记对象 O（族 F）；Leader 再把 F 独占分配给 B，a.md 的文档分配仍是 A。A 用原 clientKey 在 a.md 重申 O，但 familyKey 改为未分配的 G；或在独立场景直接提交 `objects:[]`。
- **实际行为/影响**：两种调用都成功落盘并登记新回执。第一种保留 objectId，把 O 从 B 的族 F 移到 G；第二种直接删掉属于 F 的 O/clientKey。没有检查旧族 F 的持有人，最终同步租约也无从重核。文档分配与族分配可独立存在，因此不能以“仍持 a.md”覆盖服务已声明的族排他。
- **已复现证据**：`r2-review-evidence/authority-probe.mts` / `.log`：`change-prior-family SUCCESS`，同 objectId，revision=2，familyKey=unassigned-new-family，oldFamilyOwner=b；`authority-delete-probe.mts` / `.log` 是**独立初始场景**，没有先移族：`remove-objects SUCCESS`、objects=[]、oldFamilyOwner=b、receipts=2。使用真实 AgentToolService/BuildActorStore/声明持久化，无权限函数替换，也无需 race。覆盖现有测试的族 await 撤租反例并不能排除这两种遗漏。
- **归因**：原 F03 修复范围内未闭合的影响面，不归因用户 WIP；主树用户覆盖引用保护也不能证明完整族授权。
- **最小修复方向**：按旧/新声明 diff 收集所有实际修改/移出/删除对象的旧族与新族，以及迁移旧 canonical；装配期和最后同步提交段核同一完整集合。保留获得显式授权的合法迁移/删除，不靠取消迁移功能或只新增一条新族测试解决。

### R2-F10-01｜Major｜有活动锚点但 binding/账本缺失时，被过滤成“全部已对账”

- **定位**：`server/src/agent/build-runtime/adapter.ts:130–140,170–177`；`process-residual.ts:334–336,363–385`。全部锚点 taskId 先被当作 covered，但不在 leaderPids 内的 run 随后直接 continue。
- **触发**：恢复/关闭时 binding 不可得且进程账本缺失（ENOENT 当前不是 degraded），旧 epoch home 内仍有合法 launch-anchor 与 running v2-store。此时 leaderPids 为空。
- **实际行为/影响**：合法锚点的 root 被无声丢弃；v2-store 因“有锚点覆盖”不产生 unknown；byPid 为空直接 confirmed。已存在的旧运行事实反而不进入任何个体检查。shutdown 又用该 confirmed 下调内存未知并返回 quiesced=true，恢复 guard 同样可以放行新 Leader。**没有要求按这些不完整证据杀进程，正确行为应至少保留 unknown。**
- **已复现证据**：`r2-review-evidence/residual-probe.mts` / `.log` 的 `UNBOUND_ANCHOR` 与 `SHUTDOWN_UNBOUND`。本轮创建 detached Node 个体（该次 pid=20637），实际读取 darwin 出生令牌并写隔离合法锚点+running 意图；真实 ps/libproc、无 probe/kill 注入，个体仍活着时输出 `state:confirmed,children:[]`、`quiesced:true`。finally 仅使用自有 ChildProcess 句柄 TERM 并等到 close。未对任何未知/历史 PID 发信号。
- **归因**：F10-R3 的“binding 丢失也按旧事实对账”仍缺分支；是当前累计候选的缺陷，不是把保守 unknown 当错误。
- **最小修复方向**：锚点归属不明不能同时充当“已覆盖”与“可忽略”的证据。未匹配 leader 归属的旧运行锚点保留未确认；对账缺少必要账本/binding 时明确 degraded，不能由空个体集合推导全部已退出。

### R2-F10-02｜Major｜内层目录扫描不可得被吞成不存在，仍可允许清理

- **定位**：`server/src/agent/build-runtime/process-residual.ts:84–95,152–155,379–388`。外层 `listBuildHomeDirs`/ledger degraded 能拒绝，但这两个真正读取锚点/意图的 scanner 无错误区分。
- **触发**：home/epoch 可枚举，但 `amagi/data/process-audits` 或 `amagi/v2-store` 自身不可枚举（如 ENOTDIR/EACCES/损坏），缺少其他可见个体。单个 anchor 的 read 错误也被无差别 continue。
- **实际行为/影响**：所有错误当作空；confirmed note 甚至声称“无派发意图……无任务即无子进程可残留”。这不是 fresh 无目录的合法 no-facts，而是证据读取失败。shutdown 返回 quiesced=true；测试/嵌入消费者据此删除可能仍有写者的 home，回到 ENOTEMPTY 修复承诺所禁止的假清理。
- **已复现证据**：同一 `residual-probe.mts/.log` 的 `UNREADABLE_SCAN`/`SHUTDOWN_UNREADABLE`。真实磁盘将上述两个目录位置置为普通文件，使 readdir 必然 ENOTDIR；生产对账仍 confirmed，shutdown quiesced=true。本例证明错误传播失败，**不声称在这个损坏夹具中另有活进程**。前一例的真实活进程是独立证据，不混为本例根因。
- **归因**：R2 对顶层扫描和账本 schema 的 fail-closed 修复未覆盖实际内层扫描；属于新增 quiescence 消费链暴露的 F10 残留缺口。
- **最小修复方向**：scanner 返回显式 degraded/unavailable 并贯穿总体 outcome；只把确证 ENOENT 按契约作不存在处理。锚点损坏/不可读不能只改 note 或依赖另一份也可能不可读的 v2-store；不能用 rm 重试掩盖。

### R2-LC-01｜Major｜shutdown 返回 quiesced 后，在途 createBuild 还能继续落库并启动流水线

- **定位**：`server/src/kb/kb-build-service.ts:705–714,725–741,872–913`；生产消费者 `server/src/index.ts:810–812,839–853,890–908`（业务 shutdown 后才关闭 HTTP）。
- **触发**：HTTP 已进入 createBuild，停在异步 `resolver.checkReadiness`；此时执行 shutdown。请求尚未进入 active/pipelineRuns，磁盘也无启动事实，因此 shutdown 扫描空并返回 quiesced=true。随后 readiness 返回 ready。
- **实际行为/影响**：没有 shuttingDown admission lease，await 后只重查 running/DB 活跃行；createBuild 继续 createKbBuild、登记 active 并执行 runPipeline。已发布的“OS 全部收口/允许清理”结论可立即被应用自身的新运行推翻。生产 HTTP 仍在该阶段服务/等待已有请求，关连接也不自动取消已经执行的 handler；后续新运行可能逃出取消快照、在收尾/目录清理后继续写或启动进程。
- **已复现证据**：`r2-review-evidence/shutdown-admission-probe.mts` / `.final.log`：`SHUTDOWN_BEFORE_READINESS ... quiesced:true` → `CREATE_ROW_AFTER_SHUTDOWN` → `ADMITTED_AFTER_SHUTDOWN ... status:preflight`。真实 createBuild/shutdown/runPipeline；仅使用其声明的就绪依赖暂停，无替换准入或 pipeline 方法。无生产资料/真实模型。夹具故意不提供完整 pool，后续 pipeline 以 `pool.configure is not a function` 失败，**这不是 finding，也不是原生进程已逃逸的复现**；本例证明真实准入/流水线已越过关闭边界，OS 后果由生产调用链静态证实。
- **归因**：createBuild 缺 shutdown gate 原先已存在，R2 新增 quiescence/shutdown 合约及消费者使其成为当前改动的直接生命周期接缝；不是无关全仓旧问题。
- **最小修复方向**：shutdown 开始即封闭创建/恢复/手动发布等相关新运行准入，并对已在 readiness 等 await 中的请求在最终入列/启动前再次检查同一失效租约；将已开始的 admission 纳入等待/取消事实链。不要只调换 HTTP close 顺序，既有在途 handler 仍需服务侧门控。

## 4. 本轮验证与证据可信度

证据目录：`agent-outputs/workflow/build-runtime-v2/r2-review-evidence/`。所有 node 取证脚本导入绝对 feature-final 源码，夹具在 `/tmp/feishu-build-v2-r2/review/`，HOME/FEISHU_SYNC_HOME 临时。脚本重跑保留现场，不自动 rm 未知运行目录。

### 独立执行

1. SHA256/index/snapshot 对照：exit0；54 个候选路径 blob 相等。未改 index。
2. cwd=`feature-final/server`：
   `npm test -- --cache=false tests/build-runtime-toolfix-regressions.test.ts tests/build-runtime-process-residual.test.ts tests/build-runtime-child-policy.test.ts tests/build-runtime-publish-cancel.test.ts tests/build-runtime-review-authority.test.ts tests/kb-build-service-shutdown.test.ts tests/knowledge-skill-examples.test.ts tests/build-runtime-bridge.test.ts`
   → exit0，**8 文件 165 pass / 3 skip**，`targeted-tests.log`。3 skip 是 gated 原生 child-policy 项，没有被算成通过。
3. 同 cwd：`npm test -- --cache=false tests/build-runtime-integration.test.ts tests/build-runtime-adapter.test.ts`
   → exit0，**2 文件 55 pass**，`runtime-tests.log`。其中同 epoch idle、fresh generation、无 termination rebuild、终止异常持久化均有实际断言。
4. cwd=`feature-final`：`node node_modules/tsx/dist/cli.mjs <本证据目录>/{authority-probe,authority-delete-probe,residual-probe,shutdown-admission-probe,path-sdk-probe}.mts`（逐个执行；显式临时 HOME/FEISHU_SYNC_HOME）
   → 最终均 exit0；各日志如上。exit0 表示取证脚本运行成功，不表示被检产品满足契约。
5. `path-sdk-probe.final.log`：生产生成 policy hook + **安装的 Pi1.4.0 createReadToolDefinition**，普通相对/绝对文件读出 ALLOWED，5 种越界/歧义/缺失目标被拦。非完整 Pi/amagi 进程，不冒充原生端到端。

首次取证失败如实保留：`shutdown-admission-probe.log` 因默认 backend=claude-code 在合法门禁被拒，随后只纠正夹具为 pi；`path-sdk-probe.log` 因 cwd=server 下没有 tsx 模块失败，随后在 feature 根运行。未改产品/放宽门禁。另有几次搜索表达式转义/超界读取错误，未作为产品验证结果。

### 仅抽核的上游证据（未冒称本轮重跑）

- `check-final.log` 尾部 server **2948 pass / 16 skip**，build-final.log 完成前端/tsc/资产/MCP/CLI；未用整套负载替代本轮分析。
- `feature-unit.log`：11 文件284 pass/4 skip；`feature-native.log`：3 文件34 pass，明确 unknown home 保留。日志中的“真实令牌+自有 ChildProcess 句柄”不是生产历史 PID 回收能力。
- `probe-confirmed-cleanup/report.md`：Pi1.4.0 声明 bin `dist/bundle/cli.js`、冻结 amagi2.21.31/hash9485dd95c004；36pass/0fail/10not-measured。末尾明确最终未确认、保留目录，不把前一观察时点无残留当最终 quiescence。
- 上述真实原生链是本地 fixture 模型驱动；不是实际 LLM 质量/六源性能证明。未借用 2.21.32 演进工作树作正式支持证明。

绿测与本轮反例不矛盾：授权测试对输入新族/跨路径租约覆盖较好，但未测同路径旧族移出/删除；生命周期测试覆盖顶层 ENOTDIR、合法 ledger 和已绑定锚点，未覆盖不匹配 leader 的合法活动锚点、内层扫描失败与 pre-admission await。`shutdown` 的 dead-anchor 正例本身无账本/binding，当前可能先被 leaderPids 过滤，不能单靠该正例证明真正执行了 root 退出探测。

## 5. full 覆盖与剩余边界

| 维度 | 审核覆盖 / 可信度 |
|---|---|
| 正确性与消费者 | ctx→工具/声明/回执→审查→候选→auto/manual release；host→supervisor→adapter→持久事实→DTO；shutdown/probe/e2e 实际结果形状。真实工具和发布内核定向测试可信，发现上述可复核反例。 |
| 权限与安全 | 代次/actor/输出/族/旧 canonical；Leader 直接工具与 child MCP；冻结 policy/四配置/包/skill；native 文件根、SDK别名/缺失回退、递归/发现/续轮工具。F03 未闭环；未发现本轮生产历史 PID 信号出口。 |
| 一致性/并发/恢复 | 同步提交段、排队/OCC/幂等、CURRENT/DB 后置异常、fresh/session/rebuild、跨 epoch 与 pid0 意图、账本 degraded、内存过期后磁盘复核。F10 和 admission 接缝仍阻断。 |
| 兼容与迁移 | legacy 保持默认；旧检查点无轮次不伪造；Windows 路径改为宿主语义；missing ledger/旧 home 兼容不能凭空 confirmed。未改用户 WIP。 |
| 资源/性能 | 关闭有 pipeline 等待和每探针超时，但 timeoutMs 不是整条 shutdown 的严格总 deadline（取消与逐历史目录扫描在预算外）；未做大历史数量关停时长基准，不据此另报无实测定量缺陷。无新增吞吐/模型成本结论。 |
| 测试与可维护性 | 独立220 pass/3 skip，不编写项目测试，不修 patch；明确测试断言与生产链差别。需要实施者把本报告反例转为正式回归，不能由审核者自证修复。 |
| UI/视觉 | 核语义和调用方；本轮未启动浏览器/Electron、未看截图，不签视觉验收。此前真实交互记录仅作上游证据。 |

未测边界（不是本报告额外“缺陷”）：Windows 真机/安装包/UNC；setsid 逃逸后代；同 uid 受信 Node 插件或外部攻击者的任意 OS 能力；所有文件系统 TOCTOU；远程真实模型质量与六源 A23（仍缺两份 sheet）；性能三路径三次中位数/20分钟。正常 queued/not-started 无 startedAt/锚点仍可能 spawn，严格 unknown 可用性限制被接受，**不列为 finding**。legacy 不应因本轮代码门控而切默认。

## 6. 交付与处置

- 仅交报告/取证，未写修复。建议实施者一次处理上述完整影响面、缺证传播与关闭准入；本节点不自行调度或继续修复循环。
- 回滚本轮产物仅移除本报告和自建 evidence/临时夹具；没有源码/index/用户现场回滚操作。建议保留证据，不自动清理其它运行目录。
- 结论仅对所声明累计纯 feature 候选及受影响调用边界有效，不是上线/A23/平台认证。

VERDICT: FIX
