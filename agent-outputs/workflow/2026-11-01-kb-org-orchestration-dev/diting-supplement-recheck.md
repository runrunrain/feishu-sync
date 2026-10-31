# D1–D5 合并态增量审核

VERDICT: FIX

范围内发现 **6 Major、1 Minor**；无已证实 Critical。测试全绿不能关闭下列反例。未修改源码、项目测试或真实数据根；本报告是唯一新增产物。

## 1. 基线与输入

- 工作目录：`/Users/run.mao/workpace/feishu-sync`；实查 HEAD=`94fdb65`。
- 对象：`git diff HEAD` 的 D1–D5 源码/测试增量及相关未跟踪新文件；无关 workflow/摩擦复盘产物排除。
- 上游 A：`/Users/run.mao/workpace/Database/01-AI技术与工具/07-工具与框架/飞书同步工具/知识库组织优化/知识标准库组织方案.md`，全文读取，重点 §4.2、§5.4、§7.2、§8。
- 上游 B：`/Users/run.mao/workpace/Database/01-AI技术与工具/07-工具与框架/飞书同步工具/构建编排优化/多模型构建编排方案（讨论稿）.md`，全文读取，重点 §3、§6。
- 同时读取仓库 `docs/design/agent-knowledge-design.md` 与 `docs/design/kb-agent-upgrade-design.md`。
- 采用任务书已裁决的「空治理 warning、治理在用 blocking」语义，不把该过渡本身报为缺陷。
- 下列 S-F 编号为本补充批新编号，不与历史 F 编号混用；未收到历史 finding 清单，不签发其逐项关闭结论。

## 2. Findings

### S-F01｜Major｜异步声明整包覆盖，破坏跨 worker 同代一致性

**定位**：`server/src/agent/agent-tool-service.ts:1532,1573–1575,1613,1818–1822,1883,2098`。

**触发**：两个构建 worker 写不同的合法认领路径。A 先读取共享 `state.knowledgeDraft` 并深拷贝，随后在新增的工作簿证据装配 `await loadWorkbookEvidenceResource(...)` 中让出执行；B 完成自己的声明并保存；A 返回后将旧副本整包保存。

**实际影响**：B 的 Markdown 仍存在，但其 docs/object/evidence/clientKeys/calls 登记及可能同时回写的审查凭据被 A 覆盖。文件级 PathClaims 不能保护全局 `knowledge-draft.json`。可能造成发布阻断、身份丢失；新文档还可能退为未纳管区域，不能保证正文与声明同代。

**证据**：本轮把 `toolKbWriteDoc` 与声明解析由同步改为 async；`executeTool():598–627` 无构建级串行保护，`saveKnowledgeDraft` 无重新读取/版本 CAS/合并，直接覆盖文件及共享状态。附录 E1 对真实声明解析器的内存并发调用返回 `[{docs:["a.md"],objects:["a"]},{docs:["b.md"],objects:["b"]}]`，两个结果互不包含对方；保存最后一个即丢失另一个。**解析器副本竞争已复现；真实双 HTTP + XLSX 的完整竞态未另跑，结论由实际 await→整包保存路径证实。** 即使无证据声明，调用方现在也有 await；工作簿 IO 提供了明确可跨请求交错的窗口。

**最小修复方向**：在每个 build 上串行化「读取当前声明→并发/计划复核→正文与声明提交」整个临界区，或装配后基于最新全局版本 CAS 并重放局部声明；所有修改共享登记/审查凭据的写者须共用同一机制。由实施者补真实两个 worker、一方 XLSX 延迟的测试。

### S-F02｜Major｜expectedRevision 不是版本，已有对象的决定修改不推进 OCC

**定位**：`server/src/kb/knowledge-governance-service.ts:260,289–295,339`。

**触发**：已有 A/B 两对象决定（revision=2）；两个窗口均持 expectedRevision=2，各自将已有对象停用，或任一修改后另一窗口基于旧决定集继续提交。

**实际影响**：`effective.size` 不随修改递增，两次都接受；两个 POST 都返回 revision=3，但 GET 仍返回 2。旧客户端不能用该 revision 检出决定集已经变化，违背 A §4.2 expectedRevision 防并发覆盖承诺。同步 JS 执行只避免指令级交错，不解决版本永远不变。

