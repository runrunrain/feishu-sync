# 知识库检索与 MCP 成品交付工作流

- task_tier: complex; execution_mode: agent_team; autonomy: unattended
- 当前终态：本机实现/交付已验收，外部真实质量与实机门槛 partial（见 acceptance-report.md）；历史记录中的 pending/FAIL 以最新续接及下方收口为准。
- 基线：`/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`（v1.1，完整 §§0–13 + 附录）
- 仓库起点：main `41d6aca`。已有未跟踪文件 `agent-outputs/workflow/2026-10-27-kb-agent-upgrade/session-friction-review-2026-10-28.md` 保持不动、不提交。
- 用户授权：按推荐决策，无人值守；每个大阶段验收后自动 git commit，不 push。
- 总验收：共用 lex-v1 查询服务、可验证内存索引、7 个有界只读 MCP 工具、应用内工具/API 对齐、默认关闭的隔离内网网关及桌面管理 UI、构建产物和可重复测试/评测/使用文档。P4/X/P5b 按设计门控，不为“全部实现”擅自开启明确不做的方向。

## 阶段与节点

| Phase | 节点 / 完整切片 / Agent | 依赖 | 输出 | 验收 | 审核 | 状态 |
|---|---|---|---|---|---|---|
| A 基线与缺陷修复 | A0 接入/数据证据调查 baize；A1 P0 多词与 raw_search 排序 luban；A2 E0 评测工具与合成 fixture luban | 设计 | investigation.md、p0-report.md、eval-report.md、stage-a-acceptance.md | 64项通过，产品L1合成Q2 Recall 0→1；真实80条缺失不冒充 | Leader | committed 8fba395 |
| B 共用查询能力 | B1 P1 引擎 luban；B2 E0 lex适配/P2七工具/P3内置接入与集成 Leader | A | engine-report.md、stage-b-evidence.md、stage-b-fixes.md、stage-b-review.md | 157项初验+49项修复相关；10/30MiB预算达标；F1/F2修复终审PASS；真实80条仍缺 | diting full首审+一次终审 | committed 060c02f |
| C 内网共享成品 | C3 P5 网关/管理面 luban；C4 P5 设置UI luoshen（原C1/C2已随B合入） | B；冻结管理API+共用注册 | gateway-report.md、ui-report.md与集成证据 | 机制/正式API/容量/真实Electron通过；两真机缺陷关闭，CIDR误报撤回 | 初审02908e87 + 唯一增量d5338094 PASS | committed c2aca8d；修复随D最终提交 |
| D 交付验证 | D1 全量check/build、真实客户端与独立staging打包、门控与成品 Leader/执行者 | C | acceptance-report.md、package-report.md、客户端报告、最终产物与提交记录 | 最终427+1981通过/8skip；新版Electron与介质通过；外部门槛按partial披露 | d5338094 PASS，无finding | accepted；本文件同批最终提交 |

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
- 2026-10-29：真实browser临时主应用已运行：/tmp/feishu-kb-live.MH6HuA/runtime.json；Node API62492/Vite5173/仅回环gateway62493，临时资料无生产正文。C4真实启停/轮换/审计/端口故障已验证，最终已停用并作废token，Node/Vite保留供复核；Leader自己的browser已关闭。Electron留成品runtime验证，不改共享ABI。
- 2026-10-29：C3生产默认看门狗真实恢复13029.46ms≤15s、10/30MiB单/3×4压测通过；indexBuildMs只在原缓存build回调观察，无另一套索引。最终增量仅gateway entry/audit/2测试，已回流；报告最新段覆盖早期blocked历史。
- 2026-10-29：首次全量发现2项旧测试根因（macOS /etc symlink、Pi测试误用Claude默认），3fac3164只修测试32项通过。随后test:all全量前端65文件423项、server136文件1977项通过/8skip（bg-24eac70a）。另一次check被正在编写的client-smoke artifact prefer-const阻断，已交原作者修正，最终还需一次统一check。
- 2026-10-29：真实pi/Claude CLI驱动发现Claude三工具顶层oneOf被跳过、pi direct8k中文按字节截中段；Leader修复schema兼容（互斥仍强校验）、pi会话≤6000字符页预算，26项相关回归通过，7098e081继续真实CLI复测，非真实LLM质量测试。
- 2026-10-29：C4实接发现回环.local推荐及故障地址误导，card+test两文件增量已合并；17项定向测试通过，最终视觉/Electron补验待候选。应用内kb_grep改literal-only，regex只留独立MCP进程，纳入C安全审核02908e87。
- 2026-10-29：独立staging候选打包7f8020f1已完成，app/dmg/zip已生成；codesign通过、包内ABI125 SQLite与stdio/HTTP MCP真调用通过，主树ABI137及native hash不变。staging /Users/run.mao/feishu-sync-candidate.1cQjnvcc；默认ad-hoc Mac arm64，无上传/公证。selected打包首派因交接过大零效果失败，改为独立isolated任务成功。
- 2026-10-29：C full代码审核02908e87 PASS；真实pi/Claude修复后复测7098e081已完成（pi≤6k逐页无截断/Claude七工具和15-40k正文实测）。C代码与文档Gate将提交，完整Electron仍由D验收，不把code PASS称发布批准。
- 2026-10-29：新增真实Discuss/Pi进程→转发扩展→内部HTTP→section/literal grep会话集成通过（eced9633，仅合成推理fixture）。最终统一npm run check退出0：前端424通过，server1979通过/8skip，lint0error/3既有warning，日志bg-dbfe5e82。
- 2026-10-29：完整打包Electron GUI补验已续接b7a9eab9（独立用户数据与回环网关，不触真实用户实例/共享ABI），尚未签发GUI通过；候选最后hash/DMG介质检查待源冻结后补齐。
- 2026-10-29：包最终复核03a528f4通过：475源文件与c2aca8d一致、app/DMG/ZIP清单及codesign一致、DMG只读挂载后已卸载、主树ABI不变。但b7a9eab9真实Electron发现三项缺陷（复制被权限拒绝、CIDR清空现象（worker真实ConfigManager反证nested merge假设，包请求链复核中）、legacy server启动options泄露desktop token），当前候选明确不放行；临时泄露令牌随app退出失效，日志已脱敏0600，未涉及真实用户token。d16d475b合并修根因，随后重包/真机复验/一次安全增量审，不用原PASS覆盖新证据。
- 2026-10-29：c1ea3374精确捕获旧候选PUT→200/busy→磁盘→GET，证明CIDR清空原本成功；初测fill空串未触发React、按钮disabled且无新请求，误读旧toast。撤回该产品FAIL及manager防御改动，仅保留回归测试。两真实缺陷由受限write-only clipboard IPC/共用helper与日志白名单修复；ea948f1a定向51+19项/tsc/build通过。主树最终npm run check && build:all && electron:build bg-a85e675f退出0，前端427、server1981通过/8skip；新包181dc28f正在重打及补standalone:3001。

