# Workflow：知识标准库组织 + 多模型构建编排 开发实现

**目标：** 按两份已交付设计文档实现 feishu-sync 标准知识库的知识组织体系与多角色构建编排：
- A 案 = `Database/01-AI技术与工具/07-工具与框架/飞书同步工具/知识库组织优化/知识标准库组织方案.md`（知识对象/主定义/状态/证据/关系/门禁/检索）
- B 案 = `Database/01-AI技术与工具/07-工具与框架/飞书同步工具/构建编排优化/多模型构建编排方案（讨论稿）.md`（撰写-审查-修订-整合-发布角色流水 + N 路配额 + 审查契约）

**总验收（用户可观察）：**
1. `cd server && npm test` 全绿 + `npm run typecheck` 通过（根 + server）。
2. 构建流程支持角色化：撰写→单元审查→定向修订（≤2 轮）→整合→最终复核→自动发布；审查报告绑定草稿哈希，旧报告不能批准新稿。
3. N 路构建配额独立于 maxConcurrentProcesses 总上限；交互/非构建保底名额额外计算。
4. kb_write_doc 支持知识对象/呈现/关系/证据声明；发布产物含 knowledge.json sidecar；manifest schemaVersion=2 与 v1 双读兼容。
5. 检索支持对象级结果、业务/审查状态过滤（operational/browse/compare）；MCP 工具同步扩展。
6. 隔离样本端到端构建测试（mock 模型）通过：写→审→修订→整合→发布全链路。

**自治级别：** unattended（跑完再说；歧义取最安全最小解释并记录）。

## 决策记录

- D1 主上指令「根据两份设计文档进行开发实现」= 批准两案实施。A 案 §10.1 建议先做组织样例（业务验证），主上直接批准开发——跳过样例先行，但隔离验证切片保留为 T4 验收内容。
- D2 两案叠加策略：B 案（编排骨架）与 A 案（知识契约）共享 T1 契约层；A 案 §7.2 明示「单模型串行也可实施，不依赖多模型编排」，故 T2（编排）与 T3（知识协议）解耦并行。
- D3 范围裁剪（本会话）：后端全量（T1–T4）；前端 UI（T5）做构建配置+进度+状态标签的核心面；飞书分发适配（A 案 §7.5 锚点降级）与可选历史摘要列为 T4 内尽力项。
- D4 旧构建兼容：正在运行的旧检查点按旧规则恢复；新流程仅新构建启用（B 案 §8）。
- D5 所有新 SQLite 列/表双登记（additive 数组 + getCreateTablesDDL）；SQLite 只存摘要，组织真相在 release knowledge.json。

## Phase 表

| Phase | 任务 | Agent | 依赖 | 输入 artifact | 输出 artifact | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| P1 | T1 契约与存储基础 | luban | — | A 案全文、B 案全文 | knowledge-schema.ts、orchestration-contracts.ts、types/config 扩展、迁移、单测 | schema 校验器测试绿；typecheck 过 | ✅ 2026-11-01（57/57，复验一致；补 3 错误码：kb_migration_invalid/kb_include_invalid/kb_coverage_invalid） |
| P2 | T2a 编排骨架：任务状态机+配额+检查点 | luban | T1 | T1 产物 | kb-build-service 调度层、agent-process-pool 配额语义、checkpoint 扩展 | 配额单测 + typecheck | ✅ 2026-11-01（177/177+worktree 228/228；集成验证全量 2245 过；kb-build-parallel 2 用例按 R3 新语义更新） |
| P2 | T3 知识协议：工具+提示词+证据读取 | luban | T1 | T1 产物 | tool-specs/agent-tool-service 扩展、kb_submit_plan/kb_get_plan、prompts、evidence-locator、raw_read 回执 | 工具层单测 + typecheck | ✅ 2026-11-01（44/44+回归 349 项；审查者 phase 只读门禁） |
| P3 | T2b 编排流水：审查闭环+整合复核+发布条件 | luban | T2a | T2a/T3 产物 | 角色流水执行、审查报告处理、修订预算、自动发布 | mock 构建 e2e 单测 | ✅ 2026-11-01（12 用例；全量 2259；新流水门=reviewPipelineActive） |
| P3 | T4a 编译与发布：compiler+validator+sidecar+双 schema reader | luban | T3 | T3 产物 | knowledge-compiler、knowledge-validator、发布布局、release-reader v1/v2 | 发布门禁单测 | ✅ 2026-11-01（23 用例；门禁 blocking→CURRENT 不动；v1 旧路径零回归） |
| P4 | T4b 检索与消费端：query/MCP/routes | luban | T2b,T4a | T4a 产物 | kb-query-service 对象查询/状态过滤/关系预算、kb-mcp-tools、routes | 检索单测 | ✅ 2026-11-01（18 用例；后端全量 2301） |
| P4 | T5 前端：构建配置+进度+状态标签 | luban | T4b | API 契约 | src/ 构建配置面板、进度视图、状态标签 | 浏览器/Electron 真机验证 | ✅ 2026-11-01（T5a 16+T5b 9 用例；真机：设置面板渲染/交互/落库（concurrency=4+confirm）/刷新回显/进度侧栏空态全过；前端全量 482） |
| P5 | T7 终审修复批（F01–F08） | luban | T6 | diting 报告 | 接缝修复 + knowledge-seam 同一数据流闭环测试 | 全量绿 + seam 测试 | ✅ 2026-11-01（6/8 关闭；F04/F05 部分） |
| P5 | T6 集成验证+diting 终审 | diting | 全部 | 阶段 diff | 审核报告 | findings 回流修复；`npm run check` 全绿 | ✅ 2026-11-01（VERDICT FIX：6 Major + 2 Minor，全部有复现证据） |
| P5 | T8 二轮修复（F05-R/N01）+ 增量复审 | luban+diting | T7 | 复审报告 | 冻结完整参数+旧检查点兼容 | 复现基线反转 | ✅ 2026-11-01（增量复审：6 RESOLVED + 2 部分→T8 修复；Leader 独立复验谓词反转/全量 check EXIT=0） |

