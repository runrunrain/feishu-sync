# 构建运行时 v2 执行计划

## 基线
- 目标：按设计v2交付单Leader + amagi子任务的知识构建，统一成果约束与旧路径迁移隔离。
- 输入：/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/编排构建效率优化/重构/基于Agent基座与工作流插件的构建重构设计-v2.md 及相邻核查证据；项目CLAUDE与工作台两设计。
- 代码：main，aa13b34；已有12个修改文件与2个未跟踪文件必须保留。基线diff保存在 /tmp/feishu-build-v2-baseline/initial.patch。
- 非目标：修改amagi上游、增加应用调度器、改变内容后端或升级Electron、未经探测启用Claude原生、未经质量/恢复/性能门槛切默认。
- 总验收：设计§13能力与故障链验收；现有check/build通过；真实API入口与UI交互；完整设计追溯；独立审核无未解决Critical/Major。真实模型性能单独记录，未运行不宣称达标。

## Phase 0：证据与基线
| ID | 需求 | 切片/Agent | 输入与依赖 | 输出 | 验收 | 隔离 |
|---|---|---|---|---|---|---|
| A | §1–15 | 代码/设计差距与验收矩阵 / baize | 设计+源码+初始diff | workflow/build-runtime-v2/research-report.md | 可定位维护模块、风险、测试可行性 | 只读主树 |
| B | 回归基线 | Leader直接处理：保存未提交diff并运行初始check，便于定位新增失败 | 初始主树 | /tmp/feishu-build-v2-baseline/ | 原始命令结果 | 主树只读验证 |

## Phase 1：并行完整切片
各任务负责调查、实现、相关自测、公开接口与报告，不各自重复跑全量。接口先公开给集成者；真正接线依赖接口稳定，不把独立调查/实现串行化。