**证据**：E1 调用真实服务（仅日志 IO 替换为内存数组）：`firstReturnedRevision=3, secondWithSameExpectedRevision=3, currentListRevision=2, records=4`。现有测试反而断言 supersede 后 GET revision 仍为 1；只测首次新增之后的旧 revision 冲突，未测更新已有决定。显式 supersedesDecisionId 能额外保护指定对象，但不是每次修改的必填条件，也不修复全局 revision。

**最小修复方向**：使用每次 append 严格递增的日志序号/记录数或内容版本；GET/POST/快照统一同一真相。保留同对象 supersede 链校验，测试两个更新请求同版本只能接受一个。

### S-F03｜Major｜人工“拒绝”被历史任意一次通过覆盖

**定位**：`server/src/kb/knowledge-validator.ts:253–262`；`server/src/kb/knowledge-governance-service.ts:400–401`。

**触发**：同一 objectId + reviewSubjectHash 先登记 passed=true，后人工发现错误提交 passed=false；或对象已有 human actor 字段，再追加拒绝。

**实际影响**：门禁用 `.some(passed)`，不计算当前有效人审结论，最新拒绝不撤销旧通过；`reviewActorKind==='human'` 也直接放行。待治理列表同样隐藏该对象。人工否决不会成为发布 blocker，违反 A §4.2「任一 rejected 则 rejected」及不可绕过内容审查的要求。

**证据**：E1 对实际编译器/门禁提交 `[true,false]` 人审历史后，`humanReviewBlockers=[]`。该最小 fixture 另有缺证据/机器报告两个独立 blocker，**没有宣称它已完整发布**；这里证明的是人审拒绝这一必要门禁完全消失，其他门禁齐备时该错误不再被拦。

**最小修复方向**：为同对象/审查主体定义有效复核记录及取代规则，显式拒绝必须阻断，不能以任意历史通过或 actor 种类覆盖；待治理状态共用该聚合函数。实施者补通过→拒绝→重审及正文变更的回归。

### S-F04｜Major｜实际生成的 unknown 对象没有 desktop 决定入口，停用/恢复亦不可达

**定位**：`server/src/kb/knowledge-governance-service.ts:422`；`src/components/kb/KbGovernancePanel.tsx:155–158,202–210`；来源路径 `server/src/agent/agent-tool-service.ts:2006–2026`。

**触发**：经真实工具创建普通对象并成功发布；工具固定 businessStatus=unknown，无 candidate 转换入口。或批准对象发布后，需要再停用/恢复。

**实际影响**：pending 只提供 candidate、stale 和高风险人审，面板业务表单只消费 candidate/stale；正常 unknown 对象没有批准按钮，正常 approved/deprecated 对象没有停用/恢复表单。服务虽允许 unknown→approved、approved→deprecated、deprecated→approved，主上却不能经本批承诺的 desktop 人工工作流执行。candidate 在 D1、D4 都按同一业务字段判定，但该字段在真实生成链上仍不可达；不能用人工拼 candidate fixture 证明工作流闭环。

**证据**：E2 对真实服务注入普通 unknown+passed 对象，得到 `releaseId=r1, highRisk=[], candidates=[], staleDecisions=[]`。前端静态消费链证实无操作对象。unknown 的生成行为是**既有事实**，本批新 UI/查询遗漏了它，属于本批暴露的需求缺口，不要求把所有 unknown 擅自升级 candidate。

**最小修复方向**：提供可治理对象列表/对象详情操作，涵盖合法转移的 unknown、approved、deprecated 等状态；分开“待裁定提示”与“可操作对象”。若增加 candidate 通道，必须有明确依据和状态语义，不能只为让面板有数据显示而硬标候选。

### S-F05｜Major｜旧载荷决定重新批准时，面板主动省略必需 supersede ID

**定位**：`src/components/kb/KbGovernancePanel.tsx:111–113`；`server/src/kb/knowledge-governance-service.ts:310–320,419`。

**触发**：已有 approved 决定绑定旧 payload；对象新载荷已发布为 unknown（新载荷旧决定不会生效），出现在 staleDecisions。主上按面板提示在新载荷上“重新决定→批准”。

**实际影响**：面板仅在 `!effectiveDecision.payloadMismatch` 时携带 supersedesDecisionId；恰在需要重绑的 stale 分支不带。服务按有效决定链仍视为 approved，要求 approved→approved 必须带 supersedesDecisionId，于是返回 400。刷新与重试不能修复，面板承诺的旧决定重绑流程必失败。allowedDecisionTargets 又按 release 状态而非有效链生成，加剧两端不一致。

