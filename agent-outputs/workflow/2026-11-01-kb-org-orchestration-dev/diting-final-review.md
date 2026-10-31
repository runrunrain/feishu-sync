# 知识组织与构建编排阶段终审

VERDICT: FIX

基线：`HEAD=4df82e3`；范围：本轮工作树 `git diff HEAD` 与知识组织/编排相关未跟踪源码和测试（T1–T5）。发现 **6 Major、2 Minor，未确认 Critical**。结论仅对本报告声明的抽样深度有效，不等于全仓无其他缺陷。

## 输入与方法

已完整读取 `CLAUDE.md`、以下 A/B 案及 workflow：
- A：`/Users/run.mao/workpace/Database/01-AI技术与工具/07-工具与框架/飞书同步工具/知识库组织优化/知识标准库组织方案.md`
- B：`/Users/run.mao/workpace/Database/01-AI技术与工具/07-工具与框架/飞书同步工具/构建编排优化/多模型构建编排方案（讨论稿）.md`
- 上游 artifact：`agent-outputs/workflow/2026-11-01-kb-org-orchestration-dev/workflow.md`

先核对 git 范围，再从真实工具入口、检查点、流水、发布及共用查询层反向构造失败条件。没有修改源码/配置、编写项目测试、运行构建或启动 server。已有全量 check/浏览器验证为任务提供的上游证据，本轮未冒称独立复验。

## Findings

### F01｜Major｜检查点恢复丢弃知识组织和审查产物

- **定位**：`server/src/kb/build-checkpoint.ts:107-125,157-174`；`server/src/kb/kb-build-service.ts:688`；`server/src/agent/agent-tool-service.ts:1740-1766`。
- **触发**：新式构建已经写入 objects/evidence/plan/reviews；随后在整合或最终复核阶段失败，用户显式恢复。
- **失败路径 / 影响**：save 只复制 `docs/**/*.md` 和 `.docid-map.json`，不包含 `knowledge-draft.json`、`organization-plan.json`、读取回执与 reviews。restore 把原 staging 整体改名为诊断副本，再只恢复这两类文件。编排任务的 passed 状态却保留于 state.json。后续可跳过已通过任务，但其组织与审查数据已不存在；轻则缺报告阻断/引用不可解析，重则 `prepareKnowledgePublish` 见不到 draft，发布退回 v1，静默失去对象与治理数据。
- **证据**：静态路径证实。现有恢复测试绿，但 `build-pipeline.test.ts:125-143` 的 writer 不提交任何知识声明，不能覆盖此反例。
- **最小修复方向**：把所有恢复所需组织、回执、报告及候选数据纳入同代原子检查点与文件哈希清单；恢复时验证该代任务状态和产物绑定，缺失不得重建为空或降为 v1。由实施者补“带对象+证据、已审节点后中断”的恢复回归。

### F02｜Major｜工具输入坐标与发布编译坐标相差一个生成标题

- **定位**：`server/src/agent/agent-tool-service.ts:1881-1899,1952,1550-1551`；`server/src/kb/knowledge-compiler.ts:532-534,572-594`。
- **触发**：正常工具调用，markdown=`## Alpha\nALPHA_ONLY\n## Beta\nBETA_ONLY`，对象范围分别为输入行 1–2、3–4。
- **失败路径 / 影响**：声明以 markdown 参数坐标保存；工具随后额外生成 `# title`，编译器去掉 header 后仍包含此标题，却直接使用声明范围。第二对象实际发布片段成为 `ALPHA_ONLY + ## Beta`，漏掉 BETA_ONLY，混入前一对象正文。锚点、claim 范围、exact 片段解析与按状态隔离的查询片段均受影响，不能保证“过滤掉的章节不会出现在结果中”。
- **证据**：本轮纯函数复现（退出 0），输出：`ko_a => [anchor,# Title,## Alpha]`；`ko_b => [anchor,ALPHA_ONLY,## Beta]`。T4a fixture 直接手写“含 # 标题”的 body 与范围，没有经过真实 kb_write_doc，因而绕过坐标接缝。
- **最小修复方向**：明确草稿坐标基准，在生成标题/去首空行时统一转换 canonical、claims、presentations，再在编译时重映射。新增真实工具→编译→对象读取的两章节用例，不只测编译器手工输入。

### F03｜Major｜对象审查/人工决定门禁未接通，pending 对象可发布

