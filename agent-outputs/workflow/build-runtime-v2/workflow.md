# 构建运行时 v2 重构 workflow

## 当前终态：已知审核发现全部闭合

主上续令后，最后R2-F10-02 scanner/schema补齐：固定home/task可见损坏不丢事实、execution/processState闭合、终态不代替OS退出、PID整数范围及Native boot成对schema。独立增量d62dfd56已accepted，**VERDICT=PASS，四类全closed、0新增finding**；与前轮14closed合并，原F01–F15全部closed（所列代码覆盖层，不是所有设计/平台验收）。报告`final-scanner-review.md`，初次FIX保留`final-scanner-review-initial.md`。

最终全量同原断言/timeout、仅串行文件：lint/typecheck、前端519/server3080通过、16skip、build通过；纯feature编译/构建、204定向/34真实原生通过；独立89项producer/矩阵/关联取证通过。候选SHA256=33d9919363a8be40fb06587c965c3d7c2aa8285f905e4e1fab04f25bcddc80d4，用户原12+2不纳入提交。legacy默认、A23六源/Windows/setsid/全FS TOCTOU/真实模型质量边界维持，不虚构通过。

## 历史R2唯一增量裁决（保留失败）
R2唯一增量1b5f488c已接受审核产物，**VERDICT=FIX：14closed/1partial，仍1个Major R2-F10-02**。非目录home、合法UUID task位置变file/link、未知execution字符串、小数PID/PGID四类损坏事实仍可假confirmed/quiesced。报告`r2-incremental-review-report.md`（主报告同r2-review-report.md），原full失败逐字保留r2-full-review-report.md。按既定复审规则完整上报，不自动再开修复/审核循环；未作为完成版本提交，用户12+2仍保留。

## 目标与基线
- 按《基于Agent基座与工作流插件的构建重构设计-v2》实现 Pi + amagi 单一调度构建；Claude 原生路径能力未实测前不启用。
- 自治级别：unattended。主上后续明确要求每完成大阶段提交Git；仅提交本次阶段产物，保护任务启动时所有未提交改动。真实资料不用于测试；使用临时 FEISHU_SYNC_HOME。
- 设计：/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/编排构建效率优化/重构/基于Agent基座与工作流插件的构建重构设计-v2.md
- 初始分支 main；12 个已修改文件与2个未跟踪文件，含知识工具、构建服务和模型限制等用户改动，均须保留。

## Phase 与任务
| ID | 目标与完整切片 | Agent | 依赖/输入 | 产物 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| P0 | 代码/设计差距与写边界核查 | baize | 设计、当前代码与diff | research-report.md | 可派发接口与逐项验收 | completed/accepted: 576f40ec |
| P1-R | 运行隔离、版本包/配置/probe、RPC | luban | 设计+实际解析器；公开接口供下游 | runtime-report.md+代码 | 单测/实际能力探测，保护普通会话 | completed/accepted b559b30e+d2bb01b8，主树已验证 |
| P1-T | 身份/分配/回执/独立审查/知识工具/MCP | luban | 设计+现有工具链 | tools-report.md+代码 | 权限/幂等/编辑与读取单测 | completed/accepted 38333292，已合主树 |
| P1-I | 主链/监督/恢复/发布/skill打包 | luban | R/T公开接口；独立部分先行 | integration-report.md+代码 | 单Leader无应用调度、故障链/旧路径测试 | 首轮c7e99841 rejected（仅假端口）；c5936873 accepted/已合主树，真实API发布3/3；d21e38cc续补双作者/取消/恢复真实证据 |
| P1-E | 扩展白名单与派发守卫接线 | luban | R守卫接口+I环境契约 | extension-report.md+代码 | 实际改参进入冻结scope，普通会话不变 | 首轮08679499 rejected；918a4d13 accepted，已合主树 |
| P1-C | 真实工具面差异的child-policy防御补充 | luban | 实测codemode强制注入；Advisor C方案 | child-policy-report.md+配置/模块/测试 | 实际child首/续轮过滤、调用拒绝、缺失/篡改fail-closed | 20d7aaeb accepted；主树完整原生probe35pass/0fail，专项84过；已提交97376ec |
| P2-U | 配置/UI/进度与真实浏览器验证 | luoshen | I配置/DTO；独立布局先行 | ui-report.md+交互证据 | agent-browser实际交互，临时数据 | 首轮6c986837 rejected（拟定DTO）；97e740f9/87ca4440/1a62d7d1 accepted；真实浏览器3次published+2处前端修复；186b9b58复验后端模式持久化修复 |
| P3-L | 真实Pi+amagi子任务/MCP能力探测脚本与证据 | luban | 已合入基础模块；主链无依赖部分先测 | live-probe-report.md+probe脚本 | 真实child身份/禁读/工具授权/通知/取消/恢复，fixture模型诚实标注 | b361ce73 accepted；完整Leader→原生child→MCP35pass/0fail；cfadc8ea真实GLM-flash烟测17pass |
| P3 | 集成回归、真实运行能力探测与设计对照 | Leader/执行Agent | P1/P2 | 验证报告、验收矩阵 | check/build、身份取消恢复发布链 | 修复合主树；静场check前端519/server2886通过、build通过；纯feature去用户WIP编译+148过；最新native34本体过但afterAll清理ENOTEMPTY待审，详fix-integration-report |
| Gate | 高风险整体独立审核与修复 | diting | P3 | review-report.md / incremental-review-report.md | 无未解决Critical/Major | 首次eec182a8 FIX；唯一增量7fa31cae已accepted审核产物，VERDICT仍FIX（7Major/1Minor未闭合）；停止自动循环、等待主上裁决 |

