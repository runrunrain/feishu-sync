# WP-D 报告：作者/审查者阅读效率与首稿质量（D1–D4）

仓库：`/Users/run.mao/workpace/feishu-sync`。诊断输入：`agent-outputs/kb-build-speedup/diagnosis.md`（R4、R5 前两条）。
实测数据源：`~/.feishu-sync/agent/builds/b_20261105233621_7161f7/epochs/e1/home/sessions/`（只读取证）。

## 1. 变更文件（本任务写面）

| 文件 | 变更 |
|---|---|
| `server/src/agent/agent-tool-service.ts` | D1：`toolRawRead`/`toolKbReadBatch` 字节预算裁页；D2：claim bodyRange 拦截、写入期机械提示（链接/计数/空节）、回执正文提示输出；模块级 `sliceWithByteBudget`/`collectClaimLocationHints` 与两个预算常量 |
| `server/src/kb/link-repair.ts` | 新增 `findMissingRelativeMdTargets`（守卫与 repairRelativeMdLinks 镜像，发布链路零改动） |
| `server/src/kb/mechanical-precheck.ts` | 新增 `checkDraftCountClaims`（计数声明 vs 紧随枚举，纯函数） |
| `server/src/agent/skills/knowledge-build/mcp-examples.md` | D1 读取示例（limit 120→300、batch 多请求、预算说明、并行读取指引）+ D4 schema 查询诱因消除 |
| `server/src/agent/skills/knowledge-build/author-protocol.md` | D3 写前/交接前自查清单（净增 6 行）+ item5 并行读取句（行内追加） |
| `server/src/agent/skills/knowledge-build/reviewer-protocol.md` | 定向复核句 + 分页预算句替换（净 0 行） |
| `server/tests/kb-author-efficiency.test.ts` | 新增：D1×3 + D2×6（含纯函数误报边界）共 10 用例 |

共享文件 `agent-tool-service.ts` 同时含 WP-C 的参数规范化/证据文案改动（互不重叠）；`leader-protocol.md`、`tool-specs.ts` 等其余 git 修改属并行任务，本任务未触碰。

## 2. D1 阅读回合数

### 量化依据（7161f7 实测）
- **服务端上限本就不小**：raw_read 默认 `limit=800`（max 2000）、kb_read_batch 默认 `maxLines=1200`（max 4000）。**瓶颈是协议示例诱导**：mcp-examples.md 示例 `limit:120` / `maxLines:100`、正文写明「单次限制 120 行」。
- **真实行为**：456 个 raw_read 页，`returned` 中位数 **120 行**（max 200）——写作者照抄示例；296/366 个含 raw_read 的回合只发了 **1 次**调用（顺序翻页，每回合一次完整 LLM 往返）。
- **线上截断阈值**：pi 客户端对 MCP 工具输出做**中段截断**，上限 `MCP_OUTPUT_MAX_BYTES = 20*1024`（pi dist/extensions/mcp/tools.js 实核）。120 行页实测：字节中位 4248 / p90 10240 / p95 11486 / max 20705；**每行字节数中位 45 / p90 106 / p95 154**；3/456 页（0.7%）因个别超长单行（单行最高 18KB）被 pi 截断。
- **结论**：128k 上下文 / maxTokens 32768 下，单页源文本 **11KB**（约 3.7k 中文字符 ≈ 4–6k token 含坐标前缀与回执页眉）是安全体量：稀疏页（45B/行）约 240 行/页（2× 旧行数），密集页（154B/行）约 70 行/页，加前缀/页眉后仍 < 20KB 截断线。

