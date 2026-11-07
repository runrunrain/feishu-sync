# review-6：R5 修复增量复审（full）

## 结论与基线

**R5-01、R5-02、R5-03 均关闭；本轮未发现修复引入的 Critical/Major/Minor。** 结论仅覆盖这三项修复及其直接影响链，不重签其他 WP 的实现。

- 仓库 `/Users/run.mao/workpace/feishu-sync`，HEAD `5473e16c0af0b8ac587a9d335f46dded4473aa29`；对象是未提交工作树 `git diff`，不是 HEAD 已提交代码。
- 完整读取上游：`agent-outputs/kb-build-speedup/review-5.md`、`wpG-report.md`（含 §12 修复）、`wpF-report.md`（含 §10 三态修复）。以 R5 原编号逐项复审。
- 仅写本目录报告、独立探针及取证日志/差异快照；未修改项目源码或正式测试，未操作真实知识库，未 commit/stash/reset/checkout。

## 原编号复核

### R5-01｜关闭：候选集冻结在本构建快照

定位：`server/src/agent/agent-tool-service.ts:7380` 的 `nearestObjTokenHint`；七个 helper 调用点 `1221,1292,1319,1438,1506,2309,5757`。

静态路径显示 buildState 存在时只枚举 snapshot.entries，documentsProvider 仅在 else 分支参与。独立探针以全局 `PrivateSourceSecretToken9876`、快照仅 `tokA/tokB` 对照：

- raw_search、raw_read、raw_csv_cells、raw_csv_find、kb_read_batch(raw)、raw_read_image 均命中真实 not_found，错误不含全局 secret。
- raw_read_image 为隔离测试配置 ready 识图依赖并显式工具覆盖；正常构建不提供此工具，不把夹具覆盖说成生产授权。
- 第七处 readRawContent 的 helper 位于非构建分支；构建分支直接读冻结快照。直接调用非构建内核验证其仍建议全局可见 token；discuss/work 的真实 raw_read 入口也仍给建议。
- 快照内 `tokAtokA` 仍建议 `tokA`。raw_links 本夹具缺引用数据源而先拒，不把此结果计入七个 not_found 调用点覆盖。

### R5-02｜关闭：缺源不再冒充零

定位：`server/src/kb/kb-build-service.ts:readJsonArraySource/readJsonlSource/collectLeaderOrchestrationMetricsFromDisk`；`server/src/kb/build-metrics.ts:aggregateLeaderOrchestrationMetrics`；`server/scripts/build-metrics-report.ts`。

探针逐场景使用真实磁盘采集层，再通过真实报告 CLI 子进程读取临时 SQLite：

| 场景 | 采集结果 | 人读出口 |
|---|---|---|
| 仅 actors.json 存在 | 作者=1；revisionRounds=null；publishRejections=null | 审查/发布拒绝为“不可得（…）”；notes 指名缺失文件 |
| reviews.json 损坏 | revisionRounds=null | “不可得（reviews.json 缺失/损坏，见口径说明）”；note 明确损坏 |
| publish-requests.json 缺失 | publishRejections=null | “不可得（publish-requests.json 缺失/损坏，见口径说明）” |
| JSON 文件真实空数组 `[]` | totalReviews=0；publishRejections={} | 回执=0、发布拒绝=无，不与不可得混淆 |
| 全缺 | null | 无可用来源，不展示虚构零度量 |

JSON 数组文件的真实空集是 `[]`；零字节 JSON 不是合法空数组，不能误称其为可解析零记录。JSONL 的空文件由读取层保留为 ok 空记录。

复用了 review-5 已有故障注入框架但本轮实际重新执行：真实 `runPipeline` finally 中 collector 抛错、metricsJson 写库抛错，构建仍保持 failed、running=false、后续调度执行且记录 warn。预飞故意失败以隔离模型，DTO/清理/调度为夹具桩；不冒充真实发布集成验证。

### R5-03｜关闭：有效覆盖与写入点守卫一致

定位：`server/src/agent/agent-tool-service.ts:3803–3876,4347–4406`；共享编辑路径 `6217–6305`。

| 对抗输入 | 动态观察 / 原子性 |
|---|---|
| 原 itemId 重述 mapped，仍指向本次移除 objectId | 新守卫拒 kb_coverage_invalid |
| 重述到不存在 itemId，而旧 cov 未重述 | 旧 cov 仍被检查，拒绝移除 |
| 重述已存在但属于另一个来源的 foreign itemId | 原 cov 不被豁免，拒绝移除 |
| 不重述任何旧覆盖项 | 仍拒绝，错误列出原 cov 与对象身份 |
| 同 itemId 重述 unresolved，但携带旧 targetKeys | 成功；最终 targetObjectIds=[]，不是保留悬空映射 |
| 同 itemId 重复，末项 unresolved / 末项 mapped | 两种顺序均拒；不存在 last-wins 绕过 |
| 重复两项均 unresolved | invalid_request（itemId 重复） |
| 重述 mapped 指向不存在的 ko_missing | kb_coverage_invalid（目标未注册） |
| 原 itemId 改为 unresolved 并移除全部对象 | 成功且保留覆盖项待处理状态 |
| 同次新增承接对象并 mapped→新 clientKey | 成功；最终映射指向新登记 objectId |
| kb_edit_doc 重述 unresolved | 成功但原对象仍在，声明继承未受损 |
| kb_edit_doc 尝试改变覆盖项 sourceId | 仍拒“来源不可变” |
| objectMerges（同篇两个同源证据对象） | 成功；旧对象移除，旧 cov 转向后继，不被新移除检查误伤 |