## R2：主上续修授权（7 Major + 1 Minor）

主上已明确要求继续修复、完成所有修复后再收口。前轮FIX与证据不改写，本批采用当前dirty-snapshot新worktree，不回流旧046放宽补丁；完成反例修复→主树集成/真实消费链/用户WIP剔除验证→新的整批独立Gate。

| 节点 | 完整切片/写边界 | 句柄 | 状态/验收 |
|---|---|---|---|
| R2-T | F03最终对象/族/旧canonical授权租约；ToolService/ActorStore | ca6171d6 accepted/已合Root；完整影响面同步终检，5负2正race；Root与P合测68过 |
| R2-P | F11提交前失败保留v1/v2草稿 + F14真实Leader工具示例 | c648fe32 rejected→26535b00 accepted/已合Root；v1改副本保原件，否决恢复失败仍删除的首轮方案；F14外层角色测试过 |
| R2-S | F12祖先递归禁区泄漏；应用owned策略/工具面收窄 | c230c6d7→fd3b4804→49ca09c3 | accepted/已合；Leader另补SDK别名及候选回退缺口，冻结2.21.31真实文件工具/桥正反例通过 |
| R2-R | F09代次idle；F10孤儿/成员归属/缺证恢复；关闭quiescence | 3c2a6247→261b182a→8160f687→c938b3cf | 全链accepted/已合；Leader补账本schema/pre-spawn意图；定向104、静场全量及真实原生123通过；unknown现场真实保留 |
| R2-I | Leader按方法合并，静场check/build/纯feature/真实入口验证 | Leader | 验证完成待Gate；最终check519+2948/build、原生123、probe36/0；纯feature编译/构建+284及原生34通过，用户14路径独立保留 |
| R2-Gate | 本批新的full独立审核 | diting 8ab9e825 accepted | FIX：13closed/2partial（F03/F10），4Major；候选SHA256=02d8c85415b870cac60bc75c84dd04dcb968179c53e4b99705f7d074bcabeef6；独立220pass/3skip |

安全决策：优先在应用拥有的策略中收窄未经逐文件授权的递归工具并限定native文件操作到冻结skill/报告，不改amagi上游；进程归属不明保持unconfirmed，不以PID/PGID/命令名冒险清理。Publish与Runtime共享KBService仅方法面分工；Security不动Runtime的adapter，接口变更先互通。