## 总验收矩阵（2026-11-01 终态）

| 总验收项 | 结果 | 证据 |
|---|---|---|
| ① `npm run check` 全绿 | ✅ met | lint 0 error + typecheck 三段 + 前端 482 + server 2327（收尾复跑 EXIT=0） |
| ② 角色化构建流水（写→审→修订≤2轮→整合→终审→发布；报告绑定草稿哈希） | ✅ met | build-pipeline 12 用例 + seam 闭环；kb_review_pending 阻断；旧报告不批新稿 |
| ③ N 路配额独立 + 交互/非构建保底 | ✅ met | agent-process-pool 三通道（build N 不受 M 截断）；配额单测 |
| ④ kb_write_doc 知识声明 + knowledge.json sidecar + manifest v2 双读 | ✅ met | knowledge-publish 23 用例 + seam；v1 全兼容 |
| ⑤ 对象检索 + 状态过滤（operational/browse/compare）+ MCP 扩展 | ✅ met | knowledge-query 18 用例；get_object/compare_knowledge；泄漏防护 |
| ⑥ 隔离样本端到端（写→审→修订→整合→发布全链路） | ✅ met | knowledge-seam 5 用例（真实工具入口→审查→检查点→中断恢复→v2 发布→查询） |
| 前端真机验证 | ✅ met | 设置面板渲染/交互/落库（concurrency=4+confirm）/刷新回显/进度侧栏空态（agent-browser 隔离环境） |
| diting 终审 | ✅ met | 8 findings → T7 修 6 + T8 修 2（F05-R/N01）；复现基线全部反转；反向取证证明测试有效 |

**缩范围披露（待主上知悉，非静默延期）**：① 高风险 claim 人工复核通道（reviewActorKind=human 入口）与 KnowledgeGovernanceService 业务决定服务未实现——当前对象发布后为 unknown+passed（机器审查凭据），approved 不可达，operational 查询会正确排除（无虚假可达路径）；② asOf 历史查询、证据当前源比对（evidenceNote 已说明）、飞书分发锚点降级警告、工作簿/图片证据资源落盘（索引结构已就绪）为后续切片；③ 围栏 info-string 含反引号未遵循 CommonMark（diting 遗留观察，非阻断）。
| P3 | T2b 编排流水：审查闭环+整合复核+发布条件 | luban | T2a | T2a 产物 | 角色流水执行、审查报告处理、修订预算、自动发布 | mock 构建 e2e 单测 | pending |
| P3 | T4a 编译与发布：compiler+validator+sidecar+双 schema reader | luban | T3 | T3 产物 | knowledge-compiler、knowledge-validator、发布布局、release-reader v1/v2 | 发布门禁单测 | pending |
| P4 | T4b 检索与消费端：query/MCP/routes | luban | T2b,T4a | T4a 产物 | kb-query-service 对象查询/状态过滤/关系预算、kb-mcp-tools、routes | 检索单测 | pending |
| P4 | T5 前端：构建配置+进度+状态标签 | luban | T4b | API 契约 | src/ 构建配置面板、进度视图、状态标签 | 浏览器/Electron 真机验证 | pending |
| P5 | T6 集成验证+diting 终审 | diting | 全部 | 阶段 diff | 审核报告 | findings 回流修复；`npm run check` 全绿 | pending |

## 跨边界链路清单