**证据**：E2 的实际服务输出 `STALE_TARGETS ["approved"]`，按前端形状提交后得到 `kb_decision_invalid: 对象已 approved…修订既有决定须携带 supersedesDecisionId`。这是确定性调用链，不是概率竞态。

**最小修复方向**：旧载荷决定被取代仍须携带其 ID；允许目标按服务实际采用的有效链状态统一计算，并区分旧决定不生效与旧记录不存在。实施者补真实 pending DTO→前端 POST→服务接受的往返。

### S-F06｜Major｜人审用于放行，但不随不可变 release 冻结

**定位**：`server/src/kb/kb-build-service.ts:4767–4800,4829–4838`；`server/src/kb/knowledge-compiler.ts:160–172`。

**触发**：治理在用，高风险对象由 `.governance/human-reviews.jsonl` 的人工凭据通过门禁，随后成功发布。

**实际影响**：发布 `governance.json.reviewCredentials` 只有 acceptanceId/机器 validReportIds/candidateHash；`decisions` 也只保存业务决定，没有实际采用的人审记录、reviewId/reviewer/subject 绑定或该冻结集的哈希。新对象的 reviewActorKind 仍为 machine。保留该 release 而运行期治理日志丢失/迁移后，无法独立复核为什么满足强制人审；同一个不可变 release 的治理展示还依赖后来可变日志，违反 A §4.2 独立行为与依据记录以及 release 同快照凭据要求。

**证据**：静态完整追踪：snapshotForBuild 有 humanReviews → `checkHighRiskHumanReview` 消费 → 发布序列化对象没有 humanReviews 字段，也没有保留该集合的绑定哈希。`governance-freeze.json` 属于 staging/检查点白名单，不在本 release 写盘清单；不能以可清理的构建目录替代发布证据。决定条目本身的 actor/rationale/payload/scope 保留正确，此 finding 仅针对缺失的人审凭据。

**最小修复方向**：将实际采用的人审凭据（含对象、subjectHash、有效结论、记录人/时间）投影进治理 sidecar，并通过 manifest 哈希绑定；消费与展示读取发布时的凭据，运行期新增只显示待发布状态。

### S-F07｜Minor｜asOf 接受非法日历日期与无时区时间

**定位**：`server/src/kb/search/kb-query-service.ts:224–229`。

**触发**：`asOf=2025-02-30`，或 `2025-01-01T00:00:00`。

**实际影响**：Date.parse 会将不存在的二月三十日归一到三月；无时区时间按服务器本地时区解释，同请求可在不同机器跨过不同 validFrom/validUntil 边界。接口承诺“合法 ISO 日期”的输入错误没有拒绝。影响局限于显式时间查询，不影响默认检索。

**证据**：E2 调用真实 getObject，在 release 解析前注入哨兵而不接触文件：前两种输入都到达 `VALIDATION_PASSED`，garbage 则得到 invalid_request。即实际参数校验接受，不是只运行一个外部 Date.parse 表达式。

**最小修复方向**：验证年月日真实存在；日期按 UTC 业务日解释，datetime 要求 Z/显式 offset 或约定统一 UTC 后规范化；补闰年、跨时区与边界相等用例。

## 3. 条款抽样与覆盖清单

### A §4.2 全条核对