### 改动
1. **代码**：`RAW_PAGE_TEXT_BUDGET_BYTES = 11_000`——raw_read 的 slice 改为「行数 limit + 字节预算」双约束（`sliceWithByteBudget`，至少 1 行保证推进；build 态与会话态两分支同改）；kb_read_batch 增加单次调用共享 `KB_READ_BATCH_TEXT_BUDGET_BYTES = 11_000`（raw/draft 请求同受约束，预算耗尽后剩余队列整体进 `nextCursor`，续页重置——与 F05 行预算同语义，无死锁：首请求恒有 ≥1 行）。
2. **契约不变**：`<raw_page next_offset>` 仍是唯一续页坐标（= offset + 实际返回行数）；`returned` 如实报告；读取回执按实际窗口登记；空白 CSV 折叠/`<skipped_blank_csv_rows>`/`includeBlankCsvRows` 语义不变（回执与 returned 按未压缩原文计算的原逻辑未动）。
3. **协议/示例**：raw_read 示例 limit 120→300 并注明「行数+字节双预算、密度高的页自动缩短」；**新增并行读取指引**（一次回复内多个互不重叠 offset 的 raw_read，每页回执独立登记）——7161f7 已证明同回合多调用可行（60 回合 2 次、9 回合 ≥3 次）；kb_read_batch 示例改为多请求 + `maxLines:1200`（缺省值），删除「约 120 行」限制语；reviewer-protocol 的「单次控制在约 120 行」同步替换；author-protocol item5 追加并行翻页句。

### 测试
`tests/kb-author-efficiency.test.ts`：密集源自动裁页（returned<total 且 >1、next_offset 推进、**多页拼接逐字节还原源文件**、回执登记）；小源不受预算影响；kb_read_batch 双密集源分页续读不重不漏（两次 token 各 41 行全量覆盖、必然出现续页）。回归：build-runtime-tools（kb_read_batch 原预算/游标/截断用例）、agent-session、kb-discuss-integration、raw-search、raw-links 等全部通过。

## 3. D2 写入期机械拦截/提示

核对结论：mechanical-precheck（发布前审查提示）、knowledge-validator（`kb_link_invalid` 发布门）、link-repair（唯一 basename 修复）、reference-graph 均在**发布/审查**段，kb_write_doc 写入期此前仅有 claim bodyRange 的「正文范围越界」检查，无覆盖性/链接/计数检查；`kb_coverage_invalid`（(d)）已存在且完整（目标对象不属于本篇、重要映射降级绕过、移除对象仍被覆盖引用、编辑路径的 itemId/来源/分类守卫）——核对通过，未新增。

| 项 | 判定 | 实现 | 误报分析 |
|---|---|---|---|
| (a) claim bodyRange 超出对象正文范围 | **拦截**（`kb_claim_range_invalid`，4xx） | 显式 claimRange 不含于对象 bodyRange → 拒绝；错误给出 claimKey、两侧行区间与修正字段；`rememberFailedWrite` 自动附 `retryOf` 暂存令牌（测试断言） | 结构性包含检查，零语义判断：`computePayloadHash.relRange` 以对象起点为原点（knowledge-schema L438-455），发布链路同假设；显式越界声明无合法场景（仓库与测试无反例） |
| (a′) 对象正文范围无内容行但声明 claims | 提示 | headingPath 解析/显式 bodyRange 的行窗内无非标题非空行 → 回执提示（不拦截） | 标题行不计内容；csv 导入占位行非空不命中；全文对象跳过。指向错误小节（B3c-B2 样本的可判子集）几乎必错，仍按提示处理留人工裁量 |
| (b1) 相对 .md 链接目标不存在于草稿∪已发布∪当前分配 | 提示 | `findMissingRelativeMdTargets`（守卫镜像 repair：围栏/缩进/行内代码/图片/外链/绝对路径/锚点/非 .md/带 % 转义全跳过）→ 回执提示「发布门禁会拦截…若属并行任务产出请核对分配路径，否则修正或改文字提及」 | **不选拦截的原因**：并行构建中前向链接（兄弟任务尚未写出）合法；但已分配目标在 knownPaths 内不提示，未分配目标本构建内不可能出现——提示语义准确。同时是 kb_link_invalid 发布门的**前置预警**（R3 晚发现→早发现） |
| (b2) 链接指向主题不符文档 | 不机械判 | （语义不可判，任务书限定只提示）由 D3 清单「链接先 draft_list/draft_read 确认主题相符」承接 | — |
| (c) 计数声明 vs 枚举数 | 提示 | `checkDraftCountClaims`：行内「N<项/条/类/种/计/大/点/维/步>」+ 同行「、」枚举或冒号/列举语引出的紧随列表，数量不一致 → 提示（≤6 条） | 防误报：N=1（不定指）、「第N」（序数，按捕获组真实起点判定）、表格分隔行、围栏内、末段「等」（开放式不可核）、「与/和」连词末项 +1（「分为三类：攻击、防御与辅助」不报）、3~5 范围尾数等场景跳过或正确计数；宁漏报勿误报 |
| (d) 覆盖项归属 | 已存在 | `kb_coverage_invalid` 写入/编辑两路径核对无缺口 | 未改动 |