1. **写→审→发布链**：kb_write_doc（agent-tool-service）→ 草稿+声明原子落盘（T3）→ 审查任务读冻结草稿（T2b）→ 报告绑定哈希 → validator 门禁（T4a）→ publishReleaseInner 写 sidecar → CURRENT 切换。端到端责任：T4b 后 Leader 集成批跑 e2e。
2. **配额链**：config（T1）→ agent-process-pool 后台类区分构建/非构建（T2a）→ kb-build-service acquire 语义（T2a）。
3. **检索链**：release-reader v2（T4a）→ index-core/outline（T4b）→ kb-query-service（T4b）→ UI/内置工具/MCP 三入口共用（T4b/T5）。
4. **真实用户入口验收**：GUI 发起构建（配置角色模型/N 路）→ 进度展示审查状态 → 发布后检索对象结果带状态标签（T5 完成后真机验证）。

## 并行与隔离

- T1 串行先行（公共契约，types/config 多处共享）。
- T2a ∥ T3 并行（T2a 动 kb/kb-build-service+agent-process-pool+build-checkpoint；T3 动 agent/tool-specs+agent-tool-service+prompts+kb/evidence-locator+raw-source-snapshot/raw-workbook 读取侧——文件面不相交；接口契约已在 T1 冻结）。主树直做，任务书写死文件边界。
- T2b 串行（kb-build-service 独占）；T4a 依赖 T3；T4b 依赖 T2b+T4a；T5 依赖 T4b。
- 每任务自带针对性测试 + typecheck；全量回归由 harness/收尾批负责。

## 风险与修订日志

- 2026-11-01 T7 修复批（diting F01–F08）落地：F01 检查点纳入 knowledge-draft/organization-plan/read-receipts/reviews/candidate 及哈希清单；F02 声明坐标统一以 kb_write_doc markdown 参数为基准（bodyLineOffset 重映射 canonical/claims/presentations）；F03 对象级审查凭据接通（流水审查通过回写 machine 凭据 + kb_review_pending blocking 门禁）；F04 启用门重构（任一角色显式或 publishMode=confirm 启用新流水；reviewer 空值=跟随活跃预设）；F05 BuildSpec.resolvedRoles 冻结实际非密钥模型参数（specHash 覆盖，恢复校验不一致→待处理；claude-code 显式角色预设显式拒绝）；F06 基线 knowledge.json 装载进工具注册表（身份保留/有效审查延续/托管文档旧式重写拒绝）；F07 围栏状态机记开栏长度；F08 claim 相对坐标入 payloadHash。新增 server/tests/knowledge-seam.test.ts 跨切片同一数据流闭环。
- **F03 缩范围披露（Leader 已批准；diting F03b 披露修正）**：高风险人审凭据通道待后续切片——当前对象含高风险 claim 且无人工复核时仅产 warning（kb_review_human_missing）+ 本披露，不 blocking。KnowledgeGovernanceService 人工决定服务（decisions.jsonl + desktop 入口）与 desktop 人工复核入口均未实现：**当前 operational 可达 approved 的路径未开通（无业务决定入口），approved 只能来自后续人工决定服务**。诚实状态：当前所有对象发布后为 unknown+passed（机器审查凭据；工具新建对象业务状态实为 unknown，未提供 candidate 状态转换入口），未开放人工业务决定入口，approved 不可达；operational 查询会正确排除它们（T4b 已实现该过滤），不构成虚假宣传（A 案 §4.2/§7.4「未齐则 pending」）。
- 2026-11-01 diting 终审 VERDICT FIX（6M+2m，报告：同目录 diting-final-review.md）。Leader 裁决：F03 拆两层——对象级审查凭据接通+pending 门禁收紧为 T7 实现项；高风险人工复核入口与 KnowledgeGovernanceService 业务决定服务为**已披露缩范围项**（当前所有对象发布后为 unknown+passed 机器审查凭据，未开放人工业务决定入口，approved 不可达，operational 过滤会正确排除）；修复批 T7 合并全部 findings（跨切片同一文件交界，拆分必冲突）。
- Leader 直修两项：① kb-mcp-client-installer.test.ts 环境既有失败（macOS /var→/private/var realpath 前缀，fixture realpathSync 归一，非本批引入）；② eslint.config.js ignores 补 .amagi-reports/**（先前会话归档产物，非项目源码）。
- 真机验证环境：FEISHU_SYNC_HOME=临时目录 + FEISHU_SYNC_PORT=3101 + vite BACKEND_PORT 代理链；曾发现未设隔离根时与主上 3001 实例 SQLite 跨进程锁性挂死（standalone 双实例共享数据根的既有风险，非本批引入——已列入遗留观察）。
- 范围内未做（后续迭代）：governance 人工决定服务（.governance/decisions.jsonl + desktop 入口）、asOf 历史查询、证据当前源比对（evidenceNote 已说明）、飞书分发锚点降级警告（object_anchor_not_preserved）。（diting F03b 披露修正：原列于此的「增量构建基线对象复制（A 案 §7.2）」已由 T7 的 seedBaselineKnowledge 实现增量+full 装载，从本清单移除。）
- T2/T3 对 kb-build-service 与 agent-tool-service 的改造量大（2889/1552 行），任务书要求先内嵌实现设计段落再动刀，分批小步提交（工作树内）。
