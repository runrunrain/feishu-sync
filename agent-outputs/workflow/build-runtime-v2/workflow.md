# 构建运行时 v2 重构 workflow

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
| P1-I | 主链/监督/恢复/发布/skill打包 | luban | R/T公开接口；独立部分先行 | integration-report.md+代码 | 单Leader无应用调度、故障链/旧路径测试 | 首轮c7e99841 rejected（仅假端口）；生产接线续批 c5936873 running，同树 build-v2-integration |
| P1-E | 扩展白名单与派发守卫接线 | luban | R守卫接口+I环境契约 | extension-report.md+代码 | 实际改参进入冻结scope，普通会话不变 | 首轮08679499 rejected；918a4d13 accepted，已合主树 |
| P2-U | 配置/UI/进度与真实浏览器验证 | luoshen | I配置/DTO；独立布局先行 | ui-report.md+交互证据 | agent-browser实际交互，临时数据 | 首轮6c986837 rejected（拟定DTO）；97e740f9 accepted，已合主树，待实际运行增量复验 |
| P3-L | 真实Pi+amagi子任务/MCP能力探测脚本与证据 | luban | 已合入基础模块；主链无依赖部分先测 | live-probe-report.md+probe脚本 | 真实child身份/禁读/工具授权/通知/取消/恢复，fixture模型诚实标注 | running b361ce73，worktree build-v2-live-probe |
| P3 | 集成回归、真实运行能力探测与设计对照 | Leader/执行Agent | P1/P2 | 验证报告、验收矩阵 | check/build、身份取消恢复发布链 | 基础合并check+build已过，完整主链待补 |
| Gate | 高风险整体独立审核与修复 | diting | P3 | review-report.md | 无未解决Critical/Major | pending |

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