R2进程安全决策（Advisor55ae）：发现仅线索；封存归属要求root身份区间包住member birth区间再包membership观察，并核可信私有session/归属链；计划未封存失败即作废。fresh birth→数字PID signal仍有OS复用窗口，因此新构建生产路径不自动回收仅历史PID/无稳定进程引用的目标，保留unconfirmed阻断；正常stdin与保留的自有ChildProcess引用终止不变，不新增OS helper/调度器，不把模拟原子signal出口写成生产能力。所有旧事实对账与新launch准入串行，缺termination不是confirmed。

环境决策：上游HEAD仍929000e但工作树package已2.21.32，不升级生产pin来迎合漂移。正式验证使用既有受信2.21.31缓存的原样冻结副本`/tmp/feishu-build-v2-r2/amagi-pi-2.21.31`，内容SHA256=9485dd95c004f6962b89638fc39c868e5ae8f2069b51e45742525ba80d9251ab、3545文件/85558016B，与原缓存逐hash相等。2.21.32探测只作兼容探索，不替代正式支持版本证据。

## R2 Gate后合并修复（目录名R3，仍属R2的唯一增量复审批）

四项真实Major一次分流，不循环单反例修补；已派三个fresh dirty-snapshot（28605c53）独立写面。当前Gate仍FIX，修完集成后只做本R2约定的一次增量复审。

| 切片 | 责任/句柄 | 完整影响面 | 状态 |
|---|---|---|---|
| Authority | luban 3aa28cce | 旧/新声明完整影响、旧族移出/删除、edit/迁移/delete入口与最终租约 | accepted/已合；Leader另补跨path改族旧Family正交检查，先红后绿 |
| Residual | luban dd537581→19ab71d8 | 匹配/未匹配锚点与coverage分区；内层扫描缺证贯穿；PID多声称顺序无关 | accepted/已合；Leader补完整去重关联字段，冲突不丢事实 |
| Admission | luban 39495c8e | create/resume/manual publish关闭准入与在途lease、操作计入等待，禁止quiesced后起跑 | accepted/已合；Leader补共享shutdown内核与ref等待timer |
| 方向核对 | Advisor 008b32b8 | 完整不变量/入口/边界矩阵，避免再补点状反例，不实施 | 已采纳，见fix3-invariants.md |

R3目录批集成：主树check519+3007/build、原生123；纯feature typecheck/build、14文件343过4skip、原生34；原4反例在纯feature回放改为拒权/unknown/拒准入，无新row。最后timer-ref小修的全量确认遇F02 500ms实时时序夹具负载抖动，隔离11例过；保留失败日志，正用相同全量/断言/timeout仅串行文件确认，不改产品门禁。候选SHA256=f0e8da6aec7c132d9fdf8f1fac37cadb10a3481eebcb1204f1b28dcfca830aa6；待本R2唯一增量复审。

## 跨边界链路
1. 用户启动/API → BuildRunSpec → 专用agentDir → Leader RPC：冻结版本、白名单、模型；不兼容组合明确拒绝。
2. Leader task_submit/resume → 扩展守卫 → RPC任务创建事件 → ActorBinding → MCP桥接 → 成果写入：角色、代次、分配、幂等、OCC及续接撤销。
3. 独立审查 → 精确内容/依赖hash → 候选校验 → 原子发布：作者及续接链不可自审，失效审查不可发布。
4. 取消/崩溃 → 先撤凭据 → 关闭Leader与残留 → 成果级/会话级恢复：不伪造成功，不启动第二Leader。
5. RPC自触发轮次/工具事件 → 状态与侧栏：agent_end不等于成功，不展示虚构百分比或未知用量。
端到端责任为P3集成批，具体写面及接口待P0证据后冻结。

## 并行、隔离与专家Gate
- 实施切片按独立维护模块并行；预计长写任务采用dirty-snapshot worktree，完成后显式检查并集成diff。共享契约先冻结，冲突不得静默覆盖。
- 不改amagi-pi上游，不增加应用任务调度器。fuxi仅重大未决取舍调用；已有设计作为方向基线。
- 高风险整阶段集成验证后diting一次；Critical/Major或范围实变允许一次增量复审。