## 最终收口

- 181dc28f重包/7ad957c3补验：481条生产源digest `885c1582db06618660e9d1e092d34b8931579366c470b3e4efe861e548b91f3b`，包/构建对应、签名、ABI125/137、DMG挂载/ZIP完整清单、MCP真实SDK通过。正式standalone入口以FEISHU_SYNC_PORT显式49614通过；默认3001 foreign watcher未触碰，NODE_ENV=test跳过自动安装，边界不隐藏。
- c00dda65最终真实Electron PASS：四复制系统剪贴板私有回验、配置不含实际token、浏览器权限仍拒且无read桥、实际两token日志未检出、blur/CIDR/作废/正常退出通过。Leader抽看最终运行/停用截图，令牌均掩码；截图保留本机screenshots/（按仓库策略不入Git）。
- d5338094唯一增量安全终审PASS、无finding，已accept；本机交付门关闭。真实80条/12问人工/异机/睡眠24h/Windows/默认3001/公证等仍按acceptance-report列partial，P4/X/P5b未越门控。
- 回收本任务Node/Vite与全部QA实例；六个owned worktree先留tracked patch/非链接未跟踪文件至 `.amagi-reports/worktree-archives-kb-retrieval-20261029/` 再移除。三棵既有他人worktree保持不动，用户原未跟踪复盘文件SHA-256前后相等；临时amagi.json已移除、未入提交。独立打包staging/旧候选归档保留供复核，无push/上传/公证。