**输出通道关键发现**：pi 只把 MCP `content` 块交给模型（renderRawReadPage 注释同证），`details.warnings` 对子任务不可见——因此全部提示同时写入**回执正文**（`提示（不阻断，逐条自查）：…`，封顶 8 条）与 `details.warnings`。kb_write_doc 与 kb_edit_doc（同一 writeDocCore 校验链）都生效，kb_edit_doc 测试验证补丁引入缺失链接同样提示。

## 4. D3 协议精炼

- author-protocol：新增「写前/交接前自查（高频返工项）」6 行（限定词与状态保留、双口径并列标未统一、不写源外行、raw_csv_cells 逐格核对+项数一致、链接先确认主题、交接前 coverage 自查）；与既有「不要目测数逗号」「coverage 提交」内容互补不重复。**净增 6 行 ≤ 8**（numstat 7+/1−，其中 1+/1− 为 item5 行内追加并行读取句）。
- reviewer-protocol：「复核只读被问题指向的范围与当前声明，不重读全篇」并入定向复核条目（原句不存在，无重复）；「约 120 行」分页句替换为预算语义（净 0 行）。
- handoff/achievement-protocol 结构未动。

## 5. D4（可选项，已做低风险部分）

7161f7 实测：`kb_tool_schema` 70 次（draft_read 32、kb_edit_doc 10、raw_search 6…）、`mcp_list_tools` 13 次；多为会话开头成对探测。诱因：mcp-examples 首段「需要完整参数契约时调用 kb_tool_schema」与常见错误段「参数结构不符 → 调用一次 kb_tool_schema」的**无条件措辞**。已改为：「本文件示例已含常用工具的完整参数面，按示例直接调用，不要先查 schema；确需示例外字段或报错不明时才调用，同一工具一次会话不重复查」与「先按报错字段名与本文示例修正；仍不明才调用一次」。author-protocol 既有克制条款未动。未改 tool-specs.ts（不在写面）。

## 6. 测试与验证

- `cd server && npx vitest run tests/kb-author-efficiency.test.ts` → **10/10 通过**。
- 定向回归（全部通过）：knowledge-skill-examples（示例契约 7/7）、build-runtime-tools（84）、link-repair + kb-knowledge-tools（73）、kb-mechanical-precheck + kb-precheck-integration、build-pipeline / build-runtime-e2e / fix-e2e / toolfix-regressions / kb-build / kb-tool-param-tolerance（133）、frozen-pipeline / knowledge-seam / kb-build-parallel / kb-build-resume / kb-selected-build / review-blocking-issue-closure / build-runtime-bridge（102）、agent-tool-families / build-runtime-child-policy / kb-whiteboard-text / evidence-resources / governance-seam / kb-version（144）、agent-session / kb-discuss-integration / raw-search / raw-links（40）。
- `npx tsc --noEmit` → **0 错误**（任务书基线 3 个 portable-kb-service 错误已由并行任务修复；过程中出现的 build-leader-supervisor.ts 42 错为兄弟任务中间态，非本任务引入，最终已消失）。
- 未跑全量 vitest（bundled-amagi 1 项为已知基线失败；与写面无关的广域套件按任务书针对性层级未全量执行）。

## 7. 回滚说明

全部改动为独立增量：还原 `agent-tool-service.ts`、`link-repair.ts`、`mechanical-precheck.ts` 中标 `D1`/`D2` 注释的块与三份协议 md 即可；新增测试文件直接删除。无 schema/迁移/落盘格式变化；预算常量回退为原 `lines.slice(offset, offset+limit)` 即恢复旧行为。

