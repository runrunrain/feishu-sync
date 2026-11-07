# WP-E 对抗审查（full）

## 结论

**FIX：2 条 Major（1 条新引入，1 条既有缺陷被新聚合路径暴露）。** 未发现已验证的未读范围放行或跨对象伪造回执绕过；但“按全部补读建议执行后原样重试即可通过”的核心效率承诺不成立。

上游输入：`agent-outputs/kb-build-speedup/wpE-report.md`（已完整读取）。
基线：HEAD `5473e16`，审查其上工作树 WP-E 改动：`server/src/agent/agent-tool-service.ts`、`tool-specs.ts`、`server/src/kb/evidence-locator.ts` 及两份相关测试。`server/src/cli/local-install.ts` / 对应测试为并行改动，未纳入审查。没有改项目源码或项目测试。

## Findings

### R4-01｜Major｜新引入：聚合切块切断单条证据，全部补读后仍缺回执

- **定位**：`server/src/agent/agent-tool-service.ts:1944-1954`（CSV 合并后固定步长切块）；同构文本路径 `:1931-1938`；单回执覆盖条件 `:3912-3922`。
- **触发条件**：两条相邻 CSV 证据分别覆盖 record `1..15`、`16..30`，旧构建中各自合法；新构建继承后尚未读取。聚合器把它们合并为 `1..30`，输出 `raw_csv_cells(1..20)` 与 `raw_csv_cells(21..30)`。
- **实际影响**：按全部建议读取后，第二条证据 `16..30` 横跨两张回执；自动选择仍要求**一张**真实回执覆盖整个 selector，故第二次提交仍失败，继续要求 `16..30`。长篇/相邻证据批次无法一次收敛，违背 E1 聚合建议契约。不是放宽读覆盖门禁的问题。
- **动态证据**：`review-4-probe.mjs` P5：先成功写旧草稿，再携带声明/旧回执到新构建，逐条解析并执行错误里的全部建议，原样重试仍报 `kb_evidence_unresolved`；输出 `CSV hints 1..20,21..30; selector16..30 still rejected`。两条原 selector 均不超过 20 records，不依赖超限输入。
- **最小修复方向**：建议窗口必须保证每个原始 selector 至少被一个窗口完整覆盖；合并不能跨越单回执上限后盲切（可按原 selector 生成覆盖窗再去重/合并，必要时重叠读取）。不要为修提示直接放宽单回执证据门禁。实施者补 CSV 边界及同构文本切块回归。

### R4-02｜Major｜既有缺陷被本次聚合路径暴露：长资源提示始终读取段首，补读永远不命中

- **定位**：新调用点 `server/src/agent/agent-tool-service.ts:1934-1938`；被复用的既有 `evidenceReadHint` `:1881-1883`。
- **触发条件**：原始正文是单个连续 text segment，共 4000 行；提交仅引用第 3000 行，当前构建未读。该 helper 取整个 segment 的 `outStart/outEnd`，而非 selector 在 segment 中的相对位置。
- **实际影响**：建议固定为 `raw_read(offset:0, limit:2000)`，同时声称覆盖资源行 `3000..3000`。执行后仍未覆盖第 3000 行，原样重试给出相同建议，形成无效补读循环。新聚合器对后续块调用同一 helper，也不能解决该问题；可能反复建议同一大窗口，读取量远超实际需要。
- **动态证据**：`review-4-probe.mjs` P4：4000 行正文、selector 第 3000 行；解析并执行所有建议后重试仍缺回执。真实输出：`line3000: hint offset=0 limit=2000; still missing after all suggestions`。
- **归因**：段首提示算法在 HEAD 已存在，不当作本次新增算法回归；但 WP-E 明确复用它作为“精确、一次性补读”基础，新承诺在该真实可达条件下失败。
- **最小修复方向**：根据 selector 与 segment 的交集计算 `outStart + (resourceLine - resStart)`；对派生行导致的多段分别换算，并确保单次上限与真实返回窗口一致。实施者补后半段及派生行位移回归。

## 核心风险逐项核对

