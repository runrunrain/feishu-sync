# P4 · full 独立审核

## 结论

**FAIL（完整设计验收）；VERDICT: FIX。**

发现 **3 项 Major、1 项 Minor**，无已证实的 Critical。主要失败是设计承诺尚未闭合，不是已发现安全门禁整体失守。P3 对“部分完成”的声明属实；不宜把当前补丁按完整规格合入。以下结论只适用于本次指定 diff，不代表全仓安全认证。

## 范围与输入

- 工作树：`/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/kb-gate-simplify`，分支 `amagi/kb-gate-simplify`。
- 基线：`aa69abd4807c6b03e984cf6aaa0c7dcf58b88230`；审核 `git diff <baseline>`，含 intent-to-add 的新文件，共 33 文件、+691/-92。未把基线之前同步线当成本次回归。
- 完整读取上游：`/Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/kb-build-gate-simplify/p2-design.md`、同目录 `p3-report.md`、工作树 `CLAUDE.md`。P2 分段读完。
- 下文 `server/...` 均相对上述工作树。项目源码与测试未修改；唯一报告写入为本文件。没有编写项目测试或复现脚本，没有运行真实库/真实模型。

## Findings

### F01｜Major｜标准模式仍无审查主体摘要，证据/覆盖修订和规则升级继续触发补审

- **定位**：`server/src/agent/agent-tool-service.ts:2832-2833`、`:5400`（edit 后调用 `v2RecordReceipt`）；`server/src/kb/review-authority.ts:282-301`；`server/src/kb/kb-build-service.ts:1485-1488`、`:1593`。
- **触发条件**：标准模式的文档已取得独立 pass，随后只用 `kb_edit_doc.evidenceSelectorUpdates` / `coverageUpdates` 修正机械元数据；或恢复时 workflow revision 变化。
- **实际影响**：写后仍无条件 `invalidateReviewsForPaths(..., 'content_revised')`；有效报告选择仍精确比较 declaration、workflow-rules 和 doc 哈希。没有标准模式分支或 `subject:<path>` 绑定。因此文档重新进入待审，最终仍可返回 `review_missing`，不能达到 P2 §2.3 / §5.4 的“仅改证据不用补审”。恢复时也仍撤销旧规则回执。
- **证据**：静态调用链证实；`review-authority.ts` 和 `build-actors.ts` 不在本次 diff 中；P3 明确记录 S3 未实施。本轮原有审查权威测试通过，只证明旧约束没有被跳过，不能证明新语义完成。
- **归因**：旧行为被保留造成的新需求缺口，不称作旧功能回归。
- **最小修复方向**：完成 P2 §2.3 的服务端主体摘要、写后有条件失效及凭据重挂、有效报告和 workflow 恢复分支；strict 与旧回执维持精确规则。由实施者补 evidence-only / coverage-only / 正文变化 / workflow 变化的成对真实工具链回归，不应直接忽略 stale 回执。

### F02｜Major｜承接面降级在真实发布链仍会保守失效，单测没有覆盖到该断点

- **定位**：`server/src/kb/kb-build-service.ts:7041-7048`、`:7420-7424`；`server/src/kb/gate-attribution.ts:19-21`、`:39`；`server/src/kb/knowledge-compiler.ts:453-456`。
- **触发条件与实际影响**：
  1. 普通增量构建尚无本构建的 progressive release，最终发布不传显式 `draftEvidenceScopePaths`。`finalDraftEvidenceScopePaths` 此时返回 undefined，归因器收到 undefined，直接对所有问题返回 attributable=true。即使 CURRENT 已有、且与本轮完全无关的可降级历史问题，也无法按 P2 §1.2 放行。若阶段发布也被该历史问题阻住，不能靠“先成功阶段发布”解开这个循环。
  2. 承接面的 `exact` revision stale 同时由 compiler 产出。归因器用包含完整 `message` 的 key，去匹配 `validateKnowledgeGraph(previous)`；compiler 的 `exact 片段绑定的目标 revision...` 文案不是 graph 的 issue 文案，故 compiler issue 始终被视为当前问题，仍阻断。
  3. `coverage_target_missing` 的任一不存在目标都不能通过 `carried(id)`（要求当前和旧对象均有 canonical path），因此这类 mapped 缺失目标实际上无法命中当前实现的历史降级。
- **证据**：静态路径证实；`server/src/kb/progressive-knowledge-draft.ts:84-85` 的返回前提；P3 也承认后两类缺口。新增 `knowledge-publish.test.ts:437` 的测试直接调用 graph + policy，未通过 prepare/publish，因此不会发现上述真实链路差异。
- **归因**：S1 实现范围不足；未发现把本轮问题错误降级的反例，当前主要问题是该放行的历史面仍然阻断。
- **最小修复方向**：普通增量也计算明确改动面；用稳定结构身份而非跨生产者完整文案匹配历史缺陷；缺失目标的历史归属须有可复核的历史记录，否则明确保守阻断。至少补“CURRENT 历史缺陷 + 本轮无关新篇”经真实发布入口的 strict/standard 对照，涵盖 compiler 与 graph 同时报错。