## 8. 未做项与风险

- **未做**：(b2) 语义主题不符的机械判定（不可判）；计数检查仅覆盖「计数声明+可定位枚举」同段情形（跨段枚举漏报，按设计接受）；tool-specs.ts 的 limit 描述文案（写面外）；未动 leader-protocol.md。
- **风险**：① 极长单行（>11KB）单行页仍会被 pi 截断（客户端临时文件兜底，实测 3/456，行为与旧版一致）；② 计数提示对「部分列举」可能偶发提示（如「五类，以下列举前三」未含列举语时按列表计数）——仅提示且有 6 条上限；③ 链接提示对「本构建确实会出现但尚未分配」的目标会提示——按当前分配机制该路径无法出现，提示语义成立，若未来允许未分配新路径需把该集合扩展；④ 回执正文新增提示行——旧解析首行的消费方需容让（仓库内测试已全过；与 WP-C 的 appendParamNotesToResult 同形态）。

## 9. 复审修复（Major R5，2026-11-06 第二轮）

**问题（review.md R5，已复现确认）**：D1 首版预算只算原文切片字节。kb_read_batch 的最终响应是 `JSON.stringify(..., null, 2)`——反斜杠/引号转义、segmentMap/元数据、声明与 cursor 均不计入：R5 反例（90 行×120 反斜杠，源文 10,889B）单页响应 22,389B > pi 20,480B 截断线，却返回 `truncated:false`、登记覆盖全部 90 行的回执——模型可能失去正文中段，仍可引用"完整"回执。raw_read 同类：坐标前缀/页眉/末页 `<source_links>`（上限 30+30 条，可达 ~15KB）在裁页后追加，不参与预算。

**修复原则（按反馈）**：预算对象改为**最终实际发送的 content 文本** UTF-8 字节；裁页定型后才登记与返回内容一致的回执；不可装入的原子单元（单行/声明）显式续传或报精确错误，绝不声称完整读取；next_offset/回执/空白折叠/截断标记契约不变。

### 实现（agent-tool-service.ts）

- **阈值与依据**：pi 截断线 20,480B（`MCP_OUTPUT_MAX_BYTES`，实测依据见 §2）。`TOOL_PAGE_SOFT_BUDGET_BYTES = 17_000`（≈17% 裕量：封套/分隔符/测量误差）+ `TOOL_PAGE_HARD_CAP_BYTES = 19_500`（≈5% 裕量，仅不可再分原子单元可 riding）+ `KB_BATCH_QUEUE_JSON_MAX_BYTES = 8_000`（游标 base64 膨胀 ~4/3 后必须仍可装进软预算，超限报 `kb_read_batch_queue_too_large`）。
- **raw_read（renderBudgetedRawReadPage，build/会话两分支共用）**：窗口装配为纯函数（不登记回执），`assemble(lineCount)` 生成含页眉/坐标前缀/回执头/空白折叠标记/末页链接块的**完整文本**；二分（`fitWindowByBytes`）+ 非单调逐行回退兜底定型；定型后才 `appendReadReceipts(window.receipts)`。单行+页眉超硬上限 → `<oversized_line output_line bytes>` 显式跳行页：returned=0、next_offset=+1、**不登记该行回执**、正文给出 raw_search/raw_csv_find 指引。末页链接块超预算 → 按行截短（保留 closing 标签 + `raw_links` 注记），正文行不因链接被裁。
- **kb_read_batch（精确账本 admit）**：每项候选项用与最终响应**同格式**的序列化（`docBytes([...results, item], 投影游标, linesUsed)`）精确计量——JSON 转义、segmentMap、声明、cursor 全部计入；多请求逐项累计。装不下时：raw/draft 先二分裁行；raw 单行仍超硬上限 → `oversizedLine` 项（returnedLines=0、note 声明不登记回执、游标推进 offset+1）；draft `includeDeclarations` 原子超限且本页为空 → 精确错误 `kb_read_batch_item_too_large`（提示用 declarationClaimKey/declarationObjectKey 过滤）；已有结果时把请求 unshift 回队经 nextCursor 续传（F05 续页预算重置语义不变）。尾断言：最终文本 > 硬上限即抛 `kb_read_batch_output_too_large`，不返回会被截断却声称完整的响应（正常路径由 admit 精确账本保证不达；唯一未投影增量是 break 时 unshift 的一个请求项 ≤ ~1KB，在 2.5KB SOFT/HARD 裕量内）。
- **契约保持**：`<raw_page next_offset>` 唯一续页坐标、`returned` 实际行数、回执按未压缩原文窗口、`<skipped_blank_csv_rows>`/`includeBlankCsvRows`、F05 游标重置、每请求每调用至多一页——全部不变（build-runtime-tools 既有 84 用例全过）。

