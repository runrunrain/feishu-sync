# WP-F / WP-G / WP-H 对抗审查（full）

## 结论

**FIX：2 Major、1 Minor。** 未发现覆盖映射被锚点/keepObjects 自动保留绕过；发现构建外 token 泄露、部分度量缺源被静默解释为零，以及新增错误中的不可直接执行修复路径。

## 基线与范围

- 仓库：`/Users/run.mao/workpace/feishu-sync`；HEAD：`5473e16c0af0b8ac587a9d335f46dded4473aa29`；审核对象为当前未提交工作树。
- 必读上游：`agent-outputs/kb-build-speedup/wpG-report.md`、`wpF-report.md`、`wpH-report.md`（均已完整读取）。
- WP-G：agent-tool-service 的身份回退/移除提示、图片错误、token 建议、includeCoverage，以及 evidence-resources/tool-specs 对应增量。
- WP-F：build-metrics、kb-build-service 终态采集、build-runtime-host 拒绝日志、类型和只读报告脚本。
- WP-H：两篇 prompt、author-protocol/mcp-examples 与实际工具面/协议断言。
- 同 diff 的 WP-E（含证据重绑、CLI shim 等）**不重新审核、不新增其 findings**；按任务执行的相关回归测试仅提供集成信号。

## Findings

### R5-01｜Major｜近似 token 提示越过构建来源边界

- **定位**：`server/src/agent/agent-tool-service.ts:7346–7365`（尤其 7365）；入口例 `:1319`。
- **触发条件**：buildState 快照只含 `tokA`，全局 documentsProvider 另有未纳入本构建的 `PrivateSourceSecretToken9876`；模型调用 `raw_read({objToken:"Priv",offset:0,limit:10})`。
- **实际影响**：虽然读取仍报 not_found，错误却返回完整构建外 token。包含关系只要求四字符，构建角色可以从局部前缀探测不属于本构建 sources 的文档标识；不是正文读取权限被突破，但明确违反“建议只能来自本构建来源”的边界。
- **证据（动态复现）**：`review-5-probe.mjs` P1，实际错误：`原始文档不存在或无成功本地版本: Priv；你是不是想读 PrivateSourceSecretToken9876`。helper 在扫描 snapshot 后无条件追加全局 documents；优先级只是排序，不是来源过滤。其余调用同一 helper 的构建态错误路径也受影响。
- **最小修复方向**：构建态候选集严格限定本构建允许的 sources（至少不能混入 snapshot 之外 documents）；无合法候选就不提示。非构建态再使用其本身可见的 documents。由实施者补“构建外近似匹配不泄露”的正式回归测试。
- **归因**：WP-G 新增提示引入。

### R5-02｜Major｜部分度量缺失/损坏被当作真实零值，且没有缺口说明

- **定位**：`server/src/kb/kb-build-service.ts:8722–8726`；`server/src/kb/build-metrics.ts:287–334,385`；人读出口 `server/scripts/build-metrics-report.ts`。
- **触发条件**：至少一个来源存在（例如 actors.json 有一名 luban），但 reviews.json / publish-requests.json 不存在或损坏。
- **实际影响**：读取层 `null ?? []` 抹掉“不可得”和“真实空数组”的区别；聚合输出 `totalReviews=0`、`docsReviewed=0`、`publishRejections={}`，且 `notes` 不存在。报告据此显示审查回执 0、发布拒绝“无”，不能区分从未发生与证据已丢失。反向缺失 actors 时同样可能输出派发 0。这违反缺源不得编造的验收，污染提速/返工比较依据。
- **证据（动态复现）**：P6 仅创建 `actors.json=[{role:"luban"}]`：得到上述零值且无 notes；再写 `reviews.json='{broken'`，结果完全相同。P7 证明只有**全缺**才返回 null，因此现有“全缺降级”测试不能覆盖本反例。
- **最小修复方向**：向聚合层保留各文件的存在/解析成功状态；不可得指标置 null/省略并标注来源缺口，真实空文件才能表示 0/无；同步调整类型与报告显示。不得仅追加泛化说明而仍将缺失值作为确定事实展示。
- **归因**：WP-F 新增采集路径引入。

### R5-03｜Minor｜新增“coverageUpdates 改去向”建议在同次重写中仍被旧门禁提前拒绝

- **定位**：`server/src/agent/agent-tool-service.ts:3803–3826`；coverageUpdates 实际处理在 `:4315–4376`。
- **触发条件**：旧对象被 `cov` 映射；作者明确 `objects:[]`，同时提交 `coverageUpdates:[{itemId:"cov",sourceId:"tokA",category:"rule",importance:"important",disposition:"unresolved"}]`。
- **实际影响**：即便按新增提示显式改了去向，移除检查仍读取旧 draft.coverage，在处理更新前就抛同一个 kb_coverage_invalid，提示再次要求相同改法。作者进入无效修复往返；并不构成静默丢对象或门禁绕过。
- **证据（动态复现）**：P4，明确更新后仍拒，错误含“对象内容已无来源支撑时不重申对象，改用 coverageUpdates 按原 itemId 显式改去向”；持久化草稿与拒绝前字节等价。
- **最小修复方向**：若维持现有执行顺序，错误需明确指引**先** `kb_edit_doc` 单独变更覆盖去向、**再**重写移除对象；或在完整校验本次更新后对有效覆盖状态做移除检查，保留最终无悬空校验。
- **归因**：检查顺序既有；本次仅报告 WP-G 新增修复建议与实际路径不符，不将底层既有行为冒充回归。