### F03｜Major｜阶段/最终失败记忆没有实现设计承诺的共享与一次拦截

- **定位**：`server/src/kb/kb-build-service.ts:1694-1722`、`:1871-1883`；最终发布失败返回 `:1965-1970`、`:2010-2011`、知识门禁抛错 `:7430-7445`。
- **触发条件**：同一文档、正文和声明未改，持续出现例如 `kb_restatement_stale` 的确定性阻断；或最终发布首次发现某路径失败，随后又发生 checkpoint/阶段发布调度。
- **实际影响**：只有阶段发布 catch 中、且全部 groups 属于五个枚举 code 时才写 `progressiveBlocked`；`kb_restatement_stale` 不在其中。最终失败没有为可归因路径登记记忆。相同确定性问题可反复编译/校验，`stageBlockedPaths` 也不能完整告知 Leader。另因 key 纳入整候选、所有回执和整 draft，无关文档活动也会使既有失败失效，不能满足 P2 §2.4 / §5.4 的同一 `(path, hash)` 不重复拦截承诺。
- **证据**：静态检查本次所有 `progressiveBlocked` 读写位置；最终返回链未写记忆。新增 runtime-tools 测试只是手工预置 Map 后检查 DTO，不是同输入第二次调用或最终→阶段共享记忆的回归。P3 对这部分受限实现与缺测试的披露准确。
- **归因**：新效率机制未完成，不是安全放行缺陷。
- **最小修复方向**：让阶段和最终失败共用记录入口，保守归因到路径；对依赖明确的确定性失败保存足够精确的依赖 key（避免仅靠正文，也避免所有无关活动一律清空）。正式补同输入不重跑、相关依赖修复后重试、无关篇继续工作的服务链测试。无法提供完整语义时应先明确缩减并批准验收范围，不能按当前完整设计签收。

### F04｜Minor｜自动修复仍会改写合法 Markdown 代码示例

- **定位**：`server/src/kb/link-repair.ts:5-13`、`:21-25`。
- **触发条件**：标准模式写入合法的缩进代码块，例如正文 `    [a](a.md)`，当前文档为 `dir/x.md`，knownPaths 只有 `other/a.md`；或 CommonMark 允许跨行的 code span 中包含同样文本。
- **实际影响**：函数只维护围栏状态，且 inline code 状态每行重算。缩进代码示例会被改成 `    [a](../other/a.md)`，跨行 code span 同样可能被改。它们是代码内容，不是待修复的文档链接，违背“不改代码块”的 S4 边界。
- **证据**：静态确定路径：上述行既不匹配 fence，也不处于当前行的 inline code，随后直接命中 replacement。现有 `link-repair.test.ts` 只覆盖围栏与单行 inline code；未运行新增复现脚本。
- **最小修复方向**：识别 Markdown 的代码范围（含缩进代码和跨行 code span），仅在真正的 link 节点范围内修复。实施者增加上述两类反例，同时保留多候选不改、外链不改和 payloadHash 断言。

## Full 检查覆盖与安全判断

| 检查项 | 本轮证据与判断 |
|---|---|
| 路径/文件围栏、单文件硬限 | 写时 `resolveInside`、`validateStdDocPath` 和最终字节上限仍在；staging 校验的 symlink/path/header/source 检查未被 policy 登记降级。未发现此次绕过。 |
| 源变化、毒化、skip | 最终发布先 poison/快照校验；staging 仍逐源 `readVerified`，包括 skipped 源。skip 不跳过来源完整性。工具和服务端均限制工作集/理由/重复，manifest 持久化理由；full 空库硬拒绝保留。语义上“确无知识”仍由 Leader 声明，这是设计明示裁决，不把它误报为新漏洞；真实语义误判未验证。 |
| 原子发布与 CURRENT | 发布门禁在 release 写入和 CURRENT rename 前；此次未改提交点/租约。新增报告写盘在提交后，但 `writeReport` 自身捕获文件异常，不会因普通报告 I/O 错误进入删除 current release 的 catch。未发现此次破坏原子指针的路径。 |
| 审查闭环 | `review_missing`、blocking_issue_open、权威报告文件绑定和对象审查凭据仍阻断。未发现标准策略放行这些码。F01 是过严/缺功能，非漏审安全结论。 |
| verified-evidence 防伪 | key 包括证据身份、对象/claim、sourceRef、selector、quoteHash、role/nature/readReceiptId。服务端只对写时 verify 成功且声明落盘后的 evidenceId 登记；edit 走同一链。发布还检查当前快照、资源身份及两层 hash。不持久化该 Set，旧恢复/基线复制不签发，未命中回退 full；未发现模型可自行提交该凭据的工具字段。相关源变化/伪造 hash/无凭据测试通过。未做独立渗透或性能测量。 |
| strict 冻结/恢复 | 新建读取配置冻结到 entry/state/checkpoint/spec/guard；缺字段或不兼容 checkpoint 回 strict。strict 恢复后当前配置改 false 的入口测试通过。各政策收口点在 strict 下不降级。未发现动态配置把 frozen strict 放宽。 |
| 全局结构/归因 | 未登记规则失败封闭，结构码只对显式 scopeDemotable 的两类开放；不确定归因仍 block。已读 graph 结构、compiler 与发布合流。没有发现错误放行；有 F02 的过严路径。 |
| 派发/角色冻结 | 变化只把 scope 文本启发式变 advisory；角色/模型/工作目录/禁区/能力/delivery/身份与分配边界继续执行。标准 reviewer taskFile 的越界反例仍 block。 |
| 扩展与协议资产 | 构建脚本复制 skill/extension，adapter 显式加载 dist 的 dispatch-guard（开发回退 ts）；现有 dist guard 含 strictGates 分支。Leader 协议源/dist SHA-256 均为 `17ccce476df6a3e21cc9c1c94c4287e812e81e2f0cff9a936e93596bcbcf7a41`。本轮未重新 build，不能证明所有分发资产最终一致。 |
| flow / 字段与示例 | `documentWorkStatus.stageBlockedPaths`、`lastPublicationReport.blockingGroups/warningGroups`、skipped 的实际字段可对上；协议没有声称 S3 已生效，也没有声称未核实的并发池已限流。knowledge-skill-examples 4/4 通过。Leader 提及 draft_read 但自身没有该写作者读取工具的措辞在旧协议也有，不作为此次回归。 |
| 测试有效性 | 逐项阅读测试 diff：没有删测试/新增 skip；原 total/body 阻断场景改显式 strict 而非删除断言，有部分 standard 对照。测试仍未证明所有新增政策的真实服务行为，尤其 F01–F03；纯 policy 测试不能替代真实入口。 |
| 兼容/维护/性能 | additive 配置和检查点，缺省 pure gate/dispatch 行为严格。进程内 proof Set 及整候选序列化的体量成本未测；阶段记忆未实现承诺的重复消除。没有做全仓架构重构或范围外审计。 |