- **定位**：`server/src/kb/knowledge-validator.ts:159-200`；`server/src/agent/agent-tool-service.ts:1957-1958`；`server/src/kb/kb-build-service.ts:2950-2956,3952-3959`。
- **触发**：writer 声明新对象，独立机器文档审查通过；或对象带高风险 claim 和可解引用证据，但没有任何人工内容复核。
- **失败路径 / 影响**：writer 一律创建 unknown+pending；流水通过只更新 BuildTask acceptance，不产生绑定对象 reviewSubjectHash 的 passed 凭据。门禁只拒绝 rejected/stale，接受 pending；只检查 validReportIds 中所列 ID 存在，空集合也通过。高风险人审要求没有强制点，governance.decisions 恒为空且明确以“后续迭代”处理。故发布后仍是 pending，且没有受认证业务决定入口可使对象达到 operational 所需 approved；既不能保证 A 案审查前置，也不能完成其批准/消费闭环。
- **证据**：本轮直接调用真实 `runKnowledgeGates`：一个 pending 普通对象 + 有 candidate 但 validReportIds=[]、reviews=[]，得到 `{"blocking":[],"warnings":[]}`。现有 `knowledge-publish.test.ts:126-133,359-362` 本身也把 pending 对象作为合法发布 fixture。高风险 fixture 的成功路径只提供机器文档报告。
- **最小修复方向**：接通对象级审查凭据与有效人工决定冻结/复核；pending、缺规定检查、高风险无人审必须阻断。文档级最终报告不能自动冒充对象级人审。若本阶段不能实现，须明确回收“完整 A 案落地”验收并经 Leader/主上批准缩范围，不能靠注释自行延期。

### F04｜Major｜审查者“跟随活跃预设”实际关闭流水，待确认与角色设置被忽略

- **定位**：`server/src/kb/build-orchestration.ts:714-723`；`server/src/kb/kb-build-service.ts:948,1150-1184`；`src/components/settings/BuildOrchestrationSettings.tsx` 的 reviewer 空值选项与发布方式区域。
- **触发**：用户显式选择 writer 模型或设置 publishMode=confirm，但 reviewer 保持界面合法选项“跟随活跃预设”。
- **失败路径 / 影响**：reviewPipelineActive 仅在 reviewer preset/provider 非空时为真。空值不表示“使用活跃模型审查”，而是关闭整个新流水。候选与 awaiting_release 分支完全不执行，走旧式直接发布；用户要求的确认屏障失效。单独配置 writer/integrator 也不能按此入口兑现。
- **证据**：本轮真实 buildSpecFromConfig + reviewPipelineActive 复现输出 `EXPLICIT_WRITER_AND_CONFIRM_PIPELINE false confirm`；现有 `build-pipeline.test.ts:751` 将“reviewer 空值关闭流水”编码为测试预期，但 UI 并未将它显示为“禁用审查”。
- **最小修复方向**：把“旧配置兼容/是否启用新流程”与“模型引用空值=跟随”分开。至少显式 confirm 必须生效；新流程内解析并冻结跟随模型，旧检查点仍按旧流程恢复。补设置→发起→等待确认的跨层用例。

### F05｜Major｜冻结的是模型预设引用，实际模型及参数仍从实时配置读取

- **定位**：`server/src/kb/kb-build-service.ts:217-221,3226-3248`；`server/src/kb/build-orchestration.ts:148-170`；`server/src/agent/provider-descriptor.ts:45-61`。
- **触发**：构建启动后，用户修改同一 modelPresetId 的 openAiModel/baseUrl/参数，或切换空值角色所跟随的活跃模型；后续审查/修订任务启动，或重启恢复。
- **失败路径 / 影响**：BuildSpec 只存 preset/provider/thinking 引用；configForBuild 每次从 configProvider 取当前配置，只冻结 backend。resolveRoleModel 再按此时的 llm 注册表解析。specHash 与任务“模型”展示不变，真实请求却可以换模型/参数。恢复同样无法校验“原模型”是否被原位修改，违反 B §8 保存设置仅影响后续构建。
- **证据**：静态调用链证实。配置变更路径正常存在；没有把角色解析结果随 checkpoint 冻结的实现。claude-code 分支还会直接忽略显式角色预设，退回活跃模型（3239-3242），不能当作角色配置已兑现。
- **最小修复方向**：启动时冻结非密钥的实际模型标识、端点/协议与有效参数及角色规范；启动/恢复任务按冻结结果校验可用性，只动态取凭据。不可用应待处理，不静默改配或忽略角色选择。

### F06｜Major｜v2 基线组织登记未参与增量/全量初始化