| ID | 需求 | 切片/Agent | 依赖与输入 | 输出与写边界 | 验收 | 隔离 |
|---|---|---|---|---|---|---|
| R | §3、8、9、13.1 | 运行时隔离/包冻结/配置/probe/RPC / luban | 设计+实际Pi/amagi源码 | agent/build-runtime/**、pi-rpc-process.ts、build-runtime-*相关新tests；runtime-report.md | 配置匹配真实解析器；密钥不落盘；白名单/自触发/10s取消测试；探测诚实区分未测 | build-v2-runtime dirty-snapshot |
| T | §4、7、8、9 | 身份/分配/回执/审查/知识工具/MCP / luban | 设计+现有受控工具链 | agent-tool-service.ts、tool-specs.ts、agent-internal.ts、claude-bridge.cjs、path-claims.ts、build-actors.ts及独立tests；tools-report.md | pending只读/角色与代次/分配转移/幂等与OCC/独立审查/局部编辑/批量读取 | build-v2-tools dirty-snapshot |
| I | §5、6、8、9、11、13 | 构建主链/监督/恢复/发布/skill打包 / luban | R/T公开接口；可先调查并开发主链 | kb-build-service.ts、build-checkpoint.ts、build-leader-supervisor.ts、服务端agent-knowledge.ts、config-manager.ts、kb路由、skills与build-agent-assets.mjs、独立tests；integration-report.md | 新模式一个Leader无应用调度；事件确认身份；首agent_end不结束；精确候选发布；取消/恢复保护；旧模式不变 | build-v2-integration dirty-snapshot |
| E | §3.4、3.5、13.1 | 转发扩展工具收窄/守卫接线 / luban | R守卫接口，I环境约定；可先核实Pi事件API | feishu-sync-agent.js与新extension测试；extension-report.md | tool_call真实改参入执行；构建Leader无正文/内置/通用外部工具；普通会话不变 | build-v2-extension dirty-snapshot |
| U | §8、11、12 | 配置/侧栏运行观测 / luoshen | I配置DTO；可先做独立UI | 前端types/api、BuildOrchestrationSettings、BuildOrchestrationProgress、KbBuildPanel及tests；ui-report.md | 当前计划/真实排队/未知用量/恢复级别；保留阅读区；agent-browser真实交互 | build-v2-ui dirty-snapshot |

## Phase 2：集成与真实入口验收
- Leader按每树初始快照后的独占diff检查并集成，不提交，不覆盖用户改动。
- 全量check/build统一执行，原生ABI失败先诊断，非盲目重建。
- 基于临时数据从构建API启动，覆盖事件→身份→分配→桥接写入→独立审查→精确候选→发布，以及取消/恢复/迟到/幂等/转移/发布并发。
- 能力实测使用临时FEISHU_SYNC_HOME；缺少已授权真实模型或对照夹具如实标注，不读取/外传生产资料凑样本。
- Claude原生未通过同契约测试前保持拒绝启用。

## Phase 3：风险Gate与收口
- diting独立full审核整体实现与设计矩阵，只读报告。
- 少量明确问题Leader直修；跨职责问题合成一次修复批；Critical/Major或范围实变允许一次增量复审。
- 核对每项met/partial/missed；存在可补救项持续执行，真实外部阻塞诚实记录，不虚报完成。

## 跨边界链路与责任
| 链路 | 身份/状态 | 失败与端到端责任 |
|---|---|---|
| API→冻结spec→专用home→RPC Leader | buildId/generation/package+skill hash | probe失败拒绝；I+R，Phase2真实入口 |
| task_submit/resume→guard→任务事件→Actor→MCP | nativeTaskId/role/parent/scope | 未确认只读、越权拒绝、旧ID撤销；E+T+I |
| 写入→幂等/OCC→审查→申请发布 | operationId/revision/dependency hashes | 取消/换代拒写、自审拒绝、版本变化失效；T+I |
| 发布→原校验编译→release/CURRENT | 锁定candidate revision | 失败保留候选不动指针；I |
| 取消/恢复→撤token→进程终止/对账 | generation/runtime binding/checkpoint | 残留未确认不启动双Leader、UI显示终止中；R+I+U |
| 自触发RPC→监督→侧栏 | 原生任务三轴≠应用成果状态 | agent_end不宣称成功；I+U |

## 专家预算
已有v2为方向基线，不默认另开fuxi设计。重大未决取舍可咨询；整阶段高风险Gate diting一次，必要增量一次。

## 风险与回滚
- 依赖实际Pi/amagi配置与事件格式：源码核对+真实probe，版本冻结。
- 文件围栏不是OS沙箱：不授shell、只报告写面、配置/凭据/原始标准库禁区。
- 新旧协议不得互解：缺字段旧checkpoint按legacy，新模式失败保留候选、显式成果级恢复。
- 模型用量/性能不可造数：真实对照数据与mock运行分开记录。
- worktree diff可撤；不得自行git commit或破坏初始用户diff。

## 需求追溯
| 设计章节 | 任务 | 验收证据 |
|---|---|---|
| 1–2 职责与范围 | A/R/T/I/E | 调查+集成矩阵 |
| 3.1–3.3 隔离/模型/MCP | R/T | 配置与桥接测试、probe |
| 3.4–3.6 守卫/角色/配额 | R/E/I | 实际冻结scope、进程与池观测 |
| 4 身份成果权限 | T/I | pending/续接/分配/审查/幂等测试 |
| 5 流程发布 | I/T | 构建API端到端 |
| 6 skill | I | 打包与提示注入检查 |
| 7 工具减负 | T | 局部编辑/批量读取测试 |
| 8 契约持久化 | R/T/I/U | checkpoint与DTO契约 |
| 9 取消恢复 | R/T/I/U | 故障链测试与实际进程验证 |
| 10 Claude路径 | R/I/U | 未验证拒绝启用 |
| 11 维护接入 | 全部 | 独占diff审核 |
| 12 进度性能 | R/I/U | UI与运行指标，unknown诚实 |
| 13 验证迁移 | 全部 | 总验收矩阵、真实对照独立证据 |
| 14–15 风险基线 | A/Gate | 审核报告 |
