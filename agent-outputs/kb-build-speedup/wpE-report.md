# WP-E 报告：增量构建 kb_edit_doc 继承旧证据的跨构建回执自动重绑（E1）+ 4 个小摩擦（E2–E5）

日期：2026-11-07 ｜ 范围：任务书 E1–E5。实测证据：真实新构建 `b_20261107061134_8b2173` 写作者会话
`epochs/e1/home/sessions/--Users-run.mao-.feishu-sync-agent-builds-b_20261107061134-8b2173-epochs-e1-work--/2026-11-07T06-14-58-709Z_01a1b4a5-….jsonl`（只读取证；注意任务书给出的目录名 `--Users-run-mao-` 实为 `--Users-run.mao-`，按 token 定位）。

## 1. E1 根因（代码行，先答任务书的追问）

**为什么作者已读了覆盖范围仍失败？** 两级叠加：

1. **旧证据带着显式 `krr_stage_*` 回执 id 被继承**：`server/src/kb/progressive-source-snapshot.ts:264/293`（`seedProgressiveCarriedReceipts`）在阶段发布时把继承证据的回执改写为 `krr_stage_<hash(buildId, evidenceId, contentHash)>`——**绑定构建 ID**，跨构建必然失效。下一次增量构建的草稿携带该旧 id：`agent-tool-service.ts` `inheritDeclarationsForEdit`（现 `:6262` `...(item.readReceiptId ? { readReceiptId: item.readReceiptId } : {})`）原样平移进 `evidenceClaims`。
2. **显式 id 绕过自动选择**：writeDocCore 证据循环（修复前 `agent-tool-service.ts:3749`）`let readReceiptId = optStr(input, 'readReceiptId')`——「省略时按 selector 选覆盖回执」的自动选择**只对无显式 id 的证据启用**；显式旧 id 直达 `verifyEvidence`（`kb/evidence-locator.ts`），报 `readReceiptId 不在本构建回执登记（伪造或跨构建引用）`。作者随后 `raw_read(offset:0,limit:72)` 登记了覆盖回执，但旧 id 仍在 → **重试同错**（会话 06:18:43 与 06:19:47 两次同错可证）。

实测失败链（会话取证）：6 次 `kb_edit_doc` 被拒（4×`krr_stage_85a9…` 文本证据 + `krr_stage_3055…` CSV 证据）→ 试图一次提交 40 条 `evidenceSelectorUpdates` 被 schema `maxItems:20` 在**客户端校验层**拒绝（`expected at most 20 items`）→ 分批（≤20）提交时未更新的另 20 条继承证据仍带旧回执 → 原子校验再拒 → 放弃局部修订，整篇 `kb_write_doc` 重写（41 证据）。

## 2. E1 修复（agent-tool-service.ts + evidence-locator.ts）

writeDocCore 证据循环（kb_edit_doc 继承与 kb_write_doc 整篇重申共用同一校验链）：

- **继承证据识别**（`:3813` `priorEvidenceByKey`，`:3883` `inheritedUnchanged`）：按 clientKey 取既有证据记录，与本次输入做**逐字段一致**判定（objectId/claimKey/sourceId/resourceId/role/nature + selector 全字段，`evidence-locator.ts:529` 新增纯函数 `selectorIdentityKey` 做与键序无关的规范化序列化）。
- **解除旧回执**：仅当「继承未修改 且 显式 id 不在本构建回执登记」时置空旧 id，随后走**与新证据完全相同**的既有自动选择路径（同 `receipts.find(...)` 函数，未复制第二套）。workbook/media 等非行定位证据解除后按既有语义无回执也可通过（hash 校验不变）。
- **内容一致性红线（先行）**：继承证据在当前冻结来源上由服务端重新 `resolveSelector`，quoteHash 与旧记录比对——**不符即报错并指出 evidenceId**（`内容已变（quoteHash 不符）…不能静默继承`）；quoteHash 始终服务端重算，不接受自报。解引用失败同样报错指 evidenceId。
- **缺回执一次性聚合**（`:3927` 收集、`:3977` 抛出、`:1899` `missingReceiptScopesError`）：不再首条即拒。按 (sourceId, resourceId) 分组、合并相邻/重叠区间，按单次读取上限切块（text ≤2000 行、csv ≤20 record），复用 `evidenceReadHint` 生成精确 `raw_read/raw_csv_cells` 参数，逐条标注覆盖的 evidenceId；含继承证据时注明「补读后重试即可自动重绑」。单条场景保持原错误前缀（既有测试断言兼容）。

