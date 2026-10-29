# 知识库检索与 MCP 成品交付工作流

- task_tier: complex; execution_mode: agent_team; autonomy: unattended
- 基线：`/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`（v1.1，完整 §§0–13 + 附录）
- 仓库起点：main `41d6aca`。已有未跟踪文件 `agent-outputs/workflow/2026-10-27-kb-agent-upgrade/session-friction-review-2026-10-28.md` 保持不动、不提交。
- 用户授权：按推荐决策，无人值守；每个大阶段验收后自动 git commit，不 push。
- 总验收：共用 lex-v1 查询服务、可验证内存索引、7 个有界只读 MCP 工具、应用内工具/API 对齐、默认关闭的隔离内网网关及桌面管理 UI、构建产物和可重复测试/评测/使用文档。P4/X/P5b 按设计门控，不为“全部实现”擅自开启明确不做的方向。

## 阶段与节点

| Phase | 节点 / 完整切片 / Agent | 依赖 | 输出 | 验收 | 审核 | 状态 |
|---|---|---|---|---|---|---|
| A 基线与缺陷修复 | A0 接入/数据证据调查 baize；A1 P0 多词与 raw_search 排序 luban；A2 E0 评测工具与合成 fixture luban | 设计 | investigation.md、p0-report.md、eval-report.md、stage-a-acceptance.md | 64项通过，产品L1合成Q2 Recall 0→1；真实80条缺失不冒充 | Leader | accepted; committing |
| B 共用检索引擎 | B1 P1 kb/search + Store/API/MCP search 接线 luban；B2 基准与集成 Leader | A 完成后才切换；隔离开发可提前 | engine-report.md；纯函数/索引/cache/service | 算法、hash/围栏、分页基础、三端一致、10/30MB预算、无原生bundle/Node20 | diting full | isolated implementation running |
| C 完整成品 | C1 P2 七工具 stdio 与文档 luban；C2 P3 内置工具/API luban；C3 P5 网关/管理面 luban；C4 P5 设置UI luoshen | B；C3/C4基于设计冻结API先做隔离开发，最终依赖真实引擎/注册 | 各节点报告与代码 | MCP真实传输、鉴权矩阵、重启/心跳、UI真实交互、两种启动形态 | diting full，合并阶段diff一次 | C3/C4 prep running; C1/C2 pending |
| D 交付验证 | D1 全量check/build、客户端/性能抽检、门控判定、文档与成品 Leader/执行者 | C | acceptance-report.md、最终产物、提交记录 | 逐条设计追溯 met/partial/missed；未具备外部设备/人工标注条件如实披露 | 按新增风险决定 | pending |

每阶段验收后更新本文件并提交该阶段全部本任务变更；仅显式列出的文件进入提交。

## 跨边界链路与责任

| 链路 | 关键不变量 | 失败路径 | 端到端责任 / 真实入口 |
|---|---|---|---|
| CURRENT → Store → KbQueryService → UI/内置工具/stdio/网关 | 每调用单release、hash校验、同ranker、行号/anchor同坐标 | 缺release/篡改/清理/版本切换 | B1 + Leader；API 与 MCP SDK tools/call比较 |
| 桌面设置 → desktop域管理API → config/token → manager → 子进程 /mcp | 默认关、三令牌隔离、主监听保持回环、仅摘要给子进程 | actor绕过、绑定失败、轮换/退出旧进程未收口 | C3 + C4；真实UI启停与MCP调用 |
| MCP session → shared tool registry → shared service → budget/cursor/notice | 游标绑定参数与版本、会话独立notice、输出有界 | 并发切版、旧游标/旧会话、regex卡死 | C1 + C3；SDK多客户端与watchdog回归 |

## 并行与隔离

A1 在主树限界小改；A2 在独立 worktree（只改脚本/fixtures）。B1 长任务用 worktree。C1/C2/C3/C4 无共享写入时并发，有共享模块的集成由 Leader 合并或明确所有权；长写任务优先 worktree。代码不读写真实 FEISHU_SYNC_HOME，不触发真实源库同步/发布。

## 方向与风险 Gate

沿用用户提供设计，无须再次设计。B（文件围栏/完整性/公共接口）、C（网络/凭据/权限/生命周期）分别集成验证后 diting full；发现少量明确问题 Leader直修，多项合并一次回派，Critical/Major允许一次增量复审（终轮）。

## 评测与门控

- 设计§10.3先验阈值暂保留；合成正确性/规模基准不替代真实检索质量。
- 真实80条需来自真实用户/日志/阅读标注，禁止LLM生成充数，真实数据不入git。调查是否存在可用发布与历史查询，只记录脱敏统计和路径，不复制生产正文进仓库。
- P4需真实Q5门控；X需真实规模/延迟/负载门控；P5b需新网络安全约束。未触发则明确不实施并附依据。
- 第二设备、24h运行、睡眠、人工答案标注等外部验证不能用单测冒充；尽力实测，缺口单列。

## 决策与修订

- 2026-10-29：本机默认 `~/.feishu-sync/standard-kb/CURRENT.json` 不存在；先落E0工具和合成fixture，同时调查现有可用发布路径。
- 2026-10-29：Leader直接处理：编排、集成、有限修复与阶段提交；业务重实现分派。
- 2026-10-29：全局luban/luoshen模型gpt-6.1-terra未注册，首派spawn前零效果失败；初期曾临时覆盖为gpt-6.1-sol恢复。主上随后明确要求后续派发用配置默认模型，已立即从主树与全部worktree删除角色覆盖；运行中任务不打断，后续派发/resume均不指定模型/profile。默认不可用时不擅换模型。临时amagi.json仅剩测试超时，不入阶段提交，收尾移除。
- 2026-10-29：并行提前启动B1隔离开发与C3/C4无真实依赖部分，不提前切换排序器；E0基线先于P1集成。冻结网关最小契约new KbQueryService(root:string)，registerKbTools(server:Server,service,state:{lastServedCurrent?:string}):void；细节以B1产物供C1适配。
- 2026-10-29：A集成完成，E0的L1现调用产品显式命名入口；64项通过、真实CLI重跑。C1默认派发02090083再次模型未注册，未换模型；Leader将承担暂不可派发的必要集成实现。