### R5 反例修复前后（真实 AgentToolService 复跑附录脚本）

| | 修复前 | 修复后 |
|---|---|---|
| page1 | 22,389B、returned=90、truncated:false、cursor:null、1 份回执盖 90 行 | **16,894B**、returned=67、truncated:true、cursor 有 |
| page2 | — | 6,178B、returned=23、收口 |
| 回执 | [1..90]（与可能被截断的内容失配） | **[1..67],[68..90]**（与实际返回逐页一致） |

### 新增回归（tests/kb-author-efficiency.test.ts，10→15 用例）

1. **R5 反例转测试**：kb_read_batch 每页最终 JSON ≤ 17,000B；首页 truncated:true + nextCursor；逐页断言**本页新增回执覆盖行数 === returnedLines**；多页拼接逐字节还原源文；回执总覆盖恰为全文行数（不重不漏）。
2. raw_read 同源：页文本（含页眉/坐标/回执）≤ 17,000B、单页 end、回执覆盖 [1..91]（文本不经 JSON 转义，正确地单页返回）。
3. 超大单行（raw_read）：`<oversized_line>` 页 returned=0、next_offset 推进、该页零回执、**任何回执都不覆盖被跳行**、其余行拼接无损。
4. 超大单行（kb_read_batch）：`oversizedLine` 项不登记回执、游标推进到下一行、其余行经游标读全。
5. draft 声明原子超预算（8k 字符 < summaryOnly 18k 阈值但 ≈24KB 字节 > 硬上限）：报 `kb_read_batch_item_too_large` 且提示过滤参数，不截断不声称完整。
（原有 10 个 D1/D2 用例全部保留并通过；D1 密集源 fixture 加密至 ~810B/行以适配更大软预算。）

### 验证（本轮）

- `npx vitest run tests/kb-author-efficiency.test.ts` → **15/15**；build-runtime-tools + knowledge-skill-examples + kb-knowledge-tools + link-repair → 142/142；build-pipeline / e2e / fix-e2e / toolfix-regressions / kb-build / agent-session / kb-discuss-integration / raw-search → 125 passed + 7 skipped。
- `npx eslint`（本任务 4 个源/测试文件）→ 0 问题；`npx tsc --noEmit` → 0 错误（过程中出现的 agent-tool-service.ts:5151 `originBindingOf(targetPath)` 类型错误为兄弟任务 R1/R2 修复的中间态，非本任务代码，随后已由对方消除）。
- 未动 tool-specs.ts 的 required（R4 属 WP-C 写面）、review-authority、dispatch-guard。

### 残余风险

- 硬上限 19,500B 与 pi 20,480B 间 980B 裕量假设客户端封套不再放大文本（实测 pi 按 content 块原文截断，成立）；若未来客户端在文本外再包信封需回调硬上限。
- `<oversized_line>` 跳行改变了"被截断也能看到头尾"的旧行为：超大单行（>~19KB）现在完全不可见、以标记+检索指引替代——更诚实（不产生引用被截内容的回执），但模型需按指引用 raw_search 取短语。
- mcp-examples.md 已补 `<oversized_line>` 一句说明；协议净增量一句。

## 10. 增量复审修复（review-2.md R5-A/R5-B + 登记时序风险项）