## 3. E2–E5（小摩擦）

| # | 实测 | 改动 |
|---|---|---|
| E2 | 40 条 `evidenceSelectorUpdates` 被 `maxItems:20` 客户端拒绝；分批又被原子校验拒 | `tool-specs.ts:1030` maxItems 20→80；`agent-tool-service.ts:5879` 服务端上限与提示同步 50/50/**80**/20/20。原子语义不变（writeDocCore 整体校验后一次提交） |
| E3 | 11 次 `draft_read limit:0` 被 `expected >= 1` 客户端拒绝（模型只想读声明） | `tool-specs.ts:200` limit minimum 1→0 + 描述注明语义；`agent-tool-service.ts:2306-2319` limit=0 与 includeDeclarations/declarationClaimKey/declarationObjectKey 或 metadataOnly 同用 = 只返回声明不返回正文行（returnedLines=0），无声明请求报精确错误。同类核查：raw_csv_cells recordStart 已由 WP-C 放宽；raw_read/draft_search/raw_search 等的 limit:0 无「读空」之外的语义（歧义），保持 min 1；offset 均 min 0——**未放宽** |
| E4 | 2 次 `raw_read {"kind":"raw_read",…}` 被 unknown field 拒 | 核对 WP-C 放开清单：raw_read **不在**（raw_search/raw_csv_cells/raw_csv_find/draft_read/draft_list/draft_search/kb_read_batch/build_issues_list/kb_tool_schema）→ 补：`tool-specs.ts:113` additionalProperties:true；`agent-tool-service.ts:6683` normalizer 忽略 `kind`+paramNotes，其余未知参数仍精确报错 |
| E5 | 2 次 `raw_csv_find` 只给 objToken+queries | `tool-specs.ts:156` resourceId 移出 required（否则客户端先行拒绝）；`agent-tool-service.ts:1499` handler：该来源**恰有一个** CSV 附件 → 自动选用并在结果 note 注明；无附件 → 精确说明；多附件 → 精确错误列出各 resourceId（名称 + 逻辑 record 行数）。normalizer 不再拦缺省 |

## 4. Changed files

- `server/src/agent/agent-tool-service.ts` — E1 证据循环（priorEvidenceByKey/inheritedUnchanged/重绑/quoteHash 红线/缺回执收集 + `missingReceiptScopesError`）；E2 服务端上限；E3 toolDraftRead limit=0；E4 normalize `case 'raw_read'`；E5 toolRawCsvFind 唯一附件解析 + note 合并
- `server/src/agent/tool-specs.ts` — E2 maxItems 80；E3 draft_read limit min 0；E4 raw_read additionalProperties；E5 raw_csv_find required/描述
- `server/src/kb/evidence-locator.ts` — 新增导出 `selectorIdentityKey`（纯函数；判定与校验逻辑零改动）
- `server/tests/kb-edit-rebind.test.ts` — 新增 18 用例（见 §5）
- `server/tests/kb-tool-param-tolerance.test.ts` — 2 处随新契约更新：raw_csv_find 缺 resourceId（唯一附件自动选用断言）+ §8 required 断言（raw_csv_find 缺 resourceId 现在通过 schema）