| 项目 | 结果与依据 |
|---|---|
| 未读范围能否通过 | 未发现。P1：继承证据携带旧 `krr_stage_*`，新构建无真实覆盖回执时拒绝。解除旧 id 后仍走 `receipts.find` + `verifyEvidence`，不把旧 id 当覆盖证明。 |
| 修改证据冒充继承 | P2 动态拒绝修改行、claimKey、role、nature、source/resource、CSV columns；复用相同 clientKey 指向另一对象也被拒。逐字段判定使用最终 objectId，不是仅比模型 objectKey 字面。 |
| selector 完整性 | `selectorIdentityKey` 包含 schema 四类 selector 所有存储字段；columns/业务键等数组顺序被保留。lineStart/End、recordStart/End、资源路径、工作簿 sheet/range、媒体 region/hash 均在身份中。同 resourceId 还须属于指定 sourceId。 |
| quote/sourceRef/evidenceId | quoteHash 不由模型决定，服务端重算；sourceSnapshotHash/resourceHash 来自已核验当前资源而非自报。evidenceId 从 server 的 clientKey 映射确定，不能传另一对象 id 绕过 objectId 对比。任意额外 quote 字段不构成可接受的服务端证据内容。 |
| quoteHash 红线 | P3 实际写路径：当前来源选中行改变，即使已有当前覆盖回执仍拒绝继承。`resolveSelector` 对四类 selector 无分支豁免；P8 动态验证 text/csv/workbook/media 的选中内容或 caption 改变均改变 quoteHash。 |
| workbook/media 无回执语义 | HEAD 原本就仅对 text/csv 强制回执；`verifyEvidence` 对其他类型仅在显式提供 id 时验证。WP-E 把未修改旧证据的失效 id 清空，恢复已有“不提供 id 可写”语义，不构成新增加的行范围豁免。图片须使用当前 image 资源和 machine_description；imageHash 不符由解引用拒绝。 |
| 缺回执聚合 | 不通过：R4-01、R4-02。没有发现缺失范围被静默当作有回执，但建议不保证实际可满足全部证据。 |
| E2 上限 | schema 和服务端均 80；现有专项验证 80 schema 可过、81 schema/服务端拒绝，25 项真实提交成功。未改变原子校验。 |
| E3 limit=0 | P6 真实调用返回 returnedLines=0，不含正文标记；不请求声明/metadata 时精确拒绝。实现为 `lines.slice(offset, offset+limit)`，不使用 `limit || default`，非零请求不受影响。 |
| E4 raw_read | P6：`kind` 与其他未知字段并存时仍精确指出 unknownTypo；现有测试验证 kind 单独容错及参数说明。additionalProperties 放开没有取消服务端白名单。 |
| E5 唯一 CSV | P7 真实调用选中指定 objToken 唯一附件；现有专项覆盖多附件拒绝/零附件拒绝。读取只用 `snapshot.get(objToken)` 的已冻结附件，不按 query 猜资源、不扫描其他来源或别名。重复 objToken 在 snapshot Map 的覆盖策略是既有上游语义，不是此次新增别名选择。 |

## 动态验证记录

cwd：`/Users/run.mao/workpace/feishu-sync/server`。

1. `npx vitest run tests/kb-edit-rebind.test.ts tests/kb-tool-param-tolerance.test.ts tests/kb-author-efficiency.test.ts tests/kb-knowledge-tools.test.ts tests/build-runtime-tools.test.ts tests/build-runtime-toolfix-regressions.test.ts`
   - 退出 0，**6 文件 / 256 测试通过**，10.86 秒。
   - 测试可信度：确实走真实 AgentToolService 与临时 snapshot；继承回执模拟与服务端结构一致。但聚合用例仅四行小文本/单条 CSV record，无法证明 2000 行/20 record 边界的正确性。
2. `node --import tsx ../agent-outputs/kb-build-speedup/review-4-probe.mjs`
   - 最终退出 0；P1/P2/P3/P6/P7/P8 门禁断言通过，P4/P5 **成功复现缺陷**（脚本用“应继续失败”的断言记录问题，退出 0 不表示产品通过）。fixture 均在系统临时目录，finally 删除。
   - 一次性脚本：`agent-outputs/kb-build-speedup/review-4-probe.mjs`。至少 3 个独立攻击/边界反例，实际含未读、身份变更、变更 quote、长文本、跨块 CSV、limit0、未知参数与唯一附件。
   - 取证脚本准备期间曾因 cwd 相对路径不存在、源 token 出现在输出标题、替代资源只有一行、源变更后复用旧 snapshot 而失败；均修正 fixture/顺序后完成，不计为产品问题。未为通过探针改变项目代码或降低门禁。
3. `git diff --check`
   - 开始及最终运行均退出 0，无空白错误。

## 覆盖、盲区与剩余风险

- 正确性/边界：覆盖 E1–E5、selector 身份、quoteHash、上限、聚合失败与无正文语义。
- 安全/权限：检查真实覆盖回执、source/resource 所属与对象身份，运行现有 runtime 授权/写入回归；未发现本轮可复现的越权放行。
- 一致性/并发：本次未更改提交锁与原子落盘路径；相关 runtime 回归通过。未额外做并发压力/崩溃注入。
- 兼容/迁移：无存储迁移；跨构建携带旧回执已动态复核。既有 parseSelector 对 text contextHashBefore/After 的不保留、snapshot 重复 token 合并策略不归为本轮回归。
- 性能/可维护性：聚合路径复用旧 hint 的坐标错误及跨块不相容已证实；未跑超大证据清单性能基准，也未设定未获需求支持的响应大小门槛。
- workbook/media 的 hash 改变通过真实纯函数测试，加上 writeDocCore 无分支的静态链路；未用真实 xlsx/视觉模型构造跨构建端到端运行，因此不把纯函数证据表述成该类完整 E2E。没有访问真实知识库或模型。
- 本轮无前端变更，不做视觉审查；未跑全仓测试/typecheck，不能引用上游报告的全量结果作为本轮亲测。
- 回滚：仅新增本报告及一次性脚本；如需清除审查产物，仅删除这两个授权文件，不触碰项目源码/他人现场。

VERDICT: FIX