## 验证记录

工作目录均为工作树 `server/`，测试使用项目声明的 vitest 入口。

1. `npx tsc --noEmit`：**退出 0**（与首批测试串联，已实际进入 vitest）。
2. 首次相关 vitest 只传 `--maxWorkers=1`：**退出 1，0 测试**，Tinypool 报 `options.minThreads and options.maxThreads must not conflict`。属于运行参数不匹配，不记作代码失败；随后同时限定 min/max。
3. `npx vitest run tests/gate-policy.test.ts tests/link-repair.test.ts tests/knowledge-publish.test.ts tests/kb-knowledge-tools.test.ts tests/build-runtime-tools.test.ts tests/build-runtime-dispatch-guard.test.ts tests/kb-build-resume.test.ts tests/knowledge-skill-examples.test.ts tests/evidence-resources.test.ts tests/review-declaration-scope.test.ts --maxWorkers=1 --minWorkers=1`：**退出 0，10 文件、234 测试通过**。
4. `npx vitest run tests/knowledge-schema.test.ts tests/knowledge-governance.test.ts tests/build-runtime-review-authority.test.ts tests/build-actors.test.ts tests/kb-build-size.test.ts tests/kb-build.test.ts tests/kb-build-parallel.test.ts tests/kb-version.test.ts tests/progressive-knowledge-draft.test.ts tests/baseline-resource-carry.test.ts tests/config-manager.test.ts tests/build-runtime-e2e.test.ts tests/build-runtime-integration.test.ts --maxWorkers=1 --minWorkers=1`：**退出 0，12 文件通过、1 文件跳过；306 测试通过、3 跳过**。日志：`/tmp/kb-gate-review-additional.log`。
5. 合计：**22 文件通过、1 跳过，540 测试通过、3 跳过**。跳过为既有测试状态，本轮未改动。
6. `git diff --check aa69abd4807c6b03e984cf6aaa0c7dcf58b88230`：**退出 0**。结束时观察的 33 文件范围未变化。

### 验证可信度与盲区

- 编译与已有针对性回归可信；F01–F04 均明确为静态证实/需求差距，不冒充新增动态复现结果。没有为了复现向项目树添加测试。
- 未独立执行 npm build / 全量 npm test / Electron 真机 / 真实增量库或模型调用：用户授权此次为只读审核及 tsc/相关 vitest；P3 的其他运行日志只作为上游陈述，不当成本轮亲自复核结果。
- 原子失败窗口、全部 policy 的服务级 strict/standard 对照、恢复 skipped、缓存命中/失效和全量分发包哈希没有逐一动态复现。S2 安全退回 full 是合理防御，但不证明设计期待的跨构建性能收益已经兑现。
- 未发现 Critical 不等于没有安全缺陷。建议先完成 F01–F03 并补真正服务入口回归，再做增量复审；不要以本轮 540 测试通过覆盖完整规格缺口。

## 交付与回滚

本轮只新增本报告，无代码修复、无提交。回滚审核产物仅需由授权者移除本报告；实现补丁仍应按 P3 说明与并行同步 hunks 区分，不应回滚 aa69abd 前内容。