拒绝用例逐一比较 `knowledge-draft.json` **原始字节**与正文 Markdown 字节，全部不变。重试提示的“不落盘暂存”不等同于草稿部分提交。

#### unresolved 是否逃过审查

动态调用真实 `validateKnowledgeGraph`：重要 rule 的 unresolved 产生 `coverage_important_unresolved`。再调用真实 `applyGatePolicy`：strict=true 保持 blocking；standard/strict=false 转为带 demotedFrom 的 warning，仍可被发布结果感知。该策略位于既有 `gate-policy.ts:13`，本轮未修改。因而不能宣称所有模式都阻断发布，但也不是静默消失；与既有显式 coverageUpdates→unresolved 语义一致。新实现仅允许同次操作完成原先可分两次完成的动作。

#### 来源变更的真实观察（不误报为本轮回归）

`kb_write_doc` 使用**同一原 itemId 但换 sourceId=tokB**时确实成功，原 tokA 覆盖记录被整项替换；移除后没有仍引用已移除对象的有效 mapped 项。这不同于上表“改另一个 itemId、原 cov 保持不变”的拒绝情形。

已作对照：不移除对象、只用 kb_write_doc 重述 sourceId 同样成功。整项替换的 `newItemIds` 合并与 sourceId 校验来自既有 write 路径，R5 修复未新增它；kb_edit_doc 的不可变校验比 write 更严格也是既有差异。因此本轮不把“来源不可变”强加为 kb_write_doc 新契约，不列回归 finding，也不以本次通过宣称其具备来源归属权限保障。若需要跨入口统一来源不可变，应单独立项，不扩大本轮修复范围。

## 验证证据与可信度

所有 server 命令 cwd 为 `/Users/run.mao/workpace/feishu-sync/server`：

| 命令 | 退出状态 / 结果 |
|---|---|
| `npx tsc --noEmit` | 0（最终单独重跑） |
| `npx vitest run tests/kb-write-friction.test.ts tests/build-metrics-pi-amagi.test.ts tests/kb-edit-rebind.test.ts tests/kb-tool-param-tolerance.test.ts tests/kb-knowledge-tools.test.ts` | 0；5 文件 / 181 tests passed |
| `npx vitest run` | 1；234 文件通过、1 文件失败、2 文件跳过；3623 passed / 1 failed / 18 skipped |
| `node --import tsx ../agent-outputs/kb-build-speedup/review-6-probe.mjs` | 0；33 组观察，含 ≥3 个反例、5 种度量现场、CLI 与终态故障注入 |
| 根目录 `git diff --check` | 0 |

全量唯一失败是允许的基线 `tests/bundled-amagi.test.ts:165`：期望 bundled 2.21.36，当前 configured/uninstalled；不是本轮修复回归。其余未出现需要解释的全量失败。

本轮探针开发曾因 cwd 路径、导出名、编辑参数/工具白名单、合并夹具证据不足失败；均按真实错误核实后修正探针，未改项目来迁就探针。最后一次脚本完整退出 0。最初单对象跨篇合并触发既有 kb_object_registry_stale（最终空声明前置检查），正式保留的合并探针改用同篇双对象并给足共同来源证据；不把后者通过推广为所有合并形态通过，前者也不归因于 R5 守卫。

## 覆盖清单、盲区与产物

- 正确性/边界：覆盖已移除/不存在目标、旧项未重述、他源 itemId、重复输入、合法重映射、unresolved；写入点与发布策略分别核查。
- 安全/兼容：七个提示调用点静态追踪，构建候选边界与 discuss/work 对照；既有 sourceId 整项覆盖语义如实保留。
- 一致性：拒绝前后草稿/正文逐字节；共享 edit 与 objectMerges 正向实跑。
- 可观测性/终态：三态贯穿 collector/聚合/CLI；异常写库不改变终态。
- 性能/并发：无新增大规模扫描算法；本轮未做慢盘、磁盘满、多进程恶意替换或并发压力测试。复用现有声明锁及提交链，不声称形式化无竞态。
- 未做真实模型、生产构建、UI/视觉或迁移回填。探针使用系统临时目录并 finally 清理，SQLite 为隔离夹具；正式测试由实施者负责，本轮未编写项目测试。
- 证据：同目录 `review-6-probe.mjs`、`review-6-probe.log`、`review-6-targeted.log`、`review-6-full-test.log`、`review-6-scope.diff`。
- 撤回仅涉及上述 review-6 报告/取证文件；不要回滚共享项目改动。

VERDICT: PASS