| 条款 | 证据与结果 |
|---|---|
| 人工业务裁定，模型不能赋 approved | 新 API 经过 desktop auth；Build/Task 工具白名单无治理写工具，命令表无治理命令。声明固定 unknown、发布仅匹配决定后赋状态；未发现运行令牌直写治理绕过。 |
| 结构审查与业务批准分离 | 机器 passed 不直接赋 approved；业务决定亦未绕过机器报告检查。新人的拒绝聚合错误见 S-F03。 |
| 发布操作者不得绕过 blocker | runKnowledgeGates + evidenceBlocking 在 CURRENT 前抛错；确认模式也复跑。存在人审门禁逻辑缺口，不能宣称整体安全通过。 |
| 单机可兼任，但分别记录身份/依据，不声称抵御同 uid | 服务生成 decisionId/时间，actor 可自愿署名，理由非空校验存在；未把 token 当真实人员认证。发布人审依据不完整见 S-F06。 |
| 追加 decisions.jsonl；仅 desktop；修改 supersede、expectedRevision | guard 拒 cliActor/actor header/CLI token；客户端只能通过 request 取 desktop 头，伪造 actor 标记只会拒绝。服务同步 append，但 OCC/重绑见 S-F02/S-F05。内部方法无独立 auth 属受信进程实现，不等同外部可达绕过。 |
| 冻结集合与 hash，变化后失败重取 | staging 冻结、checkpoint 白名单、prepare 阶段比对；D5 seam 已重跑，kb_governance_changed→恢复重取路径通过。确认模式显式重取并重试一次，未跳过其他门禁。 |
| 决定绑定对象/payload/scope/status/理由/evidence；独立依据保留；sources 非空 | 服务校验 scope、理由与对象；发布双重匹配 payload/scope 后生效，governance.json 保存真实决定。无匹配的旧决定不会自动批准新载荷；人审独立凭据见 S-F06。 |
| 下一发布才生效，UI 标待发布，不叠加旧 release | UI 有待发布提示；对象查询/D4 分发读取 release 状态，不叠加运行期决定。正常治理动作 UI 不可达见 S-F04。 |
| 结构/内容审查聚合；高风险/裁定/冲突至少一次人审；独立签发 | pending/过期机器凭据检查保留；高风险检查已接入冻结集合。拒绝失效见 S-F03；这里只对显式 high claim 的实现作验证，未证明自动识别所有高风险语义/冲突。 |

**过渡边界**：`kb-build-service.ts:4829` 是全局治理是否在用，不是“对象有没有决定”。空集合时 high-risk 缺人审为 warning；任意决定或人审存在时，所有 high-risk 缺凭据均 blocking。普通 unknown/candidate 对象没有决定不会被 businessDecision 检查阻断；approved/disputed/deprecated 没决定才 blocking。该口径符合任务书过渡裁决；人审拒绝处理仍有 S-F03。

### A §5.4（不少于三条）

1. **正文/CSV 区段及资源 hash**：编译器原有 source-contents 区段链继续使用；新装配包同时供声明、compile、gate 使用，resourceHash 篡改在发布期阻断，测试已重跑。
2. **工作簿最小充分区间**：evidence/workbook-<slug+digest>.json 保存格值、公式/缓存性质、源 hash、选区；sheet 感知查格已接通，真实 ExcelJS xlsx fixture 通过。
3. **图片本体与描述**：只收 described/cached 图片；实际 bytes 生成 hash 和安全十六进制文件名，caption 进入 evidenceResources 索引。未描述图片拒绝，不静默以描述替代本体。
4. **路径围栏**：workbook 文件名由固定 evidence/ 前缀与过滤 slug 构成，image 文件名只用服务端 sha256；输入 resourceId 含斜杠不会成为目录。发布位置是新建 release，当前构造下未找到可输入路径穿越。未测试同 uid 外部抢建 symlink（不在产品 OS 沙箱承诺内）。
5. **hash 链和预算失败**：manifest.evidence.hash→evidence-resources.json→文件 hash；7 项 D3 测试中的超预算/篡改覆盖 CURRENT 不变、半成品目录不存在，重跑通过。预算在内存装配后检查，未做 2GB 极限容量压测。
6. **授权/只读**：查询比对只使用 read/stat/readdir 和 resolveInside，不写原始库；标准 MCP 新对象响应没有复制原文摘录或图片本体。此次未对所有 MCP/raw 授权组合做全量独立集成测试。

### B §3 / §6 与 A §7.2（不少于三条）

- **规划只提建议、无草稿写**：phase=plan 的 kb_write_doc/kb_delete_doc 服务器端拒绝；kb_unit_done/kb_finish/kb_submit_review 各有 phase 条件，不能靠换工具逃逸。plannerEnabled=false 不派 plan，新开 true 先 plan 后 write，已有 seam 测试通过。
- **不可增配额/跳审/发布**：计划入参无配额/批准字段；写/审/整合仍按服务端任务图生成。规划角色沿用 writer 模型属当前实现选择，不据此宣称独立 planner 模型配置。
- **计划冻结后派发**：planRevision≥1、产物 available 后派 write，inputRefs 带 plan ID/revision；既有路径认领继续有效。未以真实模型验证计划质量或全库语义覆盖。
- **N 路共享配额、等待不占位**：新增优先级仅排序 readyTasks，调度循环继续受 concurrency 控制；本批未改旧池准入契约，未发现放大名额路径。未重跑全部进程池/服务商限流测试。
- **review/revise 优先和等待序**：类优先→queuedAt 字符串→稳定创建序。无 Date.now 动态等待分数，当前所谓 aging 实为类内 FIFO，不能证明跨优先类的抗饥饿；墙钟回拨可让新任务排到旧任务前。有限任务图/重试上限下未复现永久饥饿，不提升为 Major，但“aging”宣传应谨慎。
- **影响闭包终止/只读支撑源/身份**：required Set 先判重再入 frontier，语义环可终止；闭包文档进入 requiredRewrites/ownedDocs、未变源进 readOnlySources 而非 workset；身份保留 seam 通过。全局登记的一致性仍被 S-F01 破坏。