- **定位**：`server/src/kb/kb-build-service.ts:755-783,3837-3847,3890-3894`；`server/src/agent/agent-tool-service.ts:1740-1766,1901-1904`。
- **触发**：发布过含对象的 v2，下一次只更改一个源进行增量，或对相同知识执行 full；模型正常按本轮 clientKey 声明改写文档。
- **失败路径 / 影响**：增量只复制 docs 与 docId 映射，不复制知识登记、证据、迁移与审查。loadKnowledgeDraft 从空注册表开始，同 clientKey 得到新随机 objectId，未变文档对象不在登记中。发布才读取 previousObjectIds，随后“未解释对象丢失”阻断正常增量；若本轮只使用旧式工具参数，根本无 draft，直接发布 v1，绕过该丢失检查。full 也未用基线登记保留身份。
- **证据**：静态路径证实；基线 knowledge 的读取只用于末端 previousObjectIds 检查，不为工具注册表提供输入。对应 A §7.2、§10.2 的增量保留与 full 身份保留未成立。
- **最小修复方向**：新构建先从已校验基线初始化对象/证据/迁移/有效审查登记，full 也保留身份注册；受影响对象按实际载荷失效。v2 后继不得因遗漏可选参数静默降级 v1，已纳管文档旧式重写须刷新或拒绝元数据。

### F07｜Minor｜围栏状态机不记录长度，合法代码示例被当作正文

- **定位**：`server/src/kb/knowledge-compiler.ts:176-190`；`server/src/kb/knowledge-validator.ts:105-115`。
- **触发**：四反引号代码块内展示三反引号和 include 语法。
- **实际影响 / 证据**：本轮纯函数复现，四反引号块内的三反引号提前关栏，后续 `{{kb-include:ko_missing:f}}` 触发 blocking `kb_include_invalid`。合法示例导致发布失败；同样的简化状态机影响链接检查。属于局部输入边界，暂列 Minor。
- **最小修复方向**：记住开栏字符与长度，只允许同字符、不短于开栏且仅含合法尾部空白的闭栏；复核缩进及 backtick info string 规则。

### F08｜Minor｜对象正文纯搬家会因 claim 绝对行号改变 payloadHash

- **定位**：`server/src/kb/knowledge-schema.ts:445-447`。
- **触发**：正文与语义不变，同一对象从文档行 1–2 移至行 11–12，claim 范围相应平移。
- **实际影响 / 证据**：computePayloadHash 把 claim.bodyRange 的文档绝对坐标纳入；本轮纯函数验证，同正文 claim 从行 2 改为 12，hash 确实改变。这将把纯位置变更视作语义修订，不能按 A §2.3/§4.3 保留审查/批准。
- **最小修复方向**：对 claim 使用对象内相对范围或规范化断言内容参与载荷哈希，发布位置只作定位；保留真正断言变化的失效检测。

## 两案条款抽样覆盖

每案均超过六条，结论按“本轮实际读到的实现路径”给出。

| 基准条款 | 核对实现 / 结果 |
|---|---|
| A §1.1 / §7.5 CURRENT 提交点 | publishReleaseInner 最后 rename CURRENT；清理异常被隔离，DB 写在 publishRelease 返回之后，未看到本轮引入的 DB 失败回删 current。未做新故障注入。 |
| A §1.1 / §6.2 MCP 无 SQLite | MCP→KbQueryService→release-reader/knowledge-index 读 JSON；新增组织链无 LocalMapStore 引用。未对整个既有依赖树重做包级审计。 |
| A §2.3 身份、载荷/审查 hash | 核对规范化、排除字段及真实写入；F02/F06/F08。目标关系修订与全图传播未做大图实验。 |
| A §3.2 exact / §7.1 坐标 | 阅读编译器全文，核对重复占位、禁止递归、范围与目标版本、链接重定位；F02/F07。 |
| A §4.2 / §7.4 权限与审查 | 工具白名单/只读 phase 能拒绝自报状态和 reviewer 草稿写；但对象审查、人审与决定服务缺口见 F03。 |
| A §5.3–5.4 证据 | 抽查 readReceipt/资源引用与发布期 verifyEvidence 接线；文本/CSV 真实门禁用例通过；工作簿/图片完整留存闭环未实现验证。 |
| A §7.2 / §10.2 增量与恢复 | F01/F06；v1/v2 reader 及 sidecar hash 失败不降级的独立单测通过。 |
| A §8.1–8.2 过滤、依赖、预算、cursor | 阅读 operational 递归、visited/memo、防环、关系一跳6对象6000字符预算、organizationHash 与 evaluatedAt 绑定；状态隔离依赖正确 bodyRange，受 F02 破坏。未验证万节点深链栈/性能。 |
| B §3 角色职责、独立审查 | 新 reviewer 使用独立任务及 phase 工具围栏；F04/F05。 |
| B §4 写审流水与最终复核 | 状态推进、单元修订、整合后最终全版 hash 复核路径及 mock 回归已核对。 |
| B §5 修订/接口失败分账 | 状态机预算与真实流水反例测试通过；本轮未发现换稿清零预算。 |
| B §6 N 路与额外容量 | diff 核对独立 build/background/session 计数、预留和释放；不再受 M 截断。未实起五个模型进程。 |
| B §7 发布条件/确认 | 全版 hash 可被 canPublish 接受，T1 57 项测试仍过；confirm 内容变更测试通过，但启用门禁有 F04，组织凭据另见 F03。 |
| B §8 冻结与恢复、迟到回执 | 取消/迟到/恢复测试通过；知识化恢复和实际配置冻结见 F01/F05。 |