未动：review-authority / build-actors / dispatch-guard / publish-readiness / server/src/cli/* / prompts / progressive-source-snapshot.ts（krr_stage 生成机制保持）。

## 5. 测试（tests/kb-edit-rebind.test.ts，临时目录 + 手工快照，不依赖 SQLite、不读写真实数据）

（用例 18→23：§10 复审新增 5 项 R4 回归。）

跨构建场景模拟：staging1 写入 → 携带 knowledge-draft.json 与正文到 staging2，read-receipts.jsonl 不携带，证据 readReceiptId 改写为 `krr_stage_*`（与 `seedProgressiveCarriedReceipts` 的真实改写一致）。

| 验收项 | 用例 | 结果 |
|---|---|---|
| E1 继承旧证据 + 已读覆盖范围 → kb_edit_doc 成功且重绑 | 编辑成功、4 条证据 readReceiptId 全部 `rr_*` 且存在于本构建 read-receipts.jsonl、evidenceId 身份稳定 | ✅ |
| E1 kb_write_doc 整篇重申携带旧回执（共享 writeDocCore） | 同上重绑断言 | ✅ |
| E1 未读 → 一次性列出全部缺失范围 | 3 条证据（相邻文本合并 + CSV）单次错误含 2 条编号建议、精确参数与「继承自旧构建」提示；按提示补读后原样重试成功 | ✅ |
| E1 内容已变（quoteHash 不符）→ 报错指出 evidenceId | 独立源行 2 变更后即使已重读仍报 `内容已变（quoteHash 不符）` + evidenceId + 修法 | ✅ |
| E1 新证据伪造回执仍拒 | evidenceClaimsAdd + `rr_forged…` → `伪造或跨构建引用` | ✅ |
| E1 被修改的继承证据带旧回执仍拒 | evidenceSelectorUpdates 换 selector + 显式 `krr_stage…` → `伪造或跨构建引用`（身份不一致不进重绑分支） | ✅ |
| E2 | 25 项一次提交成功（>旧 20 上限）且全部重绑；81 项服务端拒绝；ajv 80 过/81 拒 | ✅ |
| E3 | limit:0+includeDeclarations 只返回声明（returnedLines=0）；+metadataOnly 可用；无声明请求精确错误；ajv limit:0 过/limit:-1 拒 | ✅ |
| E4 | raw_read+kind 成功且 paramNotes 注明；未知参数仍精确报错；ajv 放行 | ✅ |
| E5 | 唯一附件自动选用+note；多附件精确错误含名称与行数（表1 2 条/表2 3 条 record）；无附件明确说明；ajv 放行 | ✅ |

## 6. 验证（cwd=server）

- `npx tsc --noEmit` → **0 错误**；`npx eslint`（5 个改动文件）→ **0 问题**
- 定向：kb-edit-rebind **18/18**；kb-tool-param-tolerance + kb-knowledge-tools + knowledge-skill-examples + build-runtime-bridge **140/140**；kb-edit-rebind + param-tolerance + kb-author-efficiency + kb-knowledge-tools + progressive-source-snapshot + progressive-knowledge-draft + evidence-resources + evidence-budget + build-runtime-damaged-evidence + toolfix-regressions **288/288**；build-runtime-tools + review-blocking-issue-closure + review-subject-standard **104/104**；kb-build / kb-build-parallel / kb-build-resume / build-runtime-e2e / fix-e2e / raw-search / kb-version **203+7skip**；build-pipeline / agent-session / kb-discuss-integration / frozen-pipeline / knowledge-seam / kb-selected-build **66/66**
- 全量 `npx vitest run`：**3580 passed / 2 failed / 18 skipped**——失败 1 = `tests/bundled-amagi.test.ts`（任务书声明的基线失败）；另 1 = `tests/desktop-server-process.test.ts` 的 CPU 隔离时序断言（maxGap 204ms vs 180ms 预算，全量并发负载下超时抖动），**隔离复跑通过**，本任务未触碰任何 desktop/electron 文件
- 真实数据：仅只读取证（会话 JSONL 定位失败形状）；所有测试用临时目录；未调用真实模型

## 7. 回滚

全部为独立增量，无 schema/迁移/落盘格式变化：按文件内 `WP-E` 注释块反向 apply 三个源文件，或由 Leader 在隔离快照定向 revert 本任务 diff（`git diff server/src/kb/evidence-locator.ts` 全部为本任务改动；agent-tool-service.ts / tool-specs.ts 为共享文件，按 WP-E 注释甄别）。新增测试文件直接删除。E1 回退后恢复「继承证据显式旧回执即拒」的旧行为。

## 8. 安全性论证（哪些门禁没有放宽）

- **零伪造回执通路**：重绑只作用于「与既有记录逐字段一致的未修改证据」——其 id 被置空后，最终落盘的 readReceiptId **一律来自服务端自动选择的本构建真实回执**（verifyEvidence 照常校验回执存在、资源一致与范围覆盖）；伪造 id 的新证据（无一致既有记录）与「改了 selector/角色/来源仍带旧 id」的声明照旧被 `伪造或跨构建引用` 拒绝（有专项对照测试）。被解除的旧 id 不再进入任何校验，不可能冒充覆盖证明。
- **quoteHash 服务端重算、内容变更硬拒**：继承证据在当前冻结来源重新解引用并与旧记录比对，不符即报错指 evidenceId；资源存在性、sourceSnapshotHash/resourceHash 对账、CSV 全空拒绝、回执范围检查全部原样（288+104 项既有回归通过）。
- **缺回执仍然拒绝**：聚合只改变报错形态（一次列全 + 最少补读参数），不改变「无本构建覆盖回执不得写入」的判定；写入依旧原子（拒绝时正文不落盘）。
- **E2 只放大批量上限**：80 封顶（服务端+schema 双层），evidenceSelectorUpdates 逐项校验与整篇原子提交语义不变。
- **E3/E4/E5 只做无歧义形状容错**：limit:0 有且仅有「只读声明」一个语义且无声明请求时报精确错误；kind 为无害冗余（忽略并说明，未知参数仍拒）；resourceId 缺省仅在**唯一**附件时解析，多/零附件都报列明候选的精确错误——不做别名猜测（WP-C 已裁量的原则保持）。
- **未触碰**：read-receipts 登记格式、krr_stage 生成机制、审查/发布门禁、角色工具面、dispatch-guard、review-authority、思考强度、独立审查与原子发布。

## 9. 未覆盖与风险

- 聚合建议中 raw_read 的 hint 采用 evidenceReadHint 的段映射窗口（如整源单段时给 offset:0,limit:4）而非最小行窗——与既有 hint 同源同语义（保证坐标可执行），非最小字节数；分块上限（2000 行/20 record）与工具单次上限一致。（已由 §10 复审修复取代）
- 继承的 workbook/media 证据在重绑路径上按既有语义「无回执也可通过」（verifyEvidence 对非行定位证据本就不要求回执，hash 校验不变）；图片证据跨构建仍受 `rebindBaselineImageEvidence` 既有机制约束。
- desktop-server-process 的时序抖动在全量并发下仍可能出现（既有现象，非本任务引入）。

## 10. 复审修复（review-4.md R4-01/R4-02，2026-11-07 第三轮）

独立审查判 FIX：①（Major，新引入）聚合区间合并后按固定步长切块会**切断单条证据**——csv 1..15 与 16..30 合并为 1..30 后切 1..20/21..30，证据 16..30 跨两张回执，按全部建议补读后仍缺回执（单张回执必须完整覆盖 selector 的门禁未变，但建议不可满足）；②（Major，既有缺陷被新路径暴露）`evidenceReadHint` 文本分支取覆盖 segment 的整段 outStart/outEnd——长资源（4000 行）上永远建议 `offset:0, limit:2000`，selector 在第 3000 行时补读永不命中。两案均用 `review-4-probe.mjs` P4/P5 动态复现（修前探针输出 `P4 REPRO offset=0 limit=2000`、`P5 REPRO hints 1..20,21..30; selector16..30 still rejected`）。

### 修复实现（不放宽「单回执须完整覆盖 selector」门禁）

- **R4-02 交集换算**（agent-tool-service.ts `planRawReadWindow` + `rawReadAdvice`，所有调用点共用）：资源行区间按与各 segment 的**交集**逐段换算 `outStart + (resourceLine - resStart)`（派生行位移/多段分别换算），窗口与真实返回一致；4000 行第 3000 行的建议变为 `offset:2999, limit:1`。
- **R4-01 覆盖窗生成**（`missingReceiptScopesError` 重写）：初始窗 = 每个原始 selector 本身，仅在「合并后仍 ≤ 单次上限（text 2000 行 / csv 20 record）**且**可满足性判定通过」时并入前窗（窗可重叠）——任何合并不切断 selector、不产生超预算窗口；删除盲切分块逻辑。
- **可满足性判定（实测发现的额外必要约束）**：raw_read 单页受渲染字节软预算（17KB，含 [O/R(/C)] 坐标前缀；实测 1200 行短行页只返回 998 行）约束，窗口按 `planRawReadWindow` 保守估算渲染字节（估算 ≥ 实际，到达末行时加 source_links 余量），估算不过软预算才作为建议；raw_csv_cells 窗口按新增纯函数 `evidence-locator.ts csvWindowSerializedEstimate`（≥ 实际序列化）校验 16000 字符上限。**单条 selector 无法由单张回执覆盖时**（超行数上限 / 超字节预算 / 被派生内容分隔成多段——raw_read 每段单独登记回执），给出「拆分证据（evidenceSelectorUpdates）」的精确错误，不给无法满足的建议。

### 探针与回归验证

- `review-4-probe.mjs`（原样，断言未改）：修后 P4 处按预期**断言反转**（`unexpected accepted` = 按全部建议补读后重试成功，退出 1，REPRO 行 0 条）；断言翻转副本（/tmp，仅把 P4/P5 重试断言改为期待成功）：**全绿退出 0**——`P4 FIXED line3000: hint offset=2999 limit=1; retry accepted`、`P5 FIXED CSV hints 1..15,16..30; retry accepted`，门禁断言 P1/P2/P3/P6/P7/P8 全部保持。
- 新增回归（kb-edit-rebind.test.ts，18→23 用例）：①相邻 CSV 证据 record 1..15 与 16..30——建议窗口恰为 [1..15]/[16..30]（不切断），按全部建议补读后原样重试成功；②相邻文本证据 1..600 与 601..1200（合并后渲染字节超单页预算）——拆为两张互不切断且各自可单次整窗返回的窗口，补读后重试成功；③4000 行正文第 3000 行：建议 `offset:2999, limit:1`（非旧实现的 offset:0,limit:2000），按建议补读后重试成功；④派生行位移：图片描述块后的资源行按交集换算（资源行 4 → 输出行 7 → offset:6, limit:1），按建议补读后重试成功；⑤不可满足对照：超 2000 行 selector、超 20 record selector、被派生内容分隔成 2 段的 selector 均给「拆分证据」精确错误且不附带任何补读建议。
- 既有断言随新契约更新：kb-tool-param-tolerance (b)（offset:2, limit:1 精确窗口）、kb-edit-rebind 聚合用例（offset:1, limit:2）。

### 验证（cwd=server）

`npx tsc --noEmit` 0 错误；eslint（4 个改动文件）0 问题；定向 353+183 项全部通过（kb-edit-rebind 23/23、param-tolerance、author-efficiency、knowledge-tools、build-runtime-tools、toolfix-regressions、progressive-source-snapshot、evidence-resources/budget、damaged-evidence、kb-build 系、e2e、review-blocking/subject、raw-search、kb-version、skill-examples）；全量 `npx vitest run`：3587 passed / 1 failed = **仅 tests/bundled-amagi.test.ts 基线失败**（本轮 desktop-server-process 时序抖动未复现）。改动文件新增：evidence-locator.ts（csvWindowSerializedEstimate）；agent-tool-service.ts（planRawReadWindow/rawReadAdvice/重写的 missingReceiptScopesError/evidenceReadHint csv 体量检查）；回滚按 §10 注释块反向 apply。

### 残余风险

- 渲染字节估算为保守近似（页眉 700B + 每行 9B 余量 + 末页链接 6KB）：对极端页面（如超长单行密集页）可能保守地把可单次返回的窗口判为需拆分——方向安全（只多拆不盲给），不影响门禁。
- 派生内容分隔的 selector（如证据横跨图片描述块）现在明确报「拆分证据」——该类 selector 在旧实现中同样永远拿不到单张覆盖回执（隐式死循环），现在显式告知修法。