**R5-A（Major）**：kb_read_batch 同页已有结果占用软预算时，后续**正常**单行（如 5KB）因 admit 整页校验失败落入 `chosenLines<=1` 分支，被误报"超单页硬上限"跳过；末行时不重入队 → 永久丢失（有回执缺口、cursor 可为 null）。
**修复**：admit 失败后先判 `aloneBytes = docBytes([item], cursorOf([request,...queue])) ≤ 硬上限`（"空页+完整封套"口径）或 `chosenLines>1` → **defer**：`queue.unshift(request)` 经 nextCursor 下一页续读（预算每页重置，下一页整行返回并登记回执）；只有空页完整封套下仍超硬上限才进入不可分单元处理。正常行不再被误报/丢弃。

**R5-B（Major）**：draft 不可分超长单行（如 25KB、无声明）在空页也超硬上限 → 旧行为 `unshift+break` 返回空 results + **不推进的 cursor** → 无限重复；raw 超长单行被静默跳过丢内容。
**修复（无损行内分片续传）**：不可分单行（raw 与 draft 同机制）按 **UTF-8 码点边界**分片交付：item 带 `lineChunk:{line,charStart,charEnd,totalChars}` 与 note，游标内部携带 `lineCharOffset`（不经工具 schema 暴露，cursor 不透明回传），续传拼回整行、**必定推进且终止**；分片页每页仍 ≤ 软预算（精确账本）。**回执语义**：分片行不登记任何读取回执（现有 selector 是整行/行区间坐标，无法表达"行内片段"，登记即允许引用未交付字节）；note 明示"分片不可作为证据引用，精确短语用 raw_csv_find/raw_csv_cells（raw）/ 缩小范围（draft）"。draft `includeDeclarations` 时先判驱动者：空文本+声明仍超硬上限 → 声明原子不可分，保留精确错误 `kb_read_batch_item_too_large`；否则分片正文（声明不随分片返回，note 引导 declarationClaimKey 单独取）。raw_read 的 `<oversized_line>` 标记保留（raw_read 的续页坐标是纯行号、不能加参数，勿动 tool-specs），但改为明确指引"需要该行内容用 kb_read_batch（游标支持行内分片续传，可无损拼回整行）"——超长行内容经 batch 无损可读，raw_read 页本身不声称完整读取。

**登记时序（review-2 风险项）**：kb_read_batch 尾部硬上限断言移到 `appendReadReceipts` **之前**——断言失败时不再留下"有回执而无交付"。

**复核入口动态验证**（review-2 §R5-A/R5-B 给定的输入）：
- draft large（200 行×~70B ≈14KB 正文）+ raw single（一行 5,000 字符）同页：无 oversizedLine/lineChunk，cursor 链拼回原 raw 行，**回执包含该行**；
- draft single-long.md `'x'.repeat(25000)`：round0 chunk 0..16216（17,000B）→ round1 chunk 16216..25000（9,541B）→ round2 收尾（393B），cursor 严格推进、必定终止，拼回 25,000 字符与原文一致（真实服务探针复跑输出）；
- 原始 R5 反例（90×120 反斜杠）复跑不变：16,894B/67 行 + 6,178B/23 行，回执 [1-67],[68-90]。

**新增回归**（kb-author-efficiency.test.ts，15→18 用例）：R5-A defer（不误报不丢行、回执含行）；R5-B raw 分片（≥2 片、note 含不登记回执、链拼回原文、无回执覆盖被分行）；CJK/emoji/反斜杠引号高转义混排 25KB+ 行（分片不切断代理对、JSON 转义计入、拼回无损）；draft 25KB 单行（cursor 严格推进去重、必终止、拼回原行）；原 15 用例保留全过。分片重建断言区分"同行片段拼 ''、跨行拼 '\n'"。

**验证**：`tsc --noEmit` 0 错误；eslint（本任务文件）0 问题；kb-author-efficiency 18/18；build-runtime-tools + knowledge-skill-examples + kb-knowledge-tools + fix-e2e + toolfix-regressions（175 passed，build-runtime-e2e 3 项环境条件跳转为既有状态）；build-pipeline/kb-build/agent-session/kb-discuss-integration/raw-search/link-repair/precheck-integration（100 passed）。未动 build_issues_submit、tool-specs。
