# P4b 增量独立复审

## 结论

**PASS；VERDICT: PASS（仅本任务声明的增量复审范围）。**

本轮未发现可复核的新增 Critical / Major / Minor。F01 原需求缺口关闭，未在所查路径发现修复引入的漏审；F04 两个指定反例通过。F02、F03 按 Leader 已批准的保留范围交接，不将未实现的完整优化重新判为失败。这不是对 P2 全规格、全仓或真实生产构建的无缺陷认证。

## 基线、输入与只读边界

- 目标：`/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/kb-gate-simplify`。
- 基线：`aa69abd4807c6b03e984cf6aaa0c7dcf58b88230`；全部补丁由 `git diff aa69abd` 界定，37 文件。本轮聚焦 F01 新签发/消费链和 F04 两个反例，不重做无因果关系的全仓审计。
- 上游输入（主树绝对路径）：
  - `/Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/kb-build-gate-simplify/p4-review.md`：F01–F04。
  - `/Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/kb-build-gate-simplify/p3-report.md`：含末尾 P4 修复和 F01 实施说明；旧段“未实施”按末尾实施记录理解。
  - `/Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/kb-build-gate-simplify/p2-design.md`：§2.3。
- 遵守根 CLAUDE.md。没有改代码、项目测试、依赖或 Git 状态，没有编写复现脚本、提交或运行真实库/模型；仅新增本报告。测试自身使用临时 fixture 目录。

## 原编号逐项结算

| 编号 | 结算 | 证据与限制 |
|---|---|---|
| F01（Major） | **关闭** | 标准模式签发 `subject:<path>`；证据/覆盖改动保留回执并补回对象凭据；正文/断言变化失效；strict/无策略/无 subject 的旧回执保持精确语义。新测试 10/10 本轮通过。发布和恢复消费见下表。没有发现修复引入回归。 |
| F02（Major，上一轮） | **保留、已接受** | 保守归因可能继续阻断历史问题；不宣称完整归因能力已实现。本任务明确不因未优化项重新判失败。 |
| F03（Major，上一轮） | **部分关闭，其余已接受保留** | 阶段确定性失败集合已纳入 `kb_restatement_stale`；最终→阶段共享与局部依赖记忆仍不完整。本轮不宣称这些效率承诺已兑现。 |
| F04（Minor） | **关闭（指定两反例）** | `link-repair.ts:13-17` 跨行保留 code-span delimiter，并跳过四空格/tab 缩进代码行；`link-repair.test.ts:14-21` 的两个独立用例本轮通过。未扩大为完整 CommonMark 解析器认证。 |

## F01 对抗路径核对

以下路径均相对目标工作树；“静态”不冒充动态复现。

| 失败假设 | 核对结果与证据 |
|---|---|
| 正文、对象、断言、关系或呈现变更仍凭旧回执发布 | `server/src/kb/review-authority.ts:231-281` 将规范化正文、来源列表、对象身份/语义字段、claimKey/riskCategory、触及对象的关系及呈现语义纳入摘要。对象新增/移出、关系端点/类型变化会改变投影；发布侧 `:427-438` 独立重算主体，不只信 receipt.status。正文修改与直接篡改 claim riskCategory 的动态用例通过；对象/关系/呈现各字段变更为静态核对，未逐项动态注入。 |
| 并发写窗口把新版本误签成旧审查主体 | `server/src/agent/agent-tool-service.ts:4357-4384,4417-4436` 在签发时同时核对 scoped declaration hash 与每篇原始 contentHash，任何不一致不签 subject，回落精确规则。签发段到 recordReview 之间没有 await；后续对象回写等待声明锁并重新核验。写入/编辑在同一声明锁内完成落盘、失效与重挂（`:2160-2187,5440-5500`），不是先放锁再补凭据。静态路径未见可让未审版本取得 subject 的异步间隙；本轮没有做受控调度竞态注入。 |
| 凭据补回顺带批准未审对象 | `agent-tool-service.ts:2839-2896` 只使用主体未变而保留的 pass 回执，要求来源快照一致、无 blocking issue、路径匹配；仅处理该路径非 tombstone 且非 passed/rejected 对象。新增对象会改变主体，无法命中此保留条件。evidence-only 测试同时断言同一 reportId 的机器凭据重挂、无待审及候选可发布；本轮通过。报告文件被覆盖/删除仍会被发布侧文件绑定核验拒绝，不能仅凭重挂对象字段取得发布权。 |
| strict 或旧回执被主体分支误放宽 | `review-authority.ts:310-321,427-464` 只有 `policy.strict===false` 才给 resolver，且所有 scopePath 都有 subject 键才启用主体分支。缺键/部分缺键走原精确规则。`build-actors.ts:792-802` 没有 retain 证明即失效。strict、无策略、删除 subject 键、workflow 漂移用例本轮通过；部分缺键为静态核对。 |
| 来源漂移被跳过 | 主体分支仍要求 `source-snapshot` 精确相等（`review-authority.ts:430`）；最终发布 `kb-build-service.ts:1988-2002` 仍复核冻结源完整性。旧精确链的来源快照漂移回归本轮通过；标准主体分支另由静态条件核对，没有冒称专门执行过标准模式快照攻击。 |
| review_missing / blocking_issue_open 被绕过 | `kb-build-service.ts:2018-2047` 仍经 missingScopedPassReviewPaths 与 canPublish；`review-authority.ts:486-501` 要求有效 pass 回执才覆盖路径；`orchestration-contracts.ts:436-442` 对有效报告的未关闭 blocking 保留硬拒绝。集成测试的缺审查与问题清单阻断场景本轮通过；不是仅凭对象 reviewStatus 放行。 |
| 阶段发布或恢复消费仍沿旧语义 | `kb-build-service.ts:1595-1608` 仅标准完整 subject 回执免 workflow 失效；`:1677-1702` 阶段 passReports 来自同一 authority，仍要求报告 pass、无未关闭 blocking、对象凭据绑定 reportId。候选组装 `:6340-6350`、手动确认 `:6538-6564` 均接 resolver。workflow 恢复测试通过；没有独立运行 selector-only 后真实阶段 CURRENT 晋级或人工确认全链。 |

