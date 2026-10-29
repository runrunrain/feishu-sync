# 知识库检索与 MCP 成品交付工作流

- task_tier: complex; execution_mode: agent_team; autonomy: unattended
- 基线：`/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`（v1.1，完整 §§0–13 + 附录）
- 仓库起点：main `41d6aca`。已有未跟踪文件 `agent-outputs/workflow/2026-10-27-kb-agent-upgrade/session-friction-review-2026-10-28.md` 保持不动、不提交。
- 用户授权：按推荐决策，无人值守；每个大阶段验收后自动 git commit，不 push。
- 总验收：共用 lex-v1 查询服务、可验证内存索引、7 个有界只读 MCP 工具、应用内工具/API 对齐、默认关闭的隔离内网网关及桌面管理 UI、构建产物和可重复测试/评测/使用文档。P4/X/P5b 按设计门控，不为“全部实现”擅自开启明确不做的方向。

## 阶段与节点

| Phase | 节点 / 完整切片 / Agent | 依赖 | 输出 | 验收 | 审核 | 状态 |
|---|---|---|---|---|---|---|
| A 基线与缺陷修复 | A0 接入/数据证据调查 baize；A1 P0 多词与 raw_search 排序 luban；A2 E0 评测工具与合成 fixture luban | 设计 | investigation.md、p0-report.md、eval-report.md、stage-a-acceptance.md | 64项通过，产品L1合成Q2 Recall 0→1；真实80条缺失不冒充 | Leader | committed 8fba395 |
| B 共用查询能力 | B1 P1 引擎 luban；B2 E0 lex适配/P2七工具/P3内置接入与集成 Leader | A | engine-report.md、stage-b-evidence.md、stage-b-fixes.md、stage-b-review.md | 157项初验+49项修复相关；10/30MiB预算达标；F1/F2修复终审PASS；真实80条仍缺 | diting full首审+一次终审 | accepted; committing |
| C 内网共享成品 | C3 P5 网关/管理面 luban；C4 P5 设置UI luoshen（原C1/C2已随B合入） | B；冻结管理API+共用注册 | gateway-report.md、ui-report.md与集成证据 | 65项机制+正式Node20/24网关与管理API链已通过；补10/30MiB容量/真实UI、最终diting | diting full，合并阶段diff一次 | integrated; C3 d6a19feb补bench/恢复；C4 56df927c真实browser |
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
- 2026-10-29：A集成提交8fba395，E0的L1现调用产品显式命名入口；64项通过、真实CLI重跑。C1默认派发02090083再次模型未注册，未换模型；Leader承担P2/P3与E0 lex接线。B合并为共用查询完整阶段（P1/P2/P3），P5为C，避免提交不可构建的跨接口中间态。
- 2026-10-29：B初验157项，合成10/30MiB预算达标。独立首审F1 Major分页适配断路/F2 Minor含#路径回归；Leader最小修复，49项相关验证通过，终审d0d6eb69 PASS，任务均已accept，真实80条门槛仍缺。
- 2026-10-29：C正式管理API→子进程→7工具、三端一致、双session notice、轮换/停用、Node20 HTTP bundle真实测试通过。配置保存后refresh的兼容回归已修。C3/C4原始报告仍记录阻塞/mock历史，最新进展需看续接附录。
- 2026-10-29：主上修复openai-codex新模型目录注册并重启，默认gpt-6.1-terra:xhigh续接已成功：C3 d6a19feb（父96969048），C4 56df927c（父0547ff9f），无模型覆盖。C3写隔离gateway树，C4写隔离UI树，不覆盖Leader主树集成。
- 2026-10-29：真实browser临时主应用已运行：/tmp/feishu-kb-live.MH6HuA/runtime.json；Node API62492/Vite5173/仅回环gateway62493，临时资料无生产正文；C4独立session验收后保持服务供后续使用，最终由Leader回收。Electron留成品runtime验证，不并发改共享ABI。