### D2/D4 与跨批边界

- asOf 的 validFrom 排除、validUntil 等时刻失效、timeUnknown 和游标绑定测试通过；非法日期/无时区见 S-F07。HTTP search 仅 asOf 不触发对象模式，符合本轮代码公开说明；未把它解释为完整历史推理。
- legacyRef 只做索引 Map 查找，不拿其路径读取文件；迁移链 visited 防环，多后继不静默选首个。路径注入未见文件读取面。
- **已披露限制**：alias 表仅从本 release 的 canonical.path + title 推导，不能恢复改名/移动前没有保留的位置；A §2.4 的完整历史 alias 能力未获证明。本轮安全审核不将“未命中”当目录逃逸，也不签发历史导航完整性通过。
- 证据比对是只读、使用发布快照相对路径且 resolveInside；工作簿/图片比对 unsupported 有明确提示，不伪装 current。
- D4 以 release businessStatus 检查 candidate/disputed/deprecated 正文提示，非 runtime 决定；D1 亦以相同字段筛 candidate，所以字段来源一致但真实 candidate 生成缺口仍在（S-F04）。关键词存在性检查不证明语义支持，未将“命中一个词”当独立内容审查。

## 4. 验证命令与测试有效性

### 实际执行

| cwd | 命令 | 退出与关键输出 |
|---|---|---|
| 项目根 | `git rev-parse --short HEAD; git status --short; git diff HEAD --stat`，以及按模块 `git diff HEAD -- <paths>` | 0；HEAD 94fdb65，定位工作树及未跟踪 D1–D5 文件。 |
| `server/` | `npm test -- --run tests/knowledge-governance.test.ts tests/build-scheduling-supplement.test.ts tests/evidence-resources.test.ts tests/knowledge-query-time.test.ts tests/publish-anchor-degrade.test.ts tests/kb-knowledge-tools.test.ts` | 0；6 文件 **125/125**，约 2 秒；真实临时 SQLite/FS + 受控模型替身。 |
| 项目根 | `npm test -- --run src/components/kb/KbGovernancePanel.test.tsx src/views/KnowledgeView.layout.test.tsx` | 0；2 文件 **9/9**。有 React 重复 createRoot/重复 key 警告，不是零警告通过。 |
| `server/` | 附录 E1/E2 的 `node --import tsx --input-type=module` | 各 0；无文件写入、无真实数据根访问；关键反例输出见下。 |

本轮没有重跑全量 npm run check；任务书的后端 2407/前端 486 以及真机 API/UI 渲染是**上游声明**，未冒充独立复核。本轮也未调用真实模型/飞书写入，未重做真机视觉审查。

### 测试有效性判断

- D3 证据测试真实生成 xlsx、写临时 release、校验 hash/CURRENT/清理，有效支持落盘失败路径，但图片为受控字节，不能证明真实视觉理解。
- D5 seam 走真实工具/检查点/发布与临时 DB，仅 RPC 模型为替身；有效支持编排接线和冻结变更，不证明模型计划/内容审查质量。
- 治理服务测试充分覆盖新增/空理由/CLI 头拒绝，却把有效对象计数当 revision 的行为固化；漏掉已有决定并发、拒绝覆盖通过、stale UI 重绑。
- 前端四项新测试全 mock API，手填 candidate/approved DTO；没有真实生成 unknown→pending→POST 的消费链，未覆盖 S-F04/S-F05。测试 fixture 还把同一 stale 对象放进 candidates 导致重复 key 警告，不能将其当真实 DTO 一致性验证。
- S-F01 的共享文件竞态没有真正多 worker IO 交错测试；现有顺序工具测试全绿不构成其反证。