设计明确排除 evidence/coverage、canonical/claim bodyRange、revision、审查凭据和 workflow 规则。能解析但不支持原断言的证据替换风险，是 §2.3 明示接受的标准模式代价，不作为本轮新增漏洞。实现额外纳入 aliases/domainIds/scopeText/businessStatus、关系有效期等字段属于保守收紧，不是以“宽松”跳过语义变更。

## 本轮实际验证

所有命令 cwd：`/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/kb-gate-simplify/server`。均为本轮独立执行，不借用上游日志。

1. `npx tsc --noEmit`：**退出 0**；与以下首批 vitest 以 `&&` 串联，实际进入并完成测试。
2. `npx vitest run tests/review-subject-standard.test.ts tests/build-runtime-review-authority.test.ts tests/build-actors.test.ts tests/review-declaration-scope.test.ts tests/link-repair.test.ts tests/kb-build-resume.test.ts tests/knowledge-publish.test.ts tests/kb-knowledge-tools.test.ts tests/evidence-resources.test.ts --maxWorkers=1 --minWorkers=1`：**退出 0，9 文件、186 测试通过**。
3. `git diff --check aa69abd && npx vitest run tests/build-runtime-tools.test.ts tests/build-runtime-dispatch-guard.test.ts tests/gate-policy.test.ts tests/knowledge-skill-examples.test.ts tests/build-runtime-integration.test.ts --maxWorkers=1 --minWorkers=1`：**退出 0，5 文件、127 测试通过**。
4. 目标工作树根另执行 `git diff --check aa69abd`：**退出 0**。

**合计：14 文件、313 测试通过，无失败或跳过；server tsc 通过。**

验证可信度：使用项目现有 vitest 入口和真实业务类，fixture 不是真实云端/生产资料。新增测试实际覆盖写入→独立审查→编辑→Leader 状态→authority/missing→候选组装；其中 candidatePublishable helper 并非最终发布 CURRENT 全链，不能将它的成功夸大为完整发布证据。并发安全主要依据锁与同步控制流核查，未做调度压力实验。检索中出现正则转义参数错误，后改 literal 查询成功；不是代码或测试失败。

## 未覆盖与交付

- 未运行全量测试、根目录 typecheck/lint、build、Electron/浏览器、真实模型或真实增量库；本轮没有前端改动验收事项。
- 未动态穷举对象/关系/呈现字段变更、报告破坏、多路径回执部分缺键，以及 selector-only 修改后的阶段/手动确认提交链。相应结论限于所列静态路径与现有回归，不宣称所有竞态已被实测排除。
- F02/F03 剩余项保持上游所述限制，不能对外宣传全规格优化完成。
- 本轮无修复 patch；无代码回滚事项。报告回滚仅需授权者移除本文件，不应撤销他人工作树改动。