## 验证与测试有效性

### 本轮实际执行

1. 仓库根：`git rev-parse --short HEAD`、`git status --short`、`git diff HEAD --stat`、分文件 diff、`git diff HEAD --check`。基线 4df82e3；diff check 退出 0。
2. cwd=`server`：`npx vitest run tests/knowledge-publish.test.ts tests/build-pipeline.test.ts tests/knowledge-schema.test.ts tests/kb-knowledge-tools.test.ts tests/knowledge-query.test.ts tests/build-orchestration.test.ts`，退出 **0，6 文件 / 180 测试通过**。
3. 仓库根：`npm test -- src/components/settings/BuildOrchestrationSettings.test.tsx src/components/settings/BuildOrchestrationSettings.draft.test.tsx src/components/knowledge/BuildOrchestrationProgress.test.tsx`，退出 **0，3 文件 / 25 测试通过**；伴随 React createRoot/act 警告，未将其误报为功能失败。
4. cwd=`server`，两次 `node --import tsx --input-type=module` 内联纯函数取证，均退出 0，无文件写入：复核 F02/F03/F04/F07/F08。输入、调用及关键输出见各 finding；未另落脚本，遵守本轮“唯一报告可写”边界。

### 哪些证据可信，哪些不能替代集成验收

- 有效：工具拒绝非法声明/证据、真实临时文件发布及 CURRENT 不变检查、源资源 hash 重解引用、旧 schema reader、流水 mock 的失败/缺报告/修订/取消/迟到分支。不是所有测试都只是 happy path。
- **关键缺口是接缝，而非测试数量**：T2b 全链路 fixture 调用旧式 kb_write_doc，T4a fixture 则直接手写声明与文档坐标，两者没有完成“真实声明工具→审查→checkpoint 恢复→v2 编译发布→对象查询”的同一数据闭环。F01/F02/F06 因而可与全绿并存。
- T4a 的“合法零 blocking”fixture 把 pending 作为成功预期；这不是人审门禁的有效证明（F03）。T1 测试继续通过，只证明扩展未破坏它原来覆盖的输入，不能证明整版哈希绑定覆盖了所有组织语义。
- 本轮没有重跑 lint/typecheck/全量 check，没有亲自浏览器走查；上游的保存/回显/进度侧栏验证不能证明确认屏障与后台模型冻结实际生效。前端 DOM 测试也不能替代真机视觉/交互结论。

## 覆盖范围、盲区与交付边界

- 深审：新增 compiler/validator/contracts、检查点、工具声明写入与审查提交、编排 review/integrate/confirm、发布前后失败边界；抽审：模型解析、配额池、SQLite additive/CHECK 重建、共用查询与 MCP、设置/进度组件。
- SQLite：两摘要列在 additive 与共享建表 DDL 双登记；CHECK 重建的 CREATE/INSERT/DROP/RENAME/索引处于 BEGIN/COMMIT，异常 ROLLBACK。未进行故障注入，故仅给静态事务评估，不签发“重建所有失败均已实测”。
- 未全量逐行审阅所有既有模块/全部测试；不把无关未跟踪历史报告纳入实现 findings。没有审美判断、真实模型质量实验、长链性能、平台打包、生产迁移或真实数据核验。飞书分发锚点降级沿用 workflow D3 的尽力项，未作为已完成验收。
- Findings 均为当前改动引入或新功能接线暴露的问题；未把已知既有技术债混作回归。F03 是完整设计落地缺口，而不是声称已利用到飞书凭据或 OS 权限。
- 唯一写入：本报告。回滚仅涉及本报告文件，由 Leader 决定；未提供或应用修复 patch。建议实施者优先处理 F01–F06，并以带知识声明的跨切片失败路径回归后按原编号复审。