## 5. 可复核取证（仅内存，无新增脚本文件）

任务仅授权报告写入，因此复现脚本以本报告 E1/E2 代码块留存，不另建项目测试或外部脚本文件。可以在 `server/` 直接执行。服务日志 IO/组织计划读取为显式内存隔离，不冒充 FS 或完整发布证据。

### E1：OCC、人审拒绝、共享声明副本

```bash
node --import tsx --input-type=module <<'NODE'
import {KnowledgeGovernanceService} from './src/kb/knowledge-governance-service.ts';
import {compileKnowledgeRelease} from './src/kb/knowledge-compiler.ts';
import {runKnowledgeGates} from './src/kb/knowledge-validator.ts';
import {AgentToolService} from './src/agent/agent-tool-service.ts';
const objects=['ko_A','ko_B'].map(objectId=>({objectId,type:'rule',title:objectId,aliases:[],domainIds:[],familyKey:objectId,variantKey:'v',scopeKey:'s',scopeText:'s',canonical:{docId:'kd_a',path:'a.md',bodyRange:{startLine:2,endLine:3}},revision:1,locationRevision:0,payloadHash:'h',reviewSubjectHash:'r',businessStatus:'unknown',reviewStatus:'passed',claims:[]}));
const service=new KnowledgeGovernanceService({outputRoot:'/virtual-only',readCurrentKnowledge:()=>({objects})});
const records=[]; service.allDecisionRecords=()=>records; service.humanReviews=()=>[]; service.appendRecord=(_,r)=>records.push(r);
const input=(o,status,revision)=>({objectId:o.objectId,payloadHash:'h',scopeKey:'s',businessStatus:status,rationale:'confirmed',expectedRevision:revision});
service.recordDecision(input(objects[0],'approved',0)); service.recordDecision(input(objects[1],'approved',1));
const a=service.recordDecision(input(objects[0],'deprecated',2));
const b=service.recordDecision(input(objects[1],'deprecated',2));
console.log('OCC',JSON.stringify({firstReturnedRevision:a.revision,secondWithSameExpectedRevision:b.revision,currentListRevision:service.listDecisions().revision,records:records.length}));
const header='<!--\nfeishu_sync_kb:\n  doc_id: kd_a\n  sources:\n    - tok\n  build_id: b\n-->\n';
const obj={...objects[0],claims:[{claimKey:'cap',bodyRange:{startLine:3,endLine:3},riskCategory:'high',evidenceIds:[]}]};
const compiled=compileKnowledgeRelease({docs:[{path:'a.md',content:header+'# Doc\n## Rule\nLimit 3\n'}],knowledgeDraft:{schemaVersion:1,buildId:'b',docs:{'a.md':{docId:'kd_a',revision:1}},objects:[obj],presentations:[],relations:[],evidence:[],coverage:[]},releaseId:'r1',evidenceResources:[]});
const actual=compiled.knowledge.objects[0];
const reviews=[true,false].map((passed,i)=>({reviewId:'r'+i,createdAt:'2026-11-01T00:00:0'+i+'Z',actor:'human',objectId:actual.objectId,reviewSubjectHash:actual.reviewSubjectHash,passed}));
const governance={decisionRecords:[],effectiveDecisions:[],humanReviews:reviews,revision:0,snapshotHash:'x',takenAt:'now'};
const gate=runKnowledgeGates({compiled,candidate:null,reviews:[],snapshot:{entries:[],get:()=>undefined,size:0},knowledgeBaseRoot:'/virtual-only',governance});
console.log('HUMAN_REJECT',JSON.stringify({history:reviews.map(r=>r.passed),humanReviewBlockers:gate.blocking.filter(x=>x.code==='kb_review_human_missing'),allBlockerCodes:gate.blocking.map(x=>x.code)}));
const tools=new AgentToolService({dataRoot:'/virtual-only',documentsProvider:()=>[]});
tools.loadOrganizationPlan=()=>({objects:[],planRevision:0,planId:'p'});
const base={schemaVersion:1,buildId:'b',docs:{},clientKeys:{},evidenceKeys:{},objects:[],presentations:[],relations:[],evidence:[],coverage:[],calls:{}};
const args=key=>({objects:[{clientKey:key,type:'concept',title:key,familyKey:key,variantKey:'v',scopeKey:'s',scopeText:'scope'}]});
const pending=['a','b'].map(key=>tools.buildKnowledgeDeclaration({}, {stagingRoot:'/virtual-only'}, base,key+'.md','kd_'+key,args(key),'## Concept\nExplanation'));
const results=await Promise.all(pending);
console.log('PARALLEL_DECLARATIONS',JSON.stringify(results.map(r=>({docs:Object.keys(r.draft.docs),objects:r.draft.objects.map(o=>o.title)}))));
NODE
```