## 风险与回滚
- 外部运行版本/模型映射/MCP实际行为须实测；失败只报告能力不足，不fallback为单agent或legacy。
- 性能目标须三次同夹具真实模型对照，不以单测代替；无法取得合法夹具或运行环境则明确未覆盖。
- 新路径按冻结orchestrationMode分支，旧检查点保持legacy，不迁移解释新任务状态。
- 六源对照、平台沙箱等不能虚构结论；新模式门槛未过不得默认启用。

## 决策日志
- 2026-11-01：启动调查。需求明确，复用设计，无需另做需求澄清。正式计划：agent-outputs/execution-plan/20261101-012338-build-runtime-v2/execution-plan.md。
- 初始check：lint/typecheck通过；数据库测试因better-sqlite3 ABI125与Node ABI137不匹配失败，原输出 /tmp/feishu-build-v2-baseline/check.log。Leader直接处理：按CLAUDE执行server npm rebuild better-sqlite3（exit0）修复验证环境，未改源码。
- 修复ABI后主树check全通过：服务端165 passed/1 skipped，2492 passed/4 skipped，前端全部通过；原输出 /tmp/feishu-build-v2-baseline/check-node-abi.log。各worktree共享依赖不得重复rebuild。
- 实施采用五个独占写面dirty-snapshot worktree；接口提供者尽早发布契约，接线消费者按真实API适配，不各自重建同类基建。
- 主上追加要求：每完成一个大阶段提交Git；取代最初不提交约束。P0调查已accepted，初始全量check已通过，提交该阶段文档。原始用户diff不随该提交纳入。
- E首轮因守卫策略重复与真实amagi冻结契约探测不足被拒绝，续接918a4d13在同树收敛，首轮真实Pi事件管线证据保留。
- U首轮fixture浏览器验证通过，但拟定DTO未接真实后端，续接97e740f9在同树适配。
- I首轮虽假件/旧路径回归通过，但生产createBuild永久503、重复不兼容运行契约、未接权威actor store，已reject。新批c5936873扩大index与build-runtime-host接线写面，必须以R/T实际绝对路径源码为输入，补生产API成功链。
- R过程中发现npm:amagi-pi@2.21.31公共仓404，改为显式本地source物化+CLI安装固定包；不可静默引用开发仓。R还须真实pid/残留与重启恢复、完整包hash收敛。
- T受控写链需覆盖异步声明准备/锁排队后的代次/分配重检与同operationId并发，不以同步前置检查代替取消race验证。
- 基础R/T/E/U已按独占diff合入主树，未混入初始用户diff；Leader直接修复env信封为{tools,guard}、adapter实际注入守卫/精确MCP名单、包路径与hash对齐校验、无探测器时默认阻断双Leader。
- 合并专项：typecheck+12套件193次测试执行通过（含真实Pi+amagi冻结契约）；全量check通过：服务端2685passed/4skip；build:all通过。原日志 /tmp/feishu-build-v2-baseline/{merged-foundations-tests,foundations-check,foundations-build}.log。注意部分测试跨导入注册契约测试，次数不等于独立测试场景数。
- R包修正d2bb01b8已accepted并只回流两文件：完整hash、symlink/预算拒绝、正式CLI本地安装、并发/残留保护与复用篡改检出。真实临时CLI安装实测成功。
- 最新主树typecheck+13套件218次执行通过（日志foundations-refined-tests-3.log）；早期ENOTEMPTY诊断为退出/落盘竞争，已修真实close确认和有界测试目录清理。新增private属性closed曾与Claude子类冲突，typecheck诊断后改transportClosed并重验通过。
- 将R/E定义为独立运行基础里程碑，先行提交（不等未完成生产主链冒充完成）。从暂存区导出纯提交快照 /tmp/feishu-runtime-stage.mprpyf，仅含R/E、不含用户初始diff和T/U未提交修改：typecheck+9套件158次执行通过，日志staged-runtime-tests.log。扩展初始用户maxTokens改动仍未暂存，明确隔离。
- live probe首次selected派发因用户完成通知混入历史导致context-too-large（effects=none），改自足isolated契约成功派发b361ce73。
- P0提交：f54f190 docs: establish build runtime v2 execution baseline。来源软提示中research-report为已accepted的baize任务576f40ec产物，已只读核对commit stat，非异源。
- 运行基础里程碑提交：5f39dd8 feat: add isolated Pi build runtime and frozen dispatch guard；18个代码/测试文件+报告/活计划。仅R/E，T/U和初始用户diff保持未提交。异源软提示路径均为已验收R/E子任务产物，已只读核对commit stat。
- 真实probe run4：临时sentinel read/grep deny通过，但child有codemode（不是MCP auto-enable，而是amagi强制追加），不能标A03通过。详见runtime-decision-child-policy.md；Advisor C方案通过应用owned策略扩展保留原工具面意图，不改上游/不加派发器；新任务20d7aaeb执行，未验证前仍fail。
- probe前两轮fixture SSE index错误导致多工具JSON串接，不是生产底座证据；已定位。tool_execution_start在守卫前，只能观察原参数，冻结结果看v2-store/audit，不能误判守卫失效。MCP/续接分配仍待b361ce73诊断。
- 初始范围外8文件已逐一hash对比dirty-snapshot 43c35e71完全一致（模型限制/vision/ModelProviderSettings/AgentSettingsCard/MarkdownView及相关测试）；扩展原maxTokens 32768改动仍未提交。
- child-policy已合主树：真实完整probe35pass/0fail/11not-measured，旧codemode失败容忍已移除；原探针只测试工具名发现，不把旧报告‘可发现并调用’误读成已实际绕过业务授权。策略不声称卸载或OS沙箱，微任务声明面窗口由独立tool_call阻断兜底。
- 97376ec提交child-policy/Leader系统规则注入。c985790提交权威成果/主链/发布门禁/真实probe，初始用户共享文件通过feature-only三方暂存隔离；只有agent-tool-service的draft_read冲突手工在临时index文本消解，工作树用户声明读取增强未动。纯暂存快照typecheck+5套件74次执行及新读快照28例通过，不依赖原用户未提交改动。
- Leader直修draft_read坐标哈希从同一次已返回body计算，避免第二次读盘把新内容hash配给旧正文；已加单次读取回归，28例通过。
- 主树真实生产API POST→Pi/amagi作者/独立审查→工具桥→原校验→CURRENT published，显式资源3/3。首次全量有旧legacy恢复测试5s超时，隔离14/14通过后原口径全量2757pass/11skip（未放宽timeout/断言）；build:all通过。日志integration-full-check-recheck/integration-real-api-e2e。
- cfadc8ea已accepted：真实官方coding端点GLM5.3-flash，Leader材料工具→1×baize→MCP Alpha读取→后台完成通知收尾17pass/0fail，56秒；密钥仅环境/未泄漏/无残留。不是默认GLM5.3完整profile或六源性能证据。
- 1a62d7d1真实浏览器三次published发现终局DTO丢模式；Leader修SQLite orchestration_mode additive（legacy默认）、检查点mode、create/resume/toDto持久模式，无会话不得冒充同会话恢复；typecheck+3套件22过。186b9b58复验中。源码修复不触及原始KB/真实SQLite。
- 性能对照9e6825dc核实：原六源4/6冻结字节可得，2份sheet缺失且无批准夹具；不拿新导出/合成文档冒充同源。A23外部阻塞，不切默认legacy。
- 本轮统一修复三方合入；静场全量check519+2886、build及纯feature148通过。最新原生34例本体通过但afterAll ENOTEMPTY归因未闭合，独立审核已保留失败，不改timeout/不盲重跑遮盖。
- 0469e24a排除queued/not-started的放宽补丁被拒；它不能排除fork→锚点微窗口，Root保留strict unknown。实际普通同组孤儿、成员归属失效、缺终止记录重建是增量审核另证的3个F10 Major，不得以该保守边界豁免。
- 7fa31cae唯一full增量：9closed/5partial/1open，7Major（F03/F09/F10×3/F11/F12）+1Minor（F14）。真实递归grep泄漏合成禁区sentinel，普通同组孤儿假confirmed、注入误信号、v1草稿丢失均有隔离证据。审核产物已accept，产品Gate未通过；不启动下一修复/审核轮，不把修复候选作为完成版本提交。交接见incremental-review-report.md、fix-integration-report.md、metadata.json；初始用户12+2继续保留。