## 验证证据

### 实际命令与结果

以下 server 命令 cwd 均为 `/Users/run.mao/workpace/feishu-sync/server`：

| 命令 | 退出状态 / 结果 |
|---|---|
| `npx tsc --noEmit` | 0 |
| `npx vitest run tests/kb-write-friction.test.ts tests/build-metrics-pi-amagi.test.ts tests/kb-edit-rebind.test.ts tests/kb-tool-param-tolerance.test.ts` | 0；4 文件、101 测试通过 |
| `npx vitest run` | 1；234 文件通过、1 文件失败、2 文件跳过；3611 passed / 1 failed / 18 skipped |
| `npx vitest run tests/knowledge-skill-examples.test.ts tests/evidence-resources.test.ts tests/kb-knowledge-tools.test.ts tests/build-runtime-tools.test.ts` | 0；4 文件、147 测试通过 |
| `node --import tsx ../agent-outputs/kb-build-speedup/review-5-probe.mjs` | 0；10 组独立探针观察与断言完成；其中 P1/P4/P6 重现 findings |

仓库根 `git diff --check`：0。

全量唯一失败是任务允许的 `tests/bundled-amagi.test.ts:165`：环境报告 configured/uninstalled，与期望 bundled 2.21.36 不符；未归因到 F/G/H。desktop-server-process 本轮没有失败，不需单独重跑。

完整全量输出：`agent-outputs/kb-build-speedup/review-5-full-test.log`。
探针源码/输出：`agent-outputs/kb-build-speedup/review-5-probe.mjs`、`review-5-probe.log`。

### 探针清单与可信度

- P1：本构建外近似 token 泄露（真实 executeTool 入口）。
- P2/P3：正文锚点、额外 keepObjects 均不能保留遗漏对象或绕过覆盖守卫；拒绝前后草稿一致。
- P4：显式 coverage 更新未到执行点就拒绝；验证新错误修复路径。
- P5：`includeCoverage:false` 仍 invalid_request，不因 falsy 值放行。
- P6/P7：部分缺失/损坏与全缺对照；采集函数真实磁盘读取。
- P8：未描述的 unavailable 图片即使提示带资源信息仍拒绝；更换冻结图片后写入仍拒绝，实际发布复核 `verifySnapshotIntact` 报 source_changed_during_build。图片媒体校验在发布复核，不声称写入点已毒化整个构建。
- P9：真实报告 CLI 子进程读取临时 SQLite，退出 0；数据库字节和 home 根文件名单前后相同。源码确实使用 `{readonly:true}`。
- P10：执行真实 `runPipeline` finally，故障注入 collector 抛错、metricsJson 列写入抛错；终态保留 failed，running=false，后续调度仍执行，捕获到告警。为隔离模型，preflight 人工失败，DTO/清理/调度使用夹具桩；不冒充 published 集成或真实模型验证。

探针只读项目源码，fixture 全在系统临时目录且 finally 清理。编写过程首次误用相对产物路径导致文件未创建，纠正后运行；P8 首版曾错误期待写入阶段检测 mediaHash，实测 kb_evidence_unresolved 后核实发布阶段真实检查位置，修订为验证真实发布复核。最终脚本与日志是通过的最终口径，不隐瞒探针开发中的失败。

## 覆盖与未发现问题的边界

| 维度 | 覆盖结论 |
|---|---|
| 正确性/门禁 | 实现未增加自动保留、锚点恢复或 keepObjects 分支；精确 objectId 回退仍走族排他/跨路径授权。声明、证据替换及发布门禁未见因本次提示改动被放宽。P2/P3/P8 与相关工具测试支持；不是对所有构造的完备证明。 |
| 安全/来源边界 | 提示泄露见 R5-01；图片提示仍在资源不存在分支抛错，无新增登记或放行。 |
| 终态/兼容 | 新指标 additive；metrics 写入晚于终态，故障隔离见 P10。旧 JSON DTO 透传由定向测试覆盖。 |
| 并发/性能 | 拒绝日志使用一次同步 append，单 Node 事件循环内无 read-modify-write 覆盖竞态；异常被捕获。未复现日志损坏或派发失败。同步磁盘写有事件循环阻塞成本，未做慢盘/磁盘满/多进程共享 epoch 压测，不保证零延迟。 |
| 读取边界 | collector 固定读取 build-actors/epoch 的权威文件，不扫描模型会话 JSONL；报告 DB readonly 有动态验证。构建 id/根路径依赖上游可信配置；本轮未做同 uid 恶意 symlink/并行替换文件的 OS 安全测试。 |
| WP-H 文本/断言 | 修改后的工具名均与可用面相符，面外 kb_get_plan 等有“勿调用/仅应用内”限定；协议/示例测试 7/7。新增自检要求保留限定词、证据范围和不确定性，没有要求少报问题、放宽证据或规避独立审查。 |
| 验证有效性 | 指定测试虽全部通过，却未覆盖构建外 token 与部分缺源；独立探针补到两个空洞。未修改或新增项目正式测试。 |

未做真实模型构建、生产知识库回填、UI/视觉审核、长期并发/慢盘压测。结论只适用于本报告声明的 F/G/H 工作树范围；全量结果不是全仓安全认证。

## 产物与现场保护

本轮仅新增本目录 `review-5.md`、`review-5-probe.mjs` 及两个验证日志；未改项目源码、测试或任何他人现场，未 commit/stash/checkout/reset。撤回本轮产物仅需移除这些明确属于本轮的报告文件，不应回滚共享工作树。

VERDICT: FIX