实际 stdout：

```text
OCC {"firstReturnedRevision":3,"secondWithSameExpectedRevision":3,"currentListRevision":2,"records":4}
HUMAN_REJECT {"history":[true,false],"humanReviewBlockers":[],"allBlockerCodes":["kb_evidence_unresolved","kb_review_credential_missing"]}
PARALLEL_DECLARATIONS [{"docs":["a.md"],"objects":["a"]},{"docs":["b.md"],"objects":["b"]}]
```

### E2：日期校验、unknown 面板空态、stale 重绑

```bash
node --import tsx --input-type=module <<'NODE'
import {KbQueryService} from './src/kb/search/kb-query-service.ts';
import {KnowledgeGovernanceService} from './src/kb/knowledge-governance-service.ts';
const q=new KbQueryService('/virtual-only',{prewarm:false}); q.resolveRelease=()=>{throw new Error('VALIDATION_PASSED')};
for(const asOf of ['2025-02-30','2025-01-01T00:00:00','2025-01-01T00:00:00Z','garbage']){try{await q.getObject({objectId:'ko_A',asOf})}catch(e){console.log('ASOF',asOf,e.code??e.message)}}
const object={objectId:'ko_A',title:'Rule',type:'rule',scopeKey:'s',payloadHash:'new',reviewSubjectHash:'r',businessStatus:'unknown',reviewStatus:'passed',claims:[]};
const svc=new KnowledgeGovernanceService({outputRoot:'/virtual-only',readCurrentKnowledge:()=>({releaseId:'r1',objects:[object]})});svc.allDecisionRecords=()=>[];svc.humanReviews=()=>[];
console.log('UNKNOWN_PANEL',JSON.stringify(svc.pendingGovernanceWork()));
svc.allDecisionRecords=()=>[{decisionId:'old',objectId:'ko_A',payloadHash:'old',businessStatus:'approved',scopeKey:'s'}];svc.appendRecord=()=>{};
console.log('STALE_TARGETS',JSON.stringify(svc.pendingGovernanceWork().staleDecisions[0].allowedDecisionTargets));
try{svc.recordDecision({objectId:'ko_A',payloadHash:'new',scopeKey:'s',businessStatus:'approved',rationale:'Reapproval',expectedRevision:1})}catch(e){console.log('STALE_UI_SUBMIT',e.code,e.message)}
NODE
```

实际 stdout：

```text
ASOF 2025-02-30 VALIDATION_PASSED
ASOF 2025-01-01T00:00:00 VALIDATION_PASSED
ASOF 2025-01-01T00:00:00Z VALIDATION_PASSED
ASOF garbage invalid_request
UNKNOWN_PANEL {"releaseId":"r1","highRisk":[],"candidates":[],"staleDecisions":[]}
STALE_TARGETS ["approved"]
STALE_UI_SUBMIT kb_decision_invalid 对象已 approved：重申不产生新决定，修订既有决定须携带 supersedesDecisionId
```

## 6. 未覆盖、可信度与交接

- 审核方式为 full 的**本批变更范围**，并非全仓审计：正确性/权限/并发/一致性重点实查；迁移/兼容按 additive 类型和 checkpoint 链抽样；性能只看有界性与预算，未压测；视觉与真实模型语义不作通过结论。
- 治理主体拒绝、冻结变更、证据预算与清理有相关真实临时环境测试支持；人工人审/并发、UI 真实状态闭环的验证缺口足以阻断本阶段。
- 未测试恶意同 uid Node 插件，亦不声称它被 OS 沙箱限制。没有新增外部凭据或联网要求。
- 本轮未实施修复或编写正式测试。建议实施者优先处理 S-F01/S-F02/S-F03，再补完整 desktop 决定生命周期与发布凭据，按原编号复审。
- 回滚：本轮只新增本报告，回滚仅涉及本报告文件；无需、也未执行任何源码/数据回滚。

VERDICT: FIX
