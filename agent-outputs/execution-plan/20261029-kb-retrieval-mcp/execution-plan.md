# 执行计划：标准知识库检索与 MCP

## 基线与完成定义

- 上游：`/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`，v1.1。
- 活计划：`agent-outputs/workflow/20261029-kb-retrieval-mcp/workflow.md`（阶段状态与决策权威）。
- 无人值守，阶段自动提交，不push；保护原有未跟踪文档。
- 完成定义：本机可运行成品、可重复测试、可配置独立内网只读共享；外部/人工验收限制必须逐条披露。

| ID | 设计需求 | 完整切片 / 执行 | 依赖与契约 | 必需产物 | 验收与隔离 |
|---|---|---|---|---|---|
| A0 | §2/§10/§13.1 | 工程/真实评测前提调查 baize | 原设计+现代码，只读 | investigation.md | 文件定位、真实与合成分离、安装/外部设备条件；主树报告唯一写面 |
| A1 | P0 F1/F2 | 多词与raw排序 luban | L1保留可比L0；不改评测脚本 | p0-report.md + 代码 | 多词/引号/ID/排序/旧MCP回归；主树小范围 |
| A2 | E0 §10 | 可复用评测CLI、fixture、基线 luban | L0/L1先行，lex-v1后接 | eval-report.md + script/fixture/docs | 指标算法/报告、确定性10/30MB模式；worktree |
| B1 | P1 §§5–6/§8 | 纯检索引擎、hash索引/cache、服务与三端search接入 luban | 消费A1/A2；统一服务是后续唯一数据入口 | engine-report.md + 代码/测试 | 解析/回退/outline/BM25F/snippet/grep/hash/cache/围栏；分片让出；Node20无原生bundle；worktree |
| B2 | P1 §6.5/§10.3 | 评测接线/规模与三端一致集成 Leader或resume A2 | B1公共接口 | 基准报告 | 合成10/30MB时间/内存，真实指标不造；阶段diting full后提交 |
| C1 | P2 §7/§8 | 共用七工具注册+stdio v2 luban | B1门面；registerKbTools(server,queryService,sessionState)供网关复用 | mcp-v2-report.md | schemas/预算/分页/游标/切版/正文围栏/错误/instructions；SDK真实传输；worktree |
| C2 | P3 §9 | 内置kb_search/kb_read/kb_grep及API luban | B1服务，工具能力白名单齐全 | builtin-report.md | Discuss/Work/build服务端准入、section分页、三端一致；worktree/有限文件 |
| C3 | P5 §13 | 独立网关、token/network/manager/config/API/构建 luban | B1服务 + C1工具注册契约 | gateway-report.md | A1–A3/A7/A8：私网/socket/Origin/令牌/actor隔离、会话/并发、心跳/重启、产物；worktree |
| C4 | P5 §13.8.3 | 完整设置卡片与API客户端 luoshen | C3管理API表按原设计冻结；不改后端 | ui-report.md + screenshot | 实际Electron/浏览器启停、异常、令牌与配置复制、审计/排障；worktree |
| D1 | §10.4/§13.10 | 合并后全量回归/成品与验收文档 Leader | B/C已验收，阶段审核 | acceptance-report.md + 成品 + commit记录 | npm run check/build:all/electron:build，实际客户端/运行形态/网络检查；所有未具备条件单列 |

## 专家与风险

用户设计已足够指导实现，fuxi不重复设计。B（围栏/公共查询接口）与C（凭据/网络/权限/生命周期）分别一次合并diting full，Critical/Major修复只增量终审一次。相互独立切片同批并行；真实数据/接口依赖串行，不按固定角色流水线拆解。

## 门控与回滚

P4仅真实Q5低于设计门槛才启动，X仅真实性能/规模/负载触发，P5b仅不可信网络且无覆盖网络或合规要求触发。未触发不是遗漏。阶段A/B/C各独立commit，可revert；P0–P3/P5发布格式不变。网关运行回滚首先停用监听，令牌不入config/git/子进程argv，不更改系统防火墙，不启用真实内网共享作为测试副作用。
